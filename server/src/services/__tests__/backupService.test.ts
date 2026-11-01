import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** How a fake child process behaves: what it prints and how it exits. */
interface Behaviour { stdout?: string; exitCode?: number; stderr?: string; exitAfterStdoutEndMs?: number }

const h = vi.hoisted(() => ({
  calls: [] as Array<{ cmd: string; args: string[] }>,
  behaviours: new Map<string, Behaviour>(),
  invalidateSystemAccounts: vi.fn(),
  invalidatePermissions: vi.fn(),
  invalidateTelegram: vi.fn(),
}));

/**
 * A spawned process stand-in. Producers (pg_dump, gunzip) print `stdout` and exit; filters (gzip,
 * psql) pass stdin through to stdout and exit when stdin ends.
 */
function fakeProcess(cmd: string, args: string[]) {
  h.calls.push({ cmd, args });
  const b = h.behaviours.get(cmd) ?? {};
  const proc = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  const exit = () => setTimeout(() => {
    if (b.stderr) proc.stderr.write(b.stderr);
    proc.emit('close', b.exitCode ?? 0);
  }, b.exitAfterStdoutEndMs ?? 0);
  const producer = cmd === 'pg_dump' || cmd === 'gunzip';
  if (producer) {
    setImmediate(() => {
      proc.stdout.end(b.stdout ?? 'SELECT 1;\n');
      proc.stdout.once('end', exit);
      proc.stdout.resume();
    });
  } else {
    proc.stdin.pipe(proc.stdout);
    proc.stdin.once('end', exit);
    if (cmd === 'psql') proc.stdout.resume();
  }
  return proc;
}

vi.mock('child_process', () => ({
  spawn: vi.fn((cmd: string, args: string[]) => fakeProcess(cmd, args)),
  execFileSync: vi.fn(() => Buffer.from('pg_dump (PostgreSQL) 16')),
}));
vi.mock('../systemAccounts', () => ({ systemAccounts: { invalidateCache: h.invalidateSystemAccounts } }));
vi.mock('../permissionService', () => ({ invalidatePermissionCache: h.invalidatePermissions }));
vi.mock('../telegramService', () => ({ invalidateTelegramConfigCache: h.invalidateTelegram }));
vi.mock('../../lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import {
  BACKUP_RETENTION,
  BackupOperationError,
  RESTORE_FAILED,
  SAFETY_BACKUP_FAILED,
  backupDir,
  backupKindOf,
  buildDumpCommand,
  buildRestoreCommand,
  createBackup,
  dumpTimeoutMs,
  restoreBackup,
  restoreTimeoutMs,
  rotateBackups,
  spawnPipeline,
  uploadFileName,
} from '../backupService';

const conn = { host: 'db', port: '5432', user: 'u', password: 'p', db: 'erp' };
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-svc-'));
  vi.stubEnv('BACKUP_DIR', dir);
  vi.stubEnv('DATABASE_URL', 'postgresql://u:p@db:5432/erp?schema=public');
  h.calls.length = 0;
  h.behaviours.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

const files = () => fs.readdirSync(dir).sort();

describe('restore command', () => {
  it('stops at the first error and runs the dump as one transaction (local and docker exec)', () => {
    for (const local of [true, false]) {
      const { args } = buildRestoreCommand(conn, local);
      const i = args.indexOf('-v');
      expect(args[i + 1]).toBe('ON_ERROR_STOP=1');
      expect(args).toContain('--single-transaction');
    }
    expect(buildRestoreCommand(conn, false).cmd).toBe('docker');
    expect(buildDumpCommand(conn, true).args).toEqual(expect.arrayContaining(['--clean', '--if-exists']));
  });
});

describe('spawnPipeline', () => {
  const out = () => path.join(dir, 'x.sql.gz');

  it('resolves once pg_dump and gzip exited 0 and the file is written', async () => {
    h.behaviours.set('pg_dump', { stdout: 'CREATE TABLE t();\n' });
    await spawnPipeline('pg_dump', [], 'gzip', [], out(), {}, 5000);
    expect(fs.readFileSync(out(), 'utf8')).toBe('CREATE TABLE t();\n');
  });

  it('rejects and deletes the file when pg_dump fails after the file was flushed', async () => {
    h.behaviours.set('pg_dump', { stdout: 'partial', exitCode: 1, stderr: 'connection lost', exitAfterStdoutEndMs: 30 });
    await expect(spawnPipeline('pg_dump', [], 'gzip', [], out(), {}, 5000)).rejects.toThrow('pg_dump exited 1: connection lost');
    expect(fs.existsSync(out())).toBe(false);
  });

  it('rejects and deletes the file when gzip exits non-zero', async () => {
    h.behaviours.set('gzip', { exitCode: 2, stderr: 'no space' });
    await expect(spawnPipeline('pg_dump', [], 'gzip', [], out(), {}, 5000)).rejects.toThrow('gzip exited 2: no space');
    expect(fs.existsSync(out())).toBe(false);
  });
});

