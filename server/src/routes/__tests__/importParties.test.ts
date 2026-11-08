// Party import rows (E2-R13, PR-5.12): amounts, direction and the old column aliases, read without a database.
import { describe, expect, it } from 'vitest';
import { parsePartyRows } from '../../services/partyImportRows';

const parse = (rows: Record<string, string>[], numeric: Array<Record<string, boolean>> = rows.map(() => ({}))) =>
  parsePartyRows(rows, numeric, (v) => String(v ?? ''));

const one = (row: Record<string, string>, numeric: Record<string, boolean> = {}) => parse([row], [numeric]);

describe('party import rows', () => {
  it('a Customer defaults to a receivable and a Supplier to a payable', () => {
    expect(one({ name: 'A', partyType: 'Customer', openingBalance: '5000000' }).rows[0].openings).toEqual({ AR: '5000000' });
    expect(one({ name: 'B', partyType: 'Supplier', openingBalance: '300' }).rows[0].openings).toEqual({ AP: '300' });
  });

  it('a Both party with an amount must say the direction; a zero says nothing', () => {
    const noDirection = one({ name: 'C', partyType: 'Both', openingBalance: '20000000' });
    expect(noDirection.rows).toEqual([]);
    expect(noDirection.errors).toEqual([{ row: 2, message: expect.stringContaining('arahSaldo'), code: 'PARTY_OPENING_DIRECTION' }]);
    expect(one({ name: 'C', partyType: 'Both', openingBalance: '0' }).rows[0].openings).toEqual({});
    expect(one({ name: 'C', partyType: 'Both', openingBalance: '20000000', arahSaldo: 'Hutang' }).rows[0].openings).toEqual({ AP: '20000000' });
  });

  it.each([
    ['Piutang', 'AR'], ['hutang', 'AP'], ['receivable', 'AR'], ['PAYABLE', 'AP'],
  ])('arahSaldo %s sets %s on a Both party', (word, kind) => {
    expect(one({ name: 'D', partyType: 'Both', openingBalance: '10', arah_saldo: word }).rows[0].openings).toEqual({ [kind]: '10' });
    expect(one({ name: 'D', partyType: 'Both', openingBalance: '10', direction: word }).rows[0].openings).toEqual({ [kind]: '10' });
  });

  it('refuses a direction the party type does not have, and an unknown word', () => {
    const customerPayable = one({ name: 'E', partyType: 'Customer', openingBalance: '10', arahSaldo: 'Hutang' });
    expect(customerPayable.errors[0]).toMatchObject({ code: 'PARTY_OPENING_DIRECTION', message: expect.stringContaining('Customer tidak punya hutang') });
    const supplierReceivable = one({ name: 'E', partyType: 'Supplier', piutang: '10' });
    expect(supplierReceivable.errors[0]).toMatchObject({ code: 'PARTY_OPENING_DIRECTION' });
    expect(one({ name: 'E', partyType: 'Both', openingBalance: '10', arahSaldo: 'kredit' }).errors[0].message).toContain('arahSaldo "kredit"');
  });

  it('the old piutang / hutang columns state the amount and the direction; a conflict is a row error', () => {
    expect(one({ name: 'F', partyType: 'Both', hutang: '700' }).rows[0].openings).toEqual({ AP: '700' });
    expect(one({ name: 'F', partyType: 'Both', piutang: '0', hutang: '700' }).rows[0].openings).toEqual({ AP: '700' });
    expect(one({ name: 'F', partyType: 'Both', piutang: '5', hutang: '7' }).errors).toHaveLength(1);
    expect(one({ name: 'F', partyType: 'Both', piutang: '5', arahSaldo: 'Hutang' }).errors).toHaveLength(1);
    expect(one({ name: 'F', partyType: 'Both', piutang: '5', openingBalance: '6' }).errors).toHaveLength(1);
    expect(one({ name: 'F', partyType: 'Customer', piutang: '5', openingBalance: '5' }).rows[0].openings).toEqual({ AR: '5' });
  });

  it('refuses a negative amount with OPENING_NEGATIVE, in every opening column', () => {
    for (const col of ['openingBalance', 'saldo_awal', 'depositBalance', 'customerDepositBalance']) {
      const res = one({ name: 'G', partyType: 'Both', [col]: '-1', arahSaldo: 'Piutang' });
      expect(res.rows).toEqual([]);
      expect(res.errors).toEqual([{ row: 2, message: 'Saldo awal pihak tidak boleh negatif.', code: 'OPENING_NEGATIVE' }]);
    }
    expect(one({ name: 'G', partyType: 'Customer', openingBalance: '-0' }).rows[0].openings).toEqual({ AR: '0' });
  });

  it('refuses amounts with thousand separators or text instead of reading them', () => {
    expect(one({ name: 'H', partyType: 'Customer', openingBalance: '5.000.000' }).errors[0].message).toContain('"5.000.000"');
    expect(one({ name: 'H', partyType: 'Customer', openingBalance: 'abc' }).rows).toEqual([]);
    expect(one({ name: 'H', partyType: 'Customer', depositBalance: '1,5' }).rows).toEqual([]);
  });

  it('a number cell with float noise is rounded, a real third decimal is refused', () => {
    expect(one({ name: 'I', partyType: 'Customer', openingBalance: '110000.00000000001' }, { openingBalance: true }).rows[0].openings).toEqual({ AR: '110000.00' });
    expect(one({ name: 'I', partyType: 'Customer', openingBalance: '10.005' }, { openingBalance: true }).rows).toEqual([]);
  });

  it('blank cells state nothing; an explicit zero is stated', () => {
    expect(one({ name: 'J', partyType: 'Customer', openingBalance: '', depositBalance: '' }).rows[0].openings).toEqual({});
    expect(one({ name: 'J', partyType: 'Customer', openingBalance: '0' }).rows[0].openings).toEqual({ AR: '0' });
  });

  it('deposits: a Customer\'s depositBalance is its Customer deposit, a Supplier has only the Supplier deposit', () => {
    expect(one({ name: 'K', partyType: 'Customer', depositBalance: '50' }).rows[0].openings).toEqual({ CDEP: '50' });
    expect(one({ name: 'K', partyType: 'Customer', depositBalance: '50', customerDepositBalance: '70' }).rows[0].openings).toEqual({ CDEP: '70' });
    expect(one({ name: 'K', partyType: 'Supplier', depositBalance: '50', customerDepositBalance: '0' }).rows[0].openings).toEqual({ VDEP: '50' });
    expect(one({ name: 'K', partyType: 'Supplier', customerDepositBalance: '70' }).errors).toHaveLength(1);
    expect(one({ name: 'K', partyType: 'Both', depositBalance: '5', customerDepositBalance: '7', hutang: '3' }).rows[0].openings).toEqual({ VDEP: '5', CDEP: '7', AP: '3' });
  });

  it('keeps the earlier row checks and row numbers (header = row 1)', () => {
    const res = parse([{ name: '', partyType: 'Customer' }, { name: 'L', partyType: 'Mitra' }, { name: 'M', partyType: 'Customer', openingBalance: '1' }]);
    expect(res.errors.map((e) => e.row)).toEqual([2, 3]);
    expect(res.rows.map((r) => [r.rowNum, r.name])).toEqual([[4, 'M']]);
  });
});
