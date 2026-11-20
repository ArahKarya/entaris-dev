// System account remap without a database (E2-R8, PR-4.12): which saves are moves, how a residue
// becomes reclass journals, when a balance refuses the save, and that only the remap reclass uses
// the group/inactive and per-line account rule escapes (plan §2.3).
import { describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Prisma } from '@prisma/client';

vi.mock('../../lib/prisma', () => ({ prisma: {} }));

import {
  ACCOUNT_HAS_BALANCE,
  AccountHasBalanceError,
  REMAP_SOURCE_RULE,
  accountResidue,
  assertTransferAllowed,
  findFormerResidues,
  isReclassRole,
  planRemap,
  reclassJournals,
  remapCandidates,
  sweepFormerAccounts,
  type BalancePlan,
} from '../systemAccountRemap';
import { postableAccountProblem } from '../ledger/accountGuard';
import { sourceKeys } from '../ledger/journalSource';
import { validateJournalLines } from '../../utils/journalLineRules';

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const ref = (id: string, accountNumber: string) => ({ id, accountNumber, name: `Akun ${accountNumber}` });

describe('isReclassRole', () => {
  it('is true for single-account balance-sheet roles only', () => {
    expect(isReclassRole('AR')).toBe(true);
    expect(isReclassRole('CUSTOMER_DEPOSIT')).toBe(true);
    expect(isReclassRole('RETAINED_EARNINGS')).toBe(true);
    expect(isReclassRole('COGS')).toBe(false);
    expect(isReclassRole('SALES_RETURN')).toBe(false);
    expect(isReclassRole('CASH')).toBe(false); // multi-account
    expect(isReclassRole('FIXED_ASSET')).toBe(false);
  });
});

describe('remapCandidates', () => {
  it('lists single-account roles whose one stored account is replaced', () => {
    const stored = [{ role: 'AR', accountId: 'a' }, { role: 'COGS', accountId: 'g5' }, { role: 'AP', accountId: 'p' }];
    const requested = [{ role: 'AR', accountId: 'b' }, { role: 'COGS', accountId: 'c51' }, { role: 'AP', accountId: 'p' }];
    expect(remapCandidates(requested, stored)).toEqual([
      { role: 'AR', fromAccountId: 'a', toAccountId: 'b' },
      { role: 'COGS', fromAccountId: 'g5', toAccountId: 'c51' },
    ]);
  });

  it('skips new roles, multi-account roles and unchanged re-sends', () => {
    const stored = [{ role: 'CASH', accountId: 'k1' }, { role: 'AR', accountId: 'a' }];
    const requested = [{ role: 'CASH', accountId: 'k2' }, { role: 'AR', accountId: 'a' }, { role: 'AP', accountId: 'p' }];
    expect(remapCandidates(requested, stored)).toEqual([]);
  });
});

/** A tx whose $queryRaw answers the residue query and whose account lookup knows `accounts`. */
function residueTx(rows: unknown[], accounts = [ref('a', '1.2.1'), ref('b', '1.2.2')]) {
  const queryRaw = vi.fn(async () => rows);
  const tx = {
    $queryRaw: queryRaw,
    account: { findMany: async ({ where }: any) => accounts.filter((a) => where.id.in.includes(a.id)) },
  };
  return { tx: tx as any, queryRaw };
}

