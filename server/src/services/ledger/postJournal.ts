// The one posting function for journals (E2-R3, plan §2.4). In the caller's transaction:
//   1. lines through the one validator (utils/journalLineRules.ts): Decimal, at least 2 lines,
//      debit total exactly equal to credit total;
//   2. fiscal year from the journal's own date, open and not locked (utils/periodGuard.ts); a
//      caller that expects a year passes expectFiscalYearId to have it verified, never to choose it;
//   3. the entry number (JV advisory lock) first, then account rows locked FOR UPDATE in id order,
//      the same order as every other JV writer, then the account rule (detail, active, control);
//   4. party per line under the party rule (services/ledger/partyRules.ts);
//   5. one journal with its items, one createMany of ledger rows (reference JournalEntry);
//   6. balances in Decimal, one UPDATE per account in id order;
//   7. with partyEffect 'recalc', the touched parties' outstanding recalculated from the documents
//      and the manual adjustments (never incremented).

import type { FiscalYear, JournalEntry, JournalItem, JournalSourceType, Prisma } from '@prisma/client';
import { generateDocumentNumber } from '../../utils/documentNumber';
import { BusinessError } from '../../utils/errors';
import { assertJournalLines, type JournalLineInput, type NormalizedJournalLine } from '../../utils/journalLineRules';
import { assertPeriodOpen, type PeriodGuardOptions } from '../../utils/periodGuard';
import { applyAccountImpacts, recalcPartyOutstanding } from '../../utils/accountBalance';
import { businessDayOf } from '../../utils/businessDate';
import { assertPostableAccounts, type PostableRule } from './accountGuard';
import { loadPartyRoleMap, loadPartyTypes, partyLineProblem, type PartyRule } from './partyRules';

type Tx = Prisma.TransactionClient;

export const JOURNAL_FY_MISMATCH = 'JOURNAL_FY_MISMATCH';

export interface PostJournalInput {
  date: Date;
  narration: string;
  lines: readonly JournalLineInput[];
  /** Required: new code never writes a journal without a source. */
  sourceType: JournalSourceType;
  /** Built with sourceKeys (services/ledger/journalSource.ts). */
  sourceKey?: string | null;
  createdBy: string;
  /** Default: the next JV number of the journal's fiscal year. Year-end close and deposits pass their own. */
  entryNumber?: string;
  /** manualJournalRule / TEMPLATE_RULE / DOCUMENT_RULE (services/ledger/accountGuard.ts). */
  accountRule: PostableRule;
  /**
   * Rule per account id replacing accountRule for that account. Only the system account remap
   * reclass passes it (REMAP_SOURCE_RULE on the old account, services/systemAccountRemap.ts).
   */
  lineRules?: ReadonlyMap<string, PostableRule>;
  partyRule: PartyRule;
  /** Default 'none'; 'recalc' only for MANUAL / IMPORT / RECURRING. */
  partyEffect?: 'recalc' | 'none';
  /** Ledger rows without a party (journal items keep theirs); the payment request posting does this today. */
  ledgerPartyless?: boolean;
  /** Verified against the year of `date` (JOURNAL_FY_MISMATCH); the year is never taken from here. */
  expectFiscalYearId?: string;
  /** { ignoreLock: true } only for the year-end close journal. */
  periodOptions?: PeriodGuardOptions;
  dropEmptyLines?: boolean;
  /** submittedAt; default now. */
  now?: Date;
}

export interface PostedJournal {
  journal: JournalEntry & { items: JournalItem[] };
  fiscalYear: FiscalYear;
}

/** Throws the first party problem as BusinessError, naming the 1-based line. No-op under 'off'. */
async function assertPartyLines(tx: Tx, lines: readonly NormalizedJournalLine[], rule: PartyRule): Promise<void> {
  if (rule === 'off') return;
  const [roles, types] = await Promise.all([loadPartyRoleMap(tx, lines.map((l) => l.accountId)), loadPartyTypes(tx, lines.map((l) => l.partyId))]);
  lines.forEach((line, index) => {
    const partyType = line.partyId ? types.get(line.partyId) ?? null : null;
    const problem = partyLineProblem({ partyId: line.partyId, partyType }, roles.get(line.accountId), rule);
    if (problem) throw new BusinessError(`Baris ${index + 1}: ${problem.message}`, problem.code);
  });
}

export async function postJournal(tx: Tx, input: PostJournalInput): Promise<PostedJournal> {
  const lines = assertJournalLines(input.lines, { dropEmptyLines: input.dropEmptyLines });

  const fiscalYear = await assertPeriodOpen(tx, { date: input.date }, 'jurnal', input.periodOptions);
  if (input.expectFiscalYearId !== undefined && input.expectFiscalYearId !== fiscalYear.id) {
    throw new BusinessError(
      `Tanggal jurnal ${businessDayOf(input.date)} masuk tahun buku ${fiscalYear.name}, bukan tahun buku yang diharapkan.`,
      JOURNAL_FY_MISMATCH,
    );
  }

  // The number (and with it the JV advisory lock) before the account rows: every other JV writer
  // takes generateDocumentNumber first and then updates balances, so the opposite order deadlocks.
  const entryNumber = input.entryNumber ?? (await generateDocumentNumber(tx, 'JV', input.date, fiscalYear.id));

  const accounts = await assertPostableAccounts(tx, lines.map((l) => l.accountId), input.accountRule, {
    lockRows: true,
    lineRules: input.lineRules,
  });
  await assertPartyLines(tx, lines, input.partyRule);

  const journal = await tx.journalEntry.create({
    data: {
      entryNumber,
      date: input.date,
      narration: input.narration,
      status: 'Submitted',
      fiscalYearId: fiscalYear.id,
      createdBy: input.createdBy,
      submittedAt: input.now ?? new Date(),
      sourceType: input.sourceType,
      sourceKey: input.sourceKey ?? null,
      items: {
        create: lines.map((l) => ({
          accountId: l.accountId,
          partyId: l.partyId,
          debit: l.debit,
          credit: l.credit,
          description: l.description,
        })),
      },
    },
    include: { items: true },
  });

  await tx.accountingLedgerEntry.createMany({
    data: journal.items.map((item) => ({
      date: input.date,
      accountId: item.accountId,
      partyId: input.ledgerPartyless ? null : item.partyId,
      debit: item.debit,
      credit: item.credit,
      referenceType: 'JournalEntry',
      referenceId: journal.id,
      description: item.description || input.narration,
      fiscalYearId: fiscalYear.id,
    })),
  });

  await applyAccountImpacts(tx, lines, new Map([...accounts].map(([id, a]) => [id, a.rootType])));

  if (input.partyEffect === 'recalc') {
    const partyIds = [...new Set(lines.map((l) => l.partyId).filter((id): id is string => !!id))].sort();
    for (const partyId of partyIds) await recalcPartyOutstanding(tx, partyId);
  }

  return { journal, fiscalYear };
}
