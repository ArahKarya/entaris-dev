// Classifies legacy journals (source_type NULL) into a JournalSourceType for the one-time backfill.
// Pure: the backfill script gathers the facts (link columns, audit rows, templates) and this
// module applies the rules top-down, first match wins. A NULL source means "not manual", so only
// confident results should ever be written; low-confidence rows stay NULL for the accountant.
// Also holds the Journal-menu allowlist (which source types the menu may cancel) and the one
// sourceKey convention (sourceKeys): every writer builds its key here, so keys stay parseable.

import { JournalSourceType } from '@prisma/client';
import { businessDayOf } from '../../utils/businessDate';

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

/** One sourceKey segment: non-empty and without ':' so a key splits back into its parts. */
function keyPart(value: string): string {
  if (!value || value.includes(':')) throw new Error(`sourceKey part "${value}" must be non-empty and contain no ":"`);
  return value;
}

/** Business day of a run date as YYYY-MM-DD; a string must already be that day. */
function dayPart(day: Date | string): string {
  if (typeof day !== 'string') return businessDayOf(day);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`sourceKey day "${day}" must be YYYY-MM-DD`);
  return day;
}

/** Opening-balance subledger of a party: receivable, payable, supplier or customer deposit. */
export type OpeningPartyKind = 'AR' | 'AP' | 'VDEP' | 'CDEP';

/**
 * The sourceKey of each journal kind that has one (plan step 4 §2.5). Keys are not unique in the
 * database: FY_CLOSE:<id> repeats after a reopen, and the guards that use a key check it themselves.
 * Writers without a key (manual journal, cash book, unmigrated document writers) leave it NULL.
 */
export const sourceKeys = {
  /** Year-end closing journal of a fiscal year. */
  close: (fiscalYearId: string): string => `FY_CLOSE:${keyPart(fiscalYearId)}`,
  /** Refund journal of a customer or supplier deposit. */
  depositRefund: (depositId: string): string => `DEPOSIT_REFUND:${keyPart(depositId)}`,
  /** One run of a recurring template on its business day. */
  recurring: (templateId: string, runDay: Date | string): string => `RECURRING:${keyPart(templateId)}:${dayPart(runDay)}`,
  /** Journal group n (1-based) of an imported file, keyed by the file's SHA-256 (first 16 hex chars). */
  importGroup: (fileSha256: string, groupNo: number): string => {
    if (!/^[0-9a-f]{16,64}$/.test(fileSha256)) throw new Error('sourceKey import hash must be lowercase SHA-256 hex');
    if (!Number.isInteger(groupNo) || groupNo < 1) throw new Error(`sourceKey import group "${groupNo}" must be a positive integer`);
    return `IMPORT:${fileSha256.slice(0, 16)}:${groupNo}`;
  },
  /**
   * Balance-sheet reclass when a system account role moves from one account to another. A reclass
   * too long for one journal is split; each piece carries its 1-based part number.
   */
  remap: (role: string, fromAccountId: string, toAccountId: string, day: Date | string, part?: number): string => {
    if (part !== undefined && (!Number.isInteger(part) || part < 1)) throw new Error(`sourceKey remap part "${part}" must be a positive integer`);
    const key = `REMAP:${keyPart(role)}:${keyPart(fromAccountId)}:${keyPart(toAccountId)}:${dayPart(day).replace(/-/g, '')}`;
    return part === undefined ? key : `${key}:${part}`;
  },
  /** Opening balance of an account. */
  openingAccount: (accountId: string): string => `OPENING:ACCOUNT:${keyPart(accountId)}`,
  /** Opening balance of one subledger of a party. */
  openingParty: (partyId: string, kind: OpeningPartyKind): string => `OPENING:PARTY:${keyPart(partyId)}:${kind}`,
  /**
   * One price revision of a purchase invoice, by its journal number (an invoice is revised many
   * times); cancelling the invoice voids every journal under purchaseRevisionPrefix(invoiceId).
   */
  purchaseRevision: (invoiceId: string, entryNumber: string): string => `${purchaseRevisionPrefix(invoiceId)}${keyPart(entryNumber)}`,
  /**
   * Value true-up and zero-stock sweep of a cancelled stock movement (E3-R8, PR-6.5a), by the
   * movement taken back: DR/CR inventory against COGS (services/inventory/reversalValueJournal.ts).
   */
  inventoryTrueUp: (movementId: string): string => `INVENTORY_TRUE_UP:${keyPart(movementId)}`,
} as const;

/** Prefix of the sourceKeys of a purchase invoice's price revisions (for startsWith queries). */
export function purchaseRevisionPrefix(invoiceId: string): string {
  return `PURCHASE_REVISION:${keyPart(invoiceId)}:`;
}

/** sourceKey of a deposit refund journal: the deposit payment it refunds. */
export function depositRefundSourceKey(depositId: string): string {
  return sourceKeys.depositRefund(depositId);
}

/** Prefix shared by every remap sourceKey (for startsWith queries). */
export const REMAP_KEY_PREFIX = 'REMAP:';

export interface RemapKey {
  role: string;
  fromAccountId: string;
  toAccountId: string;
  /** YYYYMMDD business day of the reclass. */
  day: string;
  /** Part number of a split reclass; absent for a reclass in one journal. */
  part?: number;
}

/** Parts of a remap sourceKey, or null when the key is not one. */
export function parseRemapSourceKey(key: string | null | undefined): RemapKey | null {
  if (!key?.startsWith(REMAP_KEY_PREFIX)) return null;
  const parts = key.split(':');
  if (parts.length !== 5 && parts.length !== 6) return null;
  if (parts.slice(1).some((p) => !p) || !/^\d{8}$/.test(parts[4])) return null;
  if (parts.length === 6 && !/^[1-9]\d*$/.test(parts[5])) return null;
  const key5 = { role: parts[1], fromAccountId: parts[2], toAccountId: parts[3], day: parts[4] };
  return parts.length === 6 ? { ...key5, part: Number(parts[5]) } : key5;
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

  if (no.startsWith('CLOSE-')) return result('FY_CLOSE', 'high', 'number CLOSE-', sourceKeys.close(f.fiscalYearId));
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
