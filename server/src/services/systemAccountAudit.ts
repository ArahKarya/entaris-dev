// Read-only audit of the system account mappings (E2-R8). Finds mappings the posting code cannot
// use or that share an account between roles of different meaning, with the ALE balance of the
// account per fiscal year and replacement candidates, so the accountant can decide each remap.
// The pure builder takes already-loaded rows; the loader reads them. Nothing is written here.

import { Prisma, type RootType } from '@prisma/client';
import { prisma } from '../lib/prisma';
import {
  ALL_SYSTEM_ROLES,
  EXCLUSIVE_MAPPING_ROLES,
  POSTING_SYSTEM_ROLES,
  REQUIRED_SYSTEM_ROLES,
  SYSTEM_ACCOUNT_ROLES,
  type SystemAccountRole,
} from '../types/systemAccounts';

type Db = Prisma.TransactionClient | typeof prisma;
const D = (v: Prisma.Decimal.Value | null | undefined): Prisma.Decimal => new Prisma.Decimal(v ?? 0);

export const AUDIT_ISSUES = [
  'GROUP_ACCOUNT',
  'INACTIVE_ACCOUNT',
  'ROOT_TYPE_MISMATCH',
  'SHARED_ACCOUNT',
  'MISSING_REQUIRED',
  'MISSING_POSTING',
] as const;
export type AuditIssue = (typeof AUDIT_ISSUES)[number];

export interface AuditAccount {
  id: string;
  accountNumber: string;
  name: string;
  rootType: RootType;
  isGroup: boolean;
  isActive: boolean;
  parentId: string | null;
}

export interface AuditMapping {
  role: string;
  accountId: string;
}

/** Active ledger sums of one account in one fiscal year. */
export interface AccountYearBalance {
  accountId: string;
  fiscalYear: string;
  rows: number;
  debit: Prisma.Decimal.Value;
  credit: Prisma.Decimal.Value;
}

export interface AuditInput {
  mappings: readonly AuditMapping[];
  accounts: readonly AuditAccount[];
  balances: readonly AccountYearBalance[];
}

export interface AuditFinding {
  issue: AuditIssue;
  role: SystemAccountRole;
  otherRole: SystemAccountRole | null;
  accountNumber: string;
  accountName: string;
  /** Posting roles are wrong for the next posting; the rest are reported for review. */
  posting: boolean;
  aleRows: number;
  /** Debit minus credit over all years, 2 decimals. */
  netAllYears: string;
  /** "2025=100.00;2026=50.00" (debit minus credit, active ALE). */
  netByYear: string;
  candidates: string[];
  detail: string;
}

const POSTING = new Set<string>(POSTING_SYSTEM_ROLES);
const EXCLUSIVE = new Set<string>(EXCLUSIVE_MAPPING_ROLES);
const MAX_CANDIDATES = 5;

/** Detail, active accounts of the expected root type: under the same parent, or under the group itself. */
function candidatesFor(account: AuditAccount | null, rootType: RootType, accounts: readonly AuditAccount[]): string[] {
  const parentId = account?.isGroup ? account.id : account?.parentId ?? null;
  const pool = accounts.filter(
    (a) => !a.isGroup && a.isActive && a.rootType === rootType && a.id !== account?.id && (parentId === null ? false : a.parentId === parentId),
  );
  return pool
    .sort((a, b) => a.accountNumber.localeCompare(b.accountNumber, undefined, { numeric: true }))
    .slice(0, MAX_CANDIDATES)
    .map((a) => `${a.accountNumber} ${a.name}`);
}

