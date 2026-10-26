/**
 * CRM routes (/api/crm, module 'crm'): follow-up list, reorder radar, Customer 360, contacts,
 * activities, PIC sales and settings. See services/crm/*.
 */
import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { AuthRequest } from '../middleware/auth';
import { can, hasCap } from '../services/permissionService';
import { activityInclude, createActivityInTx, listActivities, settleFollowup } from '../services/crm/activities';
import { createContact, deleteContact, listContacts, updateContact } from '../services/crm/contacts';
import { FOLLOWUP_KINDS, loadFollowups, type FollowupKind } from '../services/crm/followups';
import { loadPartyOverview } from '../services/crm/overview';
import { loadReorderRadar, redactReorderRows, sortReorderRows } from '../services/crm/reorderRadar';
import { assertSalesOwner, listSalesUsers } from '../services/crm/salesOwner';
import { getCrmSettings } from '../services/crm/settings';
import { BusinessError, handleRouteError } from '../utils/errors';
import { firstString, parseListPaging } from '../utils/listQuery';
import {
  CrmActivityCreateSchema,
  CrmBulkOwnerSchema,
  CrmContactSchema,
  CrmFollowupSettleSchema,
  CrmPartyProfileSchema,
  CrmSettingsSchema,
} from '../utils/schemas';
import { validateBody } from '../utils/validate';

const router = Router();

const REORDER_STATES = new Set(['late', 'ok', 'snoozed', 'insufficient']);

function parseOwner(req: AuthRequest): string | undefined {
  const owner = firstString(req.query.ownerId);
  if (owner === 'me') return req.user!.userId;
  return owner || undefined;
}

function parseKinds(value: unknown): FollowupKind[] | null {
  const raw = firstString(value);
  if (!raw) return [];
  const kinds = raw.split(',').map((k) => k.trim()).filter(Boolean);
  return kinds.every((k) => (FOLLOWUP_KINDS as readonly string[]).includes(k)) ? (kinds as FollowupKind[]) : null;
}

// GET /followups?ownerId=me|<uuid>|unassigned&kinds=inquiry,party,quotation,reorder
router.get('/followups', async (req: AuthRequest, res) => {
  try {
    const kinds = parseKinds(req.query.kinds);
    if (kinds === null) return res.status(400).json({ error: 'Jenis tindak lanjut tidak dikenal.' });
    const settings = await getCrmSettings();
    return res.json(await loadFollowups(settings, { ownerId: parseOwner(req), kinds }));
  } catch (error) {
    return handleRouteError(res, error, 'GET /crm/followups', 'Gagal mengambil daftar tindak lanjut.');
  }
});

// POST /followups/settle { kind: inquiry|party, id, snoozeTo? } -> done, or moved to snoozeTo
router.post('/followups/settle', async (req: AuthRequest, res) => {
  const body = validateBody(CrmFollowupSettleSchema, req.body, res);
  if (!body) return;
  try {
    await settleFollowup(prisma, body);
    return res.json({ success: true });
  } catch (error) {
    return handleRouteError(res, error, 'POST /crm/followups/settle', 'Gagal memperbarui tindak lanjut.');
  }
});

// GET /reorder-radar?ownerId=&state=late|ok|snoozed|insufficient
router.get('/reorder-radar', async (req: AuthRequest, res) => {
  try {
    const state = firstString(req.query.state);
    if (state && !REORDER_STATES.has(state)) return res.status(400).json({ error: 'Status radar tidak dikenal.' });
    const settings = await getCrmSettings();
    const canSeeInvoices = await can(req.user!.role, 'sales_invoice', 'view');
    const rows = redactReorderRows(sortReorderRows(await loadReorderRadar(settings, { ownerId: parseOwner(req) })), canSeeInvoices);
    return res.json({ data: state ? rows.filter((r) => r.state === state) : rows, settings });
  } catch (error) {
    return handleRouteError(res, error, 'GET /crm/reorder-radar', 'Gagal mengambil radar pesan ulang.');
  }
});