describe('createBackup', () => {
  it('names the file by kind and dumps DATABASE_URL', async () => {
    const b = await createBackup('pre-reset');
    expect(b.filename).toMatch(/^pre-reset-\d{14}\.sql\.gz$/);
    expect(b.kind).toBe('pre-reset');
    expect(files()).toEqual([b.filename]);
    expect(h.calls[0]).toEqual({ cmd: 'pg_dump', args: expect.arrayContaining(['-h', 'db', '-d', 'erp']) });
  });

  it('never overwrites a backup made in the same second', async () => {
    const a = await createBackup('backup');
    const b = await createBackup('backup');
    expect(a.filename).not.toBe(b.filename);
    expect(files()).toHaveLength(2);
  });
});

describe('restoreBackup', () => {
  const source = () => {
    const p = path.join(dir, 'upload-20261001000000-abcd1234.sql.gz');
    fs.writeFileSync(p, 'x');
    return p;
  };

  it('takes a pre-restore safety backup, restores with psql and drops the runtime caches', async () => {
    const result = await restoreBackup(source());
    expect(result.safetyBackup).toMatch(/^pre-restore-/);
    expect(h.calls.map((c) => c.cmd)).toEqual(['pg_dump', 'gzip', 'gunzip', 'psql']);
    expect(h.calls[3].args).toEqual(expect.arrayContaining(['ON_ERROR_STOP=1', '--single-transaction']));
    expect(h.invalidateSystemAccounts).toHaveBeenCalledOnce();
    expect(h.invalidatePermissions).toHaveBeenCalledOnce();
    expect(h.invalidateTelegram).toHaveBeenCalledOnce();
  });

  it('does not run psql when the safety backup fails', async () => {
    h.behaviours.set('pg_dump', { exitCode: 1, stderr: 'permission denied' });
    const err = await restoreBackup(source()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackupOperationError);
    expect((err as BackupOperationError).code).toBe(SAFETY_BACKUP_FAILED);
    expect(h.calls.map((c) => c.cmd)).not.toContain('psql');
    expect(files().filter((f) => f.startsWith('pre-restore-'))).toEqual([]);
  });

  it('reports a psql failure with the safety backup name and still drops the caches', async () => {
    h.behaviours.set('psql', { exitCode: 3, stderr: 'ERROR: relation "x" does not exist' });
    const err = (await restoreBackup(source()).catch((e: unknown) => e)) as BackupOperationError;
    expect(err.code).toBe(RESTORE_FAILED);
    expect(err.message).toContain('psql exited 3');
    expect(err.safetyBackup).toMatch(/^pre-restore-/);
    expect(h.invalidateSystemAccounts).toHaveBeenCalledOnce();
    expect(h.invalidatePermissions).toHaveBeenCalledOnce();
    expect(h.invalidateTelegram).toHaveBeenCalledOnce();
  });
});

describe('uploadFileName', () => {
  it('is unique, upload- prefixed and never the name of an official backup', () => {
    const now = new Date('2026-10-01T00:00:00Z');
    const a = uploadFileName(now);
    const b = uploadFileName(now);
    expect(a).not.toBe(b);
    for (const n of [a, b]) {
      expect(n).toMatch(/^upload-\d{14}-[0-9a-f]{8}\.sql\.gz$/);
      expect(backupKindOf(n)).toBe('upload');
    }
  });
});

describe('rotateBackups', () => {
  it('keeps the newest files per kind and leaves files of no kind alone', async () => {
    const touch = (name: string, ageMin: number) => {
      const p = path.join(dir, name);
      fs.writeFileSync(p, 'x');
      const t = new Date(Date.now() - ageMin * 60_000);
      fs.utimesSync(p, t, t);
    };
    for (let i = 0; i < 6; i++) touch(`backup-2026100100000${i}.sql.gz`, 10 + i);
    for (let i = 0; i < 4; i++) touch(`pre-reset-2026100100000${i}.sql.gz`, 1 + i);
    for (let i = 0; i < 2; i++) touch(`upload-2026100100000${i}-aaaaaaaa.sql.gz`, i);
    touch('simple_erp_20261001.sql.gz', 999);

    const removed = await rotateBackups();

    expect(removed.sort()).toEqual(['backup-20261001000005.sql.gz', 'pre-reset-20261001000003.sql.gz']);
    expect(files().filter((f) => f.startsWith('backup-'))).toHaveLength(BACKUP_RETENTION.backup);
    expect(files().filter((f) => f.startsWith('pre-reset-'))).toHaveLength(BACKUP_RETENTION['pre-reset']);
    expect(files()).toContain('simple_erp_20261001.sql.gz');
    expect(BACKUP_RETENTION).toEqual({ backup: 5, 'pre-reset': 3, 'pre-restore': 3, upload: 5 });
  });
});

describe('defaults', () => {
  it('uses <cwd>/backups and 120 s / 300 s timeouts unless set in the environment', () => {
    vi.stubEnv('BACKUP_DIR', '');
    vi.stubEnv('BACKUP_DUMP_TIMEOUT_MS', '');
    vi.stubEnv('BACKUP_RESTORE_TIMEOUT_MS', '');
    expect(backupDir()).toBe(path.resolve(process.cwd(), 'backups'));
    expect(dumpTimeoutMs()).toBe(120_000);
    expect(restoreTimeoutMs()).toBe(300_000);
    vi.stubEnv('BACKUP_DUMP_TIMEOUT_MS', '600000');
    vi.stubEnv('BACKUP_RESTORE_TIMEOUT_MS', '900000');
    expect(dumpTimeoutMs()).toBe(600_000);
    expect(restoreTimeoutMs()).toBe(900_000);
  });
});
