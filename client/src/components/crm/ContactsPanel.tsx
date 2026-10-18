/** Customer contacts (CRM F5): list with WhatsApp links, add / edit / delete. */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Mail, MessageCircle, Pencil, Plus, Trash2 } from 'lucide-react';
import api from '@/lib/api';
import { crmKeys, whatsappUrl, type PartyContact } from '@/lib/crm';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ConfirmDialog, Field, RowActions } from '@/components/shared';
import { FormError, OverlayBody, OverlayFooter, OverlayHeader } from '@/components/sales/dialog-parts-b';
import { dialogShellClass } from '@/components/sales/dialog-classes-b';

interface ContactSaveResult {
  contact: PartyContact;
  warning: { phoneUsedBy: { partyId: string; partyName: string }[] };
}

interface ContactDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  partyId: string;
  partyName: string;
  contact: PartyContact | null;
}

function ContactDialog(props: ContactDialogProps) {
  const [pending, setPending] = useState(false);
  return (
    <Dialog open={props.open} onOpenChange={(next) => !pending && props.onOpenChange(next)}>
      <DialogContent size="md" className={dialogShellClass}>
        {/* Mounted only while open, so the fields start from the contact being edited. */}
        <ContactForm {...props} onPendingChange={setPending} />
      </DialogContent>
    </Dialog>
  );
}

function ContactForm({
  onOpenChange,
  partyId,
  partyName,
  contact,
  onPendingChange,
}: ContactDialogProps & { onPendingChange: (pending: boolean) => void }) {
  const { t } = useTranslation('crm');
  const queryClient = useQueryClient();
  const [name, setName] = useState(contact?.name ?? '');
  const [position, setPosition] = useState(contact?.position ?? '');
  const [phone, setPhone] = useState(contact?.phone ?? '');
  const [email, setEmail] = useState(contact?.email ?? '');
  const [isPrimary, setIsPrimary] = useState(contact?.isPrimary ?? false);
  const [notes, setNotes] = useState(contact?.notes ?? '');
  const [error, setError] = useState('');

  const mutation = useMutation({
    mutationFn: async () => {
      const body = {
        name: name.trim(),
        position: position.trim() || null,
        phone: phone.trim() || null,
        email: email.trim() || null,
        isPrimary,
        notes: notes.trim() || null,
      };
      const res = contact
        ? await api.put<ContactSaveResult>(`/crm/contacts/${contact.id}`, body)
        : await api.post<ContactSaveResult>(`/crm/parties/${partyId}/contacts`, body);
      return res.data;
    },
    onMutate: () => onPendingChange(true),
    onSettled: () => onPendingChange(false),
    onSuccess: (result) => {
      toast.success(t('contacts.toast.saved'));
      const others = result.warning.phoneUsedBy.map((p) => p.partyName);
      if (others.length) toast.warning(t('contacts.toast.phoneUsed', { names: others.join(', ') }));
      void queryClient.invalidateQueries({ queryKey: crmKeys.all });
      onOpenChange(false);
    },
    onError: (err: { response?: { data?: { error?: string } } }) => setError(err.response?.data?.error ?? t('contacts.toast.failed')),
  });

  const submit = () => {
    setError('');
    if (!name.trim()) {
      setError(t('contacts.errors.nameRequired'));
      return;
    }
    mutation.mutate();
  };
  const nameError = error === t('contacts.errors.nameRequired') ? error : undefined;

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <OverlayHeader>
        <DialogTitle>{contact ? t('contacts.dialog.editTitle') : t('contacts.dialog.createTitle')}</DialogTitle>
        <DialogDescription>{t('contacts.dialog.description', { name: partyName })}</DialogDescription>
      </OverlayHeader>
      <OverlayBody>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('contacts.dialog.name')} required error={nameError}>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          </Field>
          <Field label={t('contacts.dialog.position')}>
            <Input value={position} onChange={(e) => setPosition(e.target.value)} maxLength={120} />
          </Field>
          <Field label={t('contacts.dialog.phone')}>
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" maxLength={40} placeholder="0812..." />
          </Field>
          <Field label={t('contacts.dialog.email')}>
            <Input value={email} onChange={(e) => setEmail(e.target.value)} type="email" />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={isPrimary} onCheckedChange={(v) => setIsPrimary(v === true)} />
          {t('contacts.dialog.isPrimary')}
        </label>
        <Field label={t('contacts.dialog.notes')}>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={1000} />
        </Field>
        <FormError message={nameError ? undefined : error} />
      </OverlayBody>
      <OverlayFooter>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
          {t('contacts.dialog.cancel')}
        </Button>
        <Button type="submit" loading={mutation.isPending} disabled={!name.trim()}>
          {mutation.isPending ? t('contacts.dialog.saving') : t('contacts.dialog.save')}
        </Button>
      </OverlayFooter>
    </form>
  );
}

