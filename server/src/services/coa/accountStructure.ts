// Database facts behind the chart-of-accounts rules (E2-R6): which accounts carry ledger rows,
// children, system mappings, and the net that blocks deactivation. Reads only through the
// caller's transaction. Accounts are locked FOR UPDATE in id order so two edits (or an edit and
// a posting that also locks its accounts) cannot deadlock.

import { Prisma } from '@prisma/client';
import type { ImportExisting, ParentFacts, StructureFacts } from './accountRules';

type Db = Prisma.TransactionClient;

export async function lockAccounts(tx: Db, ids: readonly (string | null | undefined)[]): Promise<void> {
  const unique = [...new Set(ids.filter((id): id is string => !!id))].sort();
  if (unique.length === 0) return;
  await tx.$queryRaw`SELECT id FROM accounts WHERE id = ANY(${unique}::text[]) ORDER BY id FOR UPDATE`;
}

/** Ids among `ids` that have at least one active ledger row (their number prefix and group flag are frozen). */
export async function accountIdsWithLedger(db: Db, ids?: readonly string[]): Promise<Set<string>> {
  const rows = await db.accountingLedgerEntry.groupBy({
    by: ['accountId'],
    where: { isCancelled: false, ...(ids ? { accountId: { in: [...ids] } } : {}) },
  });
  return new Set(rows.map((r) => r.accountId));
}

/** One groupBy over the active ledger, one account read, one mapping read, one fiscal year read. */
export async function loadStructureFacts(tx: Db, ids: readonly string[]): Promise<Map<string, StructureFacts>> {
  const unique = [...new Set(ids)];
  const [ledger, accounts, mappings] = await Promise.all([
    tx.accountingLedgerEntry.groupBy({
      by: ['accountId', 'fiscalYearId'],
      where: { isCancelled: false, accountId: { in: unique } },
      _sum: { debit: true, credit: true },
    }),
    tx.account.findMany({
      where: { OR: [{ id: { in: unique } }, { parentId: { in: unique } }] },
      select: { id: true, parentId: true, rootType: true, isActive: true },
    }),
    tx.systemAccountMapping.findMany({ where: { accountId: { in: unique } }, select: { accountId: true, role: true } }),
  ]);
  const years = await tx.fiscalYear.findMany({
    where: { id: { in: [...new Set(ledger.map((l) => l.fiscalYearId))] } },
    select: { id: true, isClosed: true },
  });
  const closedYear = new Set(years.filter((y) => y.isClosed).map((y) => y.id));
  const rootTypeOf = new Map(accounts.map((a) => [a.id, a.rootType]));

  const facts = new Map<string, StructureFacts>();
  for (const id of unique) {
    facts.set(id, { hasLedger: false, deactivationNet: new Prisma.Decimal(0), childCount: 0, activeChildCount: 0, mappedRoles: [] });
  }
  for (const row of ledger) {
    const f = facts.get(row.accountId)!;
    f.hasLedger = true;
    // Balance-sheet accounts carry their whole history; revenue/expense are zeroed per year by the
    // close, so only open years can still block (closed years just show a presentation balance).
    const pnl = ['REVENUE', 'EXPENSE'].includes(rootTypeOf.get(row.accountId) ?? '');
    if (pnl && closedYear.has(row.fiscalYearId)) continue;
    f.deactivationNet = f.deactivationNet.plus(row._sum.debit ?? 0).minus(row._sum.credit ?? 0);
  }
  for (const a of accounts) {
    const f = a.parentId ? facts.get(a.parentId) : undefined;
    if (!f) continue;
    f.childCount += 1;
    if (a.isActive) f.activeChildCount += 1;
  }
  for (const m of mappings) {
    const f = facts.get(m.accountId)!;
    facts.set(m.accountId, { ...f, mappedRoles: [...f.mappedRoles, m.role] });
  }
  return facts;
}

export interface ImportFacts {
  /** Stored accounts by number: the rows' own numbers and their parents. */
  existing: Map<string, ImportExisting>;
  parents: Map<string, ParentFacts>;
}

/**
 * Stored accounts for an import: one account read (the numbers plus the children of those that
 * exist) and one ledger groupBy. Also used by the preview, which writes nothing.
 */
export async function loadImportFacts(db: Db, numbers: readonly string[]): Promise<ImportFacts> {
  const unique = [...new Set(numbers)];
  const accounts = await db.account.findMany({
    where: { OR: [{ accountNumber: { in: unique } }, { parent: { accountNumber: { in: unique } } }] },
    select: { id: true, accountNumber: true, rootType: true, isGroup: true, parentId: true },
  });
  const asked = new Set(unique);
  const own = accounts.filter((a) => asked.has(a.accountNumber));
  const withLedger = await accountIdsWithLedger(db, own.map((a) => a.id));
  const existing = new Map<string, ImportExisting>();
  const parents = new Map<string, ParentFacts>();
  for (const a of own) {
    const childCount = accounts.filter((c) => c.parentId === a.id).length;
    existing.set(a.accountNumber, {
      id: a.id, rootType: a.rootType, isGroup: a.isGroup, parentId: a.parentId, hasLedger: withLedger.has(a.id), childCount,
    });
    parents.set(a.accountNumber, { id: a.id, accountNumber: a.accountNumber, rootType: a.rootType, isGroup: a.isGroup });
  }
  return { existing, parents };
}
