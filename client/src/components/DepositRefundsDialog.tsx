/**
 * Cash refunds of one customer or supplier deposit, with "Batalkan refund" on each active refund.
 * Cancelling voids the refund journal, lowers the deposit's refunded total and gives the amount back
 * to the deposit balance (server: POST /<deposits>/:id/refunds/:journalId/cancel, doc.cancel).
 * The Journal menu no longer cancels refund journals.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/lib/api';
import { can, cap } from '@/lib/permissions';
import { formatDate, formatRupiah } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { ConfirmDialog, Field, StatusBadge } from '@/components/shared';
import { OverlayBody, OverlayFooter, OverlayHeader } from './sales/dialog-parts-b';
import { dialogShellClass } from './sales/dialog-classes-b';

export type DepositSide = 'customer' | 'vendor';

const SIDES: Record<DepositSide, { endpoint: string; module: string; queryKey: string }> = {
  customer: { endpoint: '/customer-deposits', module: 'customer_deposit', queryKey: 'customer-deposits' },
  vendor: { endpoint: '/vendor-deposits', module: 'vendor_deposit', queryKey: 'vendor-deposits' },
};

/** Same limit as the server's CancelReasonSchema. */
const REASON_MAX = 500;

export interface DepositRefund {
  journalEntryId: string;
  entryNumber: string;
  date: string;
  amount: number;
  status: string;
  cashAccount: { id: string; accountNumber: string; name: string } | null;
  cancelReason: string | null;
}

/** The refund cancel needs edit on the deposit module (route mount) and doc.cancel (requireCap). */
function canCancelDepositRefund(side: DepositSide): boolean {
  return can(SIDES[side].module, 'edit') && cap('doc.cancel');
}

function errorMessage(err: unknown, fallback: string): string {
  const data = (err as { response?: { data?: { error?: unknown } } })?.response?.data;
  return typeof data?.error === 'string' ? data.error : fallback;
}

interface Props {
  side: DepositSide;
  deposit: { id: string; paymentNumber: string; partyName?: string | null };
  onClose: () => void;
}

