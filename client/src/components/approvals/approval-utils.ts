/** Pure formatting + estimation helpers shared by ApprovalPanel and its detail dialog. */

import i18n from '@/i18n';
import { LOCALE } from '@/lib/format';

export const fmtNum = (n: number) => n.toLocaleString(LOCALE, { maximumFractionDigits: 3 });
export const fmtDate = (d: string) =>
  new Date(d).toLocaleDateString(LOCALE, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Request types with a translated label (`approvals:docTypes.*`). */
const REQUEST_DOC_TYPES = [
  'PurchaseInvoice',
  'ProductionRun',
  'SalesReturn',
  'DeliveryOrder',
  'PurchaseOrder',
  'ProductionRunEdit',
  'PurchaseInvoiceRevisePrice',
] as const;
type RequestDocType = (typeof REQUEST_DOC_TYPES)[number];
const isRequestDocType = (t: string): t is RequestDocType => (REQUEST_DOC_TYPES as readonly string[]).includes(t);

/** Display label for a known request document type, or the raw type when unknown. */
export const docTypeLabel = (t: string): string => (isRequestDocType(t) ? i18n.t(`approvals:docTypes.${t}`) : t);

/** Pengajuan yang MENGUBAH dokumen existing (bukan membuat baru) → tampil sebagai perbandingan. */
export const isEditApprovalType = (t: string) => t === 'ProductionRunEdit' || t === 'PurchaseInvoiceRevisePrice';

/** Permintaan dari agen AIRA lewat MCP (documentType `ai_tool:<nama>`): dijalankan sebagai pengaju saat disetujui. */
export const isAiToolApproval = (t: string) => t.startsWith('ai_tool:');

/** Label tampilan tipe pengajuan (mengenali ai_tool:*). */
export const approvalTypeLabel = (t: string) => (isAiToolApproval(t) ? i18n.t('approvals:docTypes.aiTool') : docTypeLabel(t));

/** 2 decimals, half-up (server: Decimal ROUND_HALF_UP). */
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// Line total (hargaAkhir) of one PI line in an approval payload, mirroring server
// purchaseInvoiceCalc.computePurchaseItem: qty = timbanganDiterima when > 0, else quantity;
// subtotal = qty×rate×(1−disc%), then + PPN − PPh − potonganItem, each step rounded to 2 decimals.
// The payload has no it.amount, so it is always computed.
export function piLineTotal(it: any): number {
  const received = Number(it.timbanganDiterima ?? 0);
  const qty = received > 0 ? received : Number(it.quantity ?? 0);
  const base = qty * Number(it.rate ?? 0);
  const subtotal = round2(base - base * (Number(it.discount ?? 0) / 100));
  const ppn = round2(subtotal * (Number(it.taxPct ?? 0) / 100));
  const pph = round2(subtotal * (Number(it.pphPct ?? 0) / 100));
  return round2(subtotal + ppn - pph - Number(it.potonganItem ?? 0));
}

export interface PiTotals {
  /** Σ line totals; each line already has its potonganItem deducted. */
  subtotal: number;
  potonganItem: number;
  biayaLain: number;
  grandTotal: number;
}

/** Totals from GET /approvals/requests/:id/context; headerPotonganMismatch = approve will refuse. */
export interface ServerPiTotals extends PiTotals {
  headerPotonganMismatch: boolean;
}

// Local PI totals estimate (fallback while the context loads). grandTotal = subtotal + biayaLain;
// the header potongan only caches Σ potonganItem and is never subtracted again.
export function piTotals(payload: any): PiTotals {
  const items: any[] = payload?.items ?? [];
  const subtotal = round2(items.reduce((s, it) => s + piLineTotal(it), 0));
  const potonganItem = round2(items.reduce((s, it) => s + Number(it.potonganItem ?? 0), 0));
  const biayaLain = Number(payload?.biayaLain ?? 0);
  return { subtotal, potonganItem, biayaLain, grandTotal: round2(subtotal + biayaLain) };
}

/** Server totals when the context has them, else the local estimate. */
export function resolvePiTotals(
  ctx: { piTotals?: ServerPiTotals | null } | null | undefined,
  payload: { potongan?: unknown; items?: unknown[]; biayaLain?: unknown } | null | undefined,
): ServerPiTotals {
  if (ctx?.piTotals) return ctx.piTotals;
  const local = piTotals(payload);
  const header = Number(payload?.potongan ?? 0);
  return { ...local, headerPotonganMismatch: header > 0 && Math.abs(header - local.potonganItem) > 0.01 };
}

// Estimasi HPP/Kg produksi dari payload. Material hanya pasti bila batchUnitCost
// terisi; jika tidak, material tak diketahui (return knownMaterial=false).
export function prodHppEstimate(payload: any): { hpp: number | null; knownMaterial: boolean; byproductValue: number; costTotal: number; mainQty: number } {
  const inputs: any[] = payload?.inputs ?? [];
  const outputs: any[] = payload?.outputs ?? [];
  const costs: any[] = payload?.costs ?? [];
  const mainQty = outputs.filter((o) => !o.isByProduct).reduce((s, o) => s + Number(o.quantity ?? 0), 0);
  const inputQty = inputs.reduce((s, i) => s + Number(i.quantity ?? 0), 0);
  const byproductValue = outputs.filter((o) => o.isByProduct).reduce((s, o) => s + Number(o.quantity ?? 0) * Number(o.unitPrice ?? 0), 0);
  // Material: hanya jika SEMUA input punya batchUnitCost > 0.
  const allHaveBatch = inputs.length > 0 && inputs.every((i) => Number(i.batchUnitCost ?? 0) > 0);
  const material = allHaveBatch ? inputs.reduce((s, i) => s + Number(i.quantity ?? 0) * Number(i.batchUnitCost ?? 0), 0) : 0;
  // Biaya: rate × basisQty (InputQty/OutputQty/Fixed).
  let costTotal = 0;
  for (const c of costs) {
    const rate = Number(c.rate ?? 0);
    if (c.basis === 'InputQty') costTotal += rate * inputQty;
    else if (c.basis === 'OutputQty') costTotal += rate * mainQty;
    else costTotal += rate; // Fixed
  }
  if (!allHaveBatch || mainQty <= 0) return { hpp: null, knownMaterial: allHaveBatch, byproductValue, costTotal: Math.round(costTotal), mainQty };
  const hpp = (material + costTotal - byproductValue) / mainQty;
  return { hpp: Math.round(hpp), knownMaterial: true, byproductValue, costTotal: Math.round(costTotal), mainQty };
}

/** Party / item names the server resolves in GET /approvals/requests/:id/context. */
export interface ApprovalLookupContext {
  party?: { id: string; name: string } | null;
  supplier?: { name?: string | null } | null;
  items?: Record<string, { name: string; unit: string }>;
  /** Purchase invoice totals by the posting formula; null for other types or an invalid payload. */
  piTotals?: ServerPiTotals | null;
}

export interface ApprovalLabels {
  partyName: (partyId: string | null | undefined) => string;
  itemName: (itemId: string | null | undefined) => string;
  itemUnit: (itemId: string | null | undefined) => string;
}

/**
 * Display labels for ids stored in an approval payload. While the context is loading the
 * placeholder is an ellipsis; a missing record falls back to a short id instead of a bare dash.
 */
export function approvalLabels(ctx: ApprovalLookupContext | null | undefined, loading: boolean): ApprovalLabels {
  const shortId = (id: string | null | undefined) => (id ? id.slice(0, 8) : '?');
  return {
    partyName: (partyId) => {
      if (!partyId) return '—';
      const name = (ctx?.party?.id === partyId ? ctx.party.name : null) ?? ctx?.supplier?.name;
      if (name) return name;
      return loading ? '…' : i18n.t('approvals:lookup.partyFallback', { id: shortId(partyId) });
    },
    itemName: (itemId) => {
      const name = itemId ? ctx?.items?.[itemId]?.name : undefined;
      if (name) return name;
      return loading ? '…' : i18n.t('approvals:lookup.itemFallback', { id: shortId(itemId) });
    },
    itemUnit: (itemId) => (itemId ? ctx?.items?.[itemId]?.unit : undefined) ?? '',
  };
}
