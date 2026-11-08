// Party import (E2-R13, plan step 5 PR-5.12): the profile of a party comes from the sheet, its
// opening balances only through the one opening balance service (setOpeningBalanceInTx, PARTY targets).
//   - A new party is created with zero balances and each stated opening is set by the service, all in
//     one transaction: a refused opening leaves no party behind.
//   - An existing party (same name and type) gets its profile refreshed. Its opening balances change
//     only when it has no transactions (invoices, payments, deposits outside its opening ones): the
//     same amount is 'unchanged', a different one replaces the recorded opening and needs the row
//     confirmed (owner decision #3). A party with transactions keeps its balances; correct them with
//     a manual journal.
import { Prisma, type PrismaClient } from '@prisma/client';
import { BusinessError } from '../utils/errors';
import { mappedAccount } from './systemAccounts';
import { sourceKeys, type OpeningPartyKind } from './ledger/journalSource';
import { peekCutoverDate, recordedOpening, setOpeningBalanceInTx, type OpeningOutcome } from './ledger/openingBalance';
import { findActivePartyOpeningJournals } from './ledger/openingBalanceParty';
import { OPENING_REPLACE_UNCONFIRMED } from './ledger/openingImportCodes';
import type { PartyImportRow } from './partyImportRows';

type Tx = Prisma.TransactionClient;
type Db = Tx | PrismaClient;
type Dec = Prisma.Decimal;

export const OPENING_KINDS: readonly OpeningPartyKind[] = ['AR', 'AP', 'VDEP', 'CDEP'];
const KEY_PREFIX = sourceKeys.openingParty('x', 'AR').slice(0, -'x:AR'.length);

/** Marks the issue of a party that has transactions: its sheet balances were not applied. */
export const PARTY_OPENING_KEPT = 'PARTY_OPENING_KEPT';

export type KindAction = 'unchanged' | 'post' | 'replace';

export interface KindPreview {
  kind: OpeningPartyKind;
  action: KindAction;
  recorded: string | null;
  amount: string;
}

/** What the sheet's openings would do to a party; `kept` = the party has transactions, nothing changes. */
export interface PartyOpeningPreview {
  allowed: true;
  reason: null;
  cutoverDate: string | null;
  recorded: string | null;
  action: KindAction | 'kept';
  runningBalance: false;
  needsConfirm: boolean;
  kinds: KindPreview[];
}

const profileOf = (row: PartyImportRow) => ({ phone: row.phone, email: row.email, address: row.address, taxId: row.taxId });
const statedKinds = (row: PartyImportRow): Array<[OpeningPartyKind, Dec]> =>
  OPENING_KINDS.flatMap((k) => (row.openings[k] !== undefined ? [[k, new Prisma.Decimal(row.openings[k]!)] as [OpeningPartyKind, Dec]] : []));

/** The active party with this name and type: the import's identity for a party (never a prefix or a partial name). */
export const findImportedParty = (db: Db, row: Pick<PartyImportRow, 'name' | 'partyType'>) =>
  db.party.findFirst({ where: { name: row.name, partyType: row.partyType }, orderBy: { createdAt: 'asc' } });

/**
 * Invoices, payments and deposits of the party, apart from cancelled documents and its opening
 * deposits (those belong to the opening balance, not to its transactions).
 */
export async function hasPartyTransactions(db: Db, partyId: string): Promise<boolean> {
  const equity = await mappedAccount(db as Tx, 'OPENING_EQUITY');
  const notCancelled = { partyId, status: { not: 'Cancelled' as const } };
  if (await db.salesInvoice.findFirst({ where: notCancelled, select: { id: true } })) return true;
  if (await db.purchaseInvoice.findFirst({ where: notCancelled, select: { id: true } })) return true;
  const payment = await db.payment.findFirst({
    where: { ...notCancelled, accountId: { not: equity.id }, NOT: { journalEntry: { sourceType: 'OPENING' } } },
    select: { id: true },
  });
  return !!payment;
}

const recordedOf = async (db: Db, partyId: string, kind: OpeningPartyKind): Promise<Dec | null> =>
  recordedOpening(db, { kind: 'PARTY', partyId, subledger: kind });

/**
 * Active opening deposit payments the service did not key (the old party import, the old deposit
 * screen): the service replaces them by cancelling the payment, so the row is a replacement that
 * needs the user's confirmation even though `recordedOf` sees no keyed opening. Null when none.
 */
