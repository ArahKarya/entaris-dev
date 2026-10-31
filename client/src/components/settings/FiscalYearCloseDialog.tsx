/**
 * Year-close dialog in Pengaturan > Tahun Buku: loads the close checklist (GET
 * /fiscal-years/:id/close-checklist) and shows each check, blocking ones in red and warnings in
 * amber, before the close confirmation. "Tutup Buku" stays disabled while a blocking check fails.
 * The server runs the same checks again when closing; a refusal (CLOSE_CHECKLIST_FAILED) carries
 * the fresh checklist, which replaces the one shown.
 */
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Lock, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/lib/api';
import { formatRupiah } from '@/lib/format';
import { showDay } from '@/lib/periodLock';
import { cn } from '@/lib/utils';
import { LoadingState } from '@/components/shared';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';

export interface CloseCheckItem {
  key: string;
  kind: string;
  label: string;
  date?: string;
  amount?: string;
  baselined?: boolean;
}

export interface CloseCheckResult {
  id: string;
  severity: 'block' | 'warn';
  status: 'ok' | 'fail';
  count: number;
  baselinedCount: number;
  items: CloseCheckItem[];
}

export interface CloseChecklist {
  fiscalYear: { id: string; name: string; startDay: string; endDay: string; isClosed: boolean };
  canClose: boolean;
  blocking: number;
  warnings: number;
  checks: CloseCheckResult[];
}

/** Items listed per failing check; the rest is summed up as "+N lainnya". */
const SHOWN_ITEMS = 5;

const checklistKey = (yearId: string) => ['fiscal-year-close-checklist', yearId];

interface ApiError {
  response?: { data?: { error?: unknown; code?: unknown; checklist?: CloseChecklist } };
}

function errorMessage(err: unknown, fallback: string): string {
  const data = (err as ApiError)?.response?.data;
  return typeof data?.error === 'string' ? data.error : fallback;
}

interface FiscalYearCloseDialogProps {
  /** The year to close; null keeps the dialog shut. */
  year: { id: string; name: string } | null;
  onOpenChange: (open: boolean) => void;
}

