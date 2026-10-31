/**
 * "Kunci periode" card in Pengaturan > Tahun Buku: the monthly lock date, a form to set, move or
 * clear it, and the change history (server: GET/PUT /period-lock). Postings, edits and cancels
 * dated on or before the lock date are rejected with PERIOD_LOCKED. Changing it needs edit on the
 * journal module (route mount) and the period.lock capability; moving it back or clearing it needs
 * a reason (at least 5 characters, as on the server).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Lock, Unlock } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { canSetPeriodLock, movesLockBack, showDay, usePeriodLock } from '@/lib/periodLock';
import { todayLocal } from '@/lib/date';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { DateInput, Field, LoadingState } from '@/components/shared';
import { SettingsCard } from './SettingsCard';

const REASON_MIN = 5;
const REASON_MAX = 500;

function errorMessage(err: unknown, fallback: string): string {
  const data = (err as { response?: { data?: { error?: unknown } } })?.response?.data;
  return typeof data?.error === 'string' ? data.error : fallback;
}

export function PeriodLockCard() {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();
  const canEdit = canSetPeriodLock();
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState<'set' | 'clear' | null>(null);

  const lockQuery = usePeriodLock();
  const current = lockQuery.data?.lockDate ?? null;

  const saveMutation = useMutation({
    mutationFn: (vars: { lockDate: string | null; reason: string }) =>
      api.put('/period-lock', { lockDate: vars.lockDate, reason: vars.reason || null }),
    onSuccess: (_res, vars) => {
      toast.success(vars.lockDate ? t('fiscal.lock.toast.saved', { date: showDay(vars.lockDate, '') }) : t('fiscal.lock.toast.cleared'));
      setDate('');
      setReason('');
      setSubmitted(null);
      queryClient.invalidateQueries({ queryKey: ['period-lock'] });
    },
    onError: (err: unknown) => toast.error(errorMessage(err, t('fiscal.lock.toast.saveError'))),
  });

  const latestLockable = todayLocal(-1);
  const target = submitted === 'clear' ? null : date || null;
  const needsReason = submitted !== null && movesLockBack(current, target);
  const reasonError = needsReason && reason.trim().length < REASON_MIN ? t('fiscal.lock.errors.reasonRequired') : undefined;
  const dateError =
    submitted === 'set' && !date
      ? t('fiscal.lock.errors.dateRequired')
      : submitted === 'set' && date > latestLockable
        ? t('fiscal.lock.errors.datePast')
        : undefined;
  const reasonRequiredHint = movesLockBack(current, date || null);

  const submit = (mode: 'set' | 'clear') => {
    setSubmitted(mode);
    const next = mode === 'clear' ? null : date || null;
    if (mode === 'set' && (!date || date > latestLockable)) return;
    if (movesLockBack(current, next) && reason.trim().length < REASON_MIN) return;
    saveMutation.mutate({ lockDate: next, reason: reason.trim() });
  };

  const logs = lockQuery.data?.logs ?? [];

  return (
    <SettingsCard title={t('fiscal.lock.title')} description={t('fiscal.lock.description')}>
      {lockQuery.isLoading ? (
        <LoadingState label={t('fiscal.lock.loading')} />
      ) : lockQuery.isError ? (
        <div className="flex items-center justify-between gap-3 text-sm text-danger-text" role="alert">
          <span>{t('fiscal.lock.loadFailed')}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => lockQuery.refetch()}>
            {t('fiscal.lock.retry')}
          </Button>
        </div>
      ) : (
        <div className="space-y-5">
          <div className="flex items-start gap-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
              {current ? <Lock className="size-4" aria-hidden /> : <Unlock className="size-4 text-primary" aria-hidden />}
            </span>
            <div className="min-w-0">
              <p className="font-medium text-foreground" data-testid="period-lock-current">
                {current ? t('fiscal.lock.lockedUntil', { date: showDay(current, '') }) : t('fiscal.lock.none')}
              </p>
              {lockQuery.data?.updatedBy && lockQuery.data.updatedAt && (
                <p className="text-xs text-muted-foreground">
                  {t('fiscal.lock.updatedBy', { name: lockQuery.data.updatedBy.fullName, date: formatDateTime(lockQuery.data.updatedAt) })}
                </p>
              )}
            </div>
          </div>

          {canEdit && (
            <form
              noValidate
              className="space-y-3"
              onSubmit={(e) => { e.preventDefault(); submit('set'); }}
            >
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label={t('fiscal.lock.date')} required error={dateError} hint={t('fiscal.lock.dateHint')}>
                  <DateInput value={date} onChange={setDate} max={latestLockable} disabled={saveMutation.isPending} />
                </Field>
                <Field
                  label={t('fiscal.lock.reason')}
                  required={reasonRequiredHint || submitted === 'clear'}
                  error={reasonError}
                  hint={t('fiscal.lock.reasonHint')}
                >
                  <Textarea
                    value={reason}
                    maxLength={REASON_MAX}
                    rows={2}
                    onChange={(e) => setReason(e.target.value)}
                    disabled={saveMutation.isPending}
                  />
                </Field>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" loading={saveMutation.isPending && submitted === 'set'} disabled={saveMutation.isPending}>
                  <Lock aria-hidden /> {t('fiscal.lock.save')}
                </Button>
                {current && (
                  <Button
                    type="button"
                    variant="outline"
                    loading={saveMutation.isPending && submitted === 'clear'}
                    disabled={saveMutation.isPending}
                    onClick={() => submit('clear')}
                  >
                    <Unlock aria-hidden /> {t('fiscal.lock.clear')}
                  </Button>
                )}
              </div>
            </form>
          )}

          <div className="space-y-2">
            <h4 className="text-sm font-semibold text-foreground">{t('fiscal.lock.history')}</h4>
            {logs.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('fiscal.lock.historyEmpty')}</p>
            ) : (
              <div className="overflow-x-auto rounded border border-border">
                <Table aria-label={t('fiscal.lock.history')}>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('fiscal.lock.columns.when')}</TableHead>
                      <TableHead>{t('fiscal.lock.columns.user')}</TableHead>
                      <TableHead>{t('fiscal.lock.columns.change')}</TableHead>
                      <TableHead>{t('fiscal.lock.columns.reason')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {logs.map((log) => (
                      <TableRow key={log.id}>
                        <TableCell className="num whitespace-nowrap text-xs">{formatDateTime(log.createdAt)}</TableCell>
                        <TableCell className="text-xs">{log.user?.fullName ?? '—'}</TableCell>
                        <TableCell className="num whitespace-nowrap text-xs">
                          {showDay(log.oldDate, t('fiscal.lock.noLock'))} → {showDay(log.newDate, t('fiscal.lock.noLock'))}
                        </TableCell>
                        <TableCell className="text-xs break-words">{log.reason ?? '—'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        </div>
      )}
    </SettingsCard>
  );
}
