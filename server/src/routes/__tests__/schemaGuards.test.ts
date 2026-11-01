import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ queryRaw: vi.fn() }));
vi.mock('../../lib/prisma', () => ({ prisma: { $queryRaw: db.queryRaw } }));

import { REQUIRED_TRIGGERS, checkRequiredTriggers } from '../health/schemaGuards';

const rows = (enabled: Record<string, string>) =>
  REQUIRED_TRIGGERS.filter((t) => enabled[t.name] !== undefined).map((t) => ({ table: t.table, name: t.name, enabled: enabled[t.name] }));

beforeEach(() => db.queryRaw.mockReset());

describe('checkRequiredTriggers', () => {
  it('is ok when both audit triggers exist and fire', async () => {
    db.queryRaw.mockResolvedValue(rows({ audit_trail_append_only_row: 'O', audit_trail_append_only_truncate: 'O' }));
    const r = await checkRequiredTriggers();
    expect(r).toMatchObject({ status: 'ok', count: 0, fixable: false });
  });

  it('is an error when a trigger is missing', async () => {
    db.queryRaw.mockResolvedValue(rows({ audit_trail_append_only_row: 'O' }));
    const r = await checkRequiredTriggers();
    expect(r.status).toBe('error');
    expect(r.count).toBe(1);
    expect(r.details).toEqual([{ table: 'audit_trail', name: 'audit_trail_append_only_truncate', problem: 'missing' }]);
    // A restart helps only after restoring an older dump; otherwise the migration SQL is re-run.
    expect(r.message).toMatch(/^1 trigger database hilang;.*mulai ulang aplikasi.*MIGRATION\.md/);
    expect(r.message).not.toContain('ENABLE TRIGGER');
  });

  it('is an error when a trigger is disabled', async () => {
    db.queryRaw.mockResolvedValue(rows({ audit_trail_append_only_row: 'D', audit_trail_append_only_truncate: 'O' }));
    const r = await checkRequiredTriggers();
    expect(r.status).toBe('error');
    expect(r.details).toEqual([{ table: 'audit_trail', name: 'audit_trail_append_only_row', problem: 'disabled' }]);
    // migrate deploy skips an applied migration, so a restart would not re-enable it.
    expect(r.message).toContain('ENABLE TRIGGER <nama> untuk: audit_trail_append_only_row.');
    expect(r.message).not.toContain('mulai ulang');
  });

  it('points to re-running the migration SQL when triggers are both missing and disabled', async () => {
    db.queryRaw.mockResolvedValue(rows({ audit_trail_append_only_row: 'D' }));
    const r = await checkRequiredTriggers();
    expect(r.count).toBe(2);
    expect(r.message).toMatch(/^1 trigger database hilang dan 1 nonaktif;.*MIGRATION\.md/);
  });
});