describe('accountResidue / planRemap', () => {
  it('a party role keeps one line per party (party null included)', async () => {
    const { tx } = residueTx([{ party_id: null, amount: '-10.00' }, { party_id: 'p1', amount: '300000000.00' }]);
    const lines = await accountResidue(tx, 'AR', 'a');
    expect(lines.map((l) => [l.partyId, l.amount.toFixed(2)])).toEqual([[null, '-10.00'], ['p1', '300000000.00']]);
  });

  it('another balance-sheet role is one line without a party; zero is nothing', async () => {
    expect((await accountResidue(residueTx([{ amount: '42.50' }]).tx, 'INVENTORY', 'a')).map((l) => [l.partyId, l.amount.toFixed(2)]))
      .toEqual([[null, '42.50']]);
    expect(await accountResidue(residueTx([{ amount: '0.00' }]).tx, 'INVENTORY', 'a')).toEqual([]);
    expect(await accountResidue(residueTx([{ amount: null }]).tx, 'INVENTORY', 'a')).toEqual([]);
  });

  it('a profit and loss role is planned without reading the ledger', async () => {
    const { tx, queryRaw } = residueTx([{ party_id: null, amount: '5.00' }]);
    const plan = await planRemap(tx, { role: 'COGS', fromAccountId: 'a', toAccountId: 'b' });
    expect(plan.kind).toBe('pnl');
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('a balance-sheet plan sums the residue', async () => {
    const { tx } = residueTx([{ party_id: 'p1', amount: '300.00' }, { party_id: 'p2', amount: '200.00' }]);
    const plan = await planRemap(tx, { role: 'AR', fromAccountId: 'a', toAccountId: 'b' });
    expect(plan).toMatchObject({ kind: 'balance', from: { accountNumber: '1.2.1' }, to: { accountNumber: '1.2.2' } });
    expect(plan.kind === 'balance' && plan.net.toFixed(2)).toBe('500.00');
  });
});

const plan = (lines: Array<[string | null, string]>): BalancePlan => ({
  kind: 'balance', role: 'AR', from: ref('a', '1.2.1'), to: ref('b', '1.2.2'),
  lines: lines.map(([partyId, amount]) => ({ partyId, amount: D(amount) })),
  net: lines.reduce((s, [, a]) => s.plus(a), D(0)),
});

describe('reclassJournals', () => {
  it('moves each party line to the new account, opposite side on the old one, balanced', () => {
    const [lines, ...rest] = reclassJournals(plan([['p1', '300.00'], ['p2', '-50.25']]));
    expect(rest).toEqual([]);
    expect(lines.map((l) => [l.accountId, l.partyId, String(l.debit), String(l.credit)])).toEqual([
      ['a', 'p1', '0', '300'],
      ['b', 'p1', '300', '0'],
      ['a', 'p2', '50.25', '0'],
      ['b', 'p2', '0', '50.25'],
    ]);
    expect(validateJournalLines(lines).ok).toBe(true);
  });

  it('splits a long reclass into balanced journals of at most maxLines lines', () => {
    const many = plan(Array.from({ length: 7 }, (_, i) => [`p${i}`, `${i + 1}.00`] as [string, string]));
    const journals = reclassJournals(many, 4);
    expect(journals.map((j) => j.length)).toEqual([4, 4, 4, 2]);
    for (const j of journals) expect(validateJournalLines(j).ok).toBe(true);
  });
});

describe('assertTransferAllowed', () => {
  const pnl = { kind: 'pnl' as const, role: 'COGS' as const, from: ref('g', '5'), to: ref('c', '5.1') };

  it('refuses a balance without transferBalance, listing the balances', () => {
    let err: unknown;
    try {
      assertTransferAllowed([pnl, plan([['p1', '1.00']]), plan([])], false);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AccountHasBalanceError);
    expect((err as AccountHasBalanceError).code).toBe(ACCOUNT_HAS_BALANCE);
    expect((err as AccountHasBalanceError).balances).toHaveLength(1);
  });

  it('passes with transferBalance, with nothing to move, and for profit and loss roles', () => {
    expect(() => assertTransferAllowed([plan([['p1', '1.00']])], true)).not.toThrow();
    expect(() => assertTransferAllowed([pnl, plan([])], false)).not.toThrow();
  });
});

describe('REMAP_SOURCE_RULE', () => {
  const acc = { id: 'g', accountNumber: '1.2', name: 'Piutang', rootType: 'ASSET' as const, isGroup: true, isActive: false };
  it('accepts a group or inactive old account; other rules still refuse it', () => {
    expect(postableAccountProblem(acc, REMAP_SOURCE_RULE, ['AR'])).toBeNull();
    expect(postableAccountProblem(acc, { label: 'Akun posting', allowControl: true }, null)?.code).toBe('ACCOUNT_GROUP');
    expect(postableAccountProblem({ ...acc, isGroup: false }, { label: 'Akun posting', allowControl: true }, null)?.code).toBe('ACCOUNT_INACTIVE');
  });
});

interface MoveRow { role: string; fromAccountId: string; toAccountId: string | null; movedAt: Date }

/**
 * journalEntry.findMany answers remap journals, systemAccountRoleMove.findMany the move history;
 * mappings, item accounts and the residue query (accountId, then the hand-made filter) are configurable.
 */
function formerTx(
  keys: string[],
  mappings: Array<{ role: string; accountId: string }>,
  residue: (accountId: string, filter?: Prisma.Sql) => unknown[],
  opts: { moves?: MoveRow[]; itemAccounts?: string[] } = {},
) {
  return {
    journalEntry: { findMany: async () => keys.map((sourceKey, i) => ({ sourceKey, createdAt: new Date(Date.UTC(2162, 0, 10 + i)) })) },
    systemAccountRoleMove: { findMany: async () => opts.moves ?? [] },
    inventoryItem: { count: async ({ where }: any) => (opts.itemAccounts ?? []).filter((a) => a === where.accountId).length },
    systemAccountMapping: { findMany: async ({ where }: any = {}) => mappings.filter((m) => !where?.role || m.role === where.role) },
    account: { findMany: async ({ where }: any) => where.id.in.map((id: string) => ref(id, id)) },
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => residue(String(values[0]), values[1] as Prisma.Sql),
    $executeRaw: vi.fn(async () => 0),
  } as any;
}

describe('findFormerResidues / sweepFormerAccounts', () => {
  const keys = [
    sourceKeys.remap('AR', 'old', 'cur', '2162-01-10'),
    sourceKeys.remap('AR', 'old', 'cur', '2162-02-10'), // same former account twice: reported once
    sourceKeys.remap('COGS', 'g5', 'c51', '2162-01-10'), // profit and loss: never former here
    sourceKeys.remap('INVENTORY', 'inv-old', 'inv', '2162-01-10'),
  ];
  const residue = (accountId: string) => (accountId === 'old' ? [{ party_id: 'p1', amount: '-3.00' }] : accountId === 'inv-old' ? [{ amount: '0' }] : []);

  it('reports former balance-sheet accounts that still hold something, not the current account', async () => {
    const tx = formerTx(keys, [{ role: 'AR', accountId: 'cur' }, { role: 'INVENTORY', accountId: 'inv' }], residue);
    expect(await findFormerResidues(tx)).toEqual([
      expect.objectContaining({ role: 'AR', fromAccountId: 'old', toAccountId: 'cur', amount: '-3.00', partyCount: 1, sweepable: true }),
    ]);
  });

  it('an account the role is mapped to again is not former', async () => {
    const tx = formerTx(keys, [{ role: 'AR', accountId: 'old' }], residue);
    expect(await findFormerResidues(tx, 'AR')).toEqual([]);
  });

  it('a profit and loss role cannot be swept', async () => {
    const tx = formerTx(keys, [{ role: 'COGS', accountId: 'c51' }], residue);
    await expect(sweepFormerAccounts(tx, 'COGS', { actorId: 'u', reason: 'sisa' })).rejects.toMatchObject({ code: 'SWEEP_ROLE_INVALID' });
  });

  it('an unmapped role cannot be swept', async () => {
    const tx = formerTx(keys, [], residue);
    await expect(sweepFormerAccounts(tx, 'AR', { actorId: 'u', reason: 'sisa' })).rejects.toMatchObject({ code: 'ACCOUNT_MAPPING_MISSING' });
  });

  it('nothing left: no journal', async () => {
    const tx = formerTx(keys, [{ role: 'INVENTORY', accountId: 'inv' }], residue);
    expect(await sweepFormerAccounts(tx, 'INVENTORY', { actorId: 'u', reason: 'sisa' })).toEqual([]);
    expect(tx.$executeRaw).toHaveBeenCalledOnce(); // the remap advisory lock
  });

  it('a move with nothing reclassed (history row only) still makes a former account', async () => {
    const moves = [{ role: 'AR', fromAccountId: 'old', toAccountId: 'cur', movedAt: new Date('2162-03-01T02:00:00Z') }];
    const tx = formerTx([], [{ role: 'AR', accountId: 'cur' }], residue, { moves });
    expect(await findFormerResidues(tx)).toEqual([
      expect.objectContaining({ role: 'AR', fromAccountId: 'old', toAccountId: 'cur', amount: '-3.00', sweepable: true }),
    ]);
  });

  it('a cleared role (no account now) is reported but not sweepable', async () => {
    const moves = [{ role: 'EMPLOYEE_ADVANCE', fromAccountId: 'old', toAccountId: null, movedAt: new Date('2162-03-01') }];
    const tx = formerTx([], [], residue, { moves });
    expect(await findFormerResidues(tx)).toEqual([
      expect.objectContaining({ role: 'EMPLOYEE_ADVANCE', fromAccountId: 'old', sweepable: false }),
    ]);
  });

  it('a former account another role maps now is skipped, in the report and the sweep', async () => {
    const moves = [{ role: 'EMPLOYEE_ADVANCE', fromAccountId: 'old', toAccountId: 'adv', movedAt: new Date('2162-03-01') }];
    const tx = formerTx([], [{ role: 'EMPLOYEE_ADVANCE', accountId: 'adv' }, { role: 'PROJECT_GUARANTEE', accountId: 'old' }], residue, { moves });
    expect(await findFormerResidues(tx)).toEqual([]);
    expect(await sweepFormerAccounts(tx, 'EMPLOYEE_ADVANCE', { actorId: 'u', reason: 'sisa' })).toEqual([]);
  });

  it('a former inventory account an item still uses is skipped', async () => {
    const moves = [{ role: 'INVENTORY', fromAccountId: 'old', toAccountId: 'inv', movedAt: new Date('2162-03-01') }];
    const tx = formerTx([], [{ role: 'INVENTORY', accountId: 'inv' }], residue, { moves, itemAccounts: ['old'] });
    expect(await findFormerResidues(tx)).toEqual([]);
  });

  it('the residue of a former account leaves out hand-made journals after the last history move, not after a sweep', async () => {
    const movedAt = new Date('2162-03-01T02:00:00Z');
    const seen: Prisma.Sql[] = [];
    const moves = [{ role: 'AR', fromAccountId: 'old', toAccountId: 'cur', movedAt }];
    // The sweep journal (createdAt 2162-01-10 in formerTx, any time) does not replace the move time.
    const tx = formerTx([sourceKeys.remap('AR', 'old', 'cur', '2162-04-01')], [{ role: 'AR', accountId: 'cur' }], (id, filter) => {
      if (filter) seen.push(filter);
      return residue(id);
    }, { moves });
    await findFormerResidues(tx);
    expect(seen).toHaveLength(1);
    expect(seen[0].sql).toContain('ale.created_at >');
    expect(seen[0].values).toEqual([movedAt, 'MANUAL', 'IMPORT', 'RECURRING', 'CASH_BOOK']);
  });
});

/** Production .ts files under src (tests excluded), relative to src. */
const SRC = join(__dirname, '../..');
function sourceFiles(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' || e.name === 'node_modules' ? [] : sourceFiles(full);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [relative(SRC, full).split('\\').join('/')] : [];
  });
}

describe('architecture: the remap escapes stay in the remap (plan §2.3)', () => {
  const users = (needle: RegExp) => sourceFiles().filter((f) => needle.test(readFileSync(join(SRC, f), 'utf8'))).sort();

  it('only accountGuard (definition) and systemAccountRemap use allowGroupOrInactive', () => {
    expect(users(/allowGroupOrInactive/)).toEqual(['services/ledger/accountGuard.ts', 'services/systemAccountRemap.ts']);
  });

  it('only accountGuard, postJournal (definitions), systemAccountRemap, the opening balance service and the manual stock movement pass lineRules', () => {
    expect(users(/\blineRules\b/)).toEqual([
      'services/inventory/manualMovement.ts',
      'services/ledger/accountGuard.ts',
      'services/ledger/openingBalance.ts',
      'services/ledger/postJournal.ts',
      'services/systemAccountRemap.ts',
    ]);
  });
});
