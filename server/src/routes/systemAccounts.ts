import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { AuthRequest } from '../middleware/auth';
import { BusinessError, handleRouteError } from '../utils/errors';
import { systemAccounts } from '../services/systemAccounts';
import { postableAccountProblem } from '../services/ledger/accountGuard';
import { changedMappings, findRoleConflict, resultingMappings } from '../services/systemAccountMappingRules';
import {
  AccountHasBalanceError,
  applyRemap,
  assertRemapEmptied,
  assertTransferAllowed,
  findFormerResidues,
  hasResidue,
  isReclassRole,
  lockRemaps,
  planRemap,
  remapCandidates,
  sweepFormerAccounts,
  type RemapPlan,
  type RemapTransfer,
} from '../services/systemAccountRemap';
import {
  SYSTEM_ACCOUNT_ROLES,
  ALL_SYSTEM_ROLES,
  type SystemAccountRole,
} from '../types/systemAccounts';

const router = Router();

// GET /api/system-accounts — list all mappings grouped by role
router.get('/', async (req: AuthRequest, res: Response) => {
  const mappings = await prisma.systemAccountMapping.findMany({
    include: {
      account: {
        select: { id: true, accountNumber: true, name: true, accountType: true, rootType: true },
      },
    },
    orderBy: [{ role: 'asc' }, { sortOrder: 'asc' }],
  });

  // Group by role
  const grouped: Record<string, Array<{
    id: string;
    accountId: string;
    accountNumber: string;
    accountName: string;
    accountType: string;
    sortOrder: number;
  }>> = {};

  for (const m of mappings) {
    const list = grouped[m.role] ?? [];
    list.push({
      id: m.id,
      accountId: m.account.id,
      accountNumber: m.account.accountNumber,
      accountName: m.account.name,
      accountType: m.account.accountType,
      sortOrder: m.sortOrder,
    });
    grouped[m.role] = list;
  }

  // Build roles metadata
  const roles = ALL_SYSTEM_ROLES.map((key) => {
    const meta = SYSTEM_ACCOUNT_ROLES[key];
    return {
      key: meta.key,
      label: meta.label,
      description: meta.description,
      multiAccount: meta.multiAccount,
      required: meta.required,
      expectedRootType: meta.expectedRootType,
      // Balance-sheet single-account role: its balance moves with the mapping (otherwise history stays).
      balanceMoves: isReclassRole(key),
    };
  });

  // Old accounts of balance-sheet roles still holding a balance after a remap (sweep candidates).
  const formerResidues = await findFormerResidues(prisma);

  res.json({ mappings: grouped, roles, formerResidues });
});

/** Answers ACCOUNT_HAS_BALANCE with the balances for the transfer dialog; anything else as usual. */
function remapError(res: Response, error: unknown, context: string, fallback: string) {
  if (error instanceof AccountHasBalanceError) {
    return res.status(400).json({ error: error.message, code: error.code, balances: error.balances });
  }
  return handleRouteError(res, error, context, fallback);
}

// PUT /api/system-accounts: update mappings (requires settings edit permission)
const updateSchema = z.object({
  mappings: z.array(
    z.object({
      role: z.string(),
      accountId: z.string().uuid(),
      sortOrder: z.number().int().min(0).default(0),
    }),
  ).default([]),
  // Roles yang ingin dilepas total (set ke kosong). Tidak boleh role wajib.
  clearRoles: z.array(z.string()).default([]),
  // Pindahkan saldo akun lama peran neraca ke akun baru (jurnal reklas hari ini). Wajib dengan alasan.
  transferBalance: z.boolean().default(false),
  reason: z.string().trim().min(5, 'Alasan minimal 5 karakter.').max(500).optional(),
}).refine((d) => d.mappings.length > 0 || d.clearRoles.length > 0, {
  message: 'Tidak ada perubahan untuk disimpan.',
}).refine((d) => !d.transferBalance || !!d.reason, {
  message: 'Alasan wajib diisi untuk memindahkan saldo.',
  path: ['reason'],
});

