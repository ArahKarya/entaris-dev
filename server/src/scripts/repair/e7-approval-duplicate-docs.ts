// Read-only report of documents an approval may have created twice (E7-R1, M-26 / G-55).
// Before the atomic claim, two approvals of one request (double click, web + Telegram) could each
// create the document, and a crash between the document commit and the status update left the
// request Pending with its document already made. This script lists candidates only; the
// accountant checks each one and cancels a real duplicate through the normal cancel path. It never
// writes to the database.
//
// Two kinds of candidates, for requests that create a document (PurchaseInvoice, ProductionRun,
// SalesReturn, DeliveryOrder):
// - duplicate: an Approved request's document has a twin of the same type with the same creator
//   (the requester), party key, business day and total quantity, created within ±10 minutes of the
//   decision and not the document of any approval request;
// - pending_with_document: a Pending request whose payload (creator, party, day, total quantity)
//   matches a document created after the request and not the document of any approval request.
// The party key is the source invoice for a SalesReturn (its payload has no partyId) and the
// party otherwise; a purchase invoice line counts its weighed quantity when one was typed.
// Two genuine documents with equal values in the same window are reported too: candidates only.
//
// Usage (from server/, DATABASE_URL set):
//   node dist/scripts/repair/e7-approval-duplicate-docs.js [--out file.csv]
//   (or `npx tsx src/scripts/repair/e7-approval-duplicate-docs.ts …` from a source checkout)

import { writeFileSync } from 'node:fs';
import { prisma } from '../../lib/prisma';
import { csvCell } from '../../utils/csv';
import { businessDayOf } from '../../utils/businessDate';

export const CREATING_TYPES = ['PurchaseInvoice', 'ProductionRun', 'SalesReturn', 'DeliveryOrder'] as const;
export type CreatingType = (typeof CREATING_TYPES)[number];

export const WINDOW_MS = 10 * 60 * 1000;

export interface RequestRow {
  id: string;
  documentType: CreatingType;
  status: string;
  documentId: string | null;
  requestedBy: string;
  payload: unknown;
  createdAt: Date;
  decidedAt: Date | null;
}

export interface DocRow {
  id: string;
  number: string;
  createdBy: string;
  // Source sales invoice for a SalesReturn, party otherwise (null for a ProductionRun).
  partyKey: string | null;
  day: string;
  qty: number;
  createdAt: Date;
  cancelled: boolean;
}

export interface CandidateRow {
  kind: 'duplicate' | 'pending_with_document';
  requestId: string;
  documentType: CreatingType;
  requestStatus: string;
  approvedDocumentNumber: string | null;
  candidateId: string;
  candidateNumber: string;
  candidateCreatedAt: Date;
  candidateCancelled: boolean;
}

// Quantity that identifies a document: production inputs, line quantities otherwise. A purchase
// invoice stores the weighed quantity when it is set (purchaseInvoiceCalc.effectiveQuantity).
function payloadQty(type: CreatingType, payload: Record<string, unknown>): number {
  const lines = (type === 'ProductionRun' ? payload.inputs : payload.items) as
    | Array<{ quantity?: unknown; timbanganDiterima?: unknown }>
    | undefined;
  return (lines ?? []).reduce((s, l) => {
    const weighed = type === 'PurchaseInvoice' ? Number(l.timbanganDiterima ?? 0) : 0;
    return s + (weighed > 0 ? weighed : Number(l.quantity ?? 0));
  }, 0);
}

// Same key as loadDocs stores: the source invoice for a SalesReturn, the party otherwise.
function payloadPartyKey(type: CreatingType, payload: Record<string, unknown>): string | null {
  const key = type === 'SalesReturn' ? payload.salesInvoiceId : payload.partyId;
  return typeof key === 'string' ? key : null;
}

const sameSignature = (a: Pick<DocRow, 'createdBy' | 'partyKey' | 'day' | 'qty'>, b: DocRow) =>
  a.createdBy === b.createdBy && a.partyKey === b.partyKey && a.day === b.day && Math.abs(a.qty - b.qty) < 1e-6;

/**
 * Pure matcher. `docs` holds the documents of each type; `linkedDocIds` every documentId of any
 * approval request (those are accounted for and never reported as a twin).
 */
export function findCandidates(
  requests: readonly RequestRow[],
  docs: ReadonlyMap<CreatingType, readonly DocRow[]>,
  linkedDocIds: ReadonlySet<string>,
): CandidateRow[] {
  const out: CandidateRow[] = [];
  for (const r of requests) {
    const pool = docs.get(r.documentType) ?? [];
    const unlinked = (d: DocRow) => !linkedDocIds.has(d.id);
    if (r.status === 'Approved' && r.documentId && r.decidedAt) {
      const own = pool.find((d) => d.id === r.documentId);
      if (!own) continue;
      const at = r.decidedAt.getTime();
      for (const d of pool) {
        if (d.id === own.id || !unlinked(d) || Math.abs(d.createdAt.getTime() - at) > WINDOW_MS) continue;
        if (sameSignature(own, d)) out.push(row('duplicate', r, own.number, d));
      }
    } else if (r.status === 'Pending' && r.payload && typeof r.payload === 'object') {
      const p = r.payload as Record<string, unknown>;
      if (typeof p.date !== 'string') continue;
      const wanted = {
        createdBy: r.requestedBy,
        partyKey: payloadPartyKey(r.documentType, p),
        day: p.date.slice(0, 10),
        qty: payloadQty(r.documentType, p),
      };
      for (const d of pool) {
        if (!unlinked(d) || d.createdAt < r.createdAt) continue;
        if (sameSignature(wanted, d)) out.push(row('pending_with_document', r, null, d));
      }
    }
  }
  return out;
}

