/**
 * Which lines of a delivery note edit keep their stock movement (PR-6.5b, owner decision #9), pure.
 * Old and new lines are paired per (item, warehouse): first lines whose quantity did not change, then
 * the rest in line order. A paired line keeps the cost its movement was posted at
 * (inventoryLedger.reviseOutbound); an old line left over is reversed at its own value; a new line
 * left over is posted at the book's value now.
 */
import Decimal from 'decimal.js';

/** An old line with an active Out movement. */
export interface EditOldLine {
  movementId: string;
  itemId: string;
  warehouseId: string;
  quantity: Decimal.Value;
}

/** A stock line of the edit body, by its index in body.items. */
export interface EditNewLine {
  index: number;
  itemId: string;
  warehouseId: string;
  quantity: Decimal.Value;
}

export interface EditPairedLine {
  index: number;
  movementId: string;
  oldQuantity: Decimal;
  newQuantity: Decimal;
}

export interface DeliveryOrderEditPlan {
  paired: EditPairedLine[];
  /** Movements of old lines no new line takes over. */
  removed: string[];
  /** Indices of new lines with no old line to keep. */
  added: number[];
}

const keyOf = (l: { itemId: string; warehouseId: string }) => `${l.itemId}::${l.warehouseId}`;

function groupBy<T extends { itemId: string; warehouseId: string }>(lines: readonly T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const l of lines) groups.set(keyOf(l), [...(groups.get(keyOf(l)) ?? []), l]);
  return groups;
}

function pairGroup(olds: readonly EditOldLine[], news: readonly EditNewLine[]): DeliveryOrderEditPlan {
  const paired: EditPairedLine[] = [];
  const freeOld = [...olds];
  const unmatched: EditNewLine[] = [];
  const pair = (o: EditOldLine, n: EditNewLine) => paired.push({
    index: n.index, movementId: o.movementId, oldQuantity: new Decimal(o.quantity), newQuantity: new Decimal(n.quantity),
  });
  for (const n of news) {
    const at = freeOld.findIndex((o) => new Decimal(o.quantity).eq(n.quantity));
    if (at < 0) {
      unmatched.push(n);
      continue;
    }
    pair(freeOld[at]!, n);
    freeOld.splice(at, 1);
  }
  const added: number[] = [];
  for (const n of unmatched) {
    const o = freeOld.shift();
    if (o) pair(o, n);
    else added.push(n.index);
  }
  return { paired, removed: freeOld.map((o) => o.movementId), added };
}

export function planDeliveryOrderEdit(olds: readonly EditOldLine[], news: readonly EditNewLine[]): DeliveryOrderEditPlan {
  const oldGroups = groupBy(olds);
  const newGroups = groupBy(news);
  const keys = [...new Set([...oldGroups.keys(), ...newGroups.keys()])];
  const parts = keys.map((k) => pairGroup(oldGroups.get(k) ?? [], newGroups.get(k) ?? []));
  return {
    paired: parts.flatMap((p) => p.paired).sort((a, b) => a.index - b.index),
    removed: parts.flatMap((p) => p.removed),
    added: parts.flatMap((p) => p.added).sort((a, b) => a - b),
  };
}
