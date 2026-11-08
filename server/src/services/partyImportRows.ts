// The rows of a party import file (E2-R13, plan step 5 PR-5.12), read without touching the database.
//
// Opening columns (blank = not stated, the party's recorded opening stays; "0" = set it to zero):
//   openingBalance (aliases outstandingAmount, saldoAwal, balance, snake_case) + arahSaldo
//   (arah_saldo, direction: Piutang|Hutang|receivable|payable). The old piutang / hutang columns
//   state the amount and the direction at once. A Customer defaults to Piutang and a Supplier to
//   Hutang; a Both party must say, one direction per row (a Both party with both sides is two rows).
//   depositBalance: a Supplier's / Both party's Supplier deposit (a Customer's goes to its Customer
//   deposit, as before); customerDepositBalance: a Customer's / Both party's Customer deposit.
// Amounts are plain decimals (parseImportAmount) and never below zero.
import { Prisma } from '@prisma/client';
import type { OpeningPartyKind } from './ledger/journalSource';
import { OPENING_NEGATIVE } from './ledger/openingBalance';
import { PARTY_OPENING_DIRECTION } from './ledger/openingImportCodes';
import { parseImportAmount } from '../utils/importDate';

export type PartyKind = 'Customer' | 'Supplier' | 'Both';
export type Direction = 'RECEIVABLE' | 'PAYABLE';

export interface PartyImportRow {
  /** Row number in the sheet (header = 1). */
  rowNum: number;
  name: string;
  partyType: PartyKind;
  phone?: string;
  email?: string;
  address?: string;
  taxId?: string;
  /** The opening balance wanted per subledger, only for the ones the sheet states. */
  openings: Partial<Record<OpeningPartyKind, string>>;
  /** The cells as shown in the preview table ('' when the sheet leaves them blank). */
  shown: { openingBalance: string; arahSaldo: string; depositBalance: string; customerDepositBalance: string };
}

export interface PartyImportError {
  row: number;
  message: string;
  code?: string;
}

const OPENING_KEYS = ['openingBalance', 'opening_balance', 'outstandingAmount', 'outstanding_amount', 'saldoAwal', 'saldo_awal', 'balance'];
const DIRECTION_KEYS = ['arahSaldo', 'arah_saldo', 'direction'];
const DEPOSIT_KEYS = ['depositBalance', 'deposit_balance', 'saldoDeposit', 'saldo_deposit', 'uangMuka', 'uang_muka'];
const CUSTOMER_DEPOSIT_KEYS = ['customerDepositBalance', 'customer_deposit_balance', 'depositPelanggan', 'deposit_pelanggan'];

type Cells = Record<string, string>;
type Numeric = Record<string, boolean> | undefined;

interface Cell {
  key: string;
  raw: string;
  /** The parsed amount (plain decimal string), set by amountOf. */
  value?: string;
}

const firstFilled = (r: Cells, keys: readonly string[]): Cell | null => {
  for (const key of keys) {
    const raw = (r[key] ?? '').toString().trim();
    if (raw) return { key, raw };
  }
  return null;
};

class RowError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

const isNegative = (v: string): boolean => {
  const d = new Prisma.Decimal(v);
  return d.isNegative() && !d.isZero();
};

function amountOf(cell: Cell, numeric: Numeric): Cell {
  const parsed = parseImportAmount(cell.raw, { fromNumberCell: !!numeric?.[cell.key] });
  if (!parsed.ok) throw new RowError(parsed.message);
  if (isNegative(parsed.value)) throw new RowError('Saldo awal pihak tidak boleh negatif.', OPENING_NEGATIVE);
  return { ...cell, value: new Prisma.Decimal(parsed.value).isZero() ? '0' : parsed.value };
}

function parseDirection(cell: Cell | null): Direction | null {
  if (!cell) return null;
  const word = cell.raw.toLowerCase();
  if (word === 'piutang' || word === 'receivable') return 'RECEIVABLE';
  if (word === 'hutang' || word === 'payable') return 'PAYABLE';
  throw new RowError(`arahSaldo "${cell.raw}" tidak valid. Gunakan: Piutang atau Hutang.`, PARTY_OPENING_DIRECTION);
}

const positive = (c: Cell | null): boolean => !!c?.value && new Prisma.Decimal(c.value).gt(0);

