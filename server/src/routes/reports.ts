import { Router } from 'express';
import ExcelJS from 'exceljs';
import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';
import { systemAccounts } from '../services/systemAccounts';
import { computeBalanceSheet } from '../services/reports/balanceSheet';
import { logger } from '../lib/logger';
import { compareAccountNumber } from '../utils/accountSort';
import { buildTrialBalance } from '../utils/trialBalance';
import { sumMoney } from '../utils/moneySum';
import { computeImpact } from '../utils/accountBalance';
import Decimal from 'decimal.js';
import { asOfBound, businessToday, reportRange } from '../utils/businessDate';
import operationalRouter from './reports/operational';
import purchasingReportRouter from './reports/purchasing';

const router = Router();

// Operational reports (HPP, payable/receivable schedule, daily) live in
// reports/operational.ts to keep this file scannable.
router.use(operationalRouter);
router.use(purchasingReportRouter);

// GET /api/reports/trial-balance
router.get('/trial-balance', async (req, res) => {
  // Inclusive business days -> half-open [start 00:00, end+1 00:00) WIB.
  const parsed = reportRange(req.query, {});
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  const { gte: startDate, lt: endBefore } = parsed.range;

  try {
    const where: Prisma.AccountingLedgerEntryWhereInput = { isCancelled: false };
    if (startDate || endBefore) where.date = { gte: startDate, lt: endBefore };

    const [entries, accounts] = await Promise.all([
      prisma.accountingLedgerEntry.groupBy({
        by: ['accountId'],
        where,
        _sum: { debit: true, credit: true },
      }),
      // All accounts: group accounts with direct postings must appear too,
      // otherwise the totals no longer balance.
      prisma.account.findMany({
        select: { id: true, name: true, accountNumber: true, accountType: true, rootType: true },
      }),
    ]);

    const report = buildTrialBalance(
      accounts.map((a) => ({ ...a, accountType: a.accountType as string, rootType: a.rootType as string })),
      entries.map((e) => ({ accountId: e.accountId, debit: e._sum.debit ?? 0, credit: e._sum.credit ?? 0 })),
    );

    return res.json(report);
  } catch (error) {
    logger.error({ error }, 'GET /reports/trial-balance error');
    return res.status(500).json({ error: 'Gagal membuat laporan neraca saldo.' });
  }
});

// GET /api/reports/profit-loss
router.get('/profit-loss', async (req, res) => {
  // Inclusive business days -> half-open [start 00:00, end+1 00:00) WIB.
  const parsed = reportRange(req.query, {});
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  const { gte: startDate, lt: endBefore } = parsed.range;

  try {
    const where: Prisma.AccountingLedgerEntryWhereInput = {
      isCancelled: false,
      account: { OR: [{ rootType: 'REVENUE' as any }, { rootType: 'EXPENSE' as any }] },
    };
    if (startDate || endBefore) where.date = { gte: startDate, lt: endBefore };

    const [allAccounts, entries] = await Promise.all([
      prisma.account.findMany({
        where: { OR: [{ rootType: 'REVENUE' as any }, { rootType: 'EXPENSE' as any }] },
      }),
      prisma.accountingLedgerEntry.groupBy({
        by: ['accountId'],
        where,
        _sum: { debit: true, credit: true },
      }),
    ]);
    allAccounts.sort((a, b) => compareAccountNumber(a.accountNumber, b.accountNumber));

    const summaryMap = new Map(
      entries.map((e) => [
        e.accountId,
        { debit: new Decimal(e._sum.debit?.toString() ?? 0), credit: new Decimal(e._sum.credit?.toString() ?? 0) },
      ])
    );

    // O(n) with pre-built Maps instead of O(n²) allAccounts.find/filter
    const accountById = new Map(allAccounts.map((a) => [a.id, a]));
    const childrenOf = new Map<string | null, typeof allAccounts>();
    for (const a of allAccounts) {
      if (!childrenOf.has(a.parentId)) childrenOf.set(a.parentId, []);
      childrenOf.get(a.parentId)!.push(a);
    }

    const getBalance = (accountId: string): number => {
      const summ = summaryMap.get(accountId);
      const account = accountById.get(accountId);
      let balance = new Decimal(0);
      if (summ && account) {
        balance = account.rootType === 'REVENUE' ? summ.credit.minus(summ.debit) : summ.debit.minus(summ.credit);
      }
      for (const child of childrenOf.get(accountId) ?? []) {
        balance = balance.plus(getBalance(child.id));
      }
      return balance.toNumber();
    };

    const buildHierarchy = (parentId: string | null): any[] =>
      (childrenOf.get(parentId) ?? [])
        .map((a) => ({
          id: a.id,
          name: a.name,
          accountNumber: a.accountNumber,
          isGroup: a.isGroup,
          balance: getBalance(a.id),
          children: a.isGroup ? buildHierarchy(a.id) : [],
        }))
        .filter((a) => a.balance !== 0 || a.isGroup);

    // Build top-level items for each rootType — include roots themselves with nested children
    const buildRootItems = (rootType: string): any[] => {
      const roots = allAccounts.filter((a) => a[`rootType`] === rootType && !a.parentId);
      return roots
        .map((root) => ({
          id: root.id,
          name: root.name,
          accountNumber: root.accountNumber,
          isGroup: root.isGroup,
          balance: getBalance(root.id),
          children: root.isGroup ? buildHierarchy(root.id) : [],
        }))
        .filter((a) => a.balance !== 0 || a.isGroup)
        .sort((a: any, b: any) => compareAccountNumber(a.accountNumber, b.accountNumber));
    };

    const revenueAccounts = buildRootItems('REVENUE');
    const expenseAccounts = buildRootItems('EXPENSE');

    const totalRevenue = sumMoney(revenueAccounts.map((a: any) => a.balance));
    const totalExpense = sumMoney(expenseAccounts.map((a: any) => a.balance));

    return res.json({
      revenue: revenueAccounts,
      expense: expenseAccounts,
      totalRevenue,
      totalExpense,
      netProfit: sumMoney([totalRevenue, new Decimal(totalExpense).negated()]),
    });
  } catch (error) {
    logger.error({ error }, 'GET /reports/profit-loss error');
    return res.status(500).json({ error: 'Gagal membuat laporan laba rugi.' });
  }
});