async function legacyDepositOf(db: Db, partyId: string, kind: OpeningPartyKind): Promise<Dec | null> {
  if (kind !== 'VDEP' && kind !== 'CDEP') return null;
  const legacy = (await findActivePartyOpeningJournals(db, partyId, kind)).deposits.filter((d) => !d.keyed);
  if (legacy.length === 0) return null;
  return legacy.reduce((sum, d) => sum.add(new Prisma.Decimal(d.payment.amount)), new Prisma.Decimal(0));
}

/** What is recorded for the kind and whether the row replaces it (a legacy deposit always does). */
async function kindState(db: Db, partyId: string, kind: OpeningPartyKind, amount: Dec): Promise<{ recorded: Dec | null; action: KindAction }> {
  const keyed = await recordedOf(db, partyId, kind);
  const legacy = await legacyDepositOf(db, partyId, kind);
  if (legacy !== null) return { recorded: keyed ?? legacy, action: 'replace' };
  return { recorded: keyed, action: kindAction(keyed, amount) };
}

function kindAction(recorded: Dec | null, amount: Dec): KindAction {
  if (recorded === null) return amount.isZero() ? 'unchanged' : 'post';
  return recorded.eq(amount) ? 'unchanged' : 'replace';
}

/** Per kind: what the sheet would do to an existing party (no writes). */
async function existingKinds(db: Db, partyId: string, row: PartyImportRow): Promise<KindPreview[]> {
  const out: KindPreview[] = [];
  for (const [kind, amount] of statedKinds(row)) {
    const { recorded, action } = await kindState(db, partyId, kind, amount);
    out.push({ kind, action, recorded: recorded?.toFixed(2) ?? null, amount: amount.toFixed(2) });
  }
  return out;
}

function summarize(kinds: KindPreview[], kept: boolean, cutoverDate: string | null): PartyOpeningPreview {
  const changing = kinds.filter((k) => k.action !== 'unchanged');
  const replace = kinds.find((k) => k.action === 'replace');
  const action = changing.length === 0 ? 'unchanged' : kept ? 'kept' : replace ? 'replace' : 'post';
  return {
    allowed: true,
    reason: null,
    cutoverDate,
    recorded: (replace ?? kinds.find((k) => k.recorded !== null))?.recorded ?? null,
    action,
    runningBalance: false,
    needsConfirm: action === 'replace',
    kinds,
  };
}

/** The opening part of one preview row, or null when the sheet states no opening for it. */
export async function previewPartyOpening(db: Db, row: PartyImportRow): Promise<PartyOpeningPreview | null> {
  if (statedKinds(row).length === 0) return null;
  const cutover = await peekCutoverDate(db).then((c) => c.day, () => null);
  const existing = await findImportedParty(db, row);
  if (!existing) {
    const kinds: KindPreview[] = statedKinds(row).map(([kind, amount]) => ({ kind, action: kindAction(null, amount), recorded: null, amount: amount.toFixed(2) }));
    return summarize(kinds, false, cutover);
  }
  return summarize(await existingKinds(db, existing.id, row), await hasPartyTransactions(db, existing.id), cutover);
}

export interface PartyImportContext {
  userId: string;
  /** The user ticked this row's replacement. */
  confirmed: boolean;
  throughLock?: { reason: string };
}

export interface PartyImportIssue {
  message: string;
  code?: string;
}

export interface PartyImportResult {
  created: boolean;
  /** Per stated kind: what the opening balance service did. */
  openings: Array<{ kind: OpeningPartyKind; action: OpeningOutcome['action']; journalNumber: string | null }>;
  /** The party is saved, but part of the sheet was not applied. */
  issues: PartyImportIssue[];
}

const keptMessage = (name: string) => `Mitra "${name}" sudah ada: data profil diperbarui, saldo awal tidak diubah. Koreksi saldo lewat jurnal manual.`;

