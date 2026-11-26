import { describe, it, expect } from 'vitest';
import { planDeliveryOrderEdit } from '../deliveryOrderEditPlan';

const old = (movementId: string, itemId: string, warehouseId: string, quantity: number) => ({ movementId, itemId, warehouseId, quantity });
const line = (index: number, itemId: string, warehouseId: string, quantity: number) => ({ index, itemId, warehouseId, quantity });
const pairs = (plan: ReturnType<typeof planDeliveryOrderEdit>) =>
  plan.paired.map((p) => [p.index, p.movementId, p.oldQuantity.toNumber(), p.newQuantity.toNumber()]);

describe('planDeliveryOrderEdit', () => {
  it('keeps every line of an unchanged note', () => {
    const plan = planDeliveryOrderEdit([old('m1', 'i1', 'w1', 100), old('m2', 'i2', 'w1', 5)], [line(0, 'i1', 'w1', 100), line(1, 'i2', 'w1', 5)]);
    expect(pairs(plan)).toEqual([[0, 'm1', 100, 100], [1, 'm2', 5, 5]]);
    expect(plan.removed).toEqual([]);
    expect(plan.added).toEqual([]);
  });

  it('pairs a changed quantity on the same item and warehouse', () => {
    const plan = planDeliveryOrderEdit([old('m1', 'i1', 'w1', 100)], [line(0, 'i1', 'w1', 120)]);
    expect(pairs(plan)).toEqual([[0, 'm1', 100, 120]]);
  });

  it('treats another warehouse as a removed line and a new one', () => {
    const plan = planDeliveryOrderEdit([old('m1', 'i1', 'w1', 100)], [line(0, 'i1', 'w2', 100)]);
    expect(plan.paired).toEqual([]);
    expect(plan.removed).toEqual(['m1']);
    expect(plan.added).toEqual([0]);
  });

  it('pairs equal quantities first when one item has several lines, whatever the order', () => {
    const plan = planDeliveryOrderEdit(
      [old('m1', 'i1', 'w1', 30), old('m2', 'i1', 'w1', 70)],
      [line(0, 'i1', 'w1', 70), line(1, 'i1', 'w1', 40), line(2, 'i1', 'w1', 10)],
    );
    expect(pairs(plan)).toEqual([[0, 'm2', 70, 70], [1, 'm1', 30, 40]]);
    expect(plan.added).toEqual([2]);
    expect(plan.removed).toEqual([]);
  });

  it('removes old lines no new line takes over', () => {
    const plan = planDeliveryOrderEdit([old('m1', 'i1', 'w1', 30), old('m2', 'i2', 'w1', 70)], [line(0, 'i2', 'w1', 50)]);
    expect(pairs(plan)).toEqual([[0, 'm2', 70, 50]]);
    expect(plan.removed).toEqual(['m1']);
  });
});
