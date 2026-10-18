/** Customer sales profile: PIC, manual order cycle, radar pause (PUT /crm/parties/:id/profile). */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import api from '@/lib/api';
import { formatNumber } from '@/lib/format';
import { crmKeys, type PartyOverview } from '@/lib/crm';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DateInput, Field } from '@/components/shared';
import { SalesOwnerSelect } from './SalesOwnerSelect';

const MAX_CYCLE = 730;

interface SalesProfileFormProps {
  overview: PartyOverview;
  canEdit: boolean;
}

/** Fields start from the saved profile; the caller keys this by the profile so a save resets it. */
export function SalesProfileForm({ overview, canEdit }: SalesProfileFormProps) {
  const { t } = useTranslation('crm');
  const queryClient = useQueryClient();
  const { party, reorder } = overview;
  const [ownerId, setOwnerId] = useState(party.salesOwnerId ?? '');
  const [cycle, setCycle] = useState(party.reorderCycleDays ? String(party.reorderCycleDays) : '');
  const [snoozedUntil, setSnoozedUntil] = useState(party.reorderSnoozedUntil ?? '');
  const [cycleError, setCycleError] = useState('');

  const mutation = useMutation({
    mutationFn: async (body: { salesOwnerId: string | null; reorderCycleDays: number | null; reorderSnoozedUntil: string | null }) =>
      api.put(`/crm/parties/${party.id}/profile`, body),
    onSuccess: () => {
      toast.success(t('customer.profile.saved'));
      void queryClient.invalidateQueries({ queryKey: crmKeys.all });
    },
    onError: (err: { response?: { data?: { error?: string } } }) => toast.error(err.response?.data?.error ?? t('customer.profile.failed')),
  });

  const submit = () => {
    setCycleError('');
    const trimmed = cycle.trim();
    const days = trimmed ? Number(trimmed) : null;
    if (days !== null && (!Number.isInteger(days) || days < 1 || days > MAX_CYCLE)) {
      setCycleError(t('customer.profile.cycleInvalid'));
      return;
    }
    mutation.mutate({ salesOwnerId: ownerId || null, reorderCycleDays: days, reorderSnoozedUntil: snoozedUntil || null });
  };

  const average =
    reorder?.avgIntervalDays != null ? t('customer.profile.cycleAverage', { days: formatNumber(reorder.avgIntervalDays, { maxDecimals: 1 }) }) : '';

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="grid gap-3"
    >
      <Field label={t('customer.profile.owner')}>
        {(control) => <SalesOwnerSelect id={control.id} value={ownerId} onChange={setOwnerId} disabled={!canEdit} />}
      </Field>
      <Field label={t('customer.profile.cycle')} hint={t('customer.profile.cycleHint', { average })} error={cycleError}>
        <Input
          value={cycle}
          onChange={(e) => setCycle(e.target.value.replace(/\D/g, ''))}
          inputMode="numeric"
          className="w-32"
          disabled={!canEdit}
        />
      </Field>
      <Field label={t('customer.profile.snooze')} hint={t('customer.profile.snoozeHint')}>
        {(control) => <DateInput id={control.id} value={snoozedUntil} onChange={setSnoozedUntil} disabled={!canEdit} className="w-44" />}
      </Field>
      {canEdit && (
        <div>
          <Button type="submit" size="sm" loading={mutation.isPending}>
            {t('customer.profile.save')}
          </Button>
        </div>
      )}
    </form>
  );
}