export function FiscalYearCloseDialog({ year, onOpenChange }: FiscalYearCloseDialogProps) {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();
  const yearId = year?.id ?? '';

  const query = useQuery<CloseChecklist>({
    queryKey: checklistKey(yearId),
    queryFn: async () => (await api.get<CloseChecklist>(`/fiscal-years/${yearId}/close-checklist`)).data,
    enabled: !!year,
    staleTime: 0,
  });

  const closeMutation = useMutation({
    mutationFn: async () => api.post(`/fiscal-years/${yearId}/close`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fiscal-years'] });
      queryClient.removeQueries({ queryKey: checklistKey(yearId) });
      toast.success(t('fiscal.toast.closed'));
      onOpenChange(false);
    },
    onError: (err: unknown) => {
      const data = (err as ApiError)?.response?.data;
      if (data?.code === 'CLOSE_CHECKLIST_FAILED' && data.checklist) queryClient.setQueryData(checklistKey(yearId), data.checklist);
      toast.error(errorMessage(err, t('fiscal.toast.closeError')));
    },
  });

  const checklist = query.data;
  const failing = checklist?.checks.filter((c) => c.status === 'fail') ?? [];
  const passing = checklist?.checks.filter((c) => c.status === 'ok') ?? [];

  return (
    <Dialog open={year !== null} onOpenChange={(o) => !closeMutation.isPending && onOpenChange(o)}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{t('fiscal.closeConfirm.title', { name: year?.name ?? '' })}</DialogTitle>
          <DialogDescription>{t('fiscal.closeConfirm.description')}</DialogDescription>
        </DialogHeader>

        {query.isLoading ? (
          <LoadingState label={t('fiscal.checklist.loading')} />
        ) : query.isError || !checklist ? (
          <div className="flex items-center justify-between gap-3 text-sm text-danger-text" role="alert">
            <span>{errorMessage(query.error, t('fiscal.checklist.loadFailed'))}</span>
            <Button type="button" variant="outline" size="sm" onClick={() => query.refetch()}>
              {t('fiscal.lock.retry')}
            </Button>
          </div>
        ) : (
          <div className="space-y-3" data-testid="close-checklist">
            <p
              className={cn('text-sm font-medium', checklist.canClose ? 'text-success-text' : 'text-danger-text')}
              role="status"
            >
              {checklist.canClose
                ? checklist.warnings > 0
                  ? t('fiscal.checklist.readyWithWarnings', { count: checklist.warnings })
                  : t('fiscal.checklist.ready')
                : t('fiscal.checklist.blocked', { count: checklist.blocking })}
            </p>
            <ul className="space-y-2">
              {failing.map((check) => (
                <CheckRow key={check.id} check={check} />
              ))}
            </ul>
            {passing.length > 0 && (
              <ul className="space-y-1 text-sm text-muted-foreground" aria-label={t('fiscal.checklist.passed')}>
                {passing.map((check) => (
                  <li key={check.id} className="flex items-start gap-2">
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success-text" aria-hidden />
                    <span>
                      {checkTitle(t, check.id)}
                      {check.baselinedCount > 0 && (
                        <span className="text-xs"> · {t('fiscal.checklist.baselined', { count: check.baselinedCount })}</span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={closeMutation.isPending}>
            {t('fiscal.form.cancel')}
          </Button>
          <Button
            variant="danger"
            onClick={() => closeMutation.mutate()}
            loading={closeMutation.isPending}
            disabled={!checklist?.canClose || closeMutation.isPending}
          >
            <Lock aria-hidden /> {t('fiscal.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Label of a check; one registered later by another module falls back to its id. */
function checkTitle(t: TFunction<'settings'>, id: string): string {
  return t(`fiscal.checklist.checks.${id}.title`, { defaultValue: id });
}

/**
 * Item labels are document numbers, except a system-account role, whose server label is an
 * Indonesian name: that one is shown in the user's language, with the server label as fallback.
 */
function itemLabel(t: TFunction<'settings'>, item: CloseCheckItem): string {
  if (item.kind !== 'SystemAccountRole') return item.label;
  return t(`fiscal.checklist.roles.${item.key}`, { defaultValue: item.label });
}

function CheckRow({ check }: { check: CloseCheckResult }) {
  const { t } = useTranslation('settings');
  const blocks = check.severity === 'block';
  const Icon = blocks ? XCircle : AlertTriangle;
  const counted = check.items.filter((i) => !i.baselined);
  const shown = counted.slice(0, SHOWN_ITEMS);
  const more = check.count - shown.length;

  return (
    <li
      className={cn('rounded-md border p-3', blocks ? 'border-danger-text/30 bg-danger-subtle' : 'border-warning-text/30 bg-warning-subtle')}
      data-testid={`close-check-${check.id}`}
    >
      <div className="flex items-start gap-2">
        <Icon className={cn('mt-0.5 size-4 shrink-0', blocks ? 'text-danger-text' : 'text-warning-text')} aria-hidden />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-medium text-foreground">
            {checkTitle(t, check.id)}{' '}
            <span className={cn('text-xs font-normal', blocks ? 'text-danger-text' : 'text-warning-text')}>
              ({blocks ? t('fiscal.checklist.blocking') : t('fiscal.checklist.warning')}, {check.count})
            </span>
          </p>
          <p className="text-xs text-muted-foreground">
            {t(`fiscal.checklist.checks.${check.id}.hint`, { defaultValue: '' })}
          </p>
          {shown.length > 0 && (
            <ul className="space-y-0.5 text-xs">
              {shown.map((item) => (
                <li key={item.key} className="flex flex-wrap gap-x-2">
                  <span className="font-medium text-foreground break-all">{itemLabel(t, item)}</span>
                  {item.date && <span className="num text-muted-foreground">{showDay(item.date, '')}</span>}
                  {item.amount && <span className="num text-muted-foreground">{formatRupiah(item.amount)}</span>}
                </li>
              ))}
            </ul>
          )}
          {more > 0 && <p className="text-xs text-muted-foreground">{t('fiscal.checklist.more', { count: more })}</p>}
          {check.baselinedCount > 0 && (
            <p className="text-xs text-muted-foreground">{t('fiscal.checklist.baselined', { count: check.baselinedCount })}</p>
          )}
        </div>
      </div>
    </li>
  );
}
