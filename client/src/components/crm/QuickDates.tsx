/** Quick picks for a follow-up date (tomorrow, 3 days, 1 week) next to a DateInput. */
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { addDaysIso, localToday } from '@/lib/crm';

const OPTIONS = [
  { key: 'tomorrow', days: 1 },
  { key: 'threeDays', days: 3 },
  { key: 'nextWeek', days: 7 },
] as const;

interface QuickDatesProps {
  value: string;
  onPick: (date: string) => void;
}

export function QuickDates({ value, onPick }: QuickDatesProps) {
  const { t } = useTranslation('crm');
  const today = localToday();
  return (
    <div className="flex flex-wrap gap-1.5">
      {OPTIONS.map((o) => {
        const date = addDaysIso(today, o.days);
        return (
          <Button
            key={o.key}
            type="button"
            size="sm"
            variant={value === date ? 'secondary' : 'outline'}
            aria-pressed={value === date}
            onClick={() => onPick(date)}
          >
            {t(`quick.${o.key}`)}
          </Button>
        );
      })}
    </div>
  );
}
