// PUT /api/system-accounts validation without a database (E2-R8, PR-4.11). A new (role, account)
// pair must be an active detail account of the role's root type, and two roles of different
// meaning may not share an account. Pairs already stored are not re-checked, so re-sending a legacy
// mapping (COGS on group account 5) next to a real change still succeeds.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callRoute } from '../../__tests__/helpers/routeHarness';

const db = vi.hoisted(() => ({
  accounts: [] as any[],
  stored: [] as Array<{ role: string; accountId: string }>,
  writes: { deleteMany: vi.fn(), createMany: vi.fn() },
  lock: vi.fn(),
}));
vi.mock('../../lib/prisma', () => {
  const prisma = {
    account: { findMany: async ({ where }: any) => db.accounts.filter((a) => where.id.in.includes(a.id)) },
    systemAccountMapping: {
      findMany: async (args: any) => (args?.include ? [] : db.stored),
      deleteMany: (...a: unknown[]) => db.writes.deleteMany(...a),
      createMany: (...a: unknown[]) => db.writes.createMany(...a),
    },
    $executeRaw: (...a: unknown[]) => db.lock(...a),
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  };
  return { prisma };
});

import router from '../systemAccounts';
import { systemAccounts } from '../../services/systemAccounts';

const acc = (id: string, number: string, over: Record<string, unknown> = {}) => ({
  id, accountNumber: number, name: `Akun ${number}`, rootType: 'ASSET', isGroup: false, isActive: true, ...over,
});
const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function put(body: unknown, role = 'Admin') {
  return callRoute(router, 'put', '/', { body, userId: 'u-1', role });
}

