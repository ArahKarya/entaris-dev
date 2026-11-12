import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { parseDriftPlanCsv, stalePlanErrors } from '../stockDriftPlan';

const HEADER = 'item_code,item_id,drift,action,warehouse_code,quantity';
const csv = (...rows: string[]) => [HEADER, ...rows].join('\n');

describe('parseDriftPlanCsv', () => {
  it('takes a blank quantity as the whole drift and leaves undecided rows out', () => {
    const plan = parseDriftPlanCsv(csv('GKP,i-1,100.000,assign,GDG-A,', 'BRS,i-2,50,writeoff,,', 'MNR,i-3,7,,,'));
    expect(plan.errors).toEqual([]);
    expect(plan.blank).toBe(1);
    expect(plan.items.map((p) => [p.itemId, p.drift.toString(), p.assignments.map((a) => [a.warehouseCode, a.quantity.toString()]), p.writeOff.toString()]))
      .toEqual([['i-1', '100', [['GDG-A', '100']], '0'], ['i-2', '50', [], '50']]);
  });

  it('splits an item over rows that add up to its drift, case-insensitive action, Indonesian decimal comma', () => {
    const plan = parseDriftPlanCsv(csv('GKP,i-1,12.5,Assign,GDG-A,10', 'GKP,i-1,12.5,assign,GDG-B,"2,25"', 'GKP,i-1,12.5,WRITEOFF,,0.25'));
    expect(plan.errors).toEqual([]);
    const [p] = plan.items;
    expect(p.assignments.map((a) => `${a.warehouseCode}:${a.quantity}`)).toEqual(['GDG-A:10', 'GDG-B:2.25']);
    expect(p.writeOff.toString()).toBe('0.25');
    expect(p.lines).toEqual([2, 3, 4]);
  });

  it('reads a semicolon-delimited sheet', () => {
    const plan = parseDriftPlanCsv('item_id;drift;action;warehouse_code;quantity\ni-1;5;assign;GDG-A;5');
    expect(plan.errors).toEqual([]);
    expect(plan.items).toHaveLength(1);
  });

  it('refuses quantities that do not add up to the drift, and applies nothing', () => {
    const plan = parseDriftPlanCsv(csv('GKP,i-1,100,assign,GDG-A,60', 'GKP,i-1,100,writeoff,,30', 'BRS,i-2,5,writeoff,,'));
    expect(plan.errors).toEqual(['item i-1 (lines 2, 3): the quantities add up to 90, the drift is 100.']);
    expect(plan.items).toEqual([]);
  });

  it.each([
    ['an unknown action', 'GKP,i-1,100,keep,,', /action "keep" is not assign or writeoff/],
    ['assign without a warehouse', 'GKP,i-1,100,assign,,', /assign needs a warehouse_code/],
    ['writeoff with a warehouse', 'GKP,i-1,100,writeoff,GDG-A,', /writeoff takes no warehouse_code/],
    ['a quantity with 4 decimals', 'GKP,i-1,100,assign,GDG-A,99.0001', /quantity "99.0001" is not a non-zero number/],
    ['a zero quantity', 'GKP,i-1,100,assign,GDG-A,0', /quantity "0" is not a non-zero number/],
    ['a thousands separator', 'GKP,i-1,1000,assign,GDG-A,"1.000,5"', /quantity "1.000,5"/],
    ['a missing drift', 'GKP,i-1,,assign,GDG-A,5', /drift "" is not the drift of the dry run/],
    ['a writeoff of a negative drift', 'GKP,i-1,-5,writeoff,,', /only assign \(negative quantities\)/],
    ['a quantity against the sign of the drift', 'GKP,i-1,-5,assign,GDG-A,5', /sign of the drift -5/],
  ])('refuses %s', (_label, row, message) => {
    const plan = parseDriftPlanCsv(csv(row));
    expect(plan.errors.join('\n')).toMatch(message);
    expect(plan.items).toEqual([]);
  });

  it('allows a negative drift assigned out of a warehouse, also as the dry run writes it (\'-5)', () => {
    const plan = parseDriftPlanCsv(csv("GKP,i-1,'-5,assign,GDG-A,"));
    expect(plan.errors).toEqual([]);
    expect(plan.items[0].assignments[0].quantity.toString()).toBe('-5');
  });

  it('refuses a split item with a blank quantity and rows with different drifts', () => {
    expect(parseDriftPlanCsv(csv('GKP,i-1,10,assign,GDG-A,', 'GKP,i-1,10,writeoff,,5')).errors.join('\n'))
      .toMatch(/a split item needs a quantity on every row/);
    expect(parseDriftPlanCsv(csv('GKP,i-1,10,assign,GDG-A,5', 'GKP,i-1,11,writeoff,,5')).errors.join('\n'))
      .toMatch(/different drift values/);
  });

  it('names the missing columns', () => {
    expect(parseDriftPlanCsv('item_id,action\ni-1,assign').errors).toEqual([
      'Missing column "drift".', 'Missing column "warehouse_code".', 'Missing column "quantity".',
    ]);
  });
});

describe('stalePlanErrors', () => {
  const [plan] = parseDriftPlanCsv(csv('GKP,i-1,100,writeoff,,')).items;

  it('passes a plan whose drift is unchanged', () => {
    expect(stalePlanErrors([plan], new Map([['i-1', new Decimal('100.000')]]))).toEqual([]);
  });

  it('refuses a plan whose item drift changed or is gone', () => {
    expect(stalePlanErrors([plan], new Map([['i-1', new Decimal(90)]]))).toEqual([
      'item i-1: the drift is 90 now, the plan was made for 100; run the dry run again.',
    ]);
    expect(stalePlanErrors([plan], new Map())).toEqual(['item i-1: not found or no drift any more; run the dry run again.']);
  });
});
