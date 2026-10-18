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
}

export function SalesOwnerSelect({ id, value, onChange, disabled }: SalesOwnerSelectProps) {
  const { t } = useTranslation('crm');
  const users = useSalesUsers();
  return (
    <Select value={value || NONE} onValueChange={(v) => onChange(v === NONE ? '' : v)} disabled={disabled}>
      <SelectTrigger id={id}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>{t('owner.none')}</SelectItem>
        {(users.data ?? []).map((u) => (
          <SelectItem key={u.id} value={u.id}>
            {u.fullName}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
