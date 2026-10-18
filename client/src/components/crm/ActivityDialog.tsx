/**
 * Log a sales activity on a Customer and/or an Inquiry (POST /crm/activities). The server moves the
 * follow-up along: a next date reopens it, no next date closes the current one.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import api from '@/lib/api';
import { ACTIVITY_TYPES, crmKeys, type ActivityType, type PartyContact } from '@/lib/crm';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { DateInput, Field } from '@/components/shared';
import { FormError, OverlayBody, OverlayFooter, OverlayHeader } from '@/components/sales/dialog-parts-b';
import { dialogShellClass } from '@/components/sales/dialog-classes-b';
import { QuickDates } from './QuickDates';

const NO_CONTACT = '__none__';

interface ActivityDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  partyId?: string | null;
  inquiryId?: string | null;
  /** Name shown in the description (Customer or prospect). */
  subjectName: string;
  defaultType?: ActivityType;
  onLogged?: () => void;
}

export function ActivityDialog(props: ActivityDialogProps) {
  const [pending, setPending] = useState(false);
  return (
    <Dialog open={props.open} onOpenChange={(next) => !pending && props.onOpenChange(next)}>
      <DialogContent size="md" className={dialogShellClass}>
        {/* Mounted only while open, so every open starts with an empty form. */}
        <ActivityForm {...props} onPendingChange={setPending} />
      </DialogContent>
    </Dialog>
  );
}

function ActivityForm({
  onOpenChange,
  partyId,
  inquiryId,
  subjectName,
  defaultType = 'WhatsApp',
  onLogged,
  onPendingChange,
}: ActivityDialogProps & { onPendingChange: (pending: boolean) => void }) {
  const { t } = useTranslation('crm');
  const queryClient = useQueryClient();
  const [type, setType] = useState<ActivityType>(defaultType);
  const [contactId, setContactId] = useState(NO_CONTACT);
  const [summary, setSummary] = useState('');
  const [outcome, setOutcome] = useState('');
  const [nextFollowUpDate, setNextFollowUpDate] = useState('');
  const [error, setError] = useState('');

  const contactsQuery = useQuery({
    queryKey: ['crm', 'contacts', partyId],
    queryFn: async () => (await api.get<PartyContact[]>(`/crm/parties/${partyId}/contacts`)).data,
    enabled: !!partyId,
  });
  const contacts = contactsQuery.data ?? [];

  const mutation = useMutation({
    mutationFn: async () =>
      (
        await api.post('/crm/activities', {
          partyId: partyId || null,
          inquiryId: inquiryId || null,
          contactId: contactId === NO_CONTACT ? null : contactId,
          type,
          summary: summary.trim(),
          outcome: outcome.trim() || null,
          nextFollowUpDate: nextFollowUpDate || null,
        })
      ).data,
    onMutate: () => onPendingChange(true),
    onSettled: () => onPendingChange(false),
    onSuccess: () => {
      toast.success(t('activity.toast.saved'));
      void queryClient.invalidateQueries({ queryKey: crmKeys.all });
      void queryClient.invalidateQueries({ queryKey: ['inquiries'] });
      if (inquiryId) void queryClient.invalidateQueries({ queryKey: ['inquiry', inquiryId] });
      onLogged?.();
      onOpenChange(false);
    },
    onError: (err: { response?: { data?: { error?: string } } }) =>
      setError(err.response?.data?.error ?? t('activity.errors.saveFailed')),
  });

  const submit = () => {
    setError('');
    if (!summary.trim()) {
      setError(t('activity.errors.summaryRequired'));
      return;
    }
    mutation.mutate();
  };

  const summaryError = error === t('activity.errors.summaryRequired') ? error : undefined;

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
        <DialogTitle>{t('activity.title')}</DialogTitle>
        <DialogDescription>{t('activity.description', { name: subjectName })}</DialogDescription>
      </OverlayHeader>

      <OverlayBody>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('activity.fields.type')}>
            <Select value={type} onValueChange={(v) => setType(v as ActivityType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ACTIVITY_TYPES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`activity.types.${value}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {contacts.length > 0 && (
            <Field label={t('activity.fields.contact')}>
              <Select value={contactId} onValueChange={setContactId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_CONTACT}>{t('activity.fields.contactNone')}</SelectItem>
                  {contacts.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.position ? `${c.name}, ${c.position}` : c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
        </div>

        <Field label={t('activity.fields.summary')} required error={summaryError}>
          <Textarea
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            rows={3}
            maxLength={2000}
            placeholder={t('activity.fields.summaryPlaceholder')}
          />
        </Field>

        <Field label={t('activity.fields.outcome')}>
          <Input
            value={outcome}
            onChange={(e) => setOutcome(e.target.value)}
            maxLength={1000}
            placeholder={t('activity.fields.outcomePlaceholder')}
          />
        </Field>

        <Field label={t('activity.fields.nextFollowUp')} hint={t('activity.fields.nextFollowUpHint')}>
          {(control) => (
            <div className="flex flex-wrap items-center gap-2">
              <DateInput id={control.id} value={nextFollowUpDate} onChange={setNextFollowUpDate} className="w-44" />
              <QuickDates value={nextFollowUpDate} onPick={setNextFollowUpDate} />
            </div>
          )}
        </Field>

        <FormError message={summaryError ? undefined : error} />
      </OverlayBody>

      <OverlayFooter>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
          {t('activity.actions.cancel')}
        </Button>
        <Button type="submit" loading={mutation.isPending} disabled={!summary.trim()}>
          {mutation.isPending ? t('activity.actions.saving') : t('activity.actions.save')}
        </Button>
      </OverlayFooter>
    </form>
  );
}
