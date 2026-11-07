/**
 * Reclass confirmation for Pengaturan > Akun Sistem (E2-R8). Shown when the server refuses a save
 * with ACCOUNT_HAS_BALANCE (mode "transfer": the old account of a balance-sheet role still holds a
 * balance) and when moving what is left on a former account (mode "sweep"). Lists each old account,
 * its balance and party count, asks for the reason (min 5 characters) and hands it to `onConfirm`;
 * the server posts the reclass journal dated today.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight } from 'lucide-react';
import { formatRupiah } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';

/** One old account as the server reports it (ACCOUNT_HAS_BALANCE balances / GET formerResidues). */
export interface ReclassBalance {
  role: string;
  roleLabel: string;
  fromAccountId: string;
  fromAccount: string;
  toAccountId: string;
  toAccount: string;
  /** Net debit − credit on the old account, 2 decimals. */
  amount: string;
  partyCount: number;
}

export const REASON_MIN = 5;

interface SystemAccountReclassDialogProps {
  mode: 'transfer' | 'sweep';
  /** null closes the dialog. */
  balances: ReclassBalance[] | null;
  pending: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}

export function SystemAccountReclassDialog({ mode, balances, pending, onConfirm, onCancel }: SystemAccountReclassDialogProps) {
  const { t } = useTranslation('finance');
  const [reason, setReason] = useState('');
  const trimmed = reason.trim();
  const tooShort = trimmed.length < REASON_MIN;

  const close = () => {
    if (pending) return;
    setReason('');
    onCancel();
  };

  return (
    <Dialog open={balances !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{t(`systemAccountsTab.reclass.${mode}.title`)}</DialogTitle>
          <DialogDescription>{t(`systemAccountsTab.reclass.${mode}.description`)}</DialogDescription>
        </DialogHeader>

        <ul className="space-y-2" data-testid="reclass-balances">
          {(balances ?? []).map((b) => (
            <li key={`${b.role}:${b.fromAccountId}`} className="rounded-md border border-border p-3 text-sm">
              <p className="font-medium text-foreground">{b.roleLabel}</p>
              <p className="mt-1 flex flex-wrap items-center gap-1.5 text-muted-foreground">
                <span>{b.fromAccount}</span>
                <ArrowRight className="size-3.5" aria-label={t('systemAccountsTab.reclass.to')} />
                <span>{b.toAccount}</span>
              </p>
              <p className="mt-1 text-foreground">
                {t('systemAccountsTab.reclass.amount', { amount: formatRupiah(b.amount, { decimals: 2 }) })}
                {b.partyCount > 0 && (
                  <span className="text-muted-foreground"> · {t('systemAccountsTab.reclass.parties', { count: b.partyCount })}</span>
                )}
              </p>
            </li>
          ))}
        </ul>

        <div className="space-y-1.5">
          <label htmlFor="reclass-reason" className="text-sm font-medium text-foreground">
            {t('systemAccountsTab.reclass.reason')}
          </label>
          <Textarea
            id="reclass-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('systemAccountsTab.reclass.reasonPlaceholder')}
            maxLength={500}
          />
          {reason.length > 0 && tooShort && (
            <p className="text-xs text-danger-text">{t('systemAccountsTab.reclass.reasonTooShort', { min: REASON_MIN })}</p>
          )}
          <p className="text-xs text-muted-foreground">{t('systemAccountsTab.reclass.dateNote')}</p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={pending}>
            {t('systemAccountsTab.reclass.cancel')}
          </Button>
          <Button onClick={() => onConfirm(trimmed)} loading={pending} disabled={tooShort || pending}>
            {t(`systemAccountsTab.reclass.${mode}.confirm`)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
