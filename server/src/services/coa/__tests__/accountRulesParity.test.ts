import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { ROOT_TYPE_BY_PREFIX } from '../accountRules';

// client/src/lib/accountRules.ts mirrors the prefix table; read it as text so the two cannot drift.
const CLIENT_FILE = path.resolve(__dirname, '../../../../../client/src/lib/accountRules.ts');

function clientTable(): Record<string, string> {
  const source = fs.readFileSync(CLIENT_FILE, 'utf8');
  const block = source.match(/ROOT_TYPE_BY_PREFIX[^=]*=\s*\{([^}]*)\}/);
  if (!block) throw new Error('ROOT_TYPE_BY_PREFIX not found in the client accountRules.ts');
  const rows = [...block[1].matchAll(/'(\d)':\s*'([A-Z]+)'/g)];
  return Object.fromEntries(rows.map((m) => [m[1], m[2]]));
}

describe('client accountRules parity', () => {
  it('has the same prefix table as the server', () => {
    expect(clientTable()).toEqual(ROOT_TYPE_BY_PREFIX);
  });

  it('uses the same number pattern', () => {
    const source = fs.readFileSync(CLIENT_FILE, 'utf8');
    expect(source).toContain('const NUMBER_PATTERN = /^[1-8](\\.\\d+)*$/;');
  });
});