// GET /sales-users -> [{ id, fullName }] for the PIC picker
router.get('/sales-users', async (_req, res) => {
  try {
    return res.json(await listSalesUsers());
  } catch (error) {
    return handleRouteError(res, error, 'GET /crm/sales-users', 'Gagal mengambil daftar sales.');
  }
});

// GET /parties/:id/overview -> Customer 360
router.get('/parties/:id/overview', async (req: AuthRequest, res) => {
  try {
    const settings = await getCrmSettings();
    const [canSeeInvoices, canSeeQuotations] = await Promise.all([
      can(req.user!.role, 'sales_invoice', 'view'),
      can(req.user!.role, 'quotation', 'view'),
    ]);
    return res.json(await loadPartyOverview(req.params.id as string, settings, { canSeeInvoices, canSeeQuotations }));
  } catch (error) {
    return handleRouteError(res, error, 'GET /crm/parties/:id/overview', 'Gagal mengambil ringkasan Customer.');
  }
});

// PUT /parties/:id/profile { salesOwnerId?, reorderCycleDays?, reorderSnoozedUntil? }
router.put('/parties/:id/profile', async (req: AuthRequest, res) => {
  const body = validateBody(CrmPartyProfileSchema, req.body, res);
  if (!body) return;
  try {
    const id = req.params.id as string;
    const party = await prisma.party.findUnique({ where: { id }, select: { id: true } });
    if (!party) throw new BusinessError('Customer tidak ditemukan.');
    if (body.salesOwnerId) await assertSalesOwner(prisma, body.salesOwnerId);
    const updated = await prisma.party.update({
      where: { id },
      data: {
        ...(body.salesOwnerId !== undefined ? { salesOwnerId: body.salesOwnerId } : {}),
        ...(body.reorderCycleDays !== undefined ? { reorderCycleDays: body.reorderCycleDays } : {}),
        ...(body.reorderSnoozedUntil !== undefined
          ? { reorderSnoozedUntil: body.reorderSnoozedUntil ? new Date(body.reorderSnoozedUntil) : null }
          : {}),
      },
      select: { id: true, salesOwnerId: true, reorderCycleDays: true, reorderSnoozedUntil: true },
    });
    return res.json(updated);
  } catch (error) {
    return handleRouteError(res, error, 'PUT /crm/parties/:id/profile', 'Gagal memperbarui profil sales Customer.');
  }
});

// POST /parties/bulk-owner { partyIds[], salesOwnerId|null }
router.post('/parties/bulk-owner', async (req: AuthRequest, res) => {
  const body = validateBody(CrmBulkOwnerSchema, req.body, res);
  if (!body) return;
  try {
    if (body.salesOwnerId) await assertSalesOwner(prisma, body.salesOwnerId);
    const result = await prisma.party.updateMany({
      where: { id: { in: body.partyIds } },
      data: { salesOwnerId: body.salesOwnerId },
    });
    return res.json({ updated: result.count });
  } catch (error) {
    return handleRouteError(res, error, 'POST /crm/parties/bulk-owner', 'Gagal mengganti PIC sales.');
  }
});

// GET /parties/:id/contacts
router.get('/parties/:id/contacts', async (req, res) => {
  try {
    return res.json(await listContacts(req.params.id as string));
  } catch (error) {
    return handleRouteError(res, error, 'GET /crm/parties/:id/contacts', 'Gagal mengambil kontak.');
  }
});

// POST /parties/:id/contacts -> { contact, warning }
router.post('/parties/:id/contacts', async (req, res) => {
  const body = validateBody(CrmContactSchema, req.body, res);
  if (!body) return;
  try {
    return res.status(201).json(await createContact(req.params.id as string, body));
  } catch (error) {
    return handleRouteError(res, error, 'POST /crm/parties/:id/contacts', 'Gagal menyimpan kontak.');
  }
});

// PUT /contacts/:id -> { contact, warning }
router.put('/contacts/:id', async (req, res) => {
  const body = validateBody(CrmContactSchema, req.body, res);
  if (!body) return;
  try {
    return res.json(await updateContact(req.params.id as string, body));
  } catch (error) {
    return handleRouteError(res, error, 'PUT /crm/contacts/:id', 'Gagal menyimpan kontak.');
  }
});