/** The AR / AP amount and the direction the sheet states for the row, or null when it states none. */
function receivableOrPayable(r: Cells, numeric: Numeric, partyType: PartyKind): { amount: string; direction: Direction | null } | null {
  const generic = firstFilled(r, OPENING_KEYS);
  const piutang = firstFilled(r, ['piutang']);
  const hutang = firstFilled(r, ['hutang']);
  const g = generic && amountOf(generic, numeric);
  let pi = piutang && amountOf(piutang, numeric);
  let hu = hutang && amountOf(hutang, numeric);
  if (positive(pi) && positive(hu)) {
    throw new RowError('Kolom piutang dan hutang terisi bersamaan. Satu baris untuk satu arah; pihak Both dengan dua sisi ditulis dua baris.', PARTY_OPENING_DIRECTION);
  }
  // A zero in the unused old column does not state a direction.
  if (positive(pi)) hu = null; else if (positive(hu)) pi = null;
  const legacy = pi ?? hu;
  const legacyDirection: Direction | null = legacy ? (legacy === pi ? 'RECEIVABLE' : 'PAYABLE') : null;
  const explicit = parseDirection(firstFilled(r, DIRECTION_KEYS));
  if (explicit && legacyDirection && explicit !== legacyDirection) {
    throw new RowError('Kolom arahSaldo bertentangan dengan kolom piutang/hutang pada baris yang sama.', PARTY_OPENING_DIRECTION);
  }
  const stated = legacy ?? g;
  if (!stated) return null;
  if (legacy && g && !new Prisma.Decimal(legacy.value!).eq(g.value!)) {
    throw new RowError(`Kolom ${legacy.key} dan ${g.key} berisi nilai yang berbeda pada baris yang sama.`);
  }
  const direction = explicit ?? legacyDirection;
  const amount = stated.value!;
  const hasReceivable = partyType !== 'Supplier';
  const hasPayable = partyType !== 'Customer';
  const checkDirection = new Prisma.Decimal(amount).gt(0) || !!explicit;
  if (direction === 'RECEIVABLE' && !hasReceivable && checkDirection) {
    throw new RowError('Supplier tidak punya piutang. Pakai arahSaldo Hutang, atau ubah partyType menjadi Both.', PARTY_OPENING_DIRECTION);
  }
  if (direction === 'PAYABLE' && !hasPayable && checkDirection) {
    throw new RowError('Customer tidak punya hutang. Pakai arahSaldo Piutang, atau ubah partyType menjadi Both.', PARTY_OPENING_DIRECTION);
  }
  if (direction === null && partyType === 'Both') {
    // A zero says nothing about which side; only an amount needs the direction.
    if (!new Prisma.Decimal(amount).gt(0)) return null;
    throw new RowError('Pihak Both wajib mengisi arahSaldo (Piutang atau Hutang) bila saldo awal lebih dari nol.', PARTY_OPENING_DIRECTION);
  }
  return { amount, direction: direction ?? (partyType === 'Supplier' ? 'PAYABLE' : 'RECEIVABLE') };
}

function openingsOf(r: Cells, numeric: Numeric, partyType: PartyKind): { openings: PartyImportRow['openings']; shown: PartyImportRow['shown'] } {
  const openings: PartyImportRow['openings'] = {};
  const sided = receivableOrPayable(r, numeric, partyType);
  if (sided) openings[sided.direction === 'PAYABLE' ? 'AP' : 'AR'] = sided.amount;

  const deposit = firstFilled(r, DEPOSIT_KEYS);
  const customerDeposit = firstFilled(r, CUSTOMER_DEPOSIT_KEYS);
  const dep = deposit && amountOf(deposit, numeric);
  const cust = customerDeposit && amountOf(customerDeposit, numeric);
  if (partyType === 'Customer') {
    // A Customer's depositBalance is its Customer deposit when customerDepositBalance says nothing.
    const wanted = positive(cust) || !dep ? cust : dep;
    if (wanted) openings.CDEP = wanted.value!;
  } else {
    if (dep) openings.VDEP = dep.value!;
    if (cust) {
      if (partyType === 'Supplier') {
        if (positive(cust)) throw new RowError('customerDepositBalance tidak berlaku untuk Supplier. Pakai partyType Both bila mitra ini juga Customer.');
      } else {
        openings.CDEP = cust.value!;
      }
    }
  }
  const shown = {
    openingBalance: sided?.amount ?? '',
    arahSaldo: sided ? (sided.direction === 'PAYABLE' ? 'Hutang' : 'Piutang') : '',
    depositBalance: dep?.value ?? '',
    customerDepositBalance: cust?.value ?? '',
  };
  return { openings, shown };
}

/** Reads and checks every row; a row with a problem is reported once and left out. */
export function parsePartyRows(
  rows: readonly Cells[],
  numericCells: readonly Numeric[],
  sanitize: (value: unknown) => string,
): { rows: PartyImportRow[]; errors: PartyImportError[] } {
  const valid: PartyImportRow[] = [];
  const errors: PartyImportError[] = [];
  rows.forEach((r, i) => {
    const rowNum = i + 2;
    if (!r.name?.trim()) {
      errors.push({ row: rowNum, message: 'Kolom "name" wajib diisi.' });
      return;
    }
    const partyType = (r.partyType || r.party_type || '').trim();
    if (!['Customer', 'Supplier', 'Both'].includes(partyType)) {
      errors.push({ row: rowNum, message: `partyType "${partyType}" tidak valid. Gunakan: Customer, Supplier, atau Both.` });
      return;
    }
    try {
      const { openings, shown } = openingsOf(r, numericCells[i], partyType as PartyKind);
      const taxId = (r.taxId || r.tax_id || '').trim();
      valid.push({
        rowNum,
        name: sanitize(r.name),
        partyType: partyType as PartyKind,
        phone: r.phone?.trim() ? sanitize(r.phone) : undefined,
        email: r.email?.trim() ? sanitize(r.email) : undefined,
        address: r.address?.trim() ? sanitize(r.address) : undefined,
        taxId: taxId ? sanitize(r.taxId || r.tax_id) : undefined,
        openings,
        shown,
      });
    } catch (e) {
      if (!(e instanceof RowError)) throw e;
      errors.push({ row: rowNum, message: e.message, ...(e.code ? { code: e.code } : {}) });
    }
  });
  return { rows: valid, errors };
}
