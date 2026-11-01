// Core of scripts/repair/e2-rupiah-only-check.ts: rows whose currency code is not IDR in the three
// tables that carry one (accounts, company_settings, payment_requests). Bookkeeping is rupiah only
// (E2-R7, E8-R12 stage 1) and no calculation reads these columns, so a non-IDR code is a stale label:
// the amounts were always booked as rupiah. --apply only rewrites the code to IDR, never an amount
// or a journal, and records each rewrite (with the approving accountant) on an audit row.

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

/** auditLog action of every rewrite this script makes (also viaMeta.script). */
export const RUPIAH_ONLY_AUDIT_ACTION = 'E2_RUPIAH_ONLY_REPAIR';

const AUDIT_ENTITY: Record<RupiahOnlyTable, string> = {
  accounts: 'Account',
  company_settings: 'CompanySettings',
  payment_requests: 'PaymentRequest',
};

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
 * The user each audit row is written under, since a script has no user of its own: the requester
 * for a payment request, the oldest active Admin for an account or the company settings.
 * `via: 'repair'` and viaMeta mark the row as written by this script.
 */
async function auditUsers(db: Db, plan: readonly RupiahOnlyRow[]): Promise<Map<string, string>> {
  const users = new Map<string, string>();
  const requestIds = plan.filter((r) => r.table === 'payment_requests').map((r) => r.id);
  if (requestIds.length > 0) {
    const requests = await db.paymentRequest.findMany({ where: { id: { in: requestIds } }, select: { id: true, requesterId: true } });
    for (const r of requests) users.set(r.id, r.requesterId);
  }
  if (plan.some((r) => r.table !== 'payment_requests')) {
    const admin = await db.user.findFirst({ where: { role: 'Admin', isActive: true }, orderBy: { createdAt: 'asc' }, select: { id: true } });
    if (!admin) throw new Error('No active Admin user to record the audit rows under.');
    for (const r of plan) if (r.table !== 'payment_requests') users.set(r.id, admin.id);
  }
  return users;
}

/**
 * Sets the currency of every planned row to IDR, only while it still holds the code the plan saw.
 * `approvedBy` (the accountant who approved the run) is required and is recorded on one audit row
 * per rewritten row (old and new code), so the approval survives in the database even if the CSV
 * report is lost.
 */
export async function applyRupiahOnlyFixes(
  db: Db,
  plan: readonly RupiahOnlyRow[],
  approvedBy: string,
): Promise<RupiahOnlyApplyResult> {
  const name = approvedBy.trim();
  if (!name) throw new Error('--apply needs --approved-by "<accountant name>"');
  const users = await auditUsers(db, plan);
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const row of plan) {
    const userId = users.get(row.id);
    const { count } = userId ? await setRupiah(db, row) : { count: 0 };
    if (count !== 1 || !userId) {
      skipped.push(row.id);
      continue;
    }
    await db.auditLog.create({
      data: {
        userId,
        action: RUPIAH_ONLY_AUDIT_ACTION,
        entityType: AUDIT_ENTITY[row.table],
        entityId: row.id,
        oldValues: { currency: row.currency },
        newValues: { currency: RUPIAH, approvedBy: name },
        via: 'repair',
        viaMeta: { script: RUPIAH_ONLY_AUDIT_ACTION, approvedBy: name },
      },
    });
    applied.push(row.id);
  }
  return { approvedBy: name, applied, skipped };
}
