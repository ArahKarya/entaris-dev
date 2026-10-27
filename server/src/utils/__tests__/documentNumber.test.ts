import { describe, it, expect, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { generateDocumentNumber } from '../documentNumber';

/**
 * Factory: builds a minimal Prisma transaction mock whose numeric MAX query returns a configurable
 * highest suffix per series (0 when the series is empty). The real SQL (numeric compare, digits-only
 * suffix) is covered by documentNumber.integration.test.ts.
 * Strategy under test: MAX(existing number) + 1 — immune to deleted/backdated rows.
 */
function makeTx(maxBySeries: Record<string, number> = {}) {
  return {
    $executeRaw: vi.fn().mockResolvedValue(undefined),
    $queryRaw: vi.fn(async (query: Prisma.Sql) => {
      const series = query.values.find((v) => typeof v === 'string') as string;
      return [{ last: BigInt(maxBySeries[series] ?? 0) }];
    }),
  } as any;
}

/** Series and SQL text of every MAX query the mock received, in call order. */
const queries = (tx: ReturnType<typeof makeTx>) =>
  tx.$queryRaw.mock.calls.map(([q]: [Prisma.Sql]) => ({
    series: q.values.find((v) => typeof v === 'string'),
    sql: q.sql,
  }));

const FISCAL_YEAR_ID = 'fy-2026';
const MARCH_2026 = new Date('2026-03-15');

describe('generateDocumentNumber — format', () => {
  it('generates SI-202603-0001 for first sales invoice in March 2026', async () => {
    const tx = makeTx();
    const num = await generateDocumentNumber(tx, 'SI', MARCH_2026, FISCAL_YEAR_ID);
    expect(num).toBe('SI-202603-0001');
  });

  it('generates PI-202603-0003 when last used is PI-202603-0002', async () => {
    const tx = makeTx({ 'PI-202603-': 2 });
    const num = await generateDocumentNumber(tx, 'PI', MARCH_2026, FISCAL_YEAR_ID);
    expect(num).toBe('PI-202603-0003');
  });

  it('generates PAY-202603-0010 when last used is PAY-202603-0009', async () => {
    const tx = makeTx({ 'PAY-202603-': 9 });
    const num = await generateDocumentNumber(tx, 'PAY', MARCH_2026, FISCAL_YEAR_ID);
    expect(num).toBe('PAY-202603-0010');
  });

  it('generates JV-202601-0001 for first journal entry in January', async () => {
    const tx = makeTx();
    const jan = new Date('2026-01-05');
    const num = await generateDocumentNumber(tx, 'JV', jan, FISCAL_YEAR_ID);
    expect(num).toBe('JV-202601-0001');
  });

  it('handles sequence ≥ 1000 without truncation', async () => {
    const tx = makeTx({ 'JV-202603-': 999 });
    const num = await generateDocumentNumber(tx, 'JV', MARCH_2026, FISCAL_YEAR_ID);
    expect(num).toBe('JV-202603-1000');
  });

  it('moves to a 5-digit suffix after 9999', async () => {
    const tx = makeTx({ 'JV-202603-': 9999 });
    const num = await generateDocumentNumber(tx, 'JV', MARCH_2026, FISCAL_YEAR_ID);
    expect(num).toBe('JV-202603-10000');
  });

  it('continues a 5-digit series', async () => {
    const tx = makeTx({ 'SM-202603-': 10000 });
    const num = await generateDocumentNumber(tx, 'SM', MARCH_2026, FISCAL_YEAR_ID);
    expect(num).toBe('SM-202603-10001');
  });
});

describe('generateDocumentNumber — regression: MAX+1 vs deleted/backdated rows', () => {
  // Real-world bug (production, Jul 2026): count(month)=114 but max=SM-202607-0134
  // → count+1 collided with existing numbers → P2002 "Data duplikat terdeteksi".
  it('continues after the MAX even when rows were deleted (gap in series)', async () => {
    const tx = makeTx({ 'SM-202607-': 134 });
    const july = new Date('2026-07-03');
    const num = await generateDocumentNumber(tx, 'SM', july, FISCAL_YEAR_ID);
    expect(num).toBe('SM-202607-0135'); // NOT 0115 (count-based would collide)
  });

  it('starts a fresh month at 0001 regardless of other months', async () => {
    const tx = makeTx({ 'STT-202607-': 50 });
    const aug = new Date('2026-08-01');
    const num = await generateDocumentNumber(tx, 'STT', aug, FISCAL_YEAR_ID);
    expect(num).toBe('STT-202608-0001');
  });
});

describe('generateDocumentNumber — journals named after the document', () => {
  it('skips past an orphan JV-<number> journal', async () => {
    const tx = makeTx({ 'SI-202603-': 4, 'JV-SI-202603-': 7 });
    const num = await generateDocumentNumber(tx, 'SI', MARCH_2026, FISCAL_YEAR_ID);
    expect(num).toBe('SI-202603-0008');
  });

  it('skips past an orphan JV-COGS-<number> journal', async () => {
    const tx = makeTx({ 'SI-202603-': 4, 'JV-SI-202603-': 4, 'JV-COGS-SI-202603-': 9 });
    const num = await generateDocumentNumber(tx, 'SI', MARCH_2026, FISCAL_YEAR_ID);
    expect(num).toBe('SI-202603-0010');
  });

  it('queries the document series and both journal series for a journal-backed prefix', async () => {
    const tx = makeTx();
    await generateDocumentNumber(tx, 'STT', MARCH_2026, FISCAL_YEAR_ID);
    expect(queries(tx).map((q: { series: string }) => q.series)).toEqual([
      'STT-202603-', 'JV-STT-202603-', 'JV-COGS-STT-202603-',
    ]);
  });

  it.each(['JV', 'OB', 'DPR', 'DKB', 'PRO'] as const)('queries only its own series for %s', async (prefix) => {
    const tx = makeTx();
    await generateDocumentNumber(tx, prefix, MARCH_2026, FISCAL_YEAR_ID);
    expect(queries(tx).map((q: { series: string }) => q.series)).toEqual([`${prefix}-202603-`]);
  });
});

describe('generateDocumentNumber — table routing', () => {
  it.each([
    ['SI', '"sales_invoices"', '"invoice_number"'],
    ['PI', '"purchase_invoices"', '"invoice_number"'],
    ['PAY', '"payments"', '"payment_number"'],
    ['SM', '"stock_movements"', '"movement_number"'],
    ['PR', '"production_runs"', '"run_number"'],
    ['SO', '"stock_opnames"', '"opname_number"'],
    ['QO', '"quotations"', '"quotation_number"'],
    ['PRO', '"proforma_invoices"', '"proforma_number"'],
    ['INQ', '"inquiries"', '"inquiry_number"'],
    ['ST', '"stock_transfers"', '"transfer_number"'],
    ['DO', '"delivery_orders"', '"do_number"'],
    ['STT', '"goods_receipts"', '"stt_number"'],
    ['PO', '"purchase_orders"', '"po_number"'],
    ['PSN', '"sales_orders"', '"so_number"'],
    ['RN', '"sales_returns"', '"return_number"'],
    ['UJ', '"project_guarantees"', '"guarantee_number"'],
    ['PP', '"payment_requests"', '"number"'],
    ['DPR', '"production_run_drafts"', '"draft_number"'],
    ['DKB', '"cash_book_drafts"', '"draft_number"'],
    ['JV', '"journal_entries"', '"entry_number"'],
    ['OB', '"journal_entries"', '"entry_number"'],
  ] as const)('reads %s from %s.%s', async (prefix, table, column) => {
    const tx = makeTx();
    await generateDocumentNumber(tx, prefix, MARCH_2026, FISCAL_YEAR_ID);
    const [first] = queries(tx);
    expect(first.series).toBe(`${prefix}-202603-`);
    expect(first.sql).toContain(`FROM ${table}`);
    expect(first.sql).toContain(`starts_with(${column}`);
  });

  it('sends the series as a bind parameter and keeps only all-digit suffixes', async () => {
    const tx = makeTx();
    await generateDocumentNumber(tx, 'JV', MARCH_2026, FISCAL_YEAR_ID);
    const [first] = queries(tx);
    expect(first.sql).not.toContain('JV-202603-');
    expect(first.sql).toContain("~ '^[0-9]{1,15}$'");
    expect(first.sql).toContain('::bigint');
  });

  it('acquires advisory lock before querying the series', async () => {
    const tx = makeTx();
    await generateDocumentNumber(tx, 'SI', MARCH_2026, FISCAL_YEAR_ID);
    expect(tx.$executeRaw).toHaveBeenCalledOnce();
    const lockCallOrder = tx.$executeRaw.mock.invocationCallOrder[0];
    const queryCallOrder = tx.$queryRaw.mock.invocationCallOrder[0];
    expect(lockCallOrder).toBeLessThan(queryCallOrder);
  });
});
