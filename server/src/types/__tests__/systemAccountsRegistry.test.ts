import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  ALL_SYSTEM_ROLES,
  POSTING_SYSTEM_ROLES,
  REQUIRED_SYSTEM_ROLES,
  SYSTEM_ACCOUNT_ROLES,
  rolesByUsage,
} from '../systemAccounts';

const SRC = path.resolve(__dirname, '../..');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' ? [] : sourceFiles(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}

const runtimeSources = ['services', 'routes']
  .flatMap((d) => sourceFiles(path.join(SRC, d)))
  .filter((f) => !f.includes(`${path.sep}demoData${path.sep}`))
  .map((f) => fs.readFileSync(f, 'utf8'));

const referenced = (role: string) => {
  const re = new RegExp(`['"\`]${role}['"\`]`);
  return runtimeSources.some((src) => re.test(src));
};

describe('system account role registry', () => {
  it('gives every role a usage', () => {
    for (const role of ALL_SYSTEM_ROLES) {
      expect(['posting', 'default', 'manual', 'belum']).toContain(SYSTEM_ACCOUNT_ROLES[role].usage);
    }
  });

  it('keeps POSTING_SYSTEM_ROLES equal to the posting-usage roles', () => {
    expect([...POSTING_SYSTEM_ROLES].sort()).toEqual([...rolesByUsage('posting')].sort());
  });

  it('references every posting role literally in services/ or routes/', () => {
    const missing = rolesByUsage('posting').filter((r) => !referenced(r));
    expect(missing).toEqual([]);
  });

  it('references no belum role in services/ or routes/ (else reclassify it)', () => {
    const used = rolesByUsage('belum').filter((r) => referenced(r));
    expect(used).toEqual([]);
  });

  it('never requires a role that is manual or belum', () => {
    const bad = REQUIRED_SYSTEM_ROLES.filter((r) => {
      const usage = SYSTEM_ACCOUNT_ROLES[r].usage;
      return usage === 'belum' || usage === 'manual';
    });
    expect(bad).toEqual([]);
  });

  it('does not require TAX_INPUT and marks the unused roles belum', () => {
    expect(SYSTEM_ACCOUNT_ROLES.TAX_INPUT.required).toBe(false);
    expect(SYSTEM_ACCOUNT_ROLES.SALES_DISCOUNT.usage).toBe('belum');
    expect(SYSTEM_ACCOUNT_ROLES.BANK_CHARGE.usage).toBe('belum');
  });
});
