/** Pick a new follow-up date. */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { DateInput, Field } from '@/components/shared';
import { OverlayBody, OverlayFooter, OverlayHeader } from '@/components/sales/dialog-parts-b';
import { dialogShellClass } from '@/components/sales/dialog-classes-b';
import { addDaysIso, localToday } from '@/lib/crm';
import { QuickDates } from './QuickDates';

interface SnoozeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (date: string) => void;
  pending?: boolean;
}

export function SnoozeDialog({ open, onOpenChange, onConfirm, pending }: SnoozeDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent size="sm" className={dialogShellClass}>
        <SnoozeForm onOpenChange={onOpenChange} onConfirm={onConfirm} pending={pending} />
      </DialogContent>
    </Dialog>
  );
}

/** Mounted only while open: starts at tomorrow each time. */
function SnoozeForm({ onOpenChange, onConfirm, pending }: Omit<SnoozeDialogProps, 'open'>) {
  const { t } = useTranslation('crm');
  const [date, setDate] = useState(() => addDaysIso(localToday(), 1));

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (date) onConfirm(date);
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <OverlayHeader>
        <DialogTitle>{t('snooze.title')}</DialogTitle>
        <DialogDescription>{t('snooze.description')}</DialogDescription>
      </OverlayHeader>
      <OverlayBody>
        <Field label={t('snooze.date')}>
          {(control) => (
            <div className="grid gap-2">
              <DateInput id={control.id} value={date} onChange={setDate} />
              <QuickDates value={date} onPick={setDate} />
            </div>
          )}
        </Field>
      </OverlayBody>
      <OverlayFooter>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
          {t('snooze.cancel')}
        </Button>
        <Button type="submit" loading={pending} disabled={!date}>
          {t('snooze.save')}
        </Button>
      </OverlayFooter>
    </form>
  );
}
