import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { absorbUntrackedOutbound, batchShortfalls, type InboundBatch } from '../batchAvailability';

let seq = 0;
/** A batch of `quantity`, `consumed` of it linked back by outbound rows, received in call order. */
function batch(quantity: number, consumed = 0): InboundBatch {
  seq += 1;
  return {
    id: `b${seq}`, movementNumber: `SM-${seq}`, date: new Date(Date.UTC(2026, 0, seq)), warehouseId: 'wh',
    quantity: new Decimal(quantity), unitCost: new Decimal(6000), consumedTracked: new Decimal(consumed),
    referenceType: null, referenceId: null, referenceNumber: null,
  };
}

const left = (rows: ReturnType<typeof absorbUntrackedOutbound>) => rows.map((r) => [r.available.toNumber(), r.consumed.toNumber()]);

describe('absorbUntrackedOutbound', () => {
  it('absorbs outbound without a batch link from the oldest batches first', () => {
    // 3 batches of 1.000 / 2.000 / 500, 300 taken from the second by a linked row: 3.200 tracked.
    // 1.700 held, so 1.500 went out unlinked: the first batch is used up, the second loses 500.
    const rows = absorbUntrackedOutbound([batch(1000), batch(2000, 300), batch(500)], 1700);
    expect(left(rows)).toEqual([[0, 1000], [1200, 800], [500, 0]]);
    expect(rows.reduce((s, r) => s.plus(r.available), new Decimal(0)).toNumber()).toBe(1700);
  });

  it('absorbs nothing when the stock held covers the tracked availability, and skips used-up batches', () => {
    expect(left(absorbUntrackedOutbound([batch(1000), batch(500)], 2000))).toEqual([[1000, 0], [500, 0]]);
    expect(left(absorbUntrackedOutbound([batch(400, 400), batch(600)], 100))).toEqual([[0, 400], [100, 500]]);
  });

  it('leaves no batch available when nothing is held', () => {
    expect(left(absorbUntrackedOutbound([batch(1000), batch(500, 100)], 0))).toEqual([[0, 1000], [0, 500]]);
  });
});

describe('batchShortfalls', () => {
  const available = new Map([['b-a', new Decimal(3000)], ['b-b', new Decimal(800)]]);

  it('sums the lines on one batch: 2.000 + 1.500 from a batch holding 3.000 is short', () => {
    expect(batchShortfalls([
      { inputLine: 1, sourceMovementId: 'b-a', quantity: 2000 },
      { inputLine: 2, sourceMovementId: 'b-b', quantity: 800 },
      { inputLine: 3, sourceMovementId: 'b-a', quantity: 1500 },
    ], available)).toEqual([{ sourceMovementId: 'b-a', inputLine: 1, needed: new Decimal(3500), available: new Decimal(3000) }]);
  });

  it('passes lines within the batch, the whole of it included, and fails a batch that holds nothing', () => {
    expect(batchShortfalls([
      { inputLine: 1, sourceMovementId: 'b-a', quantity: 1000 },
      { inputLine: 2, sourceMovementId: 'b-a', quantity: 2000 },
    ], available)).toEqual([]);
    expect(batchShortfalls([{ inputLine: 4, sourceMovementId: 'b-gone', quantity: '0.5' }], available))
      .toEqual([{ sourceMovementId: 'b-gone', inputLine: 4, needed: new Decimal('0.5'), available: new Decimal(0) }]);
  });
});
