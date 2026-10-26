/** Sales owner (PIC) picker: active users plus "no owner". Value '' = no owner. */
import { useTranslation } from 'react-i18next';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useSalesUsers } from '@/lib/crm';

const NONE = '__none__';

interface SalesOwnerSelectProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Name of the current owner, shown when that user is no longer active. */
  currentName?: string | null;
}

export function SalesOwnerSelect({ id, value, onChange, disabled, currentName }: SalesOwnerSelectProps) {
  const { t } = useTranslation('crm');
  const users = useSalesUsers();
  const list = users.data ?? [];
  // An owner who was deactivated is not in the list; keep showing them until someone changes it.
  const missingCurrent = !!value && users.isSuccess && !list.some((u) => u.id === value);
  return (
    <Select value={value || NONE} onValueChange={(v) => onChange(v === NONE ? '' : v)} disabled={disabled}>
      <SelectTrigger id={id}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>{t('owner.none')}</SelectItem>
        {missingCurrent && (
          <SelectItem value={value} disabled>
            {currentName ?? value}
          </SelectItem>
        )}
        {list.map((u) => (
          <SelectItem key={u.id} value={u.id}>
            {u.fullName}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
