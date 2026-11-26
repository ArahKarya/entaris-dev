// Inventory checks for /api/health-check (step 6). Detection only.
// Inventory Variance account (owner decision #2): manual stock out without an offset, and later the
// stock count and the drift repair, post shrinkage to the INVENTORY_VARIANCE role. Those postings
// are refused while the role is unmapped, mapped to a group, or shares its account with
// ROUNDING_ACCOUNT (services/inventory/varianceAccount.ts); this check shows it before a posting does.
// Inventory vs GL and the stock value invariant (E3-R15, PR-6.13a) read the one finder,
// services/inventory/inventoryGlCheck.ts; corrections go through the accountant (audit script
// scripts/repair/e3-inventory-gl-audit.ts), never through a fix here.
import { prisma } from '../../lib/prisma';
import {
  findInventoryGlDiffs,
  findStockValueInvariantBreaks,
  hasInventoryGlReconciliation,
  isInventoryGlBreak,
  type InventoryGlDiff,
} from '../../services/inventory/inventoryGlCheck';
import { inspectVarianceAccount } from '../../services/inventory/varianceAccount';
import { ACCOUNT_MAPPING_MISSING } from '../../types/systemAccounts';
import { rowsOrAmbiguous } from './arChecks';
import type { CheckResult } from './checks';

const DETAIL_LIMIT = 20;

const VARIANCE_MESSAGES = {
  missing: 'Akun Selisih Persediaan belum dipetakan; mutasi stok keluar tanpa akun lawan ditolak',
  group: 'Akun Selisih Persediaan dipetakan ke akun grup; mutasi stok keluar tanpa akun lawan ditolak',
  shared: 'Akun Selisih Persediaan sama dengan akun Pembulatan; mutasi stok keluar tanpa akun lawan ditolak',
} as const;

export async function checkInventoryVarianceAccount(): Promise<CheckResult> {
  const state = await inspectVarianceAccount(prisma);
  const name = 'Inventory Variance Account';
  if (state.status === 'ok') {
    return { name, status: 'ok', message: 'Akun Selisih Persediaan adalah akun rinci tersendiri', count: 0, fixable: false };
  }
  return {
    name,
    status: 'warning',
    message: VARIANCE_MESSAGES[state.status],
    count: 1,
    details: state.status === 'missing' ? [] : [{ account: `${state.account.accountNumber} ${state.account.name}`, problem: state.status }],
    fixable: false,
  };
}

const INVENTORY_VS_GL = 'Inventory vs GL';

function glDetail(r: InventoryGlDiff) {
  return {
    account: r.accountId ? `${r.accountNumber} ${r.name}` : r.name,
    gl: r.gl.toNumber(),
    book_value: r.bookValue.toNumber(),
    qty_times_avg: r.qtyTimesAvg?.toNumber() ?? null,
    do_uninvoiced: r.doUninvoiced.toNumber(),
    doc_typed_duplicate: r.docTypedDuplicate.toNumber(),
    non_journal_other: r.nonJournalOther.toNumber(),
    phantom_qty_value: r.phantomQtyValue?.toNumber() ?? null,
    difference: r.difference.toNumber(),
  };
}

/**
 * Per inventory account, the journal ledger balance against the value book. Error when any
 * account's difference (GL − book − uninvoiced delivery notes) is over 0.01 or value sits on stock
 * no warehouse holds; warning when only reconciliation items are left; ok when clean. Details: the
 * accounts with anything to show (breaks first), then the total row. An unmapped INVENTORY role
 * while an item without its own account holds stock is this check's error, not the endpoint's.
 */
export async function checkInventoryVsGl(): Promise<CheckResult> {
  const result = await rowsOrAmbiguous(INVENTORY_VS_GL, () => findInventoryGlDiffs(prisma), [ACCOUNT_MAPPING_MISSING]);
  if (!('accounts' in result)) return result;
  const breaks = result.accounts.filter(isInventoryGlBreak);
  const reconciling = result.accounts.filter((r) => !isInventoryGlBreak(r) && hasInventoryGlReconciliation(r));
  const listed = [...breaks, ...reconciling].slice(0, DETAIL_LIMIT);
  const details = listed.length > 0 ? [...listed, result.total].map(glDetail) : [];
  if (breaks.length > 0) {
    return {
      name: INVENTORY_VS_GL, status: 'error', count: breaks.length, details, fixable: false,
      message: `${breaks.length} akun persediaan: saldo Buku Besar berbeda dengan nilai buku persediaan, atau ada nilai stok tanpa stok gudang`,
    };
  }
  if (reconciling.length > 0) {
    return {
      name: INVENTORY_VS_GL, status: 'warning', count: reconciling.length, details, fixable: false,
      message: `${reconciling.length} akun persediaan cocok dengan nilai buku setelah pos rekonsiliasi (Surat Jalan belum ditagih, baris Buku Besar di luar jurnal)`,
    };
  }
  return {
    name: INVENTORY_VS_GL, status: 'ok', count: 0, details: [], fixable: false,
    message: 'Saldo Buku Besar setiap akun persediaan sama dengan nilai buku persediaan',
  };
}

/** Items whose stock_value breaks the value-ledger invariant (Σ value_delta, stock x average). */
export async function checkStockValueInvariant(): Promise<CheckResult> {
  const { total, rows } = await findStockValueInvariantBreaks(prisma, { limit: DETAIL_LIMIT });
  return {
    name: 'Stock Value Invariant',
    status: total > 0 ? 'error' : 'ok',
    message: total > 0
      ? `${total} item: nilai buku persediaan tidak sama dengan jumlah nilai mutasinya atau stok x rata-rata`
      : 'Nilai buku persediaan setiap item sama dengan jumlah nilai mutasinya dan stok x rata-rata',
    count: total,
    details: rows.map((r) => ({
      item_code: r.code,
      kind: r.kind,
      stock_value: r.actual.toNumber(),
      expected: r.expected.toNumber(),
      difference: r.difference.toNumber(),
    })),
    fixable: false,
  };
}
