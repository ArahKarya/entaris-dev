/**
 * Stock opname count entry (E3-R11). The system stock is the warehouse stock as of the count date
 * (GET /stock-opname/system-stock), loaded again right before submit. Only the lines the user filled
 * in are sent, each with the system stock the form showed; the server answers 409
 * OPNAME_STOCK_CHANGED when that moved, and the form marks those lines and reloads.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import api from '@/lib/api';
import { formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NumberInput } from '@/components/ui/number-input';
import { EmptyState, Field, LoadingState, PageHeader, StatCard } from '@/components/shared';
import { WarehouseSelectField } from '@/components/overlays/WarehouseSelectField';
import { todayLocal } from '@/lib/date';
import {
  buildSubmitLines,
  findStaleLines,
  parseCount,
  type StaleLine,
  type SystemStockRow,
} from './opnameCount';

interface SystemStockResponse {
  warehouseId: string;
  date: string;
  items: SystemStockRow[];
}

interface OpnameErrorBody {
  error?: string;
  code?: string;
  items?: { itemId: string; expectedSystemStock: string | number; systemStock: string | number }[];
}

const qty = (v: number) => formatNumber(v, { maxDecimals: 3 });
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

interface Props {
  breadcrumb: React.ReactNode;
  onBack: () => void;
  onSuccess: () => void;
}

export function StockOpnameCountForm({ breadcrumb, onBack, onSuccess }: Props) {
  const { t } = useTranslation('inventory');
  const [date, setDate] = useState(todayLocal());
  const [warehouseId, setWarehouseId] = useState('');
  const [notes, setNotes] = useState('');
  const [search, setSearch] = useState('');
  const [actualStocks, setActualStocks] = useState<Record<string, string>>({});
  // Lines whose system stock moved since the user saw it (reload before submit, or a 409).
  const [staleLines, setStaleLines] = useState<Record<string, StaleLine>>({});
  const [submitting, setSubmitting] = useState(false);

  const validDate = ISO_DATE.test(date);
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['stock-opname-system-stock', warehouseId, date],
    queryFn: () => api
      .get<SystemStockResponse>('/stock-opname/system-stock', { params: { warehouseId, date } })
      .then((r) => r.data),
    enabled: Boolean(warehouseId) && validDate,
  });
  const rows = useMemo(() => data?.items ?? [], [data]);

  const filteredRows = useMemo(() => {
    if (!search) return rows;
    const s = search.toLowerCase();
    return rows.filter((r) => r.name.toLowerCase().includes(s) || r.code.toLowerCase().includes(s));
  }, [rows, search]);

  const handleActualChange = (itemId: string, value: string) => {
    setActualStocks((prev) => ({ ...prev, [itemId]: value }));
    // Editing a marked line means the user checked it again.
    setStaleLines((prev) => {
      if (!(itemId in prev)) return prev;
      const { [itemId]: _checked, ...rest } = prev;
      return rest;
    });
  };

  const summary = useMemo(() => {
    let counted = 0;
    let surplus = 0;
    let deficit = 0;
    for (const row of rows) {
      const actual = parseCount(actualStocks[row.itemId]);
      if (actual === null) continue;
      counted++;
      if (actual > row.systemStock) surplus++;
      else if (actual < row.systemStock) deficit++;
    }
    return { counted, surplus, deficit };
  }, [rows, actualStocks]);

  /** Marks the lines a 409 listed and reloads the system stock. */
  const handleStockChanged = (body: OpnameErrorBody) => {
    const marked: Record<string, StaleLine> = {};
    for (const line of body.items ?? []) {
      marked[line.itemId] = { expectedSystemStock: Number(line.expectedSystemStock), systemStock: Number(line.systemStock) };
    }
    setStaleLines(marked);
    toast.error(t('stockOpnameCountForm.toast.stockChanged', { count: Object.keys(marked).length }));
    void refetch();
  };

  const handleSubmit = async () => {
    if (!warehouseId) {
      toast.error(t('stockOpnameCountForm.toast.warehouseRequired'));
      return;
    }
    if (buildSubmitLines(rows, actualStocks).length === 0) {
      toast.error(t('stockOpnameCountForm.toast.noItems'));
      return;
    }

    setSubmitting(true);
    try {
      // Reload the stock as of the count date right before sending: a line that moved since the form
      // showed it is marked for the user to check instead of being sent.
      const fresh = await refetch();
      if (fresh.isError || !fresh.data) {
        toast.error(t('stockOpnameCountForm.toast.loadFailed'));
        return;
      }
      const stale = findStaleLines(rows, fresh.data.items, actualStocks);
      if (Object.keys(stale).length > 0) {
        setStaleLines(stale);
        toast.error(t('stockOpnameCountForm.toast.stockChanged', { count: Object.keys(stale).length }));
        return;
      }

      await api.post('/stock-opname', {
        date,
        warehouseId,
        notes: notes || null,
        items: buildSubmitLines(rows, actualStocks),
      });
      toast.success(t('stockOpnameCountForm.toast.saved'));
      onSuccess();
    } catch (err: unknown) {
      const body = (err as { response?: { status?: number; data?: OpnameErrorBody } }).response?.data;
      if (body?.code === 'OPNAME_STOCK_CHANGED') {
        handleStockChanged(body);
        return;
      }
      toast.error(body?.error || t('stockOpnameCountForm.toast.saveFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  const resetCounts = () => {
    setActualStocks({});
    setStaleLines({});
  };

  return (
    <div className="space-y-5 pb-8">
      {/* PageHeader hides breadcrumbs below sm; keep a way back on phones. */}
      <div className="sm:hidden">{breadcrumb}</div>
      <PageHeader
        breadcrumb={breadcrumb}
        title={t('stockOpnameCountForm.title')}
        description={t('stockOpnameCountForm.description')}
      />

      {/* Header */}
      <div className="grid grid-cols-1 gap-4 rounded-lg border border-border bg-card p-4 md:grid-cols-3">
        <Field label={t('stockOpnameCountForm.fields.date')} required>
          <Input
            type="date"
            value={date}
            onChange={(e) => {
              // Counts stay (the physical count does not change); marks were against the old date.
              setDate(e.target.value);
              setStaleLines({});
            }}
          />
        </Field>
        <WarehouseSelectField
          label={t('stockOpnameCountForm.fields.warehouse')}
          required
          value={warehouseId}
          onChange={(id) => {
            // Reset entered values when switching warehouse: they were counted in the other one.
            setWarehouseId(id);
            resetCounts();
          }}
          autoDefault
          placeholder={t('stockOpnameCountForm.fields.warehousePlaceholder')}
        />
        <Field label={t('stockOpnameCountForm.fields.notes')}>
          <Input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t('stockOpnameCountForm.fields.notesPlaceholder')} />
        </Field>
      </div>
      {!warehouseId && (
        <p role="status" className="rounded-lg border border-warning/40 bg-warning-subtle p-3 text-sm text-warning-text">
          {t('stockOpnameCountForm.pickWarehouseHint')}
        </p>
      )}

      {/* Summary */}
      <section aria-label={t('stockOpnameCountForm.summary.label')} className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label={t('stockOpnameCountForm.summary.counted')} value={formatNumber(summary.counted)} />
        <StatCard label={t('stockOpnameCountForm.summary.surplus')} value={formatNumber(summary.surplus)} />
        <StatCard label={t('stockOpnameCountForm.summary.deficit')} value={formatNumber(summary.deficit)} />
      </section>

      {/* Search */}
      <div className="relative">
        <label htmlFor="opname-item-search" className="sr-only">
          {t('stockOpnameCountForm.search.label')}
        </label>
        <Search
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          id="opname-item-search"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
          placeholder={t('stockOpnameCountForm.search.placeholder')}
        />
      </div>

      {/* Items table */}
      {isLoading ? (
        <LoadingState label={t('stockOpnameCountForm.loading')} />
      ) : isError ? (
        <EmptyState
          kind="error"
          title={t('stockOpnameCountForm.loadError.title')}
          description={t('stockOpnameCountForm.loadError.description')}
          action={
            <Button size="sm" variant="outline" onClick={() => void refetch()}>
              {t('stockOpnameCountForm.loadError.retry')}
            </Button>
          }
        />
      ) : (
        <div
          className="overflow-x-auto rounded-lg border border-border bg-card"
          role="region"
          aria-label={t('stockOpnameCountForm.table.label')}
          // Focusable so keyboard users can scroll the wide count table.
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={0}
        >
          <table className="w-full min-w-[40rem] text-sm">
            <thead className="border-b border-border bg-muted/50 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2">{t('stockOpnameCountForm.table.code')}</th>
                <th scope="col" className="px-3 py-2">{t('stockOpnameCountForm.table.name')}</th>
                <th scope="col" className="px-3 py-2">{t('stockOpnameCountForm.table.unit')}</th>
                <th scope="col" className="px-3 py-2 text-right">{t('stockOpnameCountForm.table.systemStock')}</th>
                <th scope="col" className="w-36 px-3 py-2 text-right">{t('stockOpnameCountForm.table.actualStock')}</th>
                <th scope="col" className="px-3 py-2 text-right">{t('stockOpnameCountForm.table.difference')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filteredRows.map((row) => {
                const actual = parseCount(actualStocks[row.itemId]);
                const diff = actual === null ? 0 : actual - row.systemStock;
                const stale = staleLines[row.itemId];

                return (
                  <tr
                    key={row.itemId}
                    className={cn(
                      diff > 0 && 'bg-success-subtle/40',
                      diff < 0 && 'bg-danger-subtle/40',
                      stale && 'bg-warning-subtle/60',
                    )}
                  >
                    <td className="num px-3 py-2 font-mono text-xs">{row.code}</td>
                    <td className="px-3 py-2 text-foreground">
                      {row.name}
                      {stale && (
                        <p role="alert" className="text-xs text-warning-text">
                          {t('stockOpnameCountForm.table.stockChanged', {
                            from: qty(stale.expectedSystemStock),
                            to: qty(stale.systemStock),
                          })}
                        </p>
                      )}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{row.unit}</td>
                    <td className="num px-3 py-2 text-right">{qty(row.systemStock)}</td>
                    <td className="px-3 py-2">
                      <NumberInput
                        step="any"
                        min="0"
                        className={cn('num text-right', stale && 'border-warning')}
                        aria-label={t('stockOpnameCountForm.table.actualStockAria', { name: row.name })}
                        placeholder={qty(row.systemStock)}
                        value={actualStocks[row.itemId] ?? ''}
                        onChange={(e) => handleActualChange(row.itemId, e.target.value)}
                      />
                    </td>
                    <td
                      className={cn(
                        'num px-3 py-2 text-right font-semibold',
                        diff > 0 && 'text-success-text',
                        diff < 0 && 'text-danger-text',
                      )}
                    >
                      {diff !== 0 ? (diff > 0 ? '+' : '') + qty(diff) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Submit */}
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="outline" onClick={onBack}>
          {t('stockOpnameCountForm.actions.cancel')}
        </Button>
        <Button onClick={handleSubmit} loading={submitting} disabled={submitting || !warehouseId || !validDate}>
          {submitting ? t('stockOpnameCountForm.actions.saving') : t('stockOpnameCountForm.actions.submit')}
        </Button>
      </div>
    </div>
  );
}
