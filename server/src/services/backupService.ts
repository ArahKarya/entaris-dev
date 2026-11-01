// Database backup and restore (E7-R12), shared by routes/backup.ts and the data reset in
// routes/settings/dummyData.ts.
//
// - Every dump is `pg_dump --clean --if-exists | gzip` into BACKUP_DIR (default <cwd>/backups, the
//   /app/server/backups volume in Docker). A dump only counts as done when pg_dump and gzip both
//   exit 0 and the file is flushed; otherwise the partial file is deleted.
// - Files are named by kind (`backup-`, `pre-reset-`, `pre-restore-`, `upload-`) and each kind is
//   rotated on its own (BACKUP_RETENTION), so safety backups and uploads never push out routine
//   backups. Files with any other name (e.g. scripts/backup.sh output) are never rotated.
// - A restore first takes a `pre-restore` safety backup of the target database, then replays the
//   dump with `psql -v ON_ERROR_STOP=1 --single-transaction`: one error rolls everything back.

import { spawn, execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { logger } from '../lib/logger';
import { systemAccounts } from './systemAccounts';
import { invalidatePermissionCache } from './permissionService';
import { invalidateTelegramConfigCache } from './telegramService';

export type BackupKind = 'backup' | 'pre-reset' | 'pre-restore' | 'upload';
/** Kinds made by a dump; `upload` files come from POST /api/backup/upload. */
export type DumpKind = Exclude<BackupKind, 'upload'>;

/** Files kept per kind (owner decision 2: 5 routine, 3 pre-reset, 3 pre-restore, 5 uploaded). */
export const BACKUP_RETENTION: Readonly<Record<BackupKind, number>> = {
  backup: 5,
  'pre-reset': 3,
  'pre-restore': 3,
  upload: 5,
};

const DEFAULT_DUMP_TIMEOUT_MS = 120_000;
const DEFAULT_RESTORE_TIMEOUT_MS = 300_000;

export interface BackupFile {
  filename: string;
  size: number;
  date: string;
  kind: BackupKind | null;
}

export interface DbConn { host: string; port: string; user: string; password: string; db: string }

export interface DbTarget {
  /** Postgres URL to dump or restore instead of DATABASE_URL (tests point it at a scratch database). */
  databaseUrl?: string;
}

/** Backup folder, read on every call so BACKUP_DIR set after import still applies. */
export function backupDir(): string {
  return process.env.BACKUP_DIR || path.resolve(process.cwd(), 'backups');
}

function envMs(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const dumpTimeoutMs = () => envMs('BACKUP_DUMP_TIMEOUT_MS', DEFAULT_DUMP_TIMEOUT_MS);
export const restoreTimeoutMs = () => envMs('BACKUP_RESTORE_TIMEOUT_MS', DEFAULT_RESTORE_TIMEOUT_MS);

/** The kind a file name belongs to, or null for files this app did not name (never rotated). */
export function backupKindOf(filename: string): BackupKind | null {
  if (!filename.endsWith('.sql.gz')) return null;
  // pre-restore/pre-reset before backup: none is a prefix of another, but keep the longest first.
  for (const kind of ['pre-restore', 'pre-reset', 'backup', 'upload'] as const) {
    if (filename.startsWith(`${kind}-`)) return kind;
  }
  return null;
}

/** YYYYMMDDHHMMSS (UTC), the timestamp used in backup file names since the first release. */
function stamp(now: Date): string {
  return now.toISOString().replace(/[:\-T]/g, '').replace(/\..+$/, '').slice(0, 15);
}

/**
 * Name for an uploaded file: never the client's name, so an upload cannot overwrite another upload
 * or an official backup with the same name.
 */
export function uploadFileName(now: Date = new Date(), rand: string = randomBytes(4).toString('hex')): string {
  return `upload-${stamp(now)}-${rand}.sql.gz`;
}

/** `<kind>-<timestamp>.sql.gz`, with `-2`, `-3`, ... when a file of that second already exists. */
function dumpFileName(kind: DumpKind, now: Date, dir: string): string {
  const base = `${kind}-${stamp(now)}`;
  let name = `${base}.sql.gz`;
  for (let n = 2; fs.existsSync(path.join(dir, name)); n++) name = `${base}-${n}.sql.gz`;
  return name;
}

/**
 * Absolute path of a backup file from a client-supplied name, or null when the name is not a
 * plain `.sql.gz` file name (no directories, no traversal).
 */
export function resolveBackupPath(filename: unknown): string | null {
  if (typeof filename !== 'string' || !filename) return null;
  const sanitized = path.basename(filename);
  if (!sanitized.endsWith('.sql.gz')) return null;
  return path.join(backupDir(), sanitized);
}

export async function ensureBackupDir(): Promise<string> {
  const dir = backupDir();
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
}

export function parseDatabaseUrl(url: string = process.env.DATABASE_URL || ''): DbConn {
  try {
    const u = new URL(url);
    return {
      host: u.hostname || 'localhost',
      port: u.port || '5432',
      user: decodeURIComponent(u.username) || 'postgres',
      password: decodeURIComponent(u.password),
      db: u.pathname.replace(/^\//, '') || 'finance',
    };
  } catch {
    return { host: 'localhost', port: '5432', user: 'postgres', password: '', db: 'finance' };
  }
}

/** Check if we're running inside Docker */
function isInsideDocker(): boolean {
  return fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv');
}

/** Check if pg_dump is available locally */
function hasPgDumpLocally(): boolean {
  try {
    execFileSync('pg_dump', ['--version'], { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** Without local client tools (dev machine), run them inside the Compose DB service. */
const useLocalTools = () => isInsideDocker() || hasPgDumpLocally();
const dbContainerService = () => process.env.DB_DOCKER_SERVICE || 'db';

export function buildDumpCommand(c: DbConn, local = useLocalTools()): { cmd: string; args: string[] } {
  const pgFlags = ['--no-owner', '--no-privileges', '--clean', '--if-exists'];
  if (local) return { cmd: 'pg_dump', args: ['-h', c.host, '-p', c.port, '-U', c.user, '-d', c.db, ...pgFlags] };
  return { cmd: 'docker', args: ['compose', 'exec', '-T', dbContainerService(), 'pg_dump', '-U', c.user, '-d', c.db, ...pgFlags] };
}

/** psql that stops at the first error and runs the whole dump as one transaction. */
export function buildRestoreCommand(c: DbConn, local = useLocalTools()): { cmd: string; args: string[] } {
  const psqlFlags = ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '--single-transaction'];
  if (local) return { cmd: 'psql', args: ['-h', c.host, '-p', c.port, '-U', c.user, '-d', c.db, ...psqlFlags] };
  return { cmd: 'docker', args: ['compose', 'exec', '-T', dbContainerService(), 'psql', '-U', c.user, '-d', c.db, ...psqlFlags] };
}

/**
 * `dumpCmd | compressCmd > outputPath`. Resolves only when both processes exited 0 and the file is
 * flushed; on any failure both processes are stopped and the partial file is deleted.
 */
export function spawnPipeline(
  dumpCmd: string,
  dumpArgs: readonly string[],
  compressCmd: string,
  compressArgs: readonly string[],
  outputPath: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const dumper = spawn(dumpCmd, dumpArgs as string[], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const compressor = spawn(compressCmd, compressArgs as string[], { stdio: ['pipe', 'pipe', 'pipe'] });
    const outStream = fs.createWriteStream(outputPath);

    let dumpStderr = '';
    let compressStderr = '';
    dumper.stderr.on('data', (chunk: Buffer) => { dumpStderr += chunk.toString(); });
    compressor.stderr.on('data', (chunk: Buffer) => { compressStderr += chunk.toString(); });

    dumper.stdout.pipe(compressor.stdin);
    compressor.stdout.pipe(outStream);
    // gzip exiting early closes its stdin; the EPIPE is reported through its exit code instead.
    compressor.stdin.on('error', () => { /* handled by the compressor close event */ });

    let settled = false;
    let dumpDone = false;
    let compressDone = false;
    let written = false;

    const finish = (err?: Error) => {
      if (settled) return;
      if (!err && !(dumpDone && compressDone && written)) return;
      settled = true;
      clearTimeout(timer);
      if (!err) return resolve();
      dumper.kill('SIGTERM');
      compressor.kill('SIGTERM');
      outStream.destroy();
      fs.promises.unlink(outputPath).catch(() => { /* never created, or already gone */ }).finally(() => reject(err));
    };

    const timer = setTimeout(() => finish(new Error(`${dumpCmd} timed out`)), timeoutMs);

    dumper.on('error', (err) => finish(new Error(`${dumpCmd} spawn error: ${err.message}`)));
    compressor.on('error', (err) => finish(new Error(`${compressCmd} spawn error: ${err.message}`)));
    outStream.on('error', (err) => finish(new Error(`File write error: ${err.message}`)));
    dumper.on('close', (code) => {
      if (code !== 0) return finish(new Error(`${dumpCmd} exited ${code}: ${dumpStderr}`));
      dumpDone = true;
      finish();
    });
    compressor.on('close', (code) => {
      if (code !== 0) return finish(new Error(`${compressCmd} exited ${code}: ${compressStderr}`));
      compressDone = true;
      finish();
    });
    outStream.on('finish', () => { written = true; finish(); });
  });
}

/** `decompressCmd | restoreCmd`; resolves when both exited 0. */
export function spawnRestorePipeline(
  decompressCmd: string,
  decompressArgs: readonly string[],
  restoreCmd: string,
  restoreArgs: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const decompressor = spawn(decompressCmd, decompressArgs as string[], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const restorer = spawn(restoreCmd, restoreArgs as string[], { env, stdio: ['pipe', 'pipe', 'pipe'] });

    let decompStderr = '';
    let restoreStderr = '';
    decompressor.stderr.on('data', (chunk: Buffer) => { decompStderr += chunk.toString(); });
    restorer.stderr.on('data', (chunk: Buffer) => { restoreStderr += chunk.toString(); });
    restorer.stdout.on('data', () => { /* drain stdout so psql never blocks on a full pipe */ });

    decompressor.stdout.pipe(restorer.stdin);
    // psql stopping at the first error closes its stdin; its exit code reports the failure.
    restorer.stdin.on('error', () => { /* handled by the restorer close event */ });

    let settled = false;
    let decompDone = false;
    let restoreDone = false;

    const finish = (err?: Error) => {
      if (settled) return;
      if (!err && !(decompDone && restoreDone)) return;
      settled = true;
      clearTimeout(timer);
      if (!err) return resolve();
      decompressor.kill('SIGTERM');
      restorer.kill('SIGTERM');
      reject(err);
    };

    const timer = setTimeout(() => finish(new Error(`restore timed out`)), timeoutMs);

    decompressor.on('error', (err) => finish(new Error(`${decompressCmd} error: ${err.message}`)));
    restorer.on('error', (err) => finish(new Error(`${restoreCmd} error: ${err.message}`)));
    // psql's own error wins over gunzip's broken pipe when psql stops first.
    restorer.on('close', (code) => {
      if (code !== 0) return finish(new Error(`${restoreCmd} exited ${code}: ${restoreStderr}`));
      restoreDone = true;
      finish();
    });
    decompressor.on('close', (code) => {
      if (code !== 0) return finish(new Error(`${decompressCmd} exited ${code}: ${decompStderr}`));
      decompDone = true;
      finish();
    });
  });
}

async function readBackupFiles(dir: string): Promise<BackupFile[]> {
  const entries = (await fs.promises.readdir(dir)).filter((f) => f.endsWith('.sql.gz'));
  const files: BackupFile[] = [];
  for (const f of entries) {
    const stat = await fs.promises.stat(path.join(dir, f));
    files.push({ filename: f, size: stat.size, date: stat.mtime.toISOString(), kind: backupKindOf(f) });
  }
  return files.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

/** Backup files, newest first. */
export async function listBackups(): Promise<BackupFile[]> {
  return readBackupFiles(await ensureBackupDir());
}

/** Keeps the newest BACKUP_RETENTION[kind] files of each kind; files of no kind are left alone. */
export async function rotateBackups(): Promise<string[]> {
  const dir = await ensureBackupDir();
  const files = await readBackupFiles(dir);
  const removed: string[] = [];
  for (const kind of Object.keys(BACKUP_RETENTION) as BackupKind[]) {
    for (const f of files.filter((x) => x.kind === kind).slice(BACKUP_RETENTION[kind])) {
      try {
        await fs.promises.unlink(path.join(dir, f.filename));
        removed.push(f.filename);
        logger.info(`Backup rotated: deleted ${f.filename}`);
      } catch (err) {
        logger.error({ err }, `Failed to delete backup ${f.filename}`);
      }
    }
  }
  return removed;
}

/** Dumps the database into a new `<kind>-<timestamp>.sql.gz`, then rotates that kind. */
export async function createBackup(kind: DumpKind, target: DbTarget = {}): Promise<BackupFile> {
  const dir = await ensureBackupDir();
  const conn = parseDatabaseUrl(target.databaseUrl);
  const filename = dumpFileName(kind, new Date(), dir);
  const filepath = path.join(dir, filename);
  const { cmd, args } = buildDumpCommand(conn);

  await spawnPipeline(cmd, args, 'gzip', [], filepath, { ...process.env, PGPASSWORD: conn.password }, dumpTimeoutMs());

  const stat = await fs.promises.stat(filepath);
  await rotateBackups();
  return { filename, size: stat.size, date: stat.mtime.toISOString(), kind };
}

/** Error code: the safety backup before a restore or reset failed, so nothing was changed. */
export const SAFETY_BACKUP_FAILED = 'SAFETY_BACKUP_FAILED';
/** Error code: psql rejected the dump; the single transaction rolled back, so nothing was changed. */
export const RESTORE_FAILED = 'RESTORE_FAILED';

/** A restore or safety-backup failure, with the safety backup name when one was made. */
export class BackupOperationError extends Error {
  constructor(
    readonly code: typeof SAFETY_BACKUP_FAILED | typeof RESTORE_FAILED,
    readonly reason: unknown,
    readonly safetyBackup: string | null = null,
  ) {
    super(reason instanceof Error ? reason.message : String(reason));
    this.name = 'BackupOperationError';
  }
}

/**
 * Drops in-memory copies of database rows that a restore or reset replaces: system account
 * mappings, roles and rights, and the Telegram configuration. The next read loads them again.
 */
export function invalidateRuntimeCaches(): void {
  systemAccounts.invalidateCache();
  invalidatePermissionCache();
  invalidateTelegramConfigCache();
}

/**
 * Restores `filepath` (an existing file in BACKUP_DIR) into the database: a `pre-restore` safety
 * backup first (no restore when it fails), then one all-or-nothing psql transaction. Runtime
 * caches are dropped afterwards either way.
 */
export async function restoreBackup(filepath: string, target: DbTarget = {}): Promise<{ safetyBackup: string }> {
  let safety: BackupFile;
  try {
    safety = await createBackup('pre-restore', target);
  } catch (err) {
    throw new BackupOperationError(SAFETY_BACKUP_FAILED, err);
  }

  const conn = parseDatabaseUrl(target.databaseUrl);
  const { cmd, args } = buildRestoreCommand(conn);
  try {
    await spawnRestorePipeline('gunzip', ['-c', filepath], cmd, args, { ...process.env, PGPASSWORD: conn.password }, restoreTimeoutMs());
  } catch (err) {
    throw new BackupOperationError(RESTORE_FAILED, err, safety.filename);
  } finally {
    invalidateRuntimeCaches();
  }
  return { safetyBackup: safety.filename };
}
