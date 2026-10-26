/** Settings > CRM: morning reminder schedule and follow-up thresholds (GET/PUT /crm/settings). */
import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import api from '@/lib/api';
import { formatDate } from '@/lib/format';
import { can } from '@/lib/permissions';
import { crmKeys, type CrmSettings } from '@/lib/crm';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { EmptyState, Field, LoadingState } from '@/components/shared';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { SaveBar } from '@/components/settings/SaveBar';

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

type Form = Omit<CrmSettings, 'lastReminderOn'>;

function toForm(s: CrmSettings): Form {
  return {
    reminderEnabled: s.reminderEnabled,
    reminderTime: s.reminderTime,
    reminderDays: [...s.reminderDays].sort(),
    quotationNoReplyDays: s.quotationNoReplyDays,
    reorderToleranceFactor: s.reorderToleranceFactor,
    reorderMinInvoices: s.reorderMinInvoices,
  };
}

function numberOr(value: string, fallback: number): number {
  const n = Number(value.replace(',', '.'));
  return Number.isFinite(n) ? n : fallback;
}

export function CrmTab() {
  const { t } = useTranslation('crm');
  const query = useQuery({
    queryKey: crmKeys.settings,
    queryFn: async () => (await api.get<CrmSettings>('/crm/settings')).data,
  });
  if (query.isLoading) return <LoadingState />;
  if (query.isError || !query.data) return <EmptyState kind="error" title={t('settings.loadFailed')} />;
  // Keyed by the saved values: after a save the form restarts from what the server stored.
  return <CrmSettingsForm key={JSON.stringify(query.data)} saved={query.data} />;
}

function CrmSettingsForm({ saved }: { saved: CrmSettings }) {
  const { t } = useTranslation('crm');
  const queryClient = useQueryClient();
  const canEdit = can('settings', 'edit') && can('crm', 'edit');
  const enabledId = useId();
  const [form, setForm] = useState<Form>(() => toForm(saved));

  const mutation = useMutation({
    mutationFn: async (body: Form) => (await api.put<CrmSettings>('/crm/settings', body)).data,
    onSuccess: (data) => {
      toast.success(t('settings.saved'));
      queryClient.setQueryData(crmKeys.settings, data);
      void queryClient.invalidateQueries({ queryKey: crmKeys.all });
    },
    onError: (err: { response?: { data?: { error?: string } } }) => toast.error(err.response?.data?.error ?? t('settings.failed')),
  });

  const dirty = JSON.stringify(form) !== JSON.stringify(toForm(saved));
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));
  const toggleDay = (day: number) =>
    set('reminderDays', form.reminderDays.includes(day) ? form.reminderDays.filter((d) => d !== day) : [...form.reminderDays, day].sort());
  const last = saved.lastReminderOn;

  return (
    <div className="space-y-4">
      {!canEdit && <p className="text-sm text-muted-foreground">{t('settings.readOnly')}</p>}

      <SettingsCard title={t('settings.reminder.title')} description={t('settings.reminder.description')}>
        <div className="grid gap-4">
          <div className="flex items-center justify-between gap-4">
            <label htmlFor={enabledId} className="text-sm font-medium text-foreground">
              {t('settings.reminder.enabled')}
            </label>
            <Switch id={enabledId} checked={form.reminderEnabled} disabled={!canEdit} onCheckedChange={(v) => set('reminderEnabled', v)} />
          </div>
          <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
            <Field label={t('settings.reminder.time')} hint={last ? t('settings.reminder.lastSent', { date: formatDate(last) }) : t('settings.reminder.neverSent')}>
              <Input
                type="time"
                value={form.reminderTime}
                onChange={(e) => set('reminderTime', e.target.value)}
                disabled={!canEdit || !form.reminderEnabled}
              />
            </Field>
            <fieldset disabled={!canEdit || !form.reminderEnabled} className="grid gap-1.5">
              <legend className="mb-1.5 text-sm font-medium text-foreground">{t('settings.reminder.days')}</legend>
              <div className="flex flex-wrap gap-1.5">
                {WEEKDAYS.map((day) => {
                  const active = form.reminderDays.includes(day);
                  return (
                    <Button
                      key={day}
                      type="button"
                      size="sm"
                      variant={active ? 'secondary' : 'outline'}
                      aria-pressed={active}
                      className={cn('w-12', !active && 'text-muted-foreground')}
                      onClick={() => toggleDay(day)}
                    >
                      {t(`settings.weekdays.${day}`)}
                    </Button>
                  );
                })}
              </div>
            </fieldset>
          </div>
        </div>
      </SettingsCard>

      <SettingsCard title={t('settings.thresholds.title')}>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label={t('settings.thresholds.noReplyDays')}>
            <Input
              inputMode="numeric"
              value={String(form.quotationNoReplyDays)}
              onChange={(e) => set('quotationNoReplyDays', Math.trunc(numberOr(e.target.value, form.quotationNoReplyDays)))}
              disabled={!canEdit}
            />
          </Field>
          <Field label={t('settings.thresholds.tolerance')} hint={t('settings.thresholds.toleranceHint')}>
            <Input
              inputMode="decimal"
              value={String(form.reorderToleranceFactor)}
              onChange={(e) => set('reorderToleranceFactor', numberOr(e.target.value, form.reorderToleranceFactor))}
              disabled={!canEdit}
            />
          </Field>
          <Field label={t('settings.thresholds.minInvoices')}>
            <Input
              inputMode="numeric"
              value={String(form.reorderMinInvoices)}
              onChange={(e) => set('reorderMinInvoices', Math.trunc(numberOr(e.target.value, form.reorderMinInvoices)))}
              disabled={!canEdit}
            />
          </Field>
        </div>
      </SettingsCard>

      {canEdit && (
        <SaveBar
          dirty={dirty}
          saving={mutation.isPending}
          onSave={() => mutation.mutate(form)}
          onReset={() => setForm(toForm(saved))}
          saveLabel={t('settings.save')}
        />
      )}
    </div>
  );
}