// GET /api/reports/balance-sheet
// Equity split into current-year profit and retained earnings: services/reports/balanceSheet.ts.
router.get('/balance-sheet', async (req, res) => {
  // As of the end of the business day (default today): everything before the next day's 00:00 WIB.
  const asOf = asOfBound(req.query.date);
  if (!asOf.ok) return res.status(400).json({ error: asOf.error });

  try {
    return res.json(await computeBalanceSheet(prisma, { day: asOf.day, lt: asOf.lt }));
  } catch (error) {
    logger.error({ error }, 'GET /reports/balance-sheet error');
    return res.status(500).json({ error: 'Gagal membuat laporan neraca.' });
  }
});

// GET /api/reports/cash-flow
router.get('/cash-flow', async (req, res) => {
  // Default: 1 Jan of the current business year through today.
  const today = businessToday();
  const parsed = reportRange(req.query, { start: `${today.slice(0, 4)}-01-01`, end: today });
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  const { gte: start, lt: endBefore } = parsed.range;

  try {
    const cashAccounts = await systemAccounts.getAccounts('CASH');
    const cashAccountIds = cashAccounts.map((a) => a.id);

    const cashEntries = await prisma.accountingLedgerEntry.findMany({
      where: { accountId: { in: cashAccountIds }, date: { gte: start, lt: endBefore }, isCancelled: false },
      take: 50000,
    });

    const refIds = [...new Set(cashEntries.map((e) => e.referenceId).filter((id): id is string => !!id))];

    const offsettingEntries = await prisma.accountingLedgerEntry.findMany({
      where: { referenceId: { in: refIds }, accountId: { notIn: cashAccountIds }, isCancelled: false },
      include: { account: { select: { name: true, rootType: true, accountNumber: true } } },
      take: 50000,
    });

    let operating = 0;
    let investing = 0;
    let financing = 0;
    const operatingDetails: any[] = [];
    const investingDetails: any[] = [];
    const financingDetails: any[] = [];

    const arAccount = await systemAccounts.getAccount('AR');
    const apAccount = await systemAccounts.getAccount('AP');

    offsettingEntries.forEach((ent) => {
      const amount = Number(ent.credit) - Number(ent.debit);
      const rootType = ent.account.rootType as string;
      const accNum = ent.account.accountNumber;

      if (rootType === 'REVENUE' || rootType === 'EXPENSE' || accNum.startsWith(arAccount.accountNumber) || accNum.startsWith(apAccount.accountNumber)) {
        operating += amount;
        operatingDetails.push({ name: ent.account.name, amount });
      } else if (accNum.startsWith('1.6') || accNum.startsWith('1.7')) {
        investing += amount;
        investingDetails.push({ name: ent.account.name, amount });
      } else if (rootType === 'EQUITY' || accNum.startsWith('2.3')) {
        financing += amount;
        financingDetails.push({ name: ent.account.name, amount });
      } else {
        operating += amount;
        operatingDetails.push({ name: ent.account.name, amount });
      }
    });

    return res.json({
      operating,
      investing,
      financing,
      netChange: operating + investing + financing,
      details: { operating: operatingDetails, investing: investingDetails, financing: financingDetails },
    });
  } catch (error) {
    logger.error({ error }, 'GET /reports/cash-flow error');
    return res.status(500).json({ error: 'Gagal membuat laporan arus kas.' });
  }
});

