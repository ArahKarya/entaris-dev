import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { AuthRequest, requireCap } from '../middleware/auth';
import { validateBody } from '../utils/validate';
import { CreateAccountSchema, UpdateAccountSchema, SetBalanceSchema } from '../utils/schemas';
import { handleRouteError } from '../utils/errors';
import { systemAccounts } from '../services/systemAccounts';
import { logger } from '../lib/logger';
import { compareAccountNumber } from '../utils/accountSort';
import { systemAccountRenumberError } from '../utils/systemAccountGuard';
import { planCreate, planUpdate } from '../services/coa/accountRules';
import { accountIdsWithLedger, loadStructureFacts, lockAccounts } from '../services/coa/accountStructure';
import { loadPartyRoleMap } from '../services/ledger/partyRules';
import { currentPnlYear, currentProfit, pnlPeriodBalances } from '../services/coa/pnlPeriodBalances';
import { businessToday } from '../utils/businessDate';
import { hasCap } from '../services/permissionService';
import { OPENING_LOCK_RIGHT, setOpeningBalanceInTx } from '../services/ledger/openingBalance';

const router = Router();

/** Adds `locked` (an active ledger row freezes the number prefix and the group flag) to each account. */
async function withLocked<T extends { id: string }>(accounts: T[]): Promise<(T & { locked: boolean })[]> {
  const ids = await accountIdsWithLedger(prisma);
  return accounts.map((a) => ({ ...a, locked: ids.has(a.id) }));
}

/**
 * Adds periodBalance (what the Saldo column shows), periodYearName and periodApplies to each account: for revenue and
 * expense accounts the ledger balance of the fiscal year holding today; for the CURRENT_PROFIT account
 * the profit of that year; null for balance sheet accounts, and for revenue and expense accounts when no
 * fiscal year holds today; periodApplies is true on those rows and on CURRENT_PROFIT. It is read from the ledger, not from accounts.balance (E2-R15a).
 */
async function withPeriodBalance<T extends { id: string; rootType: string }>(accounts: T[]) {
  const year = await currentPnlYear(prisma, businessToday());
  const balances = year ? await pnlPeriodBalances(prisma, year.id) : [];
  const amountOf = new Map(balances.map((b) => [b.accountId, b.amount]));
  const profitIds = new Set((await systemAccounts.getAccounts('CURRENT_PROFIT')).map((a) => a.id));
  const profit = currentProfit(balances).toString();
  return accounts.map((acc) => {
    const isPnl = acc.rootType === 'REVENUE' || acc.rootType === 'EXPENSE';
    const periodBalance =
      !year ? null : isPnl ? (amountOf.get(acc.id) ?? new Prisma.Decimal(0)).toString() : profitIds.has(acc.id) ? profit : null;
    // periodApplies tells "no year for a period account" (shown as a dash) from a balance sheet account.
    const periodApplies = isPnl || profitIds.has(acc.id);
    return { ...acc, periodBalance, periodYearName: periodBalance === null ? null : year!.name, periodApplies };
  });
}

// GET /api/coa — hierarchical account tree. The response stays a plain array; each row carries
// periodBalance / periodYearName (see withPeriodBalance).
router.get('/', async (req, res) => {
  try {
    const allAccounts = await withPeriodBalance(await withLocked(await prisma.account.findMany()));
    allAccounts.sort((a, b) => compareAccountNumber(a.accountNumber, b.accountNumber));

    const buildTree = (accounts: typeof allAccounts, parentId: string | null = null): any[] =>
      accounts
        .filter((acc) => acc.parentId === parentId)
        .map((acc) => ({ ...acc, children: buildTree(accounts, acc.id) }));

    return res.json(buildTree(allAccounts));
  } catch (error) {
    logger.error({ error }, 'GET /coa error');
    return res.status(500).json({ error: 'Gagal mengambil daftar akun.' });
  }
});

// GET /api/coa/flat — flat list (for dropdowns)
router.get('/flat', async (req, res) => {
  try {
    const accounts = await prisma.account.findMany({
      where: { isActive: true },
      select: {
        id: true,
        accountNumber: true,
        name: true,
        accountType: true,
        rootType: true,
        isGroup: true,
        isActive: true,
        balance: true,
      },
    });
    const withFlag = await withLocked(accounts);
    withFlag.sort((a, b) => compareAccountNumber(a.accountNumber, b.accountNumber));
    // partyRole (AR, AP, CUSTOMER_DEPOSIT, VENDOR_DEPOSIT or null) tells a form whether a line on
    // the account takes a party (E2-R4 'strict'); same role map as postJournal. An empty id list
    // never throws PARTY_ROLE_AMBIGUOUS here: the posting reports that conflict.
    const roles = await loadPartyRoleMap(prisma, []);
    return res.json(withFlag.map((acc) => ({ ...acc, partyRole: roles.get(acc.id) ?? null })));
  } catch (error) {
    logger.error({ error }, 'GET /coa/flat error');
    return res.status(500).json({ error: 'Gagal mengambil daftar akun.' });
  }
});

