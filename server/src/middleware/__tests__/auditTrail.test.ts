import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  create: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../../lib/prisma', () => ({ prisma: { auditLog: { create: m.create } } }));
vi.mock('../../lib/logger', () => ({ logger: { warn: m.warn, error: m.error, info: vi.fn() } }));
vi.mock('../auditSnapshot', () => ({ captureBeforeSnapshot: vi.fn().mockResolvedValue(null) }));

import { auditTrailMiddleware, buildAuditData, resolveRequestId } from '../auditTrail';

/** A response that records what reaches the wire (originalJson) and when. */
function fakeRes() {
  const sent: Array<{ status: number; body: unknown }> = [];
  const headers: Record<string, string> = {};
  const res: any = {
    statusCode: 200,
    headersSent: false,
    locals: {},
    setHeader(name: string, value: string) { headers[name] = value; },
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) {
      sent.push({ status: this.statusCode, body });
      this.headersSent = true;
      return this;
    },
  };
  return { res, sent, headers };
}

function fakeReq(over: Record<string, unknown> = {}) {
  return {
    user: { userId: 'u1', role: 'Accountant' },
    method: 'POST',
    originalUrl: '/api/parties',
    ip: '127.0.0.1',
    headers: { 'user-agent': 'vitest' },
    ...over,
  } as any;
}

async function mount(req: any, res: any) {
  await auditTrailMiddleware(req, res, () => undefined);
}

/** Lets pending promise callbacks (the audit write, then the send) run. */
const flush = () => new Promise((r) => setImmediate(r));

function deferred() {
  let resolve!: (v?: unknown) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.create.mockResolvedValue({});
});

describe('resolveRequestId', () => {
  it('keeps a well-formed x-request-id', () => {
    expect(resolveRequestId('abc-123_X.y')).toBe('abc-123_X.y');
    expect(resolveRequestId('a'.repeat(64))).toBe('a'.repeat(64));
  });

  it('replaces a missing, malformed or oversized header with a UUID', () => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    for (const bad of [undefined, '', 'has space', 'semi;colon', 'a'.repeat(65), 'line\nbreak', ['x', 'y']]) {
      expect(resolveRequestId(bad)).toMatch(uuid);
    }
  });
});

