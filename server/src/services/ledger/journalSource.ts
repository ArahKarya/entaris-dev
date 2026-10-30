// Classifies legacy journals (source_type NULL) into a JournalSourceType for the one-time backfill.
// Pure: the backfill script gathers the facts (link columns, audit rows, templates) and this
// module applies the rules top-down, first match wins. A NULL source means "not manual", so only
// confident results should ever be written; low-confidence rows stay NULL for the accountant.
// Also holds the Journal-menu allowlist: which source types the menu may cancel.

import { JournalSourceType } from '@prisma/client';

/**
 * Source types the Journal menu (PATCH /journals/:id/cancel) may cancel: journals a person made
 * (by hand, by import, from a template or from the cash book), which have no other cancel path.
 * Everything else, a NULL (unknown legacy) source included, is undone from its source document,
 * or corrected with a manual reversing journal. Mirrored in client/src/lib/journalSource.ts.
 */
export const MENU_CANCELLABLE_SOURCES: ReadonlySet<JournalSourceType> = new Set([
  JournalSourceType.MANUAL,
  JournalSourceType.IMPORT,
  JournalSourceType.RECURRING,
  JournalSourceType.CASH_BOOK,
]);

/** True when the Journal menu may cancel a journal with this source type. */
export function isMenuCancellableSource(sourceType: JournalSourceType | null): boolean {
  return sourceType !== null && MENU_CANCELLABLE_SOURCES.has(sourceType);
}

export type ClassifyConfidence = 'high' | 'medium' | 'low';

export interface LegacyJournalFacts {
  entryNumber: string;
  narration: string | null;
  fiscalYearId: string;
  createdAt: Date;
  depreciationEntryCount: number;
  /** Referenced by cash_book_draft_rows.journal_entry_id. */
  inCashBookDraft: boolean;
  /** Linked StockMovement with referenceType 'OpeningBalance' (opening stock import). */
  openingStockMovement: boolean;
  /** Any other link to a source document (payment, stock movement, deposit application, GA,
   *  payment request, COGS backfill, guarantee or guarantee settlement). */
  hasDocumentLink: boolean;
  /** Audit row entityType 'journals', action CREATE, entityId = journal id (POST /journals). */
  manualAudit: boolean;
  /** Audit row entityType 'recurring' whose response result.id = journal id. */
  recurringAudit: boolean;
  /** Narration equals a journal template's narration or name. */
  matchesRecurringTemplate: boolean;
  /** Created shortly before a journal-import audit row by the same user. */
  nearImportBatch: boolean;
}

export interface LegacyClassification {
  type: JournalSourceType;
  confidence: ClassifyConfidence;
  reason: string;
  sourceKey: string | null;
}

const CASH_BOOK_NARRATION = /^Buku Kas DKB-/;
const DEPOSIT_REFUND_NARRATION = /^Refund UM (Vendor|Pelanggan):/;
const DEPOSIT_OFFSET_NARRATION = /^Offset UM (Vendor|Pelanggan):/;
// "Saldo awal aset tetap:" (demo data) is posted through POST /journals and stays out on purpose.
const OPENING_NARRATION = /^Saldo awal (piutang|hutang|uang muka vendor|uang muka pelanggan|akun|stok):/;
// Document-derived numbers: JV-<letters>… (JV-STT-, JV-COGS-, JV-COR-, …-CXL, …-R<n>).
const DOCUMENT_NUMBER = /^JV-[A-Z]/;
const SYSTEM_DOC_NARRATION =
  /^(Aplikasi Uang Muka|Revisi harga |Auto-settle COGS |Setor Uang Jaminan|Settlement Uang Jaminan|\[BATAL\] Pembatalan uang muka)/;
/** The recurring cron runs at 02:00 business time (jobs/scheduler.ts). */
const RECURRING_RUN_HOUR = 2;
const BUSINESS_UTC_OFFSET_HOURS = 7;

const result = (
  type: JournalSourceType,
  confidence: ClassifyConfidence,
  reason: string,
  sourceKey: string | null = null,
): LegacyClassification => ({ type, confidence, reason, sourceKey });

function businessHour(d: Date): number {
  return (d.getUTCHours() + BUSINESS_UTC_OFFSET_HOURS) % 24;
}

