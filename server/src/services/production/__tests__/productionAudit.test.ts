import { describe, it, expect } from 'vitest';
import { batchCostFindings, type BatchCostRow } from '../productionAudit';

let seq = 0;
/** A row of item I, posted in call order (createdAt). */
function row(movementType: BatchCostRow['movementType'], quantity: number, unitCost: number, extra: Partial<BatchCostRow> = {}): BatchCostRow {
  seq += 1;
  return {
    id: `m${String(seq).padStart(3, '0')}`, movementNumber: `SM-${seq}`, date: new Date('2026-03-01'), itemId: 'I',
    movementType, quantity, unitCost, totalValue: (quantity * unitCost).toFixed(2), createdAt: new Date(1_000 * seq),
    runId: null, runNumber: null, sourceMovementId: null, ...extra,
  };
}

const runInput = (quantity: number, unitCost: number, batch: string) =>
  row('Out', quantity, unitCost, { runId: 'run-1', runNumber: 'PR-1', sourceMovementId: batch, referenceType: 'ProductionRun' });

describe('batch-costed production runs', () => {
  it('reports an input valued at the batch cost with what it over-credited (PRD: 5.000 kg @7.000 at an average of 6.000)', () => {
    const lowBatch = row('In', 5_000, 5_000);
    const batch = row('In', 5_000, 7_000);
    const input = runInput(5_000, 7_000, batch.id);
    expect(batchCostFindings([lowBatch, batch, input])).toEqual([expect.objectContaining({
      runId: 'run-1', runNumber: 'PR-1', movementId: input.id, sourceMovementId: batch.id,
      replayedAverage: '6000.000000', difference: '5000000.00', note: 'unit cost differs from the replayed average',
    })]);
  });

  it('lists an input at the average with no difference, and skips run inputs without a batch and other outbound rows', () => {
    const batch = row('In', 1_000, 6_000);
    const rows = [batch, runInput(100, 6_000, batch.id), row('Out', 100, 5_000, { runId: 'run-2' }), row('Out', 50, 1)];
    expect(batchCostFindings(rows).map((f) => [f.movementId, f.difference, f.note])).toEqual([
      [rows[1].id, '0.00', 'at the replayed average'],
    ]);
  });

  it('flags an input with no costed inbound before it', () => {
    const input = runInput(10, 100, 'gone');
    expect(batchCostFindings([input])).toMatchObject([{ replayedAverage: '0.000000', difference: '1000.00', note: 'no costed inbound before the input (stock may predate its movements)' }]);
  });
});