describe('auditTrailMiddleware', () => {
  it('sends the request id on every response and in res.locals', async () => {
    const { res, headers } = fakeRes();
    await mount(fakeReq({ method: 'GET', headers: { 'x-request-id': 'req-77' } }), res);
    expect(headers['X-Request-Id']).toBe('req-77');
    expect(res.locals.requestId).toBe('req-77');
  });

  it('does not write an audit row for a 400 response', async () => {
    const { res, sent } = fakeRes();
    await mount(fakeReq(), res);
    res.status(400).json({ error: 'nope' });
    await flush();
    expect(m.create).not.toHaveBeenCalled();
    expect(sent).toEqual([{ status: 400, body: { error: 'nope' } }]);
  });

  it('holds a 201 response until the audit row is written', async () => {
    const write = deferred();
    m.create.mockReturnValueOnce(write.promise);
    const { res, sent } = fakeRes();
    await mount(fakeReq(), res);

    res.status(201).json({ id: 'p1' });
    await flush();
    expect(m.create).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([]);

    write.resolve({});
    await flush();
    expect(sent).toEqual([{ status: 201, body: { id: 'p1' } }]);
  });

  it('still sends the 201 when the audit write fails, and logs it with the same request id', async () => {
    m.create.mockRejectedValueOnce(new Error('connection lost'));
    const { res, sent, headers } = fakeRes();
    await mount(fakeReq({ headers: { 'x-request-id': 'req-fail-1' } }), res);

    res.status(201).json({ id: 'p1' });
    await flush();

    expect(sent).toEqual([{ status: 201, body: { id: 'p1' } }]);
    expect(headers['X-Request-Id']).toBe('req-fail-1');
    expect(m.error).toHaveBeenCalledTimes(1);
    expect(m.error.mock.calls[0][0]).toMatchObject({ requestId: 'req-fail-1' });
  });

  it('ignores status(500) and a second json() while the audited response is held', async () => {
    const write = deferred();
    m.create.mockReturnValueOnce(write.promise);
    const { res, sent } = fakeRes();
    await mount(fakeReq(), res);

    res.status(201).json({ id: 'p1' });
    res.status(500).json({ error: 'late failure' });
    write.resolve({});
    await flush();

    expect(m.create).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([{ status: 201, body: { id: 'p1' } }]);
    expect(m.warn).toHaveBeenCalled();
  });

  it('skips the send when something else already answered', async () => {
    const write = deferred();
    m.create.mockReturnValueOnce(write.promise);
    const { res, sent } = fakeRes();
    await mount(fakeReq(), res);

    res.json({ id: 'p1' });
    res.headersSent = true;
    write.resolve({});
    await flush();
    expect(sent).toEqual([]);
  });

  it('marks agent (mcp) and demo mutations', async () => {
    for (const [user, expected] of [
      [{ userId: 'u1', role: 'Accountant', via: 'mcp', mcpToken: 't', mcpChannel: 'web', mcpTool: 'party_create', mcpApprovalId: 'a1' },
        { via: 'mcp', viaMeta: { token: 't', channel: 'web', tool: 'party_create', approvalId: 'a1' } }],
      [{ userId: 'u1', role: 'Admin', via: 'demo' }, { via: 'demo' }],
    ] as const) {
      m.create.mockClear();
      const { res } = fakeRes();
      await mount(fakeReq({ user }), res);
      res.json({ id: 'p1' });
      await flush();
      expect(m.create.mock.calls[0][0].data).toMatchObject(expected);
    }
  });

  it.each([
    ['/api/settings/reset-data', { message: 'Data direset.', safetyBackup: 'pre-reset-1.sql.gz' }],
    ['/api/backup/restore', { message: 'Backup dipulihkan.', safetyBackup: 'pre-restore-1.sql.gz' }],
  ])('only logs %s (the users table is replaced, so an audit row would fail its foreign key)', async (url, body) => {
    const { res, sent } = fakeRes();
    await mount(fakeReq({ originalUrl: url, headers: { 'x-request-id': 'req-reset' } }), res);
    res.json(body);
    await flush();

    expect(m.create).not.toHaveBeenCalled();
    expect(sent).toEqual([{ status: 200, body }]);
    expect(m.warn).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'req-reset', userId: 'u1', route: `POST ${url}`, safetyBackup: body.safetyBackup }),
      expect.any(String),
    );
  });

  it('prefers res.locals.safetyBackup and ignores a query string when matching the log-only routes', async () => {
    const { res } = fakeRes();
    await mount(fakeReq({ originalUrl: '/api/backup/restore/?x=1' }), res);
    res.locals.safetyBackup = 'from-locals.sql.gz';
    res.json({ message: 'ok' });
    await flush();
    expect(m.create).not.toHaveBeenCalled();
    expect(m.warn.mock.calls[0][0]).toMatchObject({ route: 'POST /api/backup/restore', safetyBackup: 'from-locals.sql.gz' });
  });

  it('does not wrap reads or unauthenticated requests', async () => {
    for (const req of [fakeReq({ method: 'GET' }), fakeReq({ user: undefined })]) {
      const { res, sent } = fakeRes();
      await mount(req, res);
      res.json({ id: 'p1' });
      expect(sent).toHaveLength(1);
    }
    expect(m.create).not.toHaveBeenCalled();
  });
});

describe('buildAuditData', () => {
  it('maps method, entity and ids, and redacts secrets', () => {
    const data = buildAuditData({
      user: { userId: 'u1', role: 'Admin' },
      method: 'PUT',
      originalUrl: '/api/ai/config/settings',
      body: { id: 7, serviceToken: 'plain' },
      before: { id: '7', snapshot: { a: 1 } },
      ip: '10.0.0.1',
      userAgent: 'ua',
    });
    expect(data).toMatchObject({
      userId: 'u1', action: 'UPDATE', entityType: 'ai', entityId: '7', oldValues: { a: 1 }, ipAddress: '10.0.0.1', userAgent: 'ua',
    });
    expect((data.newValues as Record<string, unknown>).serviceToken).not.toBe('plain');
  });

  it('falls back to the snapshot id, then N/A', () => {
    const base = { user: { userId: 'u1', role: 'Admin' }, method: 'DELETE', originalUrl: '/api/parties/x', ip: undefined, userAgent: undefined };
    expect(buildAuditData({ ...base, body: { message: 'ok' }, before: { id: 'x', snapshot: {} } }).entityId).toBe('x');
    expect(buildAuditData({ ...base, body: null, before: null }).entityId).toBe('N/A');
  });
});