export function buildSystemAccountAudit(input: AuditInput): AuditFinding[] {
  const byId = new Map(input.accounts.map((a) => [a.id, a]));
  const findings: AuditFinding[] = [];

  const base = (accountId: string | null) => {
    const rows = input.balances.filter((b) => b.accountId === accountId).sort((a, b) => a.fiscalYear.localeCompare(b.fiscalYear));
    const net = rows.reduce((sum, r) => sum.plus(D(r.debit)).minus(D(r.credit)), D(0));
    return {
      aleRows: rows.reduce((n, r) => n + r.rows, 0),
      netAllYears: net.toFixed(2),
      netByYear: rows.map((r) => `${r.fiscalYear}=${D(r.debit).minus(D(r.credit)).toFixed(2)}`).join(';'),
    };
  };

  const roleOf = (role: string): SystemAccountRole | null =>
    (ALL_SYSTEM_ROLES as readonly string[]).includes(role) ? (role as SystemAccountRole) : null;

  for (const m of input.mappings) {
    const role = roleOf(m.role);
    const account = byId.get(m.accountId);
    if (!role || !account) continue;
    const expected = SYSTEM_ACCOUNT_ROLES[role].expectedRootType;
    const add = (issue: AuditIssue, detail: string) =>
      findings.push({
        issue, role, otherRole: null, accountNumber: account.accountNumber, accountName: account.name,
        posting: POSTING.has(role), ...base(account.id), candidates: candidatesFor(account, expected, input.accounts), detail,
      });
    if (account.isGroup) add('GROUP_ACCOUNT', 'Mapped to a group account; postings to it are refused.');
    if (!account.isActive) add('INACTIVE_ACCOUNT', 'Mapped to an inactive account.');
    if (account.rootType !== expected) add('ROOT_TYPE_MISMATCH', `Account is ${account.rootType}, role expects ${expected}.`);
  }

  // Two roles of different meaning on one account; report each pair once.
  const rolesByAccount = new Map<string, SystemAccountRole[]>();
  for (const m of input.mappings) {
    const role = roleOf(m.role);
    if (role) rolesByAccount.set(m.accountId, [...(rolesByAccount.get(m.accountId) ?? []), role]);
  }
  for (const [accountId, roles] of rolesByAccount) {
    const account = byId.get(accountId);
    if (!account) continue;
    const sorted = [...new Set(roles)].sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const [a, b] = [sorted[i], sorted[j]];
        const exclusive = EXCLUSIVE.has(a) && EXCLUSIVE.has(b);
        findings.push({
          issue: 'SHARED_ACCOUNT', role: a, otherRole: b, accountNumber: account.accountNumber, accountName: account.name,
          posting: exclusive, ...base(account.id), candidates: [],
          detail: exclusive ? 'Two roles with different meaning share one account.' : 'Two roles share one account (informational).',
        });
      }
    }
  }

  const mapped = new Set(input.mappings.map((m) => m.role));
  for (const role of ALL_SYSTEM_ROLES) {
    if (mapped.has(role)) continue;
    const required = (REQUIRED_SYSTEM_ROLES as readonly string[]).includes(role);
    const posting = POSTING.has(role);
    if (!required && !posting) continue;
    findings.push({
      issue: required ? 'MISSING_REQUIRED' : 'MISSING_POSTING', role, otherRole: null, accountNumber: '', accountName: '',
      posting, ...base(null), candidates: [],
      detail: required ? 'Required role has no account.' : 'Role used by posting code has no account.',
    });
  }

  return findings.sort((a, b) => a.role.localeCompare(b.role) || a.issue.localeCompare(b.issue));
}

export async function loadSystemAccountAuditInput(db: Db = prisma): Promise<AuditInput> {
  const [mappings, accounts, years] = await Promise.all([
    db.systemAccountMapping.findMany({ select: { role: true, accountId: true } }),
    db.account.findMany({
      select: { id: true, accountNumber: true, name: true, rootType: true, isGroup: true, isActive: true, parentId: true },
    }),
    db.fiscalYear.findMany({ select: { id: true, name: true } }),
  ]);
  const mappedIds = [...new Set(mappings.map((m) => m.accountId))];
  const sums = await db.accountingLedgerEntry.groupBy({
    by: ['accountId', 'fiscalYearId'],
    where: { accountId: { in: mappedIds }, isCancelled: false },
    _sum: { debit: true, credit: true },
    _count: { _all: true },
  });
  const yearName = new Map(years.map((y) => [y.id, y.name]));
  const balances: AccountYearBalance[] = sums.map((s) => ({
    accountId: s.accountId,
    fiscalYear: yearName.get(s.fiscalYearId) ?? s.fiscalYearId,
    rows: s._count._all,
    debit: s._sum.debit ?? 0,
    credit: s._sum.credit ?? 0,
  }));
  return { mappings, accounts, balances };
}

export async function auditSystemAccounts(db: Db = prisma): Promise<AuditFinding[]> {
  return buildSystemAccountAudit(await loadSystemAccountAuditInput(db));
}

export const AUDIT_CSV_HEADER =
  'issue,role,other_role,account_number,account_name,posting_role,ale_rows,net_all_years,net_by_year,candidates,detail';

export function auditCsvFields(f: AuditFinding): string[] {
  return [
    f.issue, f.role, f.otherRole ?? '', f.accountNumber, f.accountName, f.posting ? 'yes' : 'no',
    String(f.aleRows), f.netAllYears, f.netByYear, f.candidates.join(' | '), f.detail,
  ];
}