router.put('/', async (req: AuthRequest, res: Response) => {
  if (req.user?.role !== 'Admin') {
    return res.status(403).json({ error: 'Hanya Admin yang dapat mengubah konfigurasi akun sistem.' });
  }

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Data tidak valid.', details: parsed.error.format() });
  }

  const { mappings: inputMappings, clearRoles, transferBalance, reason } = parsed.data;

  // Validate roles
  const validRoles = new Set<string>(ALL_SYSTEM_ROLES);
  for (const m of inputMappings) {
    if (!validRoles.has(m.role)) {
      return res.status(400).json({ error: `Role "${m.role}" tidak valid.` });
    }
  }

  // Validate clearRoles: harus valid & tidak wajib
  for (const role of clearRoles) {
    if (!validRoles.has(role)) {
      return res.status(400).json({ error: `Role "${role}" tidak valid.` });
    }
    const meta = SYSTEM_ACCOUNT_ROLES[role as SystemAccountRole];
    if (meta?.required) {
      return res.status(400).json({
        error: `Role "${meta.label}" wajib dan tidak dapat dilepas. Ganti ke akun lain, bukan dikosongkan.`,
      });
    }
  }

  // Every account must exist. Only (role, account) pairs that differ from the stored mappings are
  // checked further, so re-sending an unchanged legacy mapping (e.g. COGS on a group account)
  // alongside a real change is not rejected; the mapping audit reports those.
  const accountIds = [...new Set(inputMappings.map((m) => m.accountId))];
  const accounts = await prisma.account.findMany({
    where: { id: { in: accountIds } },
    select: { id: true, accountNumber: true, name: true, isGroup: true, isActive: true, rootType: true },
  });
  const accountMap = new Map(accounts.map((a) => [a.id, a]));

  for (const m of inputMappings) {
    if (!accountMap.has(m.accountId)) {
      return res.status(400).json({ error: `Akun dengan ID "${m.accountId}" tidak ditemukan.` });
    }
  }

  // Validate single-account roles don't have multiple entries
  const roleCounts = new Map<string, number>();
  for (const m of inputMappings) {
    roleCounts.set(m.role, (roleCounts.get(m.role) ?? 0) + 1);
  }
  for (const [role, count] of roleCounts) {
    const meta = SYSTEM_ACCOUNT_ROLES[role as SystemAccountRole];
    if (!meta.multiAccount && count > 1) {
      return res.status(400).json({
        error: `Role "${meta.label}" hanya boleh memiliki 1 akun, tapi diberikan ${count}.`,
      });
    }
  }

  // Determine which roles are being updated (mapped + dilepas)
  const rolesToUpdate = [...new Set([...inputMappings.map((m) => m.role), ...clearRoles])];

  let transfers: RemapTransfer[] = [];
  try {
    transfers = await prisma.$transaction(async (tx) => {
      // Serialise saves: the stored mappings the checks compare against must still be current at commit.
      await lockRemaps(tx);
      const stored = await tx.systemAccountMapping.findMany({ select: { role: true, accountId: true } });

      const changed = changedMappings(inputMappings, stored);
      for (const m of changed) {
        const meta = SYSTEM_ACCOUNT_ROLES[m.role as SystemAccountRole];
        const problem = postableAccountProblem(
          accountMap.get(m.accountId) ?? null,
          { label: `Peran ${meta.label}`, rootTypes: [meta.expectedRootType], allowControl: true },
          null,
        );
        if (problem) throw new BusinessError(problem.message, problem.code);
      }

      const touchedRoles = new Set([...inputMappings.map((m) => m.role), ...clearRoles]);
      const conflict = findRoleConflict(changed, resultingMappings(inputMappings, stored, touchedRoles));
      if (conflict) {
        const account = accountMap.get(conflict.accountId);
        throw new BusinessError(
          `Peran ${SYSTEM_ACCOUNT_ROLES[conflict.role].label} dan peran ${SYSTEM_ACCOUNT_ROLES[conflict.otherRole].label} tidak boleh memakai akun yang sama (${account?.accountNumber} ${account?.name}).`,
          conflict.code,
        );
      }

      // A single-account role moving to another account: balance-sheet roles carry their balance
      // (refused without transferBalance), profit and loss roles move without a reclass.
      const plans: RemapPlan[] = [];
      for (const candidate of remapCandidates(inputMappings, stored)) plans.push(await planRemap(tx, candidate));
      assertTransferAllowed(plans, transferBalance);
      const moving = plans.filter(hasResidue);
      const posted: RemapTransfer[] = [];
      for (const plan of moving) {
        posted.push(await applyRemap(tx, plan, { actorId: req.user!.userId, reason: reason ?? '' }));
      }

      // Delete existing mappings for the submitted roles
      await tx.systemAccountMapping.deleteMany({
        where: { role: { in: rolesToUpdate } },
      });

      // Create new mappings
      await tx.systemAccountMapping.createMany({
        data: inputMappings.map((m) => ({
          role: m.role,
          accountId: m.accountId,
          sortOrder: m.sortOrder,
        })),
      });

      await assertRemapEmptied(tx, moving);
      return posted;
    }, { timeout: 60000 });
  } catch (error) {
    return remapError(res, error, 'PUT /system-accounts', 'Gagal menyimpan konfigurasi akun sistem.');
  }

  // Invalidate cache
  systemAccounts.invalidateCache();

  // Return updated state
  const updated = await prisma.systemAccountMapping.findMany({
    where: { role: { in: rolesToUpdate } },
    include: {
      account: {
        select: { id: true, accountNumber: true, name: true, accountType: true },
      },
    },
    orderBy: [{ role: 'asc' }, { sortOrder: 'asc' }],
  });

  res.json({
    message: 'Konfigurasi akun sistem diperbarui.',
    updated: updated.map((m) => ({
      role: m.role,
      accountId: m.account.id,
      accountNumber: m.account.accountNumber,
      accountName: m.account.name,
      sortOrder: m.sortOrder,
    })),
    transfers,
  });
});

// POST /api/system-accounts/:role/sweep: move what is left on the role's former accounts (e.g. after
// an old invoice was voided) to the account mapped now, through the same reclass as a remap.
const sweepSchema = z.object({
  reason: z.string().trim().min(5, 'Alasan minimal 5 karakter.').max(500),
});

router.post('/:role/sweep', async (req: AuthRequest, res: Response) => {
  if (req.user?.role !== 'Admin') {
    return res.status(403).json({ error: 'Hanya Admin yang dapat mengubah konfigurasi akun sistem.' });
  }
  const role = String(req.params.role ?? '');
  if (!(ALL_SYSTEM_ROLES as readonly string[]).includes(role)) {
    return res.status(400).json({ error: `Role "${role}" tidak valid.` });
  }
  const parsed = sweepSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Data tidak valid.', details: parsed.error.format() });
  }

  try {
    const transfers = await prisma.$transaction(
      (tx) => sweepFormerAccounts(tx, role as SystemAccountRole, { actorId: req.user!.userId, reason: parsed.data.reason }),
      { timeout: 60000 },
    );
    res.json({
      message: transfers.length > 0
        ? 'Sisa saldo akun lama dipindahkan ke akun yang dipetakan sekarang.'
        : 'Tidak ada sisa saldo di akun lama peran ini.',
      transfers,
    });
  } catch (error) {
    return handleRouteError(res, error, 'POST /system-accounts/:role/sweep', 'Gagal memindahkan sisa saldo akun lama.');
  }
});

export default router;
