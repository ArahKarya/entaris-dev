// Core of scripts/repair/e2-rupiah-only-check.ts: rows whose currency code is not IDR in the three
// tables that carry one (accounts, company_settings, payment_requests). Bookkeeping is rupiah only
// (E2-R7, E8-R12 stage 1) and no calculation reads these columns, so a non-IDR code is a stale label:
// the amounts were always booked as rupiah. --apply only rewrites the code to IDR, never an amount
// or a journal.

import type { Prisma } from '@prisma/client';
import type { prisma } from '../lib/prisma';
import { RUPIAH } from '../utils/schemas';

type Db = Prisma.TransactionClient | typeof prisma;

export type RupiahOnlyTable = 'accounts' | 'company_settings' | 'payment_requests';

export interface RupiahOnlyRow {
  table: RupiahOnlyTable;
  id: string;
  /** Account number and name, settings slug, or payment request number. */
  label: string;
  currency: string;
}

/** Read-only: every row whose currency is not IDR. */
export async function planRupiahOnlyFixes(db: Db): Promise<RupiahOnlyRow[]> {
  const [accounts, settings, requests] = await Promise.all([
    db.account.findMany({
      where: { currency: { not: RUPIAH } },
      orderBy: { accountNumber: 'asc' },
      select: { id: true, accountNumber: true, name: true, currency: true },
    }),
    db.companySettings.findMany({
      where: { defaultCurrency: { not: RUPIAH } },
      orderBy: { slug: 'asc' },
      select: { id: true, slug: true, defaultCurrency: true },
    }),
    db.paymentRequest.findMany({
      where: { currency: { not: RUPIAH } },
      orderBy: { number: 'asc' },
      select: { id: true, number: true, currency: true },
    }),
  ]);
  return [
    ...accounts.map((a): RupiahOnlyRow => ({ table: 'accounts', id: a.id, label: `${a.accountNumber} ${a.name}`, currency: a.currency })),
    ...settings.map((s): RupiahOnlyRow => ({ table: 'company_settings', id: s.id, label: s.slug, currency: s.defaultCurrency })),
    ...requests.map((r): RupiahOnlyRow => ({ table: 'payment_requests', id: r.id, label: r.number, currency: r.currency })),
  ];
}

export interface RupiahOnlyApplyResult {
  approvedBy: string;
  /** Rows whose currency was set to IDR. */
  applied: string[];
  /** Planned rows skipped because their currency changed since the plan. */
  skipped: string[];
}

function setRupiah(db: Db, row: RupiahOnlyRow): Promise<{ count: number }> {
  switch (row.table) {
    case 'accounts':
      return db.account.updateMany({ where: { id: row.id, currency: row.currency }, data: { currency: RUPIAH } });
    case 'company_settings':
      return db.companySettings.updateMany({ where: { id: row.id, defaultCurrency: row.currency }, data: { defaultCurrency: RUPIAH } });
    case 'payment_requests':
      return db.paymentRequest.updateMany({ where: { id: row.id, currency: row.currency }, data: { currency: RUPIAH } });
  }
}

/**
 * Sets the currency of every planned row to IDR, only while it still holds the code the plan saw.
 * `approvedBy` (the accountant who approved the run) is required.
 */
export async function applyRupiahOnlyFixes(
  db: Db,
  plan: readonly RupiahOnlyRow[],
  approvedBy: string,
): Promise<RupiahOnlyApplyResult> {
  const name = approvedBy.trim();
  if (!name) throw new Error('--apply needs --approved-by "<accountant name>"');
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const row of plan) {
    const { count } = await setRupiah(db, row);
    (count === 1 ? applied : skipped).push(row.id);
  }
  return { approvedBy: name, applied, skipped };
}