function row(kind: CandidateRow['kind'], r: RequestRow, approvedNumber: string | null, d: DocRow): CandidateRow {
  return {
    kind,
    requestId: r.id,
    documentType: r.documentType,
    requestStatus: r.status,
    approvedDocumentNumber: approvedNumber,
    candidateId: d.id,
    candidateNumber: d.number,
    candidateCreatedAt: d.createdAt,
    candidateCancelled: d.cancelled,
  };
}

const sumQty = (items: ReadonlyArray<{ quantity: unknown }>) => items.reduce((s, i) => s + Number(i.quantity), 0);

// Documents created by the given users (requesters), one query per type.
async function loadDocs(creators: string[]): Promise<Map<CreatingType, DocRow[]>> {
  const day = (d: Date) => businessDayOf(d);
  const [pis, runs, returns, dos] = await Promise.all([
    prisma.purchaseInvoice.findMany({
      where: { createdBy: { in: creators } },
      select: { id: true, invoiceNumber: true, createdBy: true, partyId: true, date: true, createdAt: true, status: true, items: { select: { quantity: true } } },
    }),
    prisma.productionRun.findMany({
      where: { createdById: { in: creators } },
      select: { id: true, runNumber: true, createdById: true, date: true, createdAt: true, isCancelled: true, items: { where: { lineType: 'Input' }, select: { quantity: true } } },
    }),
    prisma.salesReturn.findMany({
      where: { createdBy: { in: creators } },
      select: { id: true, returnNumber: true, createdBy: true, salesInvoiceId: true, date: true, createdAt: true, status: true, items: { select: { quantity: true } } },
    }),
    prisma.deliveryOrder.findMany({
      where: { createdBy: { in: creators } },
      select: { id: true, doNumber: true, createdBy: true, partyId: true, date: true, createdAt: true, status: true, items: { select: { quantity: true } } },
    }),
  ]);
  return new Map<CreatingType, DocRow[]>([
    ['PurchaseInvoice', pis.map((d) => ({ id: d.id, number: d.invoiceNumber, createdBy: d.createdBy, partyKey: d.partyId, day: day(d.date), qty: sumQty(d.items), createdAt: d.createdAt, cancelled: d.status === 'Cancelled' }))],
    ['ProductionRun', runs.map((d) => ({ id: d.id, number: d.runNumber, createdBy: d.createdById, partyKey: null, day: day(d.date), qty: sumQty(d.items), createdAt: d.createdAt, cancelled: d.isCancelled }))],
    ['SalesReturn', returns.map((d) => ({ id: d.id, number: d.returnNumber, createdBy: d.createdBy, partyKey: d.salesInvoiceId, day: day(d.date), qty: sumQty(d.items), createdAt: d.createdAt, cancelled: d.status === 'Cancelled' }))],
    ['DeliveryOrder', dos.map((d) => ({ id: d.id, number: d.doNumber, createdBy: d.createdBy, partyKey: d.partyId, day: day(d.date), qty: sumQty(d.items), createdAt: d.createdAt, cancelled: d.status === 'Cancelled' }))],
  ]);
}

function parseArgs(argv: readonly string[]): { out: string | null } {
  const opts = { out: null as string | null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opts.out = argv[++i] ?? null;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const requests = (await prisma.approvalRequest.findMany({
    where: { documentType: { in: [...CREATING_TYPES] }, status: { in: ['Approved', 'Pending'] } },
    select: { id: true, documentType: true, status: true, documentId: true, requestedBy: true, payload: true, createdAt: true, decidedAt: true },
  })) as RequestRow[];
  const linked = await prisma.approvalRequest.findMany({ where: { documentId: { not: null } }, select: { documentId: true } });
  const linkedDocIds = new Set(linked.map((l) => l.documentId!));
  const docs = await loadDocs([...new Set(requests.map((r) => r.requestedBy))]);
  const rows = findCandidates(requests, docs, linkedDocIds);

  if (opts.out) {
    const header = 'kind,request_id,document_type,request_status,approved_document,candidate_id,candidate_number,candidate_created_at,candidate_cancelled';
    const lines = rows.map((r) =>
      [r.kind, r.requestId, r.documentType, r.requestStatus, r.approvedDocumentNumber, r.candidateId, r.candidateNumber, r.candidateCreatedAt, r.candidateCancelled]
        .map(csvCell)
        .join(','),
    );
    writeFileSync(opts.out, `${[header, ...lines].join('\n')}\n`, 'utf8');
    console.log(`CSV: ${opts.out}`);
  }
  const dup = rows.filter((r) => r.kind === 'duplicate').length;
  console.log(`READ ONLY: ${requests.length} approval request(s) checked; ${dup} duplicate candidate(s), ${rows.length - dup} Pending request(s) with a matching document`);
}

// Run only as a script, not when a test imports the matcher.
if (typeof require !== 'undefined' && require.main === module) {
  main()
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
