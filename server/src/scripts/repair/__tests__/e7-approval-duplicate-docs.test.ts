import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma', () => ({ prisma: {} }));

import { findCandidates, type CreatingType, type DocRow, type RequestRow } from '../e7-approval-duplicate-docs';

const T0 = new Date('2026-05-04T03:00:00Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

const doc = (over: Partial<DocRow>): DocRow => ({
  id: 'pi-1', number: 'PI-1', createdBy: 'staff', partyId: 'sup-1', day: '2026-05-04', qty: 1000,
  createdAt: at(0), cancelled: false, ...over,
});
const approved = (over: Partial<RequestRow> = {}): RequestRow => ({
  id: 'req-1', documentType: 'PurchaseInvoice', status: 'Approved', documentId: 'pi-1', requestedBy: 'staff',
  payload: null, createdAt: at(-60), decidedAt: at(0), ...over,
});
const docsOf = (type: CreatingType, rows: DocRow[]) => new Map<CreatingType, DocRow[]>([[type, rows]]);

describe('findCandidates: Approved requests', () => {
  it('reports an unlinked twin created within 10 minutes of the decision', () => {
    const rows = findCandidates([approved()], docsOf('PurchaseInvoice', [doc({}), doc({ id: 'pi-2', number: 'PI-2', createdAt: at(1) })]), new Set(['pi-1']));
    expect(rows).toEqual([expect.objectContaining({
      kind: 'duplicate', requestId: 'req-1', approvedDocumentNumber: 'PI-1', candidateId: 'pi-2', candidateNumber: 'PI-2', candidateCancelled: false,
    })]);
  });

  it('ignores twins outside the window, of another creator, party, day or quantity, or linked to a request', () => {
    const others = [
      doc({ id: 'late', createdAt: at(11) }),
      doc({ id: 'creator', createdBy: 'other', createdAt: at(1) }),
      doc({ id: 'party', partyId: 'sup-2', createdAt: at(1) }),
      doc({ id: 'day', day: '2026-05-05', createdAt: at(1) }),
      doc({ id: 'qty', qty: 999, createdAt: at(1) }),
      doc({ id: 'linked', createdAt: at(1) }),
    ];
    const rows = findCandidates([approved()], docsOf('PurchaseInvoice', [doc({}), ...others]), new Set(['pi-1', 'linked']));
    expect(rows).toEqual([]);
  });

  it('production runs match without a party', () => {
    const run = (id: string, minutes: number): DocRow => doc({ id, number: id, partyId: null, qty: 10_000, createdAt: at(minutes) });
    const rows = findCandidates(
      [approved({ documentType: 'ProductionRun', documentId: 'run-1' })],
      docsOf('ProductionRun', [run('run-1', 0), run('run-2', -2)]),
      new Set(['run-1']),
    );
    expect(rows.map((r) => r.candidateId)).toEqual(['run-2']);
  });
});

describe('findCandidates: Pending requests', () => {
  const pending = (payload: unknown): RequestRow => approved({ status: 'Pending', documentId: null, decidedAt: null, payload });

  it('reports a document matching the payload created after the request', () => {
    const payload = { date: '2026-05-04', partyId: 'sup-1', items: [{ quantity: 600 }, { quantity: '400' }] };
    const rows = findCandidates([pending(payload)], docsOf('PurchaseInvoice', [doc({ createdAt: at(5) })]), new Set());
    expect(rows).toEqual([expect.objectContaining({ kind: 'pending_with_document', requestStatus: 'Pending', approvedDocumentNumber: null, candidateId: 'pi-1' })]);
  });

  it('ignores documents created before the request and payloads without a date', () => {
    const payload = { date: '2026-05-04', partyId: 'sup-1', items: [{ quantity: 1000 }] };
    expect(findCandidates([pending(payload)], docsOf('PurchaseInvoice', [doc({ createdAt: at(-61) })]), new Set())).toEqual([]);
    expect(findCandidates([pending({ partyId: 'sup-1', items: [{ quantity: 1000 }] })], docsOf('PurchaseInvoice', [doc({})]), new Set())).toEqual([]);
  });

  it('sums production inputs, not outputs', () => {
    const payload = { date: '2026-05-04', inputs: [{ quantity: 10_000 }], outputs: [{ quantity: 6_000 }] };
    const run = doc({ id: 'run-1', partyId: null, qty: 10_000, createdAt: at(1) });
    const rows = findCandidates([{ ...pending(payload), documentType: 'ProductionRun' }], docsOf('ProductionRun', [run]), new Set());
    expect(rows.map((r) => r.candidateId)).toEqual(['run-1']);
  });
});
