/** Reorder radar (CRM F2): repeat Customers with their cycle, last order and late status. */
import { useId, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { useTranslation } from 'react-i18next';
import { ExternalLink, MessageCircle, NotebookPen, SlidersHorizontal } from 'lucide-react';
import api from '@/lib/api';
import { formatDate, formatNumber, formatRupiah } from '@/lib/format';
import { can } from '@/lib/permissions';
import { crmKeys, whatsappUrl, type CrmSettings, type ReorderRow, type ReorderState } from '@/lib/crm';
import { cn } from '@/lib/utils';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DataTable, RowActions } from '@/components/shared';
import { ActivityDialog } from './ActivityDialog';

const STATES: (ReorderState | 'all')[] = ['all', 'late', 'ok', 'snoozed', 'insufficient'];

const STATE_TONE: Record<ReorderState, string> = {
  late: 'text-danger-text',
  ok: 'text-success-text',
  snoozed: 'text-muted-foreground',
  insufficient: 'text-muted-foreground',
};

interface RadarTableProps {
  ownerParam: string;
}

export function RadarTable({ ownerParam }: RadarTableProps) {
  const { t } = useTranslation('crm');
  const navigate = useNavigate();
  const stateId = useId();
  const canEdit = can('crm', 'edit');
  const [state, setState] = useState<ReorderState | 'all'>('all');
  const [logTarget, setLogTarget] = useState<ReorderRow | null>(null);

  const query = useQuery({
    queryKey: crmKeys.radar(ownerParam),
    queryFn: async () =>
      (
        await api.get<{ data: ReorderRow[]; settings: CrmSettings }>('/crm/reorder-radar', {
          params: ownerParam === 'all' ? {} : { ownerId: ownerParam },
        })
      ).data,
  });

  const rows = useMemo(() => {
    const all = query.data?.data ?? [];
    return state === 'all' ? all : all.filter((r) => r.state === state);
  }, [query.data, state]);

  const columns = useMemo<ColumnDef<ReorderRow>[]>(
    () => [
      {
        id: 'customer',
        header: t('radar.columns.customer'),
        meta: { cellClassName: 'min-w-44 max-w-72' },
        cell: ({ row }) => {
          const r = row.original;
          return (
            <div className="flex min-w-0 flex-col items-start gap-0.5">
              <p className="max-w-full truncate font-medium text-foreground">{r.partyName}</p>
              <p className="max-w-full truncate text-xs text-muted-foreground">{r.salesOwnerName ?? t('owner.none')}</p>
              {r.contactedSinceLate && r.lastContactOn && (
                <p className="text-xs text-muted-foreground">{t('radar.contacted', { date: formatDate(r.lastContactOn) })}</p>
              )}
            </div>
          );
        },
      },
      {
        id: 'lastOrder',
        header: t('radar.columns.lastOrder'),
        meta: { cellClassName: 'num whitespace-nowrap' },
        cell: ({ row }) => {
          const r = row.original;
          if (!r.lastOrderOn) return <span className="text-muted-foreground">—</span>;
          return (
            <div className="flex flex-col">
              <span>{formatDate(r.lastOrderOn)}</span>
              {r.daysSinceLastOrder !== null && (
                <span className="text-xs text-muted-foreground">{t('radar.daysAgo', { days: r.daysSinceLastOrder })}</span>
              )}
            </div>
          );
        },
      },
      {
        id: 'cycle',
        header: t('radar.columns.cycle'),
        meta: { hideBelow: 'md', cellClassName: 'whitespace-nowrap text-muted-foreground' },
        cell: ({ row }) => {
          const r = row.original;
          if (r.cycleDays === null) return t('radar.cycleNone');
          const days = formatNumber(r.cycleDays, { maxDecimals: 1 });
          return r.cycleSource === 'manual' ? t('radar.cycleManual', { days }) : t('radar.cycleAverage', { days });
        },
      },
      {
        id: 'lateAfter',
        header: t('radar.columns.lateAfter'),
        meta: { hideBelow: 'lg', cellClassName: 'num whitespace-nowrap text-muted-foreground' },
        cell: ({ row }) => (row.original.lateAfter ? formatDate(row.original.lateAfter) : '—'),
      },
      {
        id: 'state',
        header: t('radar.columns.state'),
        meta: { cellClassName: 'whitespace-nowrap' },
        cell: ({ row }) => {
          const r = row.original;
          return (
            <div className="flex flex-col">
              <span className={cn('text-sm font-medium', STATE_TONE[r.state])}>{t(`radar.states.${r.state}`)}</span>
              {r.state === 'late' && <span className="num text-xs text-danger-text">{t('followups.overdue', { days: r.overdueDays })}</span>}
              {r.state === 'snoozed' && r.snoozedUntil && (
                <span className="text-xs text-muted-foreground">{t('radar.snoozedUntil', { date: formatDate(r.snoozedUntil) })}</span>
              )}
            </div>
          );
        },
      },
      {
        id: 'avgOrder',
        header: t('radar.columns.avgOrder'),
        meta: { hideBelow: 'md', align: 'right', cellClassName: 'num whitespace-nowrap' },
        cell: ({ row }) => formatRupiah(row.original.avgOrderValue),
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">{t('radar.columns.actions')}</span>,
        meta: { align: 'right', headerClassName: 'w-12', cellClassName: 'w-12 py-0' },
        cell: ({ row }) => {
          const r = row.original;
          const wa = whatsappUrl(r.phone);
          return (
            <RowActions
              label={t('radar.actions.more', { name: r.partyName })}
              actions={[
                { label: t('followups.actions.whatsapp'), icon: MessageCircle, hidden: !wa, onSelect: () => wa && window.open(wa, '_blank', 'noopener,noreferrer') },
                { label: t('followups.actions.log'), icon: NotebookPen, hidden: !canEdit, onSelect: () => setLogTarget(r) },
                { label: t('radar.actions.setCycle'), icon: SlidersHorizontal, hidden: !canEdit, onSelect: () => navigate(`/crm/customers/${r.partyId}#profile`) },
                { label: t('followups.actions.openCustomer'), icon: ExternalLink, onSelect: () => navigate(`/crm/customers/${r.partyId}`) },
              ]}
            />
          );
        },
      },
    ],
    [canEdit, navigate, t],
  );

  const settings = query.data?.settings;

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <p className="max-w-3xl text-sm text-muted-foreground">
          {settings
            ? t('radar.intro', { min: settings.reorderMinInvoices, factor: formatNumber(settings.reorderToleranceFactor, { maxDecimals: 2 }) })
            : null}
        </p>
        <div className="w-full sm:w-44">
          <label htmlFor={stateId} className="sr-only">
            {t('radar.stateFilter')}
          </label>
          <Select value={state} onValueChange={(v) => setState(v as ReorderState | 'all')}>
            <SelectTrigger id={stateId}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATES.map((s) => (
                <SelectItem key={s} value={s}>
                  {t(`radar.states.${s}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <DataTable
        label={t('radar.tableLabel')}
        itemLabel={t('radar.itemLabel')}
        columns={columns}
        data={query.data ? rows : undefined}
        getRowId={(r) => r.partyId}
        loading={query.isLoading}
        error={query.error}
        onRetry={() => query.refetch()}
        onRowClick={(r) => navigate(`/crm/customers/${r.partyId}`)}
        filtered={state !== 'all'}
        onClearFilters={() => setState('all')}
        pageSize={50}
        empty={{ title: t('radar.empty.title'), description: t('radar.empty.description') }}
      />

      <ActivityDialog
        open={!!logTarget}
        onOpenChange={(open) => !open && setLogTarget(null)}
        partyId={logTarget?.partyId}
        subjectName={logTarget?.partyName ?? ''}
      />
    </div>
  );
}