// GET /api/reports/aging
router.get('/aging', async (req, res) => {
  const type = (req.query.type as string) === 'Supplier' ? 'Supplier' : 'Customer';
  const targetDate = new Date();

  try {
    let invoices: any[];
    if (type === 'Customer') {
      invoices = await prisma.salesInvoice.findMany({
        where: { status: { in: ['Submitted', 'PartiallyPaid', 'Overdue'] } },
        include: { customer: { select: { name: true } } },
        orderBy: { date: 'asc' },
        take: 10000,
      });
    } else {
      invoices = await prisma.purchaseInvoice.findMany({
        where: { status: { in: ['Submitted', 'PartiallyPaid', 'Overdue'] } },
        include: { supplier: { select: { name: true } } },
        orderBy: { date: 'asc' },
        take: 10000,
      });
    }

    const aging: Record<string, { current: number; 1: number; 31: number; 61: number; 91: number; total: number }> = {};

    invoices.forEach((inv: any) => {
      const partyName = type === 'Customer' ? inv.customer.name : inv.supplier.name;
      const dueDate = inv.dueDate ? new Date(inv.dueDate) : new Date(inv.date);
      const diffDays = Math.ceil((targetDate.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24));
      const amt = Number(inv.outstanding);

      if (!aging[partyName]) {
        aging[partyName] = { current: 0, 1: 0, 31: 0, 61: 0, 91: 0, total: 0 };
      }

      aging[partyName].total += amt;
      if (diffDays <= 0) aging[partyName].current += amt;
      else if (diffDays <= 30) aging[partyName][1] += amt;
      else if (diffDays <= 60) aging[partyName][31] += amt;
      else if (diffDays <= 90) aging[partyName][61] += amt;
      else aging[partyName][91] += amt;
    });

    return res.json(Object.entries(aging).map(([name, data]) => ({ name, ...data })));
  } catch (error) {
    logger.error({ error }, 'GET /reports/aging error');
    return res.status(500).json({ error: 'Gagal membuat laporan aging.' });
  }
});

// GET /api/reports/ledger-detail — detailed ledger entries for a specific account
router.get('/ledger-detail', async (req, res) => {
  const { accountId } = req.query;

  if (!accountId || typeof accountId !== 'string') {
    return res.status(400).json({ error: 'Parameter accountId wajib diisi.' });
  }

  // Inclusive business days -> half-open [start 00:00, end+1 00:00) WIB.
  const parsed = reportRange(req.query, {});
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  const { gte: startDate, lt: endBefore } = parsed.range;

  try {
    const account = await prisma.account.findUnique({
      where: { id: accountId },
      select: { id: true, name: true, accountNumber: true, rootType: true },
    });
    if (!account) {
      return res.status(404).json({ error: 'Akun tidak ditemukan.' });
    }

    const where: Prisma.AccountingLedgerEntryWhereInput = {
      accountId,
      isCancelled: false,
    };
    if (startDate || endBefore) where.date = { gte: startDate, lt: endBefore };

    const entries = await prisma.accountingLedgerEntry.findMany({
      where,
      orderBy: { date: 'asc' },
      select: {
        id: true,
        date: true,
        debit: true,
        credit: true,
        description: true,
        referenceType: true,
        referenceId: true,
      },
      take: 10000,
    });

    // Compute running balance
    const isDebitNormal = account.rootType === 'ASSET' || account.rootType === 'EXPENSE';
    let runningBalance = 0;
    const rows = entries.map((e) => {
      const debit = Number(e.debit);
      const credit = Number(e.credit);
      runningBalance += isDebitNormal ? (debit - credit) : (credit - debit);
      return {
        ...e,
        debit,
        credit,
        runningBalance,
      };
    });

    return res.json({
      accountId: account.id,
      accountName: account.name,
      accountNumber: account.accountNumber,
      entries: rows,
    });
  } catch (error) {
    logger.error({ error }, 'GET /reports/ledger-detail error');
    return res.status(500).json({ error: 'Gagal mengambil detail buku besar.' });
  }
});

