import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Stored-balance writer guard (E2-R15). accounts.balance follows one rule, the sum of the account's
 * active ledger rows over every year (services/ledger/storedBalances.ts), and only two files write
 * it: utils/accountBalance.ts (the incremental update of a posting) and storedBalances.ts (the
 * recalculation). A Prisma account write whose argument sets `balance`, or a raw UPDATE accounts
 * ... SET balance, anywhere else under server/src fails here. In particular the year close and
 * reopen (routes/fiscalYears.ts) do not touch it any more.
 */
const SRC = path.resolve(__dirname, '..');

const ALLOWED = new Set(['utils/accountBalance.ts', 'services/ledger/storedBalances.ts']);

const ACCOUNT_WRITE = /\baccount\s*\.\s*(createMany|create|updateMany|update|upsert)\s*\(/g;
const RAW_UPDATE = /\bUPDATE\s+"?accounts"?(?:\s+(?!SET\b)\w+)?\s+SET\b([\s\S]*?)(?:\bFROM\b|\bWHERE\b|`)/gi;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' || e.name === 'node_modules' ? [] : sourceFiles(p);
    return p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
  });
}

/** The argument text of the call whose "(" is at `open`, up to its matching ")". */
function callArgument(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')' && --depth === 0) return source.slice(open + 1, i);
  }
  return source.slice(open + 1);
}

export function balanceWrites(source: string): string[] {
  const found: string[] = [];
  for (const m of source.matchAll(ACCOUNT_WRITE)) {
    const arg = callArgument(source, m.index! + m[0].length - 1);
    if (/\bbalance\s*:/.test(arg)) found.push(`account.${m[1]}`);
  }
  for (const m of source.matchAll(RAW_UPDATE)) {
    if (/\bbalance\s*=/.test(m[1])) found.push('sql:UPDATE accounts SET balance');
  }
  return found;
}

describe('stored balance writers', () => {
  it('detects Prisma writes that set balance and raw UPDATE accounts SET balance', () => {
    expect(balanceWrites("await tx.account.update({ where: { id }, data: { balance: { decrement: x } } });")).toEqual(['account.update']);
    expect(balanceWrites("await tx.account.update({ where: { id }, data: { name: f(a) } });")).toEqual([]);
    expect(balanceWrites('await tx.$queryRaw`UPDATE accounts a\n   SET balance = 1, x = 2 FROM cmp`;')).toEqual(['sql:UPDATE accounts SET balance']);
    expect(balanceWrites('await tx.$executeRaw`UPDATE accounts SET "isActive" = false WHERE id = 1`;')).toEqual([]);
  });

  it('only utils/accountBalance.ts and services/ledger/storedBalances.ts write accounts.balance', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join('/');
      if (ALLOWED.has(rel)) continue;
      for (const w of balanceWrites(readFileSync(file, 'utf8'))) offenders.push(`${rel}: ${w}`);
    }
    expect(offenders).toEqual([]);
  });

  it('the allowed files still hold the writers (keep the list tight)', () => {
    for (const rel of ALLOWED) {
      expect(balanceWrites(readFileSync(path.join(SRC, rel), 'utf8')).length, rel).toBeGreaterThan(0);
    }
  });

  it('the year close and reopen do not write stored balances', () => {
    expect(balanceWrites(readFileSync(path.join(SRC, 'routes/fiscalYears.ts'), 'utf8'))).toEqual([]);
  });
});