beforeEach(() => {
  db.accounts = [
    acc(UUID(1), '1.2.1'),
    acc(UUID(2), '1.2.2'),
    acc(UUID(3), '1.2', { isGroup: true }),
    acc(UUID(4), '5', { rootType: 'EXPENSE', isGroup: true }),
    acc(UUID(5), '4.1', { rootType: 'REVENUE' }),
    acc(UUID(6), '1.9.9', { isActive: false }),
    acc(UUID(7), '5.1', { rootType: 'EXPENSE' }),
  ];
  db.stored = [];
  db.writes.deleteMany.mockReset();
  db.writes.createMany.mockReset();
  db.lock.mockReset();
  vi.spyOn(systemAccounts, 'invalidateCache').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('PUT /system-accounts validation', () => {
  it('non-Admin: 403, nothing read or written', async () => {
    const r = await put({ mappings: [{ role: 'AR', accountId: UUID(1) }] }, 'Accountant');
    expect(r.status).toBe(403);
    expect(db.writes.createMany).not.toHaveBeenCalled();
  });

  it('group account: 400 ACCOUNT_GROUP, nothing written', async () => {
    const r = await put({ mappings: [{ role: 'AR', accountId: UUID(3) }] });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('ACCOUNT_GROUP');
    expect(r.body.error).toBe('Peran Piutang Usaha: 1.2 Akun 1.2 adalah akun grup; pilih akun detail.');
    expect(db.writes.createMany).not.toHaveBeenCalled();
  });

  it('wrong root type: 400 ACCOUNT_ROOT_TYPE', async () => {
    const r = await put({ mappings: [{ role: 'AR', accountId: UUID(5) }] });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('ACCOUNT_ROOT_TYPE');
    expect(r.body.error).toContain('bertipe REVENUE, seharusnya ASSET');
  });

  it('inactive account: 400 ACCOUNT_INACTIVE', async () => {
    const r = await put({ mappings: [{ role: 'AR', accountId: UUID(6) }] });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('ACCOUNT_INACTIVE');
  });

  it('unknown account id: 400 without a code', async () => {
    const r = await put({ mappings: [{ role: 'AR', accountId: UUID(99) }] });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('tidak ditemukan');
  });

  it('valid new mapping: saved', async () => {
    const r = await put({ mappings: [{ role: 'AR', accountId: UUID(2) }] });
    expect(r.status).toBe(200);
    expect(db.writes.createMany).toHaveBeenCalledOnce();
  });

  it('re-sending an unchanged legacy COGS -> group 5 beside a changed AR: 200', async () => {
    db.stored = [{ role: 'COGS', accountId: UUID(4) }, { role: 'AR', accountId: UUID(1) }];
    const r = await put({
      mappings: [{ role: 'COGS', accountId: UUID(4) }, { role: 'AR', accountId: UUID(2) }],
    });
    expect(r.status).toBe(200);
    expect(db.writes.createMany.mock.calls[0][0].data).toHaveLength(2);
  });

  it('changing COGS to the group account is refused even though other roles are fine', async () => {
    db.stored = [{ role: 'COGS', accountId: UUID(7) }];
    const r = await put({ mappings: [{ role: 'COGS', accountId: UUID(4) }] });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('ACCOUNT_GROUP');
  });

  it('two exclusive roles on one account in the same request: 400 ACCOUNT_ROLE_CONFLICT', async () => {
    const r = await put({
      mappings: [{ role: 'AR', accountId: UUID(1) }, { role: 'INVENTORY', accountId: UUID(1) }],
    });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('ACCOUNT_ROLE_CONFLICT');
    expect(r.body.error).toContain('tidak boleh memakai akun yang sama (1.2.1 Akun 1.2.1)');
  });

  it('new role onto an account another exclusive role already holds: 400', async () => {
    db.stored = [{ role: 'AR', accountId: UUID(1) }];
    const r = await put({ mappings: [{ role: 'INVENTORY', accountId: UUID(1) }] });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('ACCOUNT_ROLE_CONFLICT');
  });

  it('the other role moving away in the same request lifts the conflict', async () => {
    db.stored = [{ role: 'AR', accountId: UUID(1) }];
    const r = await put({
      mappings: [{ role: 'AR', accountId: UUID(2) }, { role: 'INVENTORY', accountId: UUID(1) }],
    });
    expect(r.status).toBe(200);
  });

  it('a non-exclusive role may share an account with another non-exclusive one', async () => {
    db.stored = [{ role: 'INVENTORY_VARIANCE', accountId: UUID(7) }];
    const r = await put({ mappings: [{ role: 'ROUNDING_ACCOUNT', accountId: UUID(7) }] });
    expect(r.status).toBe(200);
  });

  it.each([
    ['CASH', 'AR'],
    ['PREPAID_EXPENSE', 'AR'],
    ['TAX_INPUT', 'INVENTORY'],
    ['EMPLOYEE_ADVANCE', 'VENDOR_DEPOSIT'],
  ])('non-exclusive %s onto the account held by exclusive %s: 400 ACCOUNT_ROLE_CONFLICT', async (role, holder) => {
    db.stored = [{ role: holder, accountId: UUID(1) }];
    const r = await put({ mappings: [{ role, accountId: UUID(1) }] });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('ACCOUNT_ROLE_CONFLICT');
    expect(db.writes.createMany).not.toHaveBeenCalled();
  });

  it('exclusive AR onto an account a CASH role holds: 400 ACCOUNT_ROLE_CONFLICT', async () => {
    db.stored = [{ role: 'CASH', accountId: UUID(1) }];
    const r = await put({ mappings: [{ role: 'AR', accountId: UUID(1) }] });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('ACCOUNT_ROLE_CONFLICT');
  });

  it('the checks run after taking the remap advisory lock', async () => {
    await put({ mappings: [{ role: 'AR', accountId: UUID(2) }] });
    expect(db.lock).toHaveBeenCalledOnce();
  });

  it('an old shared mapping does not block an unrelated change', async () => {
    db.stored = [{ role: 'AR', accountId: UUID(1) }, { role: 'INVENTORY', accountId: UUID(1) }];
    const r = await put({
      mappings: [{ role: 'AR', accountId: UUID(1) }, { role: 'INVENTORY', accountId: UUID(1) }, { role: 'PREPAID_EXPENSE', accountId: UUID(2) }],
    });
    expect(r.status).toBe(200);
  });
});
