// Pure part of the system account mapping audit (E2-R8, PR-4.11): what it flags, the balance per
// year and the replacement candidates. The loader is covered by the integration test.
import { describe, expect, it } from 'vitest';
import {
  AUDIT_CSV_HEADER,
  auditCsvFields,
  buildSystemAccountAudit,
  type AuditAccount,
  type AuditInput,
} from '../../../services/systemAccountAudit';
import { ALL_SYSTEM_ROLES, SYSTEM_ACCOUNT_ROLES } from '../../../types/systemAccounts';

const account = (id: string, accountNumber: string, over: Partial<AuditAccount> = {}): AuditAccount => ({
  id, accountNumber, name: `N${accountNumber}`, rootType: 'EXPENSE', isGroup: false, isActive: true, parentId: null, ...over,
});

const ACCOUNTS: AuditAccount[] = [
  account('g5', '5', { isGroup: true }),
  account('a51', '5.1', { parentId: 'g5' }),
  account('a52', '5.2', { parentId: 'g5' }),
  account('a53', '5.3', { parentId: 'g5', isActive: false }),
  account('a54', '5.4', { parentId: 'g5', rootType: 'REVENUE' }),
  account('ar', '1.2.1', { rootType: 'ASSET', parentId: 'g12' }),
  account('ar2', '1.2.2', { rootType: 'ASSET', parentId: 'g12' }),
  account('inactive', '9.9', { rootType: 'ASSET', isActive: false }),
  account('rev', '4.1', { rootType: 'REVENUE' }),
  account('v88', '8.8'),
];

/** Every required role mapped to a healthy account so only the cases under test show up. */
function healthyMappings(overrides: Record<string, string> = {}) {
  return ALL_SYSTEM_ROLES.map((role) => ({ role, accountId: overrides[role] ?? 'a51' }));
}

function run(input: Partial<AuditInput>) {
  return buildSystemAccountAudit({ mappings: [], accounts: ACCOUNTS, balances: [], ...input });
}

describe('buildSystemAccountAudit', () => {
  it('COGS on the group account: GROUP_ACCOUNT with balance per year and detail children as candidates', () => {
    const findings = run({
      mappings: [{ role: 'COGS', accountId: 'g5' }],
      balances: [
        { accountId: 'g5', fiscalYear: '2026', rows: 2, debit: '100.50', credit: '0.50' },
        { accountId: 'g5', fiscalYear: '2025', rows: 3, debit: '241000000', credit: '0' },
      ],
    }).filter((f) => f.role === 'COGS');
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.issue).toBe('GROUP_ACCOUNT');
    expect(f.posting).toBe(true);
    expect(f.aleRows).toBe(5);
    expect(f.netAllYears).toBe('241000100.00');
    expect(f.netByYear).toBe('2025=241000000.00;2026=100.00');
    expect(f.candidates).toEqual(['5.1 N5.1', '5.2 N5.2']);
  });

  it('inactive and wrong-root-type accounts are flagged; candidates skip inactive and other root types', () => {
    const f = run({ mappings: [{ role: 'COGS', accountId: 'a53' }, { role: 'AR', accountId: 'rev' }] });
    expect(f.find((x) => x.role === 'COGS')).toMatchObject({ issue: 'INACTIVE_ACCOUNT', candidates: ['5.1 N5.1', '5.2 N5.2'] });
    expect(f.find((x) => x.role === 'AR')).toMatchObject({ issue: 'ROOT_TYPE_MISMATCH', posting: true });
  });

  it('two exclusive roles on one account: one SHARED_ACCOUNT row, posting; a non-exclusive pair is informational', () => {
    const f = run({
      mappings: [
        { role: 'AR', accountId: 'ar' }, { role: 'INVENTORY', accountId: 'ar' },
        { role: 'INVENTORY_VARIANCE', accountId: 'v88' }, { role: 'ROUNDING_ACCOUNT', accountId: 'v88' },
      ],
    }).filter((x) => x.issue === 'SHARED_ACCOUNT');
    expect(f).toHaveLength(2);
    expect(f.find((x) => x.role === 'AR')).toMatchObject({ otherRole: 'INVENTORY', posting: true });
    expect(f.find((x) => x.role === 'INVENTORY_VARIANCE')).toMatchObject({ otherRole: 'ROUNDING_ACCOUNT', posting: false });
  });

  it('an exclusive role sharing with a non-exclusive one (CASH on the AR account) is a posting finding', () => {
    const f = run({
      mappings: [{ role: 'AR', accountId: 'ar' }, { role: 'CASH', accountId: 'ar' }, { role: 'TAX_INPUT', accountId: 'ar2' }, { role: 'INVENTORY', accountId: 'ar2' }],
    }).filter((x) => x.issue === 'SHARED_ACCOUNT');
    expect(f).toHaveLength(2);
    expect(f.every((x) => x.posting)).toBe(true);
  });

  it('missing required and missing posting roles are reported; optional unused roles are not', () => {
    const f = run({ mappings: healthyMappings().filter((m) => !['AR', 'PRODUCTION_CONVERSION', 'BANK_CHARGE'].includes(m.role)) });
    const missing = f.filter((x) => x.issue.startsWith('MISSING'));
    expect(missing.map((x) => `${x.issue}:${x.role}`).sort()).toEqual(['MISSING_POSTING:PRODUCTION_CONVERSION', 'MISSING_REQUIRED:AR']);
    expect(missing.every((x) => x.accountNumber === '')).toBe(true);
  });

  it('a clean mapping set (distinct healthy accounts) has no findings', () => {
    const accounts: AuditAccount[] = ALL_SYSTEM_ROLES.map((role, i) => ({
      id: `x${i}`, accountNumber: `1.${i}`, name: role, rootType: 'ASSET', isGroup: false, isActive: true, parentId: null,
    }));
    const roleRoot = new Map(ALL_SYSTEM_ROLES.map((r, i) => [r, `x${i}`]));
    for (const [i, role] of ALL_SYSTEM_ROLES.entries()) accounts[i].rootType = SYSTEM_ACCOUNT_ROLES[role].expectedRootType;
    const f = buildSystemAccountAudit({
      mappings: ALL_SYSTEM_ROLES.map((role) => ({ role, accountId: roleRoot.get(role)! })),
      accounts, balances: [],
    });
    expect(f).toEqual([]);
  });

  it('ignores unknown roles and balances of unmapped accounts', () => {
    const f = run({
      mappings: [{ role: 'NOT_A_ROLE', accountId: 'g5' }],
      balances: [{ accountId: 'zzz', fiscalYear: '2026', rows: 1, debit: 1, credit: 0 }],
    });
    expect(f.filter((x) => x.issue === 'GROUP_ACCOUNT')).toEqual([]);
  });

  it('CSV fields line up with the header', () => {
    const [f] = run({ mappings: [{ role: 'COGS', accountId: 'g5' }] }).filter((x) => x.role === 'COGS');
    expect(auditCsvFields(f)).toHaveLength(AUDIT_CSV_HEADER.split(',').length);
  });
});
