// Classifies legacy journals whose source_type is NULL and, only with --apply, fills it in.
// Dry run by default: prints a summary and, with --out, writes one CSV row per journal for the
// accountant to review. --apply writes only rows still NULL and only at or above --min-confidence
// (default high); everything else stays NULL, which the cancel paths treat as "not manual".
//
// Usage (from server/, DATABASE_URL set):
//   node dist/scripts/repair/e1-journal-source-backfill.js [--dry-run] [--out file.csv]
//        [--apply] [--min-confidence high|medium|low]
//   (or `npx tsx src/scripts/repair/e1-journal-source-backfill.ts …` from a source checkout)

import { writeFileSync } from 'node:fs';
import { prisma } from '../../lib/prisma';
import {
  classifyLegacyJournal,
  isNearImportBatch,
  meetsConfidence,
  recurringNarrations,
  type ClassifyConfidence,
  type ImportBatch,
  type LegacyClassification,
} from '../../services/ledger/journalSource';

const PAGE = 500;
const CONFIDENCES: readonly ClassifyConfidence[] = ['high', 'medium', 'low'];

interface Options {
  apply: boolean;
  out: string | null;
  minConfidence: ClassifyConfidence;
}

function parseArgs(argv: readonly string[]): Options {
  const opts: Options = { apply: false, out: null, minConfidence: 'high' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') opts.apply = true;
    else if (a === '--dry-run') opts.apply = false;
    else if (a === '--out') opts.out = argv[++i] ?? null;
    else if (a === '--min-confidence') {
      const v = argv[++i] as ClassifyConfidence;
      if (!CONFIDENCES.includes(v)) throw new Error(`--min-confidence must be one of ${CONFIDENCES.join(', ')}`);
      opts.minConfidence = v;
    } else throw new Error(`Unknown argument: ${a}`);
  }
  if (argv.includes('--apply') && argv.includes('--dry-run')) throw new Error('Use either --apply or --dry-run.');
  return opts;
}

const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

interface CsvRow {
  id: string;
  entryNumber: string;
  date: Date;
  status: string;
  isDummy: boolean;
  narration: string | null;
  c: LegacyClassification;
  applied: boolean;
}

async function loadContext() {
  const [templates, importAudits] = await Promise.all([
    prisma.recurringTemplate.findMany({ where: { templateType: 'journal' }, select: { name: true, templateData: true } }),
    prisma.auditLog.findMany({
      where: { entityType: 'import', action: 'CREATE' },
      select: { userId: true, createdAt: true, newValues: true },
    }),
  ]);
  const batches: ImportBatch[] = importAudits
    .filter((a) => a.newValues && typeof a.newValues === 'object' && 'totalJournals' in a.newValues)
    .map((a) => ({ userId: a.userId, at: a.createdAt }));
  return { narrations: recurringNarrations(templates), batches };
}

/** Journal ids found in the recurring-execute audit rows ({ success, result: { id } }). */
async function recurringJournalIds(): Promise<Set<string>> {
  const rows = await prisma.auditLog.findMany({
    where: { entityType: 'recurring', action: 'CREATE' },
    select: { newValues: true },
  });
  const ids = new Set<string>();
  for (const r of rows) {
    const id = (r.newValues as { result?: { id?: unknown } } | null)?.result?.id;
    if (typeof id === 'string') ids.add(id);
  }
  return ids;
}

