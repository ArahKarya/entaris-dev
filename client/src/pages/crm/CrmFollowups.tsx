/** CRM follow-ups (/crm): today's list and the reorder radar, filtered by sales owner. */
import { useId } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/components/shared';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { FollowupList } from '@/components/crm/FollowupList';
import { RadarTable } from '@/components/crm/RadarTable';
import { useSalesUsers } from '@/lib/crm';

const TABS = ['followups', 'radar'] as const;
type Tab = (typeof TABS)[number];
const isTab = (v: string | null): v is Tab => !!v && (TABS as readonly string[]).includes(v);

function OwnerFilter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation('crm');
  const id = useId();
  const users = useSalesUsers();
  return (
    <div className="w-full sm:w-52">
      <label htmlFor={id} className="sr-only">
        {t('owner.label')}
      </label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="me">{t('owner.me')}</SelectItem>
          <SelectItem value="all">{t('owner.all')}</SelectItem>
          <SelectItem value="unassigned">{t('owner.unassigned')}</SelectItem>
          {(users.data ?? []).map((u) => (
            <SelectItem key={u.id} value={u.id}>
              {u.fullName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export default function CrmFollowups() {
  const { t } = useTranslation('crm');
  const [params, setParams] = useSearchParams();
  const tab: Tab = isTab(params.get('tab')) ? (params.get('tab') as Tab) : 'followups';
  const owner = params.get('owner') || 'me';

  const update = (key: string, value: string, fallback: string) => {
    const next = new URLSearchParams(params);
    if (value === fallback) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  return (
    <Tabs value={tab} onValueChange={(v) => update('tab', v, 'followups')} className="space-y-5 pb-8">
      <PageHeader
        title={t('page.title')}
        description={t('page.description')}
        actions={<OwnerFilter value={owner} onChange={(v) => update('owner', v, 'me')} />}
      >
        <TabsList variant="underline" aria-label={t('page.tabs.label')} className="max-w-full">
          {TABS.map((value) => (
            <TabsTrigger key={value} value={value}>
              {t(`page.tabs.${value}`)}
            </TabsTrigger>
          ))}
        </TabsList>
      </PageHeader>

      <TabsContent value="followups" className="mt-0">
        <FollowupList ownerParam={owner} />
      </TabsContent>
      <TabsContent value="radar" className="mt-0">
        <RadarTable ownerParam={owner} />
      </TabsContent>
    </Tabs>
  );
}
