/**
 * Draft Data Produksi. Input produksi TIDAK langsung diposting: disimpan dulu
 * sebagai draft (tabel production_run_drafts) tanpa efek stok/GL/HPP/COGS/OEE.
 * Posting = aksi eksplisit (langsung utk role approval.bypass, via antrian
 * approval utk role lain). Lihat routes/inventory/productionRunDrafts.ts.
 */
import type { Prisma } from '@prisma/client';
import { BusinessError } from '../utils/errors';
import { generateDocumentNumber } from '../utils/documentNumber';
import { CreateProductionRunSchema } from '../utils/schemas';
import { getWarehouseStockMap, resolveWarehouseId } from '../utils/warehouseStock';
import { stockKey } from './inventory/stockLocks';
import { queueApproval } from './approvalGate';
import { submitProductionRunInTx } from './productionRunSubmit';

type Tx = Prisma.TransactionClient;
type Body = ReturnType<typeof CreateProductionRunSchema.parse>;

export const DRAFT_STATUSES = ['Draft', 'PendingApproval', 'Posted', 'Discarded'] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

export interface DraftSummary {
  inputQty: number;
  outputQty: number;
  inputCount: number;
  outputCount: number;
  mainOutput: string | null;
  inputNames: string[];
}

const fmtQty = (n: number) => n.toLocaleString('id-ID', { maximumFractionDigits: 3 });

/** Ringkasan utk daftar (pure). `names` = itemId → nama item. */
export function summarizeDraftPayload(
  body: Pick<Body, 'inputs' | 'outputs'>,
  names: ReadonlyMap<string, string>,
): DraftSummary {
  const sum = (xs: Array<{ quantity: number }>) => xs.reduce((s, x) => s + Number(x.quantity || 0), 0);
  const main = body.outputs.find((o) => !o.isByProduct) ?? body.outputs[0];
  const inputNames = [...new Set(body.inputs.map((i) => names.get(i.itemId)).filter((n): n is string => !!n))];
  return {
    inputQty: sum(body.inputs),
    outputQty: sum(body.outputs),
    inputCount: body.inputs.length,
    outputCount: body.outputs.length,
    mainOutput: main ? names.get(main.itemId) ?? null : null,
    inputNames,
  };
}

/**
 * Non-blocking warning: the input stock at the production warehouse is short now, lines of one item
 * summed (posting checks again, under the stock locks). `stock` holds that warehouse's stock.
 */
export function buildStockWarnings(
  inputs: Array<{ itemId: string; quantity: number }>,
  stock: ReadonlyMap<string, { name: string; unit: string; currentStock: number }>,
  warehouseName: string,
): string[] {
  const need = new Map<string, number>();
  for (const i of inputs) need.set(i.itemId, (need.get(i.itemId) ?? 0) + Number(i.quantity));
  const out: string[] = [];
  for (const [itemId, qty] of need) {
    const s = stock.get(itemId);
    if (s && s.currentStock < qty) {
      out.push(`Stok '${s.name}' di gudang ${warehouseName} saat ini ${fmtQty(s.currentStock)} ${s.unit}, dibutuhkan ${fmtQty(qty)} ${s.unit}. Dicek ulang saat posting.`);
    }
  }
  return out;
}

/** Names of the payload's items (1 query). */
async function loadItemNames(tx: Tx, body: Pick<Body, 'inputs' | 'outputs'>) {
  const ids = [...new Set([...body.inputs, ...body.outputs].map((l) => l.itemId))];
  const items = await tx.inventoryItem.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, unit: true },
  });
  return new Map(items.map((i) => [i.id, { name: i.name, unit: i.unit }]));
}

/**
 * Warnings for the inputs against the stock at the production warehouse (the payload's, else the
 * default), read without a lock. No warehouse: none (posting rejects the run).
 */
async function stockWarnings(tx: Tx, body: Body, names: Map<string, { name: string; unit: string }>): Promise<string[]> {
  if (body.allowNegativeStock) return [];
  const warehouseId = await resolveWarehouseId(tx, body.warehouseId);
  if (!warehouseId) return [];
  const warehouse = await tx.warehouse.findUnique({ where: { id: warehouseId }, select: { name: true } });
  const ids = [...new Set(body.inputs.map((i) => i.itemId))];
  const atWarehouse = await getWarehouseStockMap(tx, ids.map((itemId) => ({ itemId, warehouseId })));
  const stock = new Map(ids.flatMap((id) => {
    const n = names.get(id);
    return n ? [[id, { ...n, currentStock: atWarehouse.get(stockKey(id, warehouseId)) ?? 0 }] as const] : [];
  }));
  return buildStockWarnings(body.inputs, stock, warehouse?.name ?? warehouseId);
}

async function describe(tx: Tx, body: Body) {
  const names = await loadItemNames(tx, body);
  const summary = summarizeDraftPayload(body, new Map([...names].map(([k, v]) => [k, v.name])));
  const warnings = await stockWarnings(tx, body, names);
  return { summary: summary as unknown as Prisma.InputJsonValue, warnings };
}

export async function createDraft(tx: Tx, body: Body, rawBody: unknown, userId: string) {
  const { summary, warnings } = await describe(tx, body);
  const draftNumber = await generateDocumentNumber(tx, 'DPR', new Date(), '');
  const draft = await tx.productionRunDraft.create({
    data: {
      draftNumber,
      date: new Date(body.date),
      notes: body.notes ?? null,
      warehouseId: body.warehouseId ?? null,
      summary,
      payload: rawBody as Prisma.InputJsonValue,
      status: 'Draft',
      createdById: userId,
    },
  });
  return { draft, warnings };
}

