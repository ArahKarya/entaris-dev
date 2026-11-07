/**
 * Opening balance for a detail account, as of the cut-over date. The form starts from the recorded
 * opening balance the server returns (GET /coa/:id/opening), never from the running balance: the
 * server posts the difference against Ekuitas Saldo Awal and decides what is allowed.
 */
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import api from '@/lib/api';
import { formatRupiah } from '@/lib/format';
import { cap } from '@/lib/permissions';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Field } from '@/components/shared';
import { apiErrorMessage, normalSide, openingFieldValue, openingPayload, parseBalanceInput, type CoaNode } from './coa-tree';

export interface OpeningBalanceDialogProps {
  node: CoaNode | null;
  onClose: () => void;
}

export interface OpeningJournalRef {
  id: string;
  entryNumber: string;
  date: string;
  amount: string;
}

/** GET /coa/:id/opening. */
export interface AccountOpening {
  cutoverDate: string;
  cutoverStored: boolean;
  amount: string | null;
  journals: OpeningJournalRef[];
  legacyJournals: OpeningJournalRef[];
  sameDayOpeningEquity: string[];
  editable: boolean;
  reason: string | null;
}

export function OpeningBalanceDialog({ node, onClose }: OpeningBalanceDialogProps) {
  const [pending, setPending] = useState(false);
  return (
    <Dialog open={node !== null} onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent size="sm">
        {/* Keyed so the form re-initialises for every account. */}
        {node && <OpeningLoader key={node.id} node={node} onClose={onClose} onPendingChange={setPending} />}
      </DialogContent>
    </Dialog>
  );
}

