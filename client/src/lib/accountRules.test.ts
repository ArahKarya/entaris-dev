import { describe, expect, it } from 'vitest';
import {
  ROOT_TYPE_BY_PREFIX,
  deriveRootType,
  isValidAccountNumber,
  normalizeAccountNumber,
  numberPrefix,
  prefixChanged,
} from './accountRules';

describe('deriveRootType', () => {
  it.each([
    ['1.1.6', 'ASSET'],
    ['2', 'LIABILITY'],
    ['3.9', 'EQUITY'],
    ['4.5', 'REVENUE'],
    ['5.1', 'EXPENSE'],
    ['6.19', 'EXPENSE'],
    ['7.4', 'REVENUE'],
    ['8', 'EXPENSE'],
    [' 7.1 ', 'REVENUE'],
    ['9.1', null],
    ['0', null],
    ['', null],
  ])('%s -> %s', (number, expected) => {
    expect(deriveRootType(number)).toBe(expected);
  });

  it('covers prefixes 1 to 8 only', () => {
    expect(Object.keys(ROOT_TYPE_BY_PREFIX)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
  });
});

describe('number format', () => {
  it.each([
    ['1', true],
    ['6.19', true],
    ['2.1.1.01', true],
    ['9.1', false],
    ['1..2', false],
    ['1.', false],
    ['1.a', false],
    ['', false],
    ['1 .2', false],
  ])('%s valid=%s', (number, ok) => {
    expect(isValidAccountNumber(number)).toBe(ok);
  });

  it('normalizes by trimming and reads the prefix', () => {
    expect(normalizeAccountNumber('  6.19 ')).toBe('6.19');
    expect(numberPrefix('6.19')).toBe('6');
    expect(prefixChanged('6.19', '6.20')).toBe(false);
    expect(prefixChanged('6.19', '1.9.9')).toBe(true);
  });
});