// DELETE /contacts/:id (activities keep their text; their contact link is cleared)
router.delete('/contacts/:id', async (req, res) => {
  try {
    if (!(await deleteContact(req.params.id as string))) return res.status(404).json({ error: 'Kontak tidak ditemukan.' });
    return res.json({ success: true });
  } catch (error) {
    return handleRouteError(res, error, 'DELETE /crm/contacts/:id', 'Gagal menghapus kontak.');
  }
});

// GET /activities?partyId=&inquiryId=&page=&limit=
router.get('/activities', async (req, res) => {
  try {
    const query = req.query as Record<string, unknown>;
    const partyId = firstString(query.partyId);
    const inquiryId = firstString(query.inquiryId);
    if (!partyId && !inquiryId) return res.status(400).json({ error: 'partyId atau inquiryId wajib diisi.' });
    const { page, limit: take, skip } = parseListPaging(query, { defaultLimit: 20, maxLimit: 100 });
    const { data, total } = await listActivities({ partyId, inquiryId, page, take, skip });
    return res.json({ data, total, page, limit: take });
  } catch (error) {
    return handleRouteError(res, error, 'GET /crm/activities', 'Gagal mengambil riwayat aktivitas.');
  }
});

// POST /activities
router.post('/activities', async (req: AuthRequest, res) => {
  const body = validateBody(CrmActivityCreateSchema, req.body, res);
  if (!body) return;
  try {
    const activity = await prisma.$transaction((tx) => createActivityInTx(tx, body, req.user!.userId));
    return res.status(201).json(activity);
  } catch (error) {
    return handleRouteError(res, error, 'POST /crm/activities', 'Gagal mencatat aktivitas.');
  }
});

// DELETE /activities/:id (creator, or anyone allowed to cancel documents)
router.delete('/activities/:id', async (req: AuthRequest, res) => {
  try {
    const existing = await prisma.crmActivity.findUnique({ where: { id: req.params.id as string } });
    if (!existing) return res.status(404).json({ error: 'Aktivitas tidak ditemukan.' });
    const isOwner = existing.createdBy === req.user!.userId;
    if (!isOwner && !(await hasCap(req.user!.role, 'doc.cancel'))) {
      return res.status(403).json({ error: 'Hanya pencatat aktivitas yang dapat menghapusnya.' });
    }
    await prisma.crmActivity.delete({ where: { id: existing.id } });
    return res.json({ success: true });
  } catch (error) {
    return handleRouteError(res, error, 'DELETE /crm/activities/:id', 'Gagal menghapus aktivitas.');
  }
});

// GET /activities/:id
router.get('/activities/:id', async (req, res) => {
  try {
    const activity = await prisma.crmActivity.findUnique({ where: { id: req.params.id as string }, include: activityInclude });
    if (!activity) return res.status(404).json({ error: 'Aktivitas tidak ditemukan.' });
    return res.json(activity);
  } catch (error) {
    return handleRouteError(res, error, 'GET /crm/activities/:id', 'Gagal mengambil aktivitas.');
  }
});

// GET /settings
router.get('/settings', async (_req, res) => {
  try {
    return res.json(await getCrmSettings());
  } catch (error) {
    return handleRouteError(res, error, 'GET /crm/settings', 'Gagal mengambil pengaturan CRM.');
  }
});

// PUT /settings (needs Settings edit on top of CRM edit)
router.put('/settings', async (req: AuthRequest, res) => {
  if (!(await can(req.user!.role, 'settings', 'edit'))) {
    return res.status(403).json({ error: 'Akses ditolak: Tidak memiliki izin.' });
  }
  const body = validateBody(CrmSettingsSchema, req.body, res);
  if (!body) return;
  try {
    const data = { ...body, reminderDays: [...new Set(body.reminderDays)].sort((a, b) => a - b), updatedBy: req.user!.userId };
    await prisma.crmSetting.upsert({ where: { slug: 'default' }, create: { slug: 'default', ...data }, update: data });
    return res.json(await getCrmSettings());
  } catch (error) {
    return handleRouteError(res, error, 'PUT /crm/settings', 'Gagal menyimpan pengaturan CRM.');
  }
});

export default router;