export function DepositRefundsDialog({ side, deposit, onClose }: Props) {
  const { t } = useTranslation('finance');
  const queryClient = useQueryClient();
  const { endpoint, queryKey } = SIDES[side];
  const canCancel = canCancelDepositRefund(side);
  const [target, setTarget] = useState<DepositRefund | null>(null);
  const [reason, setReason] = useState('');

  const refundsQuery = useQuery({
    queryKey: [queryKey, 'refunds', deposit.id],
    queryFn: async () => (await api.get<{ data: DepositRefund[] }>(`${endpoint}/${deposit.id}/refunds`)).data.data,
  });

  const cancelMutation = useMutation({
    mutationFn: (vars: { refund: DepositRefund; reason: string }) =>
      api.post(`${endpoint}/${deposit.id}/refunds/${vars.refund.journalEntryId}/cancel`, { reason: vars.reason || null }),
    onSuccess: (_res, vars) => {
      toast.success(t('depositRefundsDialog.toast.cancelled', { number: vars.refund.entryNumber }));
      // The list row (refunded/remaining), the party deposit balance and the ledger all change.
      queryClient.invalidateQueries({ queryKey: [queryKey] });
      queryClient.invalidateQueries({ queryKey: ['parties'] });
      queryClient.invalidateQueries({ queryKey: ['journals'] });
      queryClient.invalidateQueries({ queryKey: ['coa'] });
    },
    onError: (err: unknown) => toast.error(errorMessage(err, t('depositRefundsDialog.toast.cancelFailed'))),
  });

  const openCancel = (refund: DepositRefund) => {
    setReason('');
    setTarget(refund);
  };

  const refunds = refundsQuery.data;

  return (
    <>
      <Dialog open onOpenChange={(open) => !open && !cancelMutation.isPending && onClose()}>
        <DialogContent size="md" className={dialogShellClass}>
          <OverlayHeader>
            <DialogTitle>{t('depositRefundsDialog.title')}</DialogTitle>
            <DialogDescription>
              {t('depositRefundsDialog.description', { number: deposit.paymentNumber })}
              {deposit.partyName ? ` · ${deposit.partyName}` : ''}
            </DialogDescription>
          </OverlayHeader>

          <OverlayBody>
            {refundsQuery.isLoading && <p className="text-sm text-muted-foreground">{t('depositRefundsDialog.loading')}</p>}
            {refundsQuery.isError && (
              <div className="flex items-center justify-between gap-3 text-sm text-danger-text" role="alert">
                <span>{t('depositRefundsDialog.loadFailed')}</span>
                <Button type="button" variant="outline" size="sm" onClick={() => refundsQuery.refetch()}>
                  {t('depositRefundsDialog.retry')}
                </Button>
              </div>
            )}
            {refunds && refunds.length === 0 && (
              <p className="text-sm text-muted-foreground">{t('depositRefundsDialog.empty')}</p>
            )}
            {refunds && refunds.length > 0 && (
              <ul
                aria-label={t('depositRefundsDialog.listLabel', { number: deposit.paymentNumber })}
                className="divide-y divide-border rounded border border-border"
              >
                {refunds.map((r) => {
                  const cancelled = r.status === 'Cancelled';
                  return (
                    <li key={r.journalEntryId} className="flex flex-wrap items-start justify-between gap-3 px-3 py-2.5">
                      <div className="min-w-0 space-y-0.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="num font-mono text-xs font-medium text-foreground">{r.entryNumber}</span>
                          <StatusBadge status={r.status} docType="journal" />
                        </div>
                        <p className="num text-xs text-muted-foreground">
                          {formatDate(r.date)} ·{' '}
                          {r.cashAccount
                            ? `${r.cashAccount.accountNumber} · ${r.cashAccount.name}`
                            : t('depositRefundsDialog.noCashAccount')}
                        </p>
                        {cancelled && r.cancelReason && (
                          <p className="text-xs break-words text-muted-foreground">
                            {t('depositRefundsDialog.cancelledReason', { reason: r.cancelReason })}
                          </p>
                        )}
                      </div>
                      <div className="flex flex-col items-end gap-1.5">
                        <span className={cancelled ? 'num text-sm text-muted-foreground line-through' : 'num text-sm font-semibold text-foreground'}>
                          {formatRupiah(r.amount)}
                        </span>
                        {canCancel && !cancelled && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            aria-label={t('depositRefundsDialog.cancelAria', { number: r.entryNumber })}
                            onClick={() => openCancel(r)}
                          >
                            <Undo2 aria-hidden />
                            {t('depositRefundsDialog.cancel')}
                          </Button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </OverlayBody>

          <OverlayFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={cancelMutation.isPending}>
              {t('depositRefundsDialog.close')}
            </Button>
          </OverlayFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={target !== null}
        onOpenChange={(open) => !open && setTarget(null)}
        title={t('depositRefundsDialog.cancelDialog.title', { number: target?.entryNumber ?? '' })}
        description={t('depositRefundsDialog.cancelDialog.message', { amount: formatRupiah(target?.amount ?? 0) })}
        tone="danger"
        confirmLabel={t('depositRefundsDialog.cancelDialog.confirm')}
        loading={cancelMutation.isPending}
        onConfirm={() => (target ? cancelMutation.mutateAsync({ refund: target, reason: reason.trim() }) : undefined)}
      >
        <Field label={t('depositRefundsDialog.cancelDialog.reason')}>
          <Textarea
            value={reason}
            maxLength={REASON_MAX}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('depositRefundsDialog.cancelDialog.reasonPlaceholder')}
            disabled={cancelMutation.isPending}
          />
        </Field>
      </ConfirmDialog>
    </>
  );
}