/** Applies the legacy classification rules top-down; the first match wins. */
export function classifyLegacyJournal(f: LegacyJournalFacts): LegacyClassification {
  const no = f.entryNumber;
  const narration = f.narration ?? '';

  if (no.startsWith('CLOSE-')) return result('FY_CLOSE', 'high', 'number CLOSE-', `FY_CLOSE:${f.fiscalYearId}`);
  if (no.startsWith('DEP-')) return result('DEPRECIATION', 'high', 'number DEP-');
  if (f.depreciationEntryCount > 0) return result('DEPRECIATION', 'high', 'linked depreciation entry');
  if (no.startsWith('OB-')) return result('OPENING', 'high', 'number OB- (COA opening balance)');
  if (f.inCashBookDraft) return result('CASH_BOOK', 'high', 'linked cash book draft row');
  if (CASH_BOOK_NARRATION.test(narration)) return result('CASH_BOOK', 'high', 'narration Buku Kas DKB-');
  // The refund writer never goes through POST /journals: a hand-made journal with that narration is
  // left to the manual rule below, so it is not offered as a refund of the deposit.
  if (DEPOSIT_REFUND_NARRATION.test(narration) && !f.manualAudit) {
    return result('DEPOSIT_REFUND', 'high', 'narration Refund UM');
  }
  if (DEPOSIT_OFFSET_NARRATION.test(narration)) return result('DEPOSIT_OFFSET', 'high', 'narration Offset UM');
  if (f.openingStockMovement) return result('OPENING', 'high', 'opening stock movement');
  if (OPENING_NARRATION.test(narration)) return result('OPENING', 'high', 'narration Saldo awal');
  if (f.hasDocumentLink) return result('SYSTEM_DOC', 'high', 'linked source document');
  if (DOCUMENT_NUMBER.test(no)) return result('SYSTEM_DOC', 'high', 'document-derived number JV-<doc>');
  if (SYSTEM_DOC_NARRATION.test(narration)) return result('SYSTEM_DOC', 'high', 'system narration');

  // Generic JV-YYYYMM-NNNN with no link: manual, recurring and imported journals look alike.
  if (f.manualAudit) return result('MANUAL', 'high', 'audit log POST /journals');
  if (f.recurringAudit) return result('RECURRING', 'high', 'audit log recurring execute');
  if (f.matchesRecurringTemplate) {
    return businessHour(f.createdAt) === RECURRING_RUN_HOUR
      ? result('RECURRING', 'medium', 'template narration, created at the 02:00 run')
      : result('RECURRING', 'low', 'template narration');
  }
  if (f.nearImportBatch) return result('IMPORT', 'medium', 'created just before a journal import');
  return result('MANUAL', 'low', 'generic number, no link or audit trail');
}

const CONFIDENCE_RANK: Record<ClassifyConfidence, number> = { low: 0, medium: 1, high: 2 };

/** True when a classification is at least as confident as the minimum. */
export function meetsConfidence(c: ClassifyConfidence, min: ClassifyConfidence): boolean {
  return CONFIDENCE_RANK[c] >= CONFIDENCE_RANK[min];
}

export interface ImportBatch {
  userId: string;
  at: Date;
}

/** How long before its audit row an imported journal may have been created. */
export const IMPORT_WINDOW_MS = 10 * 60 * 1000;

/** True when the journal was created by the same user within the window before an import finished. */
export function isNearImportBatch(
  createdAt: Date,
  createdBy: string,
  batches: readonly ImportBatch[],
  windowMs: number = IMPORT_WINDOW_MS,
): boolean {
  const t = createdAt.getTime();
  return batches.some((b) => b.userId === createdBy && t <= b.at.getTime() && b.at.getTime() - t <= windowMs);
}

/** Narrations a journal template would produce (templateData.narration, else the name). */
export function recurringNarrations(templates: readonly { name: string; templateData: unknown }[]): Set<string> {
  const out = new Set<string>();
  for (const t of templates) {
    out.add(t.name);
    const data = t.templateData as { narration?: unknown } | null;
    if (data && typeof data.narration === 'string' && data.narration) out.add(data.narration);
  }
  return out;
}
