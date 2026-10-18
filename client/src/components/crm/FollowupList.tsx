/**
 * Follow-up list (CRM F1): compact rows that work on a phone. Each row offers WhatsApp, Log, and a
 * menu with done / snooze / open. Inquiry and Quotation open in their existing drawers.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { CalendarClock, Check, ExternalLink, FileSignature, Inbox, MessageCircle, NotebookPen, PauseCircle, UserRound } from 'lucide-react';
import api from '@/lib/api';
import { formatDate, formatNumber } from '@/lib/format';
import { can } from '@/lib/permissions';
import { addDaysIso, crmKeys, FOLLOWUP_KINDS, localToday, whatsappUrl, type FollowupItem, type FollowupKind, type FollowupResult } from '@/lib/crm';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { EmptyState, LoadingState, RowActions, type RowAction } from '@/components/shared';
import InquiryDetailDrawer from '@/components/InquiryDetailDrawer';
import QuotationDetailDrawer from '@/components/QuotationDetailDrawer';
import { ActivityDialog } from './ActivityDialog';
import { SnoozeDialog } from './SnoozeDialog';

const RADAR_PAUSE_DAYS = 30;

interface FollowupListProps {
  ownerParam: string;
}

function DueLabel({ item }: { item: FollowupItem }) {
  const { t } = useTranslation('crm');
  if (item.overdueDays <= 0) return <span className="text-xs font-medium text-warning-text">{t('followups.dueToday')}</span>;
  return <span className="num text-xs font-medium text-danger-text">{t('followups.overdue', { days: item.overdueDays })}</span>;
}

export function FollowupList({ ownerParam }: FollowupListProps) {
  const { t } = useTranslation('crm');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canEdit = can('crm', 'edit');
  const [kind, setKind] = useState<FollowupKind | 'all'>('all');
  const [logTarget, setLogTarget] = useState<FollowupItem | null>(null);
  const [snoozeTarget, setSnoozeTarget] = useState<FollowupItem | null>(null);
  const [inquiryId, setInquiryId] = useState<string | null>(null);
  const [quotationId, setQuotationId] = useState<string | null>(null);

  const query = useQuery({
    queryKey: crmKeys.followups(ownerParam),
    queryFn: async () =>
      (await api.get<FollowupResult>('/crm/followups', { params: ownerParam === 'all' ? {} : { ownerId: ownerParam } })).data,
  });

  const settle = useMutation({
    mutationFn: async (input: { item: FollowupItem; snoozeTo?: string }) =>
      api.post('/crm/followups/settle', { kind: input.item.kind, id: input.item.id, snoozeTo: input.snoozeTo ?? null }),
    onSuccess: (_res, input) => {
      toast.success(input.snoozeTo ? t('followups.toast.snoozed', { date: formatDate(input.snoozeTo) }) : t('followups.toast.done'));
      setSnoozeTarget(null);
      void queryClient.invalidateQueries({ queryKey: crmKeys.all });
      void queryClient.invalidateQueries({ queryKey: ['inquiries'] });
    },
    onError: () => toast.error(t('followups.toast.failed')),
  });

  const pauseRadar = useMutation({
    mutationFn: async (item: FollowupItem) => {
      const until = addDaysIso(localToday(), RADAR_PAUSE_DAYS);
      await api.put(`/crm/parties/${item.id}/profile`, { reorderSnoozedUntil: until });
      return until;
    },
    onSuccess: (until, item) => {
      toast.success(t('followups.toast.paused', { name: item.partyName, date: formatDate(until) }));
      void queryClient.invalidateQueries({ queryKey: crmKeys.all });
    },
    onError: () => toast.error(t('followups.toast.failed')),
  });

  const items = useMemo(() => {
    const all = query.data?.items ?? [];
    const filtered = kind === 'all' ? all : all.filter((i) => i.kind === kind);
    return [...filtered].sort((a, b) => b.overdueDays - a.overdueDays || a.partyName.localeCompare(b.partyName));
  }, [query.data, kind]);

  const counts = query.data?.counts;
  const total = query.data?.items.length ?? 0;

  const actionsFor = (item: FollowupItem): RowAction[] => [
    {
      label: t('followups.actions.done'),
      icon: Check,
      hidden: !canEdit || (item.kind !== 'inquiry' && item.kind !== 'party'),
      onSelect: () => settle.mutate({ item }),
    },
    {
      label: t('followups.actions.snooze'),
      icon: CalendarClock,
      hidden: !canEdit || (item.kind !== 'inquiry' && item.kind !== 'party'),
      onSelect: () => setSnoozeTarget(item),
    },
    {
      label: t('followups.actions.pauseRadar'),
      icon: PauseCircle,
      hidden: !canEdit || item.kind !== 'reorder',
      onSelect: () => pauseRadar.mutate(item),
    },
    {
      label: t('followups.actions.openInquiry'),
      icon: Inbox,
      hidden: item.kind !== 'inquiry' || !can('quotation', 'view'),
      onSelect: () => setInquiryId(item.id),
    },
    {
      label: t('followups.actions.openQuotation'),
      icon: FileSignature,
      hidden: item.kind !== 'quotation' || !can('quotation', 'view'),
      onSelect: () => setQuotationId(item.id),
    },
    {
      label: t('followups.actions.openCustomer'),
      icon: ExternalLink,
      hidden: !item.partyId,
      onSelect: () => navigate(`/crm/customers/${item.partyId}`),
    },
  ];

  if (query.isLoading) return <LoadingState />;
  if (query.isError) {
    return (
      <EmptyState
        kind="error"
        title={t('followups.error')}
        action={
          <Button size="sm" variant="outline" onClick={() => query.refetch()}>
            {t('followups.retry')}
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-3">
      <div role="group" aria-label={t('followups.filterLabel')} className="flex flex-wrap gap-1.5">
        {(['all', ...FOLLOWUP_KINDS] as const).map((value) => {
          const count = value === 'all' ? total : (counts?.[value] ?? 0);
          const active = kind === value;
          return (
            <Button
              key={value}
              type="button"
              size="sm"
              variant={active ? 'secondary' : 'outline'}
              aria-pressed={active}
              onClick={() => setKind(value)}
              title={value === 'all' ? undefined : t(`kindHints.${value}`)}
            >
              {value === 'all' ? t('followups.filterAll') : t(`kinds.${value}`)}
              <span className={cn('num text-xs', active ? 'text-foreground' : 'text-muted-foreground')}>{formatNumber(count)}</span>
            </Button>
          );
        })}
      </div>

      {items.length === 0 ? (
        <EmptyState title={t('followups.empty.title')} description={t('followups.empty.description')} />
      ) : (
        <ul aria-label={t('followups.listLabel')} className="divide-y divide-border rounded-md border border-border bg-card">
          {items.map((item) => {
            const wa = whatsappUrl(item.phone);
            const subline =
              item.kind === 'reorder'
                ? t('followups.lastOrder', { date: formatDate(item.referenceDate) })
                : item.kind === 'quotation'
                  ? t('followups.sentOn', { date: formatDate(item.referenceDate) })
                  : item.title;
            return (
              <li key={`${item.kind}-${item.id}`} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground/80">{t(`kinds.${item.kind}`)}</span>
                    {item.documentNumber && <span className="num font-mono">{item.documentNumber}</span>}
                    <DueLabel item={item} />
                  </div>
                  {item.partyId ? (
                    <button
                      type="button"
                      onClick={() => navigate(`/crm/customers/${item.partyId}`)}
                      className="max-w-full truncate text-left text-sm font-semibold text-foreground hover:text-primary hover:underline"
                    >
                      {item.partyName}
                    </button>
                  ) : (
                    <p className="truncate text-sm font-semibold text-foreground">{item.partyName}</p>
                  )}
                  {subline && subline !== item.documentNumber && <p className="truncate text-sm text-muted-foreground">{subline}</p>}
                  <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                    <UserRound className="size-3" aria-hidden />
                    {item.ownerName ? t('followups.ownerLine', { name: item.ownerName }) : t('owner.none')}
                    {!item.phone && <span aria-hidden>·</span>}
                    {!item.phone && <span>{t('followups.noPhone')}</span>}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {wa && (
                    <Button asChild size="sm" variant="outline" title={t('followups.actions.whatsapp')}>
                      <a href={wa} target="_blank" rel="noopener noreferrer" aria-label={`${t('followups.actions.whatsapp')}: ${item.partyName}`}>
                        <MessageCircle aria-hidden />
                        <span className="sr-only sm:not-sr-only">WA</span>
                      </a>
                    </Button>
                  )}
                  {canEdit && (
                    <Button size="sm" variant="outline" onClick={() => setLogTarget(item)}>
                      <NotebookPen aria-hidden />
                      {t('followups.actions.log')}
                    </Button>
                  )}
                  <RowActions label={t('followups.actions.more', { name: item.partyName })} actions={actionsFor(item)} />
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <ActivityDialog
        open={!!logTarget}
        onOpenChange={(open) => !open && setLogTarget(null)}
        partyId={logTarget?.partyId}
        inquiryId={logTarget?.kind === 'inquiry' ? logTarget.id : null}
        subjectName={logTarget?.partyName ?? ''}
      />
      <SnoozeDialog
        open={!!snoozeTarget}
        onOpenChange={(open) => !open && setSnoozeTarget(null)}
        pending={settle.isPending}
        onConfirm={(date) => snoozeTarget && settle.mutate({ item: snoozeTarget, snoozeTo: date })}
      />
      <InquiryDetailDrawer inquiryId={inquiryId} onClose={() => setInquiryId(null)} />
      <QuotationDetailDrawer quotationId={quotationId} onClose={() => setQuotationId(null)} />
    </div>
  );
}