// GET /api/reports/ledger-book — full ledger with mutations per account
router.get('/ledger-book', async (req, res) => {
  const parsed = reportRange(req.query, {});
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  const { gte: startDate, lt: endBefore } = parsed.range;

  try {
    // Get all active leaf accounts (non-group)
    const accounts = await prisma.account.findMany({
      where: { isActive: true, isGroup: false },
      select: { id: true, name: true, accountNumber: true, rootType: true },
      orderBy: { accountNumber: 'asc' },
    });

    // Sort accounts naturally by account number
    accounts.sort((a, b) => compareAccountNumber(a.accountNumber, b.accountNumber));

    // Build date filter
    const dateFilter: Prisma.AccountingLedgerEntryWhereInput = { isCancelled: false };
    if (startDate || endBefore) dateFilter.date = { gte: startDate, lt: endBefore };

    // Compute opening balance (before startDate) for each account if startDate is given
    const openingBalances = new Map<string, number>();
    if (startDate) {
      const openingEntries = await prisma.accountingLedgerEntry.groupBy({
        by: ['accountId'],
        where: { isCancelled: false, date: { lt: startDate } },
        _sum: { debit: true, credit: true },
      });
      for (const entry of openingEntries) {
        const account = accounts.find(a => a.id === entry.accountId);
        if (!account) continue;
        openingBalances.set(account.id, computeImpact(account.rootType, entry._sum.debit ?? 0, entry._sum.credit ?? 0));
      }
    }

    // Fetch all ledger entries in the period
    const allEntries = await prisma.accountingLedgerEntry.findMany({
      where: dateFilter,
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        accountId: true,
        date: true,
        debit: true,
        credit: true,
        description: true,
        referenceType: true,
        referenceId: true,
      },
      take: 100000,
    });

    // Group entries by account
    const entriesByAccount = new Map<string, typeof allEntries>();
    for (const entry of allEntries) {
      const list = entriesByAccount.get(entry.accountId) ?? [];
      list.push(entry);
      entriesByAccount.set(entry.accountId, list);
    }

    // Build result: only accounts that have entries or opening balance
    const result = accounts
      .filter(account => entriesByAccount.has(account.id) || (openingBalances.get(account.id) ?? 0) !== 0)
      .map(account => {
        const openingBalance = openingBalances.get(account.id) ?? 0;
        let runningBalance = new Decimal(openingBalance);

        const entries = (entriesByAccount.get(account.id) ?? []).map(e => {
          runningBalance = runningBalance.plus(computeImpact(account.rootType, e.debit, e.credit));
          return {
            id: e.id,
            date: e.date,
            debit: Number(e.debit),
            credit: Number(e.credit),
            description: e.description,
            referenceType: e.referenceType,
            runningBalance: runningBalance.toNumber(),
          };
        });

        const totalDebit = sumMoney(entries.map((e) => e.debit));
        const totalCredit = sumMoney(entries.map((e) => e.credit));

        return {
          accountId: account.id,
          accountNumber: account.accountNumber,
          accountName: account.name,
          rootType: account.rootType,
          openingBalance,
          entries,
          totalDebit,
          totalCredit,
          closingBalance: runningBalance.toNumber(),
        };
      });

    return res.json(result);
  } catch (error) {
    logger.error({ error }, 'GET /reports/ledger-book error');
    return res.status(500).json({ error: 'Gagal mengambil data buku besar.' });
  }
});

// POST /api/reports/export — export to Excel
router.post('/export', async (req, res) => {
  const { filename, data } = req.body;
  if (!data || !Array.isArray(data)) {
    return res.status(400).json({ error: 'Data tidak valid untuk ekspor.' });
  }
  if (data.length > 50000) {
    return res.status(400).json({ error: 'Data terlalu banyak untuk ekspor (maks. 50.000 baris).' });
  }

  try {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Report');

    // Add headers from first data row keys
    if (data.length > 0) {
      worksheet.columns = Object.keys(data[0]).map((key) => ({
        header: key,
        key,
        width: 20,
      }));
    }

    // Add rows
    data.forEach((row: Record<string, unknown>) => worksheet.addRow(row));

    // Style header row
    worksheet.getRow(1).font = { bold: true };

    const buffer = await workbook.xlsx.writeBuffer();

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const safeName = (filename || 'report').replace(/[^\w\-.]/g, '_').slice(0, 100);
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.xlsx"`);
    return res.send(Buffer.from(buffer));
  } catch (error) {
    logger.error({ error }, 'POST /reports/export error');
    return res.status(500).json({ error: 'Gagal ekspor ke Excel.' });
  }
});

export default router;