async function applyOpenings(tx: Tx, partyId: string, row: PartyImportRow, ctx: PartyImportContext, skipZero: boolean, existingParty = false): Promise<PartyImportResult['openings']> {
  const done: PartyImportResult['openings'] = [];
  for (const [kind, amount] of statedKinds(row)) {
    if (skipZero && amount.isZero()) continue;
    const { recorded, action } = await kindState(tx, partyId, kind, amount);
    // The same amount is not posted again: a keyed journal dated after the cut-over day must not be voided for it.
    if (action === 'unchanged') continue;
    if (action === 'replace' && !ctx.confirmed) {
      throw new BusinessError(
        `saldo awal tercatat ${recorded!.toFixed(2)} akan diganti ${amount.toFixed(2)}. Centang konfirmasi baris ini di layar impor untuk menggantinya.`,
        OPENING_REPLACE_UNCONFIRMED,
      );
    }
    const outcome = await setOpeningBalanceInTx(tx, {
      target: { kind: 'PARTY', partyId, subledger: kind },
      amount,
      userId: ctx.userId,
      throughLock: ctx.throughLock,
    });
    // The preview ran before the service took its locks; an opening that appeared since is still a replacement.
    if (outcome.cancelled.length > 0 && !ctx.confirmed) {
      throw new BusinessError(
        `saldo awal tercatat akan diganti ${amount.toFixed(2)}. Centang konfirmasi baris ini di layar impor untuk menggantinya.`,
        OPENING_REPLACE_UNCONFIRMED,
      );
    }
    done.push({ kind, action: outcome.action, journalNumber: outcome.journal?.entryNumber ?? null });
  }
  // Owner decision #3, checked again with the service's party lock held: a document submitted since
  // the outer check must not let the opening change (the throw rolls the replacement back).
  if (existingParty && done.length > 0 && (await hasPartyTransactions(tx, partyId))) {
    throw new BusinessError(keptMessage(row.name), PARTY_OPENING_KEPT);
  }
  return done;
}

/**
 * One sheet row. Throws when nothing was saved (a new party whose opening was refused); returns
 * `issues` when the party is saved but its opening balances were not applied.
 */
export async function importPartyRow(prisma: PrismaClient, row: PartyImportRow, ctx: PartyImportContext): Promise<PartyImportResult> {
  const stated = statedKinds(row);
  const existing = await findImportedParty(prisma, row);

  if (!existing) {
    if (!stated.some(([, amount]) => !amount.isZero())) {
      await prisma.party.create({ data: { name: row.name, partyType: row.partyType, ...profileOf(row) } });
      return { created: true, openings: [], issues: [] };
    }
    // The party and its openings commit together; the service takes the period guard inside this transaction.
    const openings = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const created = await tx.party.create({ data: { name: row.name, partyType: row.partyType, ...profileOf(row) } });
      return applyOpenings(tx, created.id, row, ctx, true);
    }, { timeout: 15000 });
    return { created: true, openings, issues: [] };
  }

  await prisma.party.update({ where: { id: existing.id }, data: profileOf(row) });
  if (stated.length === 0) return { created: false, openings: [], issues: [] };

  if (await hasPartyTransactions(prisma, existing.id)) {
    const differs = (await existingKinds(prisma, existing.id, row)).some((k) => k.action !== 'unchanged');
    return {
      created: false,
      openings: [],
      issues: differs
        ? [{ message: keptMessage(row.name), code: PARTY_OPENING_KEPT }]
        : [],
    };
  }
  try {
    const openings = await prisma.$transaction((tx: Prisma.TransactionClient) => applyOpenings(tx, existing.id, row, ctx, false, true), { timeout: 15000 });
    return { created: false, openings, issues: [] };
  } catch (err) {
    if (!(err instanceof BusinessError)) throw err;
    if (err.code === PARTY_OPENING_KEPT) return { created: false, openings: [], issues: [{ message: err.message, code: PARTY_OPENING_KEPT }] };
    return { created: false, openings: [], issues: [{ message: `Mitra "${row.name}" disimpan, tetapi ${err.message}`, ...(err.code ? { code: err.code } : {}) }] };
  }
}

/** The opening balances this service recorded, per party and kind (the party template export). */
export async function recordedPartyOpenings(db: Db): Promise<Map<string, Partial<Record<OpeningPartyKind, Dec>>>> {
  const keyed = await db.journalEntry.findMany({
    where: { status: { not: 'Cancelled' }, sourceKey: { startsWith: KEY_PREFIX } },
    select: { sourceKey: true },
    distinct: ['sourceKey'],
  });
  const result = new Map<string, Partial<Record<OpeningPartyKind, Dec>>>();
  for (const { sourceKey } of keyed) {
    const [partyId, kind] = sourceKey!.slice(KEY_PREFIX.length).split(':') as [string, OpeningPartyKind];
    if (!OPENING_KINDS.includes(kind)) continue;
    const amount = await recordedOf(db, partyId, kind);
    if (amount === null) continue;
    result.set(partyId, { ...result.get(partyId), [kind]: amount });
  }
  return result;
}
