// Pure rules for the chart of accounts (E2-R6): which root type a number prefix implies, how an
// account may be created under a parent, and what an update may change. No database here; the
// facts a rule needs (ledger rows, children, mappings) come from accountStructure.ts. The client
// mirrors the prefix table in client/src/lib/accountRules.ts (a parity test keeps them equal).

import { Prisma, type RootType } from '@prisma/client';

export const ACCOUNT_NUMBER_FORMAT = 'ACCOUNT_NUMBER_FORMAT';
export const ACCOUNT_PARENT_NOT_FOUND = 'ACCOUNT_PARENT_NOT_FOUND';
export const ACCOUNT_PARENT_NOT_GROUP = 'ACCOUNT_PARENT_NOT_GROUP';
export const ACCOUNT_PARENT_MISMATCH = 'ACCOUNT_PARENT_MISMATCH';
export const ACCOUNT_TYPE_MISMATCH = 'ACCOUNT_TYPE_MISMATCH';
export const ACCOUNT_STRUCTURE_LOCKED = 'ACCOUNT_STRUCTURE_LOCKED';
export const ACCOUNT_HAS_CHILDREN = 'ACCOUNT_HAS_CHILDREN';
export const ACCOUNT_DEACTIVATE_BLOCKED = 'ACCOUNT_DEACTIVATE_BLOCKED';

/** First segment of an account number -> root type. 7 is other income; 8 stays an expense. */
export const ROOT_TYPE_BY_PREFIX: Readonly<Record<string, RootType>> = {
  '1': 'ASSET',
  '2': 'LIABILITY',
  '3': 'EQUITY',
  '4': 'REVENUE',
  '5': 'EXPENSE',
  '6': 'EXPENSE',
  '7': 'REVENUE',
  '8': 'EXPENSE',
};

/** Dotted digits, first segment 1-8: "1", "6.19", "2.1.1.01". */
const NUMBER_PATTERN = /^[1-8](\.\d+)*$/;

export interface PlanProblem {
  ok: false;
  status: 400;
  code: string;
  message: string;
}
export type PlanResult<T> = { ok: true; data: T } | PlanProblem;

const problem = (code: string, message: string): PlanProblem => ({ ok: false, status: 400, code, message });

export function normalizeAccountNumber(raw: string): string {
  return raw.trim();
}

export function isValidAccountNumber(accountNumber: string): boolean {
  return NUMBER_PATTERN.test(accountNumber);
}

export function numberPrefix(accountNumber: string): string {
  return accountNumber.split('.')[0];
}

/** Root type the number's first segment implies, or null outside 1-8. */
export function deriveRootType(accountNumber: string): RootType | null {
  return ROOT_TYPE_BY_PREFIX[numberPrefix(normalizeAccountNumber(accountNumber))] ?? null;
}

export function prefixChanged(from: string, to: string): boolean {
  return numberPrefix(from) !== numberPrefix(to);
}

const formatProblem = (accountNumber: string) =>
  problem(
    ACCOUNT_NUMBER_FORMAT,
    `Nomor akun ${accountNumber} tidak valid. Gunakan angka bertitik dengan digit pertama 1-8, mis. 1.1.6.`,
  );

export interface ParentFacts {
  id: string;
  accountNumber: string;
  rootType: RootType;
  isGroup: boolean;
}

function parentProblem(accountNumber: string, rootType: RootType, parent: ParentFacts): PlanProblem | null {
  if (!parent.isGroup) {
    return problem(ACCOUNT_PARENT_NOT_GROUP, `Induk ${parent.accountNumber} bukan akun grup.`);
  }
  if (parent.rootType !== rootType) {
    return problem(
      ACCOUNT_PARENT_MISMATCH,
      `Akun ${accountNumber} bertipe ${rootType}, tetapi induk ${parent.accountNumber} bertipe ${parent.rootType}.`,
    );
  }
  if (!accountNumber.startsWith(`${parent.accountNumber}.`)) {
    return problem(
      ACCOUNT_PARENT_MISMATCH,
      `Nomor akun ${accountNumber} harus diawali nomor induk ${parent.accountNumber}.`,
    );
  }
  return null;
}

export interface CreateInput {
  accountNumber: string;
  rootType?: RootType;
  accountType?: RootType;
  parentId?: string | null;
  isGroup?: boolean;
}

export interface CreatePlan {
  accountNumber: string;
  rootType: RootType;
  accountType: RootType;
  parentId: string | null;
  isGroup: boolean;
}

/** `parent` is the account `input.parentId` points at, or null when it does not exist / no parent. */
export function planCreate(input: CreateInput, parent: ParentFacts | null): PlanResult<CreatePlan> {
  const accountNumber = normalizeAccountNumber(input.accountNumber);
  const rootType = isValidAccountNumber(accountNumber) ? deriveRootType(accountNumber) : null;
  if (!rootType) return formatProblem(accountNumber);

  if (input.parentId && !parent) {
    return problem(ACCOUNT_PARENT_NOT_FOUND, 'Akun induk tidak ditemukan.');
  }
  if (parent) {
    const bad = parentProblem(accountNumber, rootType, parent);
    if (bad) return bad;
  }
  for (const supplied of [input.rootType, input.accountType]) {
    if (supplied && supplied !== rootType) {
      return problem(
        ACCOUNT_TYPE_MISMATCH,
        `Nomor akun ${accountNumber} bertipe ${rootType}, bukan ${supplied}. Tipe akun ditentukan oleh digit pertama nomor.`,
      );
    }
  }
  return {
    ok: true,
    data: {
      accountNumber,
      rootType,
      accountType: rootType,
      parentId: parent?.id ?? null,
      isGroup: input.isGroup ?? false,
    },
  };
}