async function classifyPage(
  ids: string[],
  ctx: Awaited<ReturnType<typeof loadContext>>,
  recurringIds: Set<string>,
) {
  const [journals, cashRows, guarantees, settlements, manualAudits] = await Promise.all([
    prisma.journalEntry.findMany({
      where: { id: { in: ids } },
      select: {
        id: true, entryNumber: true, date: true, status: true, narration: true, isDummy: true,
        fiscalYearId: true, createdAt: true, createdBy: true,
        payment: { select: { id: true } },
        stockMovement: { select: { referenceType: true } },
        depositApplication: { select: { id: true } },
        customerDepositApplication: { select: { id: true } },
        gaVehicleServiceLog: { select: { id: true } },
        gaVehicleTax: { select: { id: true } },
        gaMaterialRequest: { select: { id: true } },
        paymentRequest: { select: { id: true } },
        paymentRequestSettlement: { select: { id: true } },
        _count: { select: { depreciationEntries: true, cogsBackfillSettlements: true } },
      },
    }),
    prisma.cashBookDraftRow.findMany({ where: { journalEntryId: { in: ids } }, select: { journalEntryId: true } }),
    prisma.projectGuarantee.findMany({ where: { journalEntryId: { in: ids } }, select: { journalEntryId: true } }),
    prisma.projectGuaranteeSettlement.findMany({ where: { journalEntryId: { in: ids } }, select: { journalEntryId: true } }),
    prisma.auditLog.findMany({
      where: { entityType: 'journals', action: 'CREATE', entityId: { in: ids } },
      select: { entityId: true },
    }),
  ]);
  const cashBook = new Set(cashRows.map((r) => r.journalEntryId));
  const guaranteeLinked = new Set([...guarantees, ...settlements].map((r) => r.journalEntryId));
  const manual = new Set(manualAudits.map((a) => a.entityId));

  return journals.map((j) => {
    const openingStock = j.stockMovement?.referenceType === 'OpeningBalance';
    const hasDocumentLink = Boolean(
      j.payment || (j.stockMovement && !openingStock) || j.depositApplication || j.customerDepositApplication ||
      j.gaVehicleServiceLog || j.gaVehicleTax || j.gaMaterialRequest || j.paymentRequest ||
      j.paymentRequestSettlement || j._count.cogsBackfillSettlements > 0 || guaranteeLinked.has(j.id),
    );
    const c = classifyLegacyJournal({
      entryNumber: j.entryNumber,
      narration: j.narration,
      fiscalYearId: j.fiscalYearId,
      createdAt: j.createdAt,
      depreciationEntryCount: j._count.depreciationEntries,
      inCashBookDraft: cashBook.has(j.id),
      openingStockMovement: openingStock,
      hasDocumentLink,
      manualAudit: manual.has(j.id),
      recurringAudit: recurringIds.has(j.id),
      matchesRecurringTemplate: j.narration !== null && ctx.narrations.has(j.narration),
      nearImportBatch: isNearImportBatch(j.createdAt, j.createdBy, ctx.batches),
    });
    return { j, c };
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const ctx = await loadContext();
  const recurringIds = await recurringJournalIds();
  const rows: CsvRow[] = [];
  const counts = new Map<string, number>();
  let applied = 0;
  let cursor: string | undefined;

  for (;;) {
    const page = await prisma.journalEntry.findMany({
      // Keyset on id, not a Prisma cursor: rows applied in the previous page no longer match the filter.
      where: { sourceType: null, ...(cursor ? { id: { gt: cursor } } : {}) },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: PAGE,
    });
    if (page.length === 0) break;
    cursor = page[page.length - 1]!.id;

    for (const { j, c } of await classifyPage(page.map((p) => p.id), ctx, recurringIds)) {
      const key = `${c.type}/${c.confidence}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      let didApply = false;
      if (opts.apply && meetsConfidence(c.confidence, opts.minConfidence)) {
        // Only rows still NULL: a writer or an earlier run may have tagged it meanwhile.
        const res = await prisma.journalEntry.updateMany({
          where: { id: j.id, sourceType: null },
          data: { sourceType: c.type, ...(c.sourceKey ? { sourceKey: c.sourceKey } : {}) },
        });
        didApply = res.count === 1;
        if (didApply) applied++;
      }
      rows.push({ id: j.id, entryNumber: j.entryNumber, date: j.date, status: j.status, isDummy: j.isDummy, narration: j.narration, c, applied: didApply });
    }
  }

  if (opts.out) {
    const header = 'id,entry_number,date,status,is_dummy,narration,source_type,source_key,confidence,reason,applied';
    const lines = rows.map((r) =>
      [r.id, r.entryNumber, r.date, r.status, r.isDummy, r.narration, r.c.type, r.c.sourceKey, r.c.confidence, r.c.reason, r.applied]
        .map(csvCell)
        .join(','),
    );
    writeFileSync(opts.out, `${[header, ...lines].join('\n')}\n`, 'utf8');
    console.log(`CSV: ${opts.out}`);
  }
  console.log(`${opts.apply ? 'APPLY' : 'DRY RUN'}: ${rows.length} journal(s) with NULL source_type`);
  for (const [key, n] of [...counts.entries()].sort()) console.log(`  ${key}: ${n}`);
  if (opts.apply) console.log(`Applied: ${applied} (min confidence ${opts.minConfidence})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