const PARENT_SELECT = { id: true, accountNumber: true, rootType: true, isGroup: true } as const;

// POST /api/coa: create account (requires coa edit permission)
router.post('/', async (req, res) => {
  const body = validateBody(CreateAccountSchema, req.body, res);
  if (!body) return;

  try {
    const outcome = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await lockAccounts(tx, [body.parentId]);
      const parent = body.parentId ? await tx.account.findUnique({ where: { id: body.parentId }, select: PARENT_SELECT }) : null;
      const plan = planCreate(body, parent);
      if (!plan.ok) return plan;
      const account = await tx.account.create({
        data: { ...plan.data, name: body.name },
      });
      return { ok: true as const, account };
    });
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.message, code: outcome.code });
    return res.status(201).json(outcome.account);
  } catch (error: any) {
    logger.error({ error }, 'POST /coa error');
    if (error.code === 'P2002') {
      return res.status(409).json({ error: 'Nomor akun sudah digunakan.' });
    }
    return res.status(500).json({ error: 'Gagal membuat akun.' });
  }
});

// PUT /api/coa/:id: update account (requires coa edit permission)
router.put('/:id', async (req, res) => {
  const id = req.params.id as string;
  const body = validateBody(UpdateAccountSchema, req.body, res);
  if (!body) return;

  try {
    const outcome = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const peek = await tx.account.findUnique({ where: { id }, select: { parentId: true } });
      if (!peek) return { kind: 'notFound' as const };
      await lockAccounts(tx, [id, peek.parentId]);
      const current = await tx.account.findUnique({ where: { id } });
      if (!current) return { kind: 'notFound' as const };
      const parent = current.parentId ? await tx.account.findUnique({ where: { id: current.parentId }, select: PARENT_SELECT }) : null;
      const facts = (await loadStructureFacts(tx, [id])).get(id)!;

      const plan = planUpdate(current, body, facts, parent);
      if (!plan.ok) return { kind: 'plan' as const, plan };

      if (plan.data.accountNumber) {
        const existing = await tx.account.findFirst({ where: { accountNumber: plan.data.accountNumber, id: { not: id } }, select: { id: true } });
        if (existing) return { kind: 'duplicate' as const };
        // Akun yang dipetakan sebagai akun sistem tidak boleh diganti nomornya.
        const err = systemAccountRenumberError(current.accountNumber, plan.data.accountNumber, facts.mappedRoles);
        if (err) return { kind: 'renumber' as const, error: err };
      }
      const account = await tx.account.update({ where: { id }, data: plan.data });
      return { kind: 'ok' as const, account };
    });
    switch (outcome.kind) {
      case 'notFound': return res.status(404).json({ error: 'Akun tidak ditemukan.' });
      case 'plan': return res.status(outcome.plan.status).json({ error: outcome.plan.message, code: outcome.plan.code });
      case 'duplicate': return res.status(409).json({ error: 'Nomor akun sudah digunakan oleh akun lain.' });
      case 'renumber': return res.status(400).json({ error: outcome.error });
      case 'ok': return res.json(outcome.account);
    }
  } catch (error: any) {
    logger.error({ error }, 'PUT /coa/:id error');
    if (error.code === 'P2025') return res.status(404).json({ error: 'Akun tidak ditemukan.' });
    if (error.code === 'P2002') return res.status(409).json({ error: 'Nomor akun sudah digunakan.' });
    return res.status(500).json({ error: 'Gagal mengupdate akun.' });
  }
});

