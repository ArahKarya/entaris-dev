import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { BusinessError } from '../utils/errors';
import {
  ACCOUNT_MAPPING_MISSING,
  POSTING_SYSTEM_ROLES,
  SYSTEM_ACCOUNT_ROLES,
  REQUIRED_SYSTEM_ROLES,
  type SystemAccountRole,
} from '../types/systemAccounts';
import type { Prisma } from '@prisma/client';

export interface MappedAccount {
  id: string;
  accountNumber: string;
  name: string;
}

/** BusinessError ACCOUNT_MAPPING_MISSING for an unmapped role (the one message, translated). */
export function missingMappingError(role: SystemAccountRole): BusinessError {
  return new BusinessError(
    `Akun sistem untuk "${SYSTEM_ACCOUNT_ROLES[role].label}" belum dikonfigurasi. Silakan atur di Pengaturan > Akun Sistem.`,
    ACCOUNT_MAPPING_MISSING,
  );
}

/**
 * First account mapped to `role`, read through `tx` (never the process cache, so a mapping
 * changed in the same transaction or by another instance is seen). Throws a 400-class
 * BusinessError with ACCOUNT_MAPPING_MISSING when the role is unmapped.
 */
export async function mappedAccount(tx: Prisma.TransactionClient, role: SystemAccountRole): Promise<MappedAccount> {
  const row = await tx.systemAccountMapping.findFirst({
    where: { role },
    orderBy: { sortOrder: 'asc' },
    select: { account: { select: { id: true, accountNumber: true, name: true } } },
  });
  if (!row) throw missingMappingError(role);
  return row.account;
}

class SystemAccountsService {
  private cache: Map<string, MappedAccount[]> = new Map();
  private cacheLoaded = false;

  async loadCache(): Promise<void> {
    const mappings = await prisma.systemAccountMapping.findMany({
      include: {
        account: { select: { id: true, accountNumber: true, name: true } },
      },
      orderBy: [{ role: 'asc' }, { sortOrder: 'asc' }],
    });

    this.cache.clear();
    for (const m of mappings) {
      const list = this.cache.get(m.role) ?? [];
      list.push({
        id: m.account.id,
        accountNumber: m.account.accountNumber,
        name: m.account.name,
      });
      this.cache.set(m.role, list);
    }
    this.cacheLoaded = true;
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.cacheLoaded) {
      await this.loadCache();
    }
  }

  invalidateCache(): void {
    this.cacheLoaded = false;
    this.cache.clear();
  }

  async getAccount(role: SystemAccountRole): Promise<MappedAccount> {
    await this.ensureLoaded();
    const accounts = this.cache.get(role);
    if (!accounts || accounts.length === 0) {
      throw missingMappingError(role);
    }
    return accounts[0];
  }

  async getAccountId(role: SystemAccountRole): Promise<string> {
    const account = await this.getAccount(role);
    return account.id;
  }

  async getAccounts(role: SystemAccountRole): Promise<MappedAccount[]> {
    await this.ensureLoaded();
    return this.cache.get(role) ?? [];
  }

  async getAccountIds(role: SystemAccountRole): Promise<string[]> {
    const accounts = await this.getAccounts(role);
    return accounts.map((a) => a.id);
  }

  async getCashAccountNumbers(): Promise<string[]> {
    const accounts = await this.getAccounts('CASH');
    return accounts.map((a) => a.accountNumber);
  }

  async isCashAccount(accountNumber: string): Promise<boolean> {
    const cashNumbers = await this.getCashAccountNumbers();
    return cashNumbers.some((prefix) => accountNumber.startsWith(prefix));
  }

  async validateStartup(): Promise<void> {
    await this.loadCache();
    const missing: string[] = [];
    for (const role of REQUIRED_SYSTEM_ROLES) {
      const accounts = this.cache.get(role);
      if (!accounts || accounts.length === 0) {
        missing.push(`${role} (${SYSTEM_ACCOUNT_ROLES[role].label})`);
      }
    }
    if (missing.length > 0) {
      logger.warn(
        { missingRoles: missing },
        `System account mappings belum lengkap: ${missing.join(', ')}. Konfigurasi di Pengaturan > Akun Sistem.`,
      );
    } else {
      logger.info('Semua system account mappings sudah terkonfigurasi.');
    }

    // A posting role on a group or inactive account fails the next posting; make it loud at boot.
    const broken = await prisma.systemAccountMapping.findMany({
      where: {
        role: { in: [...POSTING_SYSTEM_ROLES] },
        account: { OR: [{ isGroup: true }, { isActive: false }] },
      },
      select: { role: true, account: { select: { accountNumber: true, name: true, isGroup: true, isActive: true } } },
    });
    if (broken.length > 0) {
      logger.error(
        {
          mappings: broken.map((m) => ({
            role: m.role,
            account: `${m.account.accountNumber} ${m.account.name}`,
            problem: m.account.isGroup ? 'group' : 'inactive',
          })),
        },
        'System account mappings point at a group or inactive account; postings for these roles will fail. Run scripts/repair/e2-system-account-audit and fix them in Settings > System Accounts.',
      );
    }
  }
}

export const systemAccounts = new SystemAccountsService();