/** What the database says about one account, loaded by accountStructure.loadStructureFacts. */
export interface StructureFacts {
  /** Any active ledger row. */
  hasLedger: boolean;
  /** Debit minus credit that blocks deactivation: whole history for balance-sheet accounts, open fiscal years only for revenue/expense. */
  deactivationNet: Prisma.Decimal;
  childCount: number;
  activeChildCount: number;
  mappedRoles: readonly string[];
}

export interface CurrentAccount {
  accountNumber: string;
  rootType: RootType;
  isGroup: boolean;
  isActive: boolean;
  balance: Prisma.Decimal;
}

export interface UpdateInput {
  accountNumber?: string;
  name?: string;
  isGroup?: boolean;
  isActive?: boolean;
}

/** Only the fields that change. A rename never touches rootType. */
export interface UpdatePlan {
  accountNumber?: string;
  name?: string;
  isGroup?: boolean;
  isActive?: boolean;
  rootType?: RootType;
  accountType?: RootType;
}

/**
 * Order: number format, structure locks of an account with ledger rows, prefix change without
 * ledger rows (children, parent), group flag, deactivation. Uniqueness (409) and the system
 * account renumber guard run in the route after this passes.
 */
export function planUpdate(
  current: CurrentAccount,
  input: UpdateInput,
  facts: StructureFacts,
  parent: ParentFacts | null,
): PlanResult<UpdatePlan> {
  const plan: UpdatePlan = {};
  const label = current.accountNumber;

  if (input.name !== undefined) plan.name = input.name;

  const requested = input.accountNumber === undefined ? undefined : normalizeAccountNumber(input.accountNumber);
  const numberChanged = requested !== undefined && requested !== current.accountNumber;
  if (numberChanged) {
    if (!isValidAccountNumber(requested)) return formatProblem(requested);
    plan.accountNumber = requested;
  }
  const changesPrefix = numberChanged && prefixChanged(current.accountNumber, requested);
  const groupChanges = input.isGroup !== undefined && input.isGroup !== current.isGroup;

  if (facts.hasLedger && changesPrefix) {
    return problem(
      ACCOUNT_STRUCTURE_LOCKED,
      `Akun ${label} sudah memiliki transaksi; awalan nomor (golongan akun) tidak dapat diubah.`,
    );
  }
  if (facts.hasLedger && groupChanges) {
    return problem(
      ACCOUNT_STRUCTURE_LOCKED,
      `Akun ${label} sudah memiliki transaksi; status grup tidak dapat diubah.`,
    );
  }
  if (changesPrefix) {
    if (facts.childCount > 0) {
      return problem(
        ACCOUNT_STRUCTURE_LOCKED,
        `Akun ${label} memiliki sub-akun; awalan nomor (golongan akun) tidak dapat diubah.`,
      );
    }
    const derived = deriveRootType(requested)!;
    plan.rootType = derived;
    plan.accountType = derived;
  }
  if (numberChanged && parent) {
    const bad = parentProblem(requested, plan.rootType ?? current.rootType, parent);
    if (bad) return bad;
  }

  if (groupChanges) {
    if (input.isGroup === false && facts.childCount > 0) {
      return problem(ACCOUNT_HAS_CHILDREN, 'Tidak dapat mengubah akun grup yang masih memiliki sub-akun.');
    }
    plan.isGroup = input.isGroup;
  }

  if (input.isActive === false && current.isActive) {
    const blocked = deactivationProblem(label, current, facts);
    if (blocked) return blocked;
  }
  if (input.isActive !== undefined && input.isActive !== current.isActive) plan.isActive = input.isActive;

  return { ok: true, data: plan };
}

function deactivationProblem(label: string, current: CurrentAccount, facts: StructureFacts): PlanProblem | null {
  if (!current.balance.isZero()) {
    return problem(ACCOUNT_DEACTIVATE_BLOCKED, `Akun ${label} masih bersaldo; kosongkan saldonya sebelum dinonaktifkan.`);
  }
  if (facts.mappedRoles.length > 0) {
    return problem(
      ACCOUNT_DEACTIVATE_BLOCKED,
      `Akun ${label} dipakai sebagai Akun Sistem (${[...new Set(facts.mappedRoles)].join(', ')}); lepaskan pemetaannya sebelum dinonaktifkan.`,
    );
  }
  if (facts.activeChildCount > 0) {
    return problem(ACCOUNT_DEACTIVATE_BLOCKED, `Akun ${label} masih memiliki sub-akun aktif; nonaktifkan sub-akun terlebih dahulu.`);
  }
  if (!facts.deactivationNet.isZero()) {
    return problem(ACCOUNT_DEACTIVATE_BLOCKED, `Akun ${label} masih memiliki saldo di buku besar; nonaktifkan setelah saldonya nol.`);
  }
  return null;
}