// PATCH /api/coa/:id/balance: the account's opening balance at the cut-over date (E2-R11), through
// the one opening balance service; requires coa edit permission. throughLock (post into a locked
// month) needs period.lock and is never open to AIRA (owner decision #10).
router.patch('/:id/balance', async (req: AuthRequest, res) => {
  const id = req.params.id as string;
  const body = validateBody(SetBalanceSchema, req.body, res);
  if (!body) return;

  try {
    if (body.throughLock) {
      if (req.user!.via === 'mcp') {
        return res.status(403).json({ error: 'AIRA tidak dapat menembus kunci periode untuk saldo awal.', code: OPENING_LOCK_RIGHT });
      }
      if (!(await hasCap(req.user!.role, 'period.lock'))) {
        return res.status(403).json({ error: 'Menembus kunci periode untuk saldo awal butuh hak Kunci Periode (period.lock).', code: OPENING_LOCK_RIGHT });
      }
    }
    const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const opening = await setOpeningBalanceInTx(tx, {
        target: { kind: 'ACCOUNT', accountId: id },
        amount: body.balance,
        asOfDate: body.asOfDate,
        userId: req.user!.userId,
        throughLock: body.throughLock,
      });
      const account = await tx.account.findUnique({ where: { id } });
      return {
        account,
        opening: {
          asOfDate: opening.asOfDate,
          action: opening.action,
          journalNumber: opening.journal?.entryNumber ?? null,
          cancelled: opening.cancelled,
        },
      };
    }, { timeout: 15000 });

    return res.json(result);
  } catch (error: any) {
    return handleRouteError(res, error, 'PATCH /coa/:id/balance', 'Gagal mengatur saldo awal.');
  }
});

// DELETE /api/coa/:id: requires coa edit permission and the doc.cancel capability
router.delete('/:id', requireCap('doc.cancel'), async (req, res) => {
  const id = req.params.id as string;

  try {
    const childCount = await prisma.account.count({ where: { parentId: id } });
    if (childCount > 0) {
      return res.status(400).json({ error: 'Tidak dapat menghapus akun yang masih memiliki sub-akun. Hapus sub-akun terlebih dahulu.' });
    }

    // Accounts mapped as system accounts cannot be deleted.
    const sysMappings = await prisma.systemAccountMapping.findMany({ where: { accountId: id }, select: { role: true } });
    if (sysMappings.length > 0) {
      const roles = sysMappings.map((m) => m.role).join(', ');
      return res.status(400).json({
        error: `Tidak dapat menghapus akun ini karena dipakai sebagai Akun Sistem (${roles}). Lepaskan dulu pemetaannya di Pengaturan → Akun Sistem.`,
      });
    }

    const [itemCount, serviceCount] = await Promise.all([
      prisma.inventoryItem.count({ where: { accountId: id } }),
      prisma.serviceItem.count({ where: { accountId: id } }),
    ]);
    if (itemCount > 0 || serviceCount > 0) {
      const parts: string[] = [];
      if (itemCount > 0) parts.push(`${itemCount} item persediaan`);
      if (serviceCount > 0) parts.push(`${serviceCount} item jasa`);
      return res.status(400).json({
        error: `Tidak dapat menghapus akun ini karena masih ditautkan ke ${parts.join(' & ')}. Ubah akun pada item tersebut terlebih dahulu.`,
      });
    }

    const ledgerCount = await prisma.accountingLedgerEntry.count({ where: { accountId: id, isCancelled: false } });
    if (ledgerCount > 0) {
      return res.status(400).json({ error: 'Tidak dapat menghapus akun yang sudah memiliki transaksi.' });
    }

    const account = await prisma.account.findUnique({ where: { id }, select: { balance: true, name: true } });
    if (!account) return res.status(404).json({ error: 'Akun tidak ditemukan.' });
    if (Number(account.balance) !== 0) {
      return res.status(400).json({ error: `Tidak dapat menghapus akun dengan saldo tidak nol (${Number(account.balance).toLocaleString('id-ID')}).` });
    }

    await prisma.account.delete({ where: { id } });
    return res.json({ message: 'Akun dihapus.' });
  } catch (error: any) {
    logger.error({ error }, 'DELETE /coa/:id error');
    if (error.code === 'P2025') return res.status(404).json({ error: 'Akun tidak ditemukan.' });
    // Foreign-key violation: account still referenced by other data
    // (jurnal manual, pembayaran, dokumen, aset tetap, biaya produksi, dll.)
    if (error.code === 'P2003') {
      return res.status(400).json({
        error: 'Tidak dapat menghapus akun ini karena masih dipakai oleh data lain (transaksi, dokumen, aset tetap, atau biaya produksi). Batalkan atau alihkan data terkait terlebih dahulu.',
      });
    }
    return res.status(500).json({ error: 'Gagal menghapus akun.' });
  }
});

export default router;