/** Update hanya selagi status Draft (atomik lewat updateMany + guard status). */
export async function updateDraft(tx: Tx, id: string, body: Body, rawBody: unknown, userId: string) {
  const { summary, warnings } = await describe(tx, body);
  const res = await tx.productionRunDraft.updateMany({
    where: { id, status: 'Draft' },
    data: {
      date: new Date(body.date),
      notes: body.notes ?? null,
      warehouseId: body.warehouseId ?? null,
      summary,
      payload: rawBody as Prisma.InputJsonValue,
      updatedById: userId,
      lastError: null,
    },
  });
  if (res.count === 0) throw new BusinessError('Draft hanya bisa diubah selama berstatus Draft.');
  const draft = await tx.productionRunDraft.findUnique({ where: { id } });
  return { draft, warnings };
}

export async function discardDraft(tx: Tx, id: string, userId: string) {
  const res = await tx.productionRunDraft.updateMany({
    where: { id, status: 'Draft' },
    data: { status: 'Discarded', updatedById: userId },
  });
  if (res.count === 0) throw new BusinessError('Hanya draft berstatus Draft yang bisa dihapus.');
}

function parsePayload(payload: unknown): Body {
  const parsed = CreateProductionRunSchema.safeParse(payload);
  if (!parsed.success) throw new BusinessError('Payload draft tidak valid: ' + (parsed.error.issues[0]?.message ?? ''));
  return parsed.data;
}

export const NOT_POSTABLE = 'Draft sudah diproses atau tidak lagi berstatus Draft.';
export const NOT_POSTABLE_CODE = 'NOT_POSTABLE';

/** Klaim atomik Draft → toStatus; gagal (count 0) = sudah diklaim proses lain. */
async function claimDraft(tx: Tx, id: string, toStatus: 'Posted' | 'PendingApproval', userId: string) {
  const res = await tx.productionRunDraft.updateMany({
    where: { id, status: 'Draft' },
    data: {
      status: toStatus,
      lastError: null,
      updatedById: userId,
      ...(toStatus === 'Posted' ? { postedById: userId, postedAt: new Date() } : {}),
    },
  });
  if (res.count === 0) throw new BusinessError(NOT_POSTABLE);
}

/** Role bypass: klaim + jalankan submitProductionRunInTx dalam tx yang sama. */
export async function postDraftDirect(tx: Tx, id: string, userId: string) {
  const draft = await tx.productionRunDraft.findUnique({ where: { id } });
  if (!draft) throw new BusinessError('Draft tidak ditemukan.');
  await claimDraft(tx, id, 'Posted', userId);
  const run = await submitProductionRunInTx(tx, parsePayload(draft.payload), draft.createdById);
  if (!run) throw new BusinessError('Gagal membuat data produksi.');
  await tx.productionRunDraft.update({ where: { id }, data: { postedRunId: run.id, postedRunNumber: run.runNumber } });
  return run;
}

/** Role non-bypass: klaim + antrikan approval (efek dokumen terjadi saat approve). */
export async function postDraftForApproval(tx: Tx, id: string, userId: string) {
  const draft = await tx.productionRunDraft.findUnique({ where: { id } });
  if (!draft) throw new BusinessError('Draft tidak ditemukan.');
  const body = parsePayload(draft.payload);
  await claimDraft(tx, id, 'PendingApproval', userId);
  const amount = body.inputs.reduce((s, it) => s + Number(it.quantity ?? 0), 0);
  const request = await queueApproval(tx, {
    documentType: 'ProductionRun',
    payload: draft.payload,
    amount,
    requestedBy: draft.createdById,
    label: `Data Produksi ${draft.draftNumber}`,
  });
  await tx.productionRunDraft.update({ where: { id }, data: { approvalRequestId: request.id } });
  return { request, amount };
}

/**
 * Dipanggil di dalam tx approve: draft yang tertaut → Posted. No-op utk antrian lama (tanpa draft).
 * Draft tertaut yang sudah tidak PendingApproval (sudah Posted) = approve kedua → NOT_POSTABLE,
 * supaya run kedua tidak ikut di-commit.
 */
export async function markDraftPostedByApproval(
  tx: Tx, requestId: string, run: { id: string; number: string }, approverId: string,
) {
  const res = await tx.productionRunDraft.updateMany({
    where: { approvalRequestId: requestId, status: 'PendingApproval' },
    data: {
      status: 'Posted', postedRunId: run.id, postedRunNumber: run.number,
      postedAt: new Date(), postedById: approverId, lastError: null,
    },
  });
  if (res.count === 0 && (await tx.productionRunDraft.count({ where: { approvalRequestId: requestId } })) > 0) {
    throw new BusinessError(NOT_POSTABLE, NOT_POSTABLE_CODE);
  }
  return res.count;
}

/** Reject / minta-revisi: draft kembali ke Draft + catatan; false bila tak ada draft tertaut. */
export async function returnDraftToEditable(
  db: Pick<Tx, 'productionRunDraft'>, requestId: string, note: string, label = 'Ditolak',
) {
  const res = await db.productionRunDraft.updateMany({
    where: { approvalRequestId: requestId, status: 'PendingApproval' },
    data: { status: 'Draft', approvalRequestId: null, lastError: `${label}: ${note || '-'}` },
  });
  return res.count > 0;
}

/** Simpan alasan gagal posting pada draft (best-effort, hanya selagi Draft / PendingApproval). */
export async function recordDraftError(db: Pick<Tx, 'productionRunDraft'>, id: string, message: string) {
  await db.productionRunDraft.updateMany({ where: { id, status: 'Draft' }, data: { lastError: message } });
}
