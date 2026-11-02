// Party problems on lines of journals a person (or a template, or a file) wrote: MANUAL, RECURRING
// and IMPORT journals that are Submitted. The rules are the ones the writers enforce from now on
// (partyRules.ts, strict): a party only on a party-role account and of the right type. Also:
// import lines on a receivable / payable / deposit account without a party (E7-R9) and manual
// lines on a deposit account, which only the Deposits module may touch.

import { Prisma } from '@prisma/client';
import { BusinessError } from '../../../../utils/errors';
import { businessDayOf } from '../../../../utils/businessDate';
import {
  PARTY_NOT_ALLOWED,
  PARTY_REQUIRED,
  PARTY_ROLE_AMBIGUOUS,
  PARTY_TYPE_MISMATCH,
  loadPartyRoleMap,
  partyLineProblem,
  type PartyRole,
} from '../../partyRules';
import type { AuditRow, AuditSection } from '../types';

interface Row {
  item_id: string;
  journal_id: string;
  entry_number: string;
  date: Date;
  source_type: string;
  is_closed: boolean;
  account_id: string;
  account_number: string;
  account_name: string;
  party_id: string | null;
  party_name: string | null;
  party_type: 'Customer' | 'Supplier' | 'Both' | null;
  debit: string;
  credit: string;
}

const DEPOSIT_ROLES: readonly PartyRole[] = ['CUSTOMER_DEPOSIT', 'VENDOR_DEPOSIT'];

function causeOf(r: Row, role: PartyRole | undefined): string | null {
  if (role && DEPOSIT_ROLES.includes(role)) return 'manual-deposit-account';
  const problem = partyLineProblem({ partyId: r.party_id, partyType: r.party_type }, role, 'strict');
  if (!problem) return null;
  if (problem.code === PARTY_NOT_ALLOWED) return 'party-on-non-role-account';
  if (problem.code === PARTY_TYPE_MISMATCH) return 'party-type-mismatch';
  if (problem.code === PARTY_REQUIRED) return r.source_type === 'IMPORT' ? 'import-role-line-without-party' : null;
  return 'party-not-found';
}

export const manualPartyLinesSection: AuditSection = {
  id: 'manualPartyLines',
  title: 'Manual, recurring and imported journal lines with a party problem',
  gate: null,
  async run(tx, opts) {
    let roles: ReadonlyMap<string, PartyRole>;
    try {
      roles = await loadPartyRoleMap(tx);
    } catch (e) {
      if (e instanceof BusinessError && e.code === PARTY_ROLE_AMBIGUOUS) {
        return [{
          section: 'manualPartyLines', cause: 'party-role-ambiguous', key: 'party-roles', label: 'Party roles',
          date: null, amount: null, count: 1, yearClosed: null, gate: false, detail: e.message,
        }];
      }
      throw e;
    }
    const since = opts.since ? Prisma.sql`AND je.created_at >= ${opts.since}` : Prisma.empty;
    const year = opts.fiscalYearId ? Prisma.sql`AND je.fiscal_year_id = ${opts.fiscalYearId}` : Prisma.empty;
    const roleIds = [...roles.keys()];
    const roleScope = roleIds.length > 0 ? Prisma.sql`OR jea.account_id IN (${Prisma.join(roleIds)})` : Prisma.empty;
    const rows = await tx.$queryRaw<Row[]>`
      SELECT jea.id AS item_id, je.id AS journal_id, je.entry_number, je.date, je.source_type::text AS source_type,
             fy.is_closed, a.id AS account_id, a."accountNumber" AS account_number, a.name AS account_name,
             jea.party_id, p.name AS party_name, p."partyType"::text AS party_type,
             jea.debit::text AS debit, jea.credit::text AS credit
        FROM journal_entry_accounts jea
        JOIN journal_entries je ON je.id = jea.journal_entry_id
        JOIN fiscal_years fy ON fy.id = je.fiscal_year_id
        JOIN accounts a ON a.id = jea.account_id
        LEFT JOIN parties p ON p.id = jea.party_id
       WHERE je.status = 'Submitted' AND je.source_type IN ('MANUAL', 'RECURRING', 'IMPORT')
         AND (jea.party_id IS NOT NULL ${roleScope}) ${since} ${year}
       ORDER BY je.date, je.entry_number, jea.id
    `;
    const out: AuditRow[] = [];
    for (const r of rows) {
      const cause = causeOf(r, roles.get(r.account_id));
      if (!cause) continue;
      const amount = new Prisma.Decimal(r.debit).gt(0) ? r.debit : r.credit;
      out.push({
        section: 'manualPartyLines',
        cause,
        key: r.item_id,
        label: r.entry_number,
        date: businessDayOf(r.date),
        amount: new Prisma.Decimal(amount).toFixed(2),
        count: 1,
        yearClosed: r.is_closed,
        gate: false,
        detail: `${r.source_type} journal ${r.journal_id}; account ${r.account_number} ${r.account_name}; party ${r.party_name ?? '(none)'}${r.party_type ? ` (${r.party_type})` : ''}`,
      });
    }
    return out;
  },
};
