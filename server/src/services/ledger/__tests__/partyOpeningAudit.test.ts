import { describe, expect, it } from 'vitest';
import { Prisma, type PartyType } from '@prisma/client';
import { classifyPartyOpening, type PartyOpeningFigures, type PartyOpeningSide } from '../partyOpeningAudit';

const D = (v: number) => new Prisma.Decimal(v);
interface SideIn { gl?: number; docs?: number; adj?: number; payments?: number; cancelled?: number; journals?: number[] | null }
const side = (s: SideIn = {}): PartyOpeningSide => {
  const gl = D(s.gl ?? 0);
  const glOpening = gl.minus(s.docs ?? 0).minus(s.adj ?? 0);
  const journals = s.journals === null ? null : (s.journals ?? []);
  return {
    gl, documents: D(s.docs ?? 0), adjustment: D(s.adj ?? 0), glOpening, payments: s.payments ?? 0,
    cancelledPayments: D(s.cancelled ?? 0), consumed: D(0),
    journals: journals === null ? null : { entryNumbers: journals.map((_, i) => `JV-${i}`), amount: journals.reduce((a, b) => a.plus(b), D(0)) },
  };
};
const party = (partyType: PartyType, cols: { or?: number; op?: number; oo: number }, receivable: SideIn = {}, payable: SideIn = {}): PartyOpeningFigures => ({
  partyId: 'p', name: 'P', partyType, isDummy: false,
  openingReceivable: D(cols.or ?? 0), openingPayable: D(cols.op ?? 0), openingOutstanding: D(cols.oo),
  receivable: side(receivable), payable: side(payable),
});
const verdict = (f: PartyOpeningFigures) => {
  const v = classifyPartyOpening(f);
  return { cls: v.cls, side: v.side, target: v.target && [v.target.receivable.toFixed(2), v.target.payable.toFixed(2)] };
};

describe('classifyPartyOpening', () => {
  it('match: the column follows the ledger after a payment took 10', () => {
    expect(verdict(party('Customer', { or: 40, oo: 40 }, { gl: 40, journals: [50], payments: 1 })).cls).toBe('match');
  });

  it('opening-from-single-journal: an imported opening left undirected', () => {
    expect(verdict(party('Customer', { oo: 50 }, { gl: 50, journals: [50] })))
      .toEqual({ cls: 'opening-from-single-journal', side: 'RECEIVABLE', target: ['50.00', '0.00'] });
    // Also when the column was never filled at all.
    expect(verdict(party('Supplier', { oo: 0 }, {}, { gl: 30, journals: [30] })))
      .toEqual({ cls: 'opening-from-single-journal', side: 'PAYABLE', target: ['0.00', '30.00'] });
    // Not with a payment on the side: the accountant looks at it.
    expect(verdict(party('Customer', { oo: 0 }, { gl: 50, journals: [50], payments: 1 })).cls).toBe('unexplained');
  });

  it('consumed-opening-not-restored: a cancel before PR-5.13 left the opening low', () => {
    expect(verdict(party('Customer', { or: 50, oo: 40 }, { gl: 50, journals: [50], payments: 1, cancelled: 10 })))
      .toEqual({ cls: 'consumed-opening-not-restored', side: 'RECEIVABLE', target: ['50.00', '0.00'] });
    // More missing than the cancelled payments explain.
    expect(verdict(party('Customer', { or: 50, oo: 30 }, { gl: 50, journals: [50], payments: 1, cancelled: 10 })).cls).toBe('unexplained');
    // The ledger above the opening journals.
    expect(verdict(party('Customer', { or: 50, oo: 50 }, { gl: 60, journals: [50], payments: 1, cancelled: 20 })).cls).toBe('unexplained');
  });

  it('undirected-matches-gl: a Customer whose remainder cut opening_outstanding alone', () => {
    expect(verdict(party('Customer', { or: 50, oo: 40 }, { gl: 40, journals: [50], payments: 1 })))
      .toEqual({ cls: 'undirected-matches-gl', side: 'RECEIVABLE', target: ['40.00', '0.00'] });
  });

  it('Both: the ledger shows the split (report), or the accountant decides', () => {
    expect(verdict(party('Both', { oo: 50 }, { gl: 20, payments: 1 }, { gl: 30 })))
      .toEqual({ cls: 'both-direction-from-gl', side: null, target: ['20.00', '30.00'] });
    expect(verdict(party('Both', { oo: 50 }, { gl: 10, payments: 1 }, { gl: 0 })).cls).toBe('both-needs-accountant');
    // A Both opening imported to AR with a single journal is directed by that journal.
    expect(verdict(party('Both', { oo: 50 }, { gl: 50, journals: [50] }, {})).cls).toBe('opening-from-single-journal');
    expect(verdict(party('Both', { or: 20, op: 30, oo: 50 }, { gl: 20, journals: [20] }, { gl: 30, journals: [30] })).cls).toBe('match');
  });

  it('reports negative and off-side openings', () => {
    expect(verdict(party('Customer', { oo: -5 }, {})).cls).toBe('negative-opening');
    expect(verdict(party('Customer', { or: 10, oo: -5 }, { gl: 0 })).cls).toBe('negative-opening');
    expect(verdict(party('Customer', { op: 10, oo: 10 }, {})).cls).toBe('opening-off-side');
  });

  it('gl-without-opening: the ledger holds an opening with no column or journal', () => {
    expect(verdict(party('Supplier', { oo: 0 }, {}, { gl: 30, docs: 10, payments: 1 })).cls).toBe('gl-without-opening');
  });
});
