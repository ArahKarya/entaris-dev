import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { assembleEquity, assembleSection, type BsAccount, type BsNode, type EquityInput } from '../balanceSheet';

const D = (n: number) => new Prisma.Decimal(n);

const acc = (id: string, accountNumber: string, rootType: BsAccount['rootType'], parentId: string | null = null, isGroup = false): BsAccount => ({
  id,
  name: `Akun ${accountNumber}`,
  accountNumber,
  isGroup,
  parentId,
  rootType,
});

// Seed-like equity tree: group 3 with 3.1, 3.2 (retained), 3.4 (current profit), 3.5.
const equityAccounts: BsAccount[] = [
  acc('g3', '3', 'EQUITY', null, true),
  acc('e31', '3.1', 'EQUITY', 'g3'),
  acc('e32', '3.2', 'EQUITY', 'g3'),
  acc('e34', '3.4', 'EQUITY', 'g3'),
  acc('e35', '3.5', 'EQUITY', 'g3'),
];

const base = (over: Partial<EquityInput> = {}): EquityInput => ({
  accounts: equityAccounts,
  own: new Map(),
  plAll: D(0),
  currentProfit: D(0),
  closingOnCurrentProfit: D(0),
  closingInYear: D(0),
  currentProfitAccountId: 'e34',
  retainedEarningsAccountId: 'e32',
  ...over,
});

/** Every node with children equals the sum of its children, at every level. */
function expectHeadersSum(nodes: BsNode[]) {
  for (const n of nodes) {
    if (n.children.length > 0) {
      expect(n.balance).toBeCloseTo(n.children.reduce((s, c) => s + c.balance, 0), 2);
      expectHeadersSum(n.children);
    }
  }
}

const find = (nodes: BsNode[], id: string): BsNode | undefined => {
  for (const n of nodes) {
    if (n.id === id) return n;
    const hit = find(n.children, id);
    if (hit) return hit;
  }
  return undefined;
};

const total = (nodes: BsNode[]) => nodes.reduce((s, n) => s + n.balance, 0);