interface ContactsPanelProps {
  partyId: string;
  partyName: string;
  contacts: PartyContact[];
  canEdit: boolean;
}

export function ContactsPanel({ partyId, partyName, contacts, canEdit }: ContactsPanelProps) {
  const { t } = useTranslation('crm');
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<PartyContact | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<PartyContact | null>(null);

  const remove = useMutation({
    mutationFn: async (id: string) => api.delete(`/crm/contacts/${id}`),
    onSuccess: () => {
      toast.success(t('contacts.toast.deleted'));
      setDeleteTarget(null);
      void queryClient.invalidateQueries({ queryKey: crmKeys.all });
    },
    onError: () => toast.error(t('contacts.toast.deleteFailed')),
  });

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  return (
    <div className="space-y-2">
      {contacts.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('contacts.empty')}</p>
      ) : (
        <ul className="divide-y divide-border">
          {contacts.map((c) => {
            const wa = whatsappUrl(c.phone);
            return (
              <li key={c.id} className="flex items-start gap-2 py-2">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-foreground">
                    {c.name}
                    {c.isPrimary && (
                      <span className="rounded-sm bg-info-subtle px-1.5 py-px text-[11px] font-medium text-info-text">{t('contacts.primary')}</span>
                    )}
                  </p>
                  {c.position && <p className="text-xs text-muted-foreground">{c.position}</p>}
                  <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs">
                    {c.phone && wa && (
                      <a href={wa} target="_blank" rel="noopener noreferrer" className="num inline-flex items-center gap-1 text-primary hover:underline">
                        <MessageCircle className="size-3" aria-hidden />+{c.phone}
                      </a>
                    )}
                    {c.email && (
                      <a href={`mailto:${c.email}`} className="inline-flex items-center gap-1 text-primary hover:underline">
                        <Mail className="size-3" aria-hidden />
                        {c.email}
                      </a>
                    )}
                  </div>
                  {c.notes && <p className="mt-0.5 text-xs text-muted-foreground">{c.notes}</p>}
                </div>
                {canEdit && (
                  <RowActions
                    label={t('contacts.menu', { name: c.name })}
                    actions={[
                      {
                        label: t('contacts.edit'),
                        icon: Pencil,
                        onSelect: () => {
                          setEditing(c);
                          setDialogOpen(true);
                        },
                      },
                      { label: t('contacts.delete'), icon: Trash2, tone: 'danger', onSelect: () => setDeleteTarget(c) },
                    ]}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
      {canEdit && (
        <Button type="button" size="sm" variant="outline" onClick={openCreate}>
          <Plus aria-hidden />
          {t('contacts.add')}
        </Button>
      )}

      <ContactDialog open={dialogOpen} onOpenChange={setDialogOpen} partyId={partyId} partyName={partyName} contact={editing} />
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={t('contacts.deleteConfirmTitle', { name: deleteTarget?.name ?? '' })}
        description={t('contacts.deleteConfirmDescription')}
        confirmLabel={t('contacts.delete')}
        tone="danger"
        loading={remove.isPending}
        onConfirm={() => { if (deleteTarget) remove.mutate(deleteTarget.id); }}
      />
    </div>
  );
}