function OpeningLoader({
  node,
  onClose,
  onPendingChange,
}: {
  node: CoaNode;
  onClose: () => void;
  onPendingChange: (pending: boolean) => void;
}) {
  const { t } = useTranslation('finance');
  const query = useQuery({
    queryKey: ['coa-opening', node.id],
    queryFn: async () => (await api.get<AccountOpening>(`/coa/${node.id}/opening`)).data,
    // The recorded opening must be fresh every time the dialog opens.
    gcTime: 0,
    staleTime: 0,
    retry: false,
  });

  if (query.data) {
    return <BalanceForm node={node} opening={query.data} onClose={onClose} onPendingChange={onPendingChange} />;
  }
  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{t('openingBalanceDialog.title')}</DialogTitle>
        <DialogDescription>
          <span className="font-mono">{node.accountNumber}</span> · {node.name}
        </DialogDescription>
      </DialogHeader>
      {query.isError ? (
        <p role="alert" className="rounded-md border border-danger/30 bg-danger-subtle px-3 py-2 text-sm text-danger-text">
          {apiErrorMessage(query.error, t('openingBalanceDialog.loadFailed'))}
        </p>
      ) : (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
          <Loader2 className="size-4 animate-spin" aria-hidden /> {t('openingBalanceDialog.loading')}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {t('openingBalanceDialog.cancel')}
        </Button>
      </DialogFooter>
    </div>
  );
}

function BalanceForm({
  node,
  opening,
  onClose,
  onPendingChange,
}: {
  node: CoaNode;
  opening: AccountOpening;
  onClose: () => void;
  onPendingChange: (pending: boolean) => void;
}) {
  const { t } = useTranslation('finance');
  const queryClient = useQueryClient();
  const canThroughLock = cap('period.lock');
  const [balance, setBalance] = useState(() => openingFieldValue(opening.amount));
  const [throughLock, setThroughLock] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');

  const mutation = useMutation({
    mutationFn: (data: ReturnType<typeof openingPayload>) => api.patch(`/coa/${node.id}/balance`, data),
    onMutate: () => onPendingChange(true),
    onSettled: () => onPendingChange(false),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['coa'] });
      queryClient.invalidateQueries({ queryKey: ['coa-opening', node.id] });
      toast.success(t('openingBalanceDialog.saved'));
      onClose();
    },
    onError: (e) => setError(apiErrorMessage(e, t('openingBalanceDialog.saveFailed'))),
  });

  const parsed = parseBalanceInput(balance);
  const valid = !Number.isNaN(parsed);
  const lockReason = throughLock ? reason.trim() : null;
  const reasonOk = lockReason === null || lockReason.length >= 10;
  const blocked = !opening.editable;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (blocked) return;
    if (!valid) {
      setError(t('openingBalanceDialog.invalid'));
      return;
    }
    if (!reasonOk) {
      setError(t('openingBalanceDialog.reasonShort'));
      return;
    }
    mutation.mutate(openingPayload(parsed, lockReason));
  };

  const recorded = opening.amount === null ? 0 : Number(opening.amount);

  return (
    <form onSubmit={handleSubmit} className="grid gap-4" noValidate>
      <DialogHeader>
        <DialogTitle>{t('openingBalanceDialog.title')}</DialogTitle>
        <DialogDescription>
          <span className="font-mono">{node.accountNumber}</span> · {node.name}
        </DialogDescription>
      </DialogHeader>

      <dl className="grid grid-cols-2 gap-3 rounded-md border border-border bg-muted/40 p-3 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">{t('openingBalanceDialog.recorded')}</dt>
          <dd className="num mt-0.5 font-medium text-foreground">
            {opening.amount === null ? t('openingBalanceDialog.none') : formatRupiah(recorded, { negative: 'parens' })}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('openingBalanceDialog.cutover')}</dt>
          <dd className="num mt-0.5 font-medium text-foreground">{opening.cutoverDate}</dd>
        </div>
        <div className="col-span-2">
          <dt className="text-xs text-muted-foreground">{t('openingBalanceDialog.normal')}</dt>
          <dd className="mt-0.5 font-medium text-foreground">
            {normalSide(node.rootType) === 'D' ? t('openingBalanceDialog.debit') : t('openingBalanceDialog.credit')}
          </dd>
        </div>
      </dl>

      {!opening.cutoverStored && (
        <p className="text-sm text-muted-foreground">{t('openingBalanceDialog.cutoverDerived', { date: opening.cutoverDate })}</p>
      )}

      {opening.legacyJournals.length > 0 && (
        <div role="alert" className="rounded-md border border-warning/30 bg-warning-subtle px-3 py-2 text-sm text-warning-text">
          <p>{t('openingBalanceDialog.legacy')}</p>
          <ul className="mt-1 list-disc pl-5">
            {opening.legacyJournals.map((j) => (
              <li key={j.id} className="num">
                {j.entryNumber} · {j.date} · {formatRupiah(Number(j.amount), { negative: 'parens' })}
              </li>
            ))}
          </ul>
        </div>
      )}

      {blocked && opening.legacyJournals.length === 0 && (
        <p role="alert" className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground">
          {t('openingBalanceDialog.blocked', { code: opening.reason ?? '' })}
        </p>
      )}

      {opening.sameDayOpeningEquity.length > 0 && (
        <p className="text-sm text-muted-foreground">
          {t('openingBalanceDialog.sameDay', { journals: opening.sameDayOpeningEquity.join(', ') })}
        </p>
      )}

      <Field
        label={t('openingBalanceDialog.newBalance')}
        required
        hint={<Trans t={t} i18nKey="openingBalanceDialog.hint" components={{ br: <br /> }} />}
      >
        <Input
          value={balance}
          onChange={(e) => setBalance(e.target.value)}
          inputMode="decimal"
          autoComplete="off"
          disabled={blocked}
          className="num font-mono"
        />
      </Field>
      <p className="-mt-2 text-sm text-muted-foreground" aria-live="polite">
        {t('openingBalanceDialog.willSave')}{' '}
        <span className="num font-medium text-foreground">
          {valid
            ? formatRupiah(parsed, {
                decimals: Number.isInteger(parsed) ? 0 : 2,
                negative: 'parens',
              })
            : '—'}
        </span>
      </p>

      {canThroughLock && !blocked && (
        <div className="grid gap-2">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={throughLock} onChange={(e) => setThroughLock(e.target.checked)} />
            {t('openingBalanceDialog.throughLock')}
          </label>
          {throughLock && (
            <Field label={t('openingBalanceDialog.lockReason')} required hint={t('openingBalanceDialog.lockReasonHint')}>
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
            </Field>
          )}
        </div>
      )}

      {error && (
        <p
          role="alert"
          className="rounded-md border border-danger/30 bg-danger-subtle px-3 py-2 text-sm text-danger-text"
        >
          {error}
        </p>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={mutation.isPending}>
          {t('openingBalanceDialog.cancel')}
        </Button>
        <Button type="submit" disabled={mutation.isPending || blocked}>
          {mutation.isPending && <Loader2 className="animate-spin" aria-hidden />}
          {t('openingBalanceDialog.save')}
        </Button>
      </DialogFooter>
    </form>
  );
}
