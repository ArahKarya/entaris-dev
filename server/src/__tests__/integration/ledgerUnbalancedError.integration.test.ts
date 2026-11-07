/**
 * Integration test: the error a deferred ledger balance trigger raises at COMMIT reaches
 * handleRouteError in a shape it recognises (E2-R3, prepared before the triggers ship).
 *
 * The real triggers arrive later, so this builds a stand-in inside the transaction: a temporary
 * table with a deferred constraint trigger that raises check_violation (SQLSTATE 23514) with the
 * same wording ("unbalanced"). It is created and dropped within the transaction, so nothing is left
 * behind. The point is the error shape of the pg driver adapter, not the trigger itself.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { handleRouteError, isLedgerUnbalanced } from '../../utils/errors';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

let prisma: PrismaClient;
let pool: Pool;

beforeAll(async () => {
  if (!hasDb) return;
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  prisma = new PrismaClient({ adapter: new PrismaPg(pool as any) });
});

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
  if (pool) await pool.end();
});

/** Fails at COMMIT: a temp table whose deferred trigger always raises a 23514 error with `message`. */
function commitWithRejectingTrigger(message: string) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`CREATE TEMP TABLE it_ale_stub (id int) ON COMMIT DROP`);
    await tx.$executeRawUnsafe(`
      CREATE FUNCTION pg_temp.it_ale_reject() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        RAISE EXCEPTION '${message}' USING ERRCODE = 'check_violation';
      END
      $fn$`);
    await tx.$executeRawUnsafe(`
      CREATE CONSTRAINT TRIGGER it_ale_reject AFTER INSERT ON it_ale_stub
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pg_temp.it_ale_reject()`);
    await tx.$executeRawUnsafe(`INSERT INTO it_ale_stub (id) VALUES (1)`);
  });
}

function mockRes() {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res as unknown as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
}

d('ledger trigger error shape (driver adapter)', () => {
  it('maps a 23514 "unbalanced" failure at COMMIT to 409 LEDGER_UNBALANCED', async () => {
    const error = await commitWithRejectingTrigger('ALE group X is unbalanced: debit 100 credit 50').then(
      () => null,
      (e: unknown) => e,
    );
    expect(error, 'the deferred trigger must reject the commit').not.toBeNull();
    expect(isLedgerUnbalanced(error)).toBe(true);

    const res = mockRes();
    handleRouteError(res, error, 'ctx', 'fallback');
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ error: 'Jurnal tidak seimbang di buku besar; transaksi dibatalkan.', code: 'LEDGER_UNBALANCED' });
  }, 30000);

  it('does not map a 23514 failure with another message', async () => {
    const error = await commitWithRejectingTrigger('some other check failed').then(() => null, (e: unknown) => e);
    expect(error).not.toBeNull();
    expect(isLedgerUnbalanced(error)).toBe(false);
  }, 30000);
});