describe('assembleEquity', () => {
  it('acceptance before the first close: retained 500 (unclosed), current 100, header 600', () => {
    const equity = assembleEquity(base({ plAll: D(600), currentProfit: D(100) }));
    const group = equity[0];
    expect(group.id).toBe('g3');
    expect(group.balance).toBe(600);
    expect(find(equity, 'current-profit')!.balance).toBe(100);
    const retained = find(equity, 'retained-earnings')!;
    expect(retained.balance).toBe(500);
    expect(retained.children.map((c) => [c.detail, c.balance])).toEqual([['unclosedProfit', 500]]);
    expectHeadersSum(equity);
    expect(total(equity)).toBe(600);
  });

  it('acceptance after the close: same split, the closed profit sits in the 3.2 part and nothing is unclosed', () => {
    const own = new Map([['e32', D(500)], ['e34', D(-500)]]);
    const equity = assembleEquity(base({ own, plAll: D(600), currentProfit: D(100), closingOnCurrentProfit: D(-500) }));
    expect(equity[0].balance).toBe(600);
    expect(find(equity, 'current-profit')!.balance).toBe(100);
    const retained = find(equity, 'retained-earnings')!;
    expect(retained.balance).toBe(500);
    expect(retained.children.map((c) => [c.detail, c.balance, c.accountId, c.selectable])).toEqual([
      ['retainedAccount', 500, 'e32', true],
    ]);
    expectHeadersSum(equity);
  });

  it('only the part of earlier profit that no close journal moved is unclosed', () => {
    // Two earlier years made 500 and 200; only the 500 year is closed.
    const own = new Map([['e32', D(500)], ['e34', D(-500)]]);
    const equity = assembleEquity(base({ own, plAll: D(800), currentProfit: D(100), closingOnCurrentProfit: D(-500) }));
    const retained = find(equity, 'retained-earnings')!;
    expect(retained.children.map((c) => [c.detail, c.balance])).toEqual([
      ['retainedAccount', 500],
      ['unclosedProfit', 200],
    ]);
    expect(retained.balance).toBe(700);
  });

  it('on the last day of a closed year leaves that year\'s own close out of the parts (pre-closing view)', () => {
    const own = new Map([['e32', D(500)], ['e34', D(-500)]]);
    const equity = assembleEquity(base({ own, plAll: D(500), currentProfit: D(500), closingOnCurrentProfit: D(-500), closingInYear: D(-500) }));
    expect(find(equity, 'current-profit')!.balance).toBe(500);
    const retained = find(equity, 'retained-earnings')!;
    expect(retained.balance).toBe(0);
    expect(retained.children).toEqual([]);
    expect(equity[0].balance).toBe(500);
  });

  it('keeps the retained-earnings composite when 3.2 and every part are zero', () => {
    const equity = assembleEquity(base());
    const retained = find(equity, 'retained-earnings')!;
    expect(retained).toMatchObject({ kind: 'retainedEarnings', name: 'Laba Ditahan', balance: 0, children: [], accountNumber: '3.2' });
  });

  it('puts current-year profit in the place of 3.4 inside the group, not at the top level', () => {
    const own = new Map([['e31', D(1000)], ['e35', D(7)]]);
    const equity = assembleEquity(base({ own, plAll: D(50), currentProfit: D(50) }));
    expect(equity.map((n) => n.id)).toEqual(['g3']);
    expect(equity[0].children.map((n) => n.id)).toEqual(['e31', 'retained-earnings', 'current-profit', 'e35']);
    const cp = find(equity, 'current-profit')!;
    expect(cp).toMatchObject({ kind: 'currentProfit', name: 'Laba Tahun Berjalan', accountNumber: '3.4', accountId: null, selectable: false });
  });

  it('shows other postings to 3.4 as their own part of retained earnings', () => {
    const own = new Map([['e32', D(500)], ['e34', D(-500 + 30)]]);
    const equity = assembleEquity(base({ own, plAll: D(500), closingOnCurrentProfit: D(-500) }));
    const retained = find(equity, 'retained-earnings')!;
    expect(retained.children.map((c) => [c.detail, c.balance])).toEqual([
      ['retainedAccount', 500],
      ['otherCurrentProfit', 30],
    ]);
    expect(retained.balance).toBe(530);
  });

  it('keeps a child of another root type, flagged, and counts it in the group', () => {
    const accounts = [...equityAccounts, acc('l9', '3.9', 'LIABILITY', 'g3')];
    const equity = assembleEquity(base({ accounts, own: new Map([['l9', D(40)]]) }));
    const odd = find(equity, 'l9')!;
    expect(odd.rootTypeMismatch).toBe(true);
    expect(equity[0].balance).toBe(40);
    expectHeadersSum(equity);
  });

  it('shows postings made directly to a group as a "group direct" row', () => {
    const equity = assembleEquity(base({ own: new Map([['g3', D(25)], ['e31', D(100)]]) }));
    const direct = find(equity, 'g3:direct')!;
    expect(direct).toMatchObject({ kind: 'detail', detail: 'groupDirect', name: 'Saldo Langsung Grup', accountId: 'g3', selectable: true, balance: 25 });
    expect(equity[0].balance).toBe(125);
    expectHeadersSum(equity);
  });

  it('without mappings puts both rows at the top level and does not throw', () => {
    const own = new Map([['e34', D(-500)], ['e32', D(500)]]);
    const equity = assembleEquity(base({ own, plAll: D(600), currentProfit: D(100), currentProfitAccountId: null, retainedEarningsAccountId: null }));
    expect(equity.map((n) => n.id)).toEqual(['g3', 'retained-earnings', 'current-profit']);
    // 3.2 and 3.4 stay plain accounts inside the group.
    expect(find(equity, 'e34')!.balance).toBe(-500);
    expect(find(equity, 'retained-earnings')!.balance).toBe(500);
    expect(total(equity)).toBe(600);
  });

  it('treats a mapping outside the equity tree as missing for placement', () => {
    const equity = assembleEquity(base({ plAll: D(10), currentProfit: D(10), currentProfitAccountId: 'nowhere' }));
    expect(equity.map((n) => n.id)).toEqual(['g3', 'current-profit']);
  });

  it('total equity equals all equity postings plus all-time profit (the old total)', () => {
    const own = new Map([['e31', D(1000)], ['e32', D(321.45)], ['e34', D(-200.1)], ['e35', D(-0.35)], ['g3', D(3)]]);
    const equity = assembleEquity(base({ own, plAll: D(987.65), currentProfit: D(-12.3), closingOnCurrentProfit: D(-200.1), closingInYear: D(-50) }));
    expect(total(equity)).toBeCloseTo(1000 + 321.45 - 200.1 - 0.35 + 3 + 987.65, 2);
    expectHeadersSum(equity);
    // Details of retained earnings add up to the composite.
    const retained = find(equity, 'retained-earnings')!;
    expect(retained.balance).toBeCloseTo(retained.children.reduce((s, c) => s + c.balance, 0), 2);
  });

  it('every synthetic row carries a name and a kind', () => {
    const equity = assembleEquity(base({ own: new Map([['e32', D(1)], ['e34', D(-1)], ['g3', D(2)]]), plAll: D(5), currentProfit: D(3), closingOnCurrentProfit: D(-2) }));
    const walk = (nodes: BsNode[]): BsNode[] => nodes.flatMap((n) => [n, ...walk(n.children)]);
    for (const n of walk(equity)) {
      expect(n.name).toBeTruthy();
      expect(n.kind).toBeTruthy();
    }
  });
});

describe('assembleSection', () => {
  const accounts: BsAccount[] = [
    acc('g1', '1', 'ASSET', null, true),
    acc('g11', '1.1', 'ASSET', 'g1', true),
    acc('a111', '1.1.1', 'ASSET', 'g11'),
    acc('a112', '1.1.2', 'ASSET', 'g11'),
    acc('a12', '1.2', 'ASSET', 'g1'),
    acc('l2', '2', 'LIABILITY', null, true),
    acc('l21', '2.1', 'LIABILITY', 'l2'),
  ];

  it('drops zero accounts, keeps groups, and headers equal their rows', () => {
    const own = new Map([['a111', D(100)], ['a112', D(0)], ['a12', D(-30)]]);
    const assets = assembleSection(accounts, own, 'ASSET');
    expect(assets.map((n) => n.id)).toEqual(['g1']);
    expect(find(assets, 'a112')).toBeUndefined();
    expect(assets[0].balance).toBe(70);
    expect(find(assets, 'g11')!.balance).toBe(100);
    expect(find(assets, 'a111')).toMatchObject({ kind: 'account', accountId: 'a111', selectable: true });
    expect(find(assets, 'g1')).toMatchObject({ selectable: false });
    expectHeadersSum(assets);
  });

  it('builds only the requested root type at the top level', () => {
    const liabilities = assembleSection(accounts, new Map([['l21', D(9)]]), 'LIABILITY');
    expect(liabilities.map((n) => n.id)).toEqual(['l2']);
    expect(liabilities[0].balance).toBe(9);
  });
});
