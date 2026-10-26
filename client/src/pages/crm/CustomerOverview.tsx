/** Customer 360 (/crm/customers/:id, CRM F6): buying pattern, activity history, open deals, contacts, sales profile. */
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CalendarClock, MessageCircle, NotebookPen, Receipt, Repeat, Wallet } from 'lucide-react';
import api from '@/lib/api';
import { formatDate, formatNumber, formatRupiah } from '@/lib/format';
import { can } from '@/lib/permissions';
import { crmKeys, whatsappUrl, type PartyOverview } from '@/lib/crm';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DocumentLink, EmptyState, LoadingState, PageHeader, StatCard, StatusBadge } from '@/components/shared';
import InquiryDetailDrawer from '@/components/InquiryDetailDrawer';
import QuotationDetailDrawer from '@/components/QuotationDetailDrawer';
import { ActivityDialog } from '@/components/crm/ActivityDialog';
import { ActivityTimeline } from '@/components/crm/ActivityTimeline';
import { ContactsPanel } from '@/components/crm/ContactsPanel';
import { SalesProfileForm } from '@/components/crm/SalesProfileForm';

function Section({ id, title, children }: { id?: string; title: string; children: React.ReactNode }) {
  return (
    <Card id={id} className="scroll-mt-20">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export default function CustomerOverview() {
  const { t } = useTranslation('crm');
  const { id = '' } = useParams();
  const canEdit = can('crm', 'edit');
  const [logOpen, setLogOpen] = useState(false);
  const [inquiryId, setInquiryId] = useState<string | null>(null);
  const [quotationId, setQuotationId] = useState<string | null>(null);

  const query = useQuery({
    queryKey: crmKeys.overview(id),
    queryFn: async () => (await api.get<PartyOverview>(`/crm/parties/${id}/overview`)).data,
    enabled: !!id,
  });

  // Deep link from the radar (#profile) once the content exists.
  useEffect(() => {
    if (query.data && window.location.hash === '#profile') {
      document.getElementById('profile')?.scrollIntoView({ block: 'start' });
    }
  }, [query.data]);

  if (query.isLoading) return <LoadingState />;
  if (query.isError || !query.data) {
    return <EmptyState kind="error" title={t('customer.error')} action={<Button size="sm" variant="outline" onClick={() => query.refetch()}>{t('followups.retry')}</Button>} />;
  }

  const o = query.data;
  const { party, purchases, reorder } = o;
  const primaryPhone = o.contacts.find((c) => c.isPrimary && c.phone)?.phone ?? o.contacts.find((c) => c.phone)?.phone ?? party.phone;
  const wa = whatsappUrl(primaryPhone);

  const cycleValue =
    reorder?.cycleDays != null
      ? reorder.cycleSource === 'manual'
        ? t('radar.cycleManual', { days: formatNumber(reorder.cycleDays, { maxDecimals: 1 }) })
        : t('radar.cycleAverage', { days: formatNumber(reorder.cycleDays, { maxDecimals: 1 }) })
      : t('radar.cycleNone');

  return (
    <div className="space-y-5 pb-8">
      <PageHeader
        title={party.name}
        description={[party.salesOwner?.fullName ?? t('owner.none'), party.address].filter(Boolean).join(' · ')}
        actions={
          <>
            {wa && (
              <Button asChild variant="outline">
                <a href={wa} target="_blank" rel="noopener noreferrer">
                  <MessageCircle aria-hidden />
                  {t('customer.whatsapp')}
                </a>
              </Button>
            )}
            {canEdit && (
              <Button onClick={() => setLogOpen(true)}>
                <NotebookPen aria-hidden />
                {t('customer.logActivity')}
              </Button>
            )}
          </>
        }
      />

      <section aria-label={t('customer.stats.label')} className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label={t('customer.stats.purchases')}
          icon={Receipt}
          value={purchases.last12MonthsTotal != null ? formatRupiah(purchases.last12MonthsTotal) : t('customer.stats.hidden')}
          hint={t('customer.stats.purchasesHint', { count: purchases.last12MonthsCount })}
        />
        <StatCard
          label={t('customer.stats.lastOrder')}
          icon={CalendarClock}
          value={purchases.lastInvoice ? formatDate(purchases.lastInvoice.date) : '—'}
          hint={reorder?.daysSinceLastOrder != null ? t('customer.stats.lastOrderHint', { days: reorder.daysSinceLastOrder }) : undefined}
        />
        <StatCard
          label={t('customer.stats.cycle')}
          icon={Repeat}
          value={cycleValue}
          hint={reorder ? t(`radar.states.${reorder.state}`) : undefined}
        />
        <StatCard
          label={t('customer.stats.receivable')}
          icon={Wallet}
          value={party.outstandingAmount != null ? formatRupiah(party.outstandingAmount) : t('customer.stats.hidden')}
          hint={t('customer.stats.receivableHint')}
        />
      </section>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Section title={t('customer.sections.openDeals')}>
            {o.inquiries.length === 0 && o.quotations.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('customer.openDeals.empty')}</p>
            ) : (
              <ul className="divide-y divide-border">
                {o.inquiries.map((q) => (
                  <li key={q.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                    <DocumentLink onClick={() => setInquiryId(q.id)}>{q.inquiryNumber}</DocumentLink>
                    <StatusBadge status={q.status} docType="inquiry" />
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">{q.itemsText}</span>
                    {q.followUpDate && !q.followUpDoneAt && (
                      <span className="num text-xs text-muted-foreground">{t('customer.openDeals.followUp', { date: formatDate(q.followUpDate) })}</span>
                    )}
                  </li>
                ))}
                {o.quotations.map((q) => (
                  <li key={q.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                    <DocumentLink onClick={() => setQuotationId(q.id)}>{q.quotationNumber}</DocumentLink>
                    <StatusBadge status={q.status} docType="quotation" />
                    <span className="num flex-1 text-muted-foreground">{formatRupiah(q.grandTotal)}</span>
                    <span className="num text-xs text-muted-foreground">
                      {q.sentAt ? t('customer.openDeals.quotationSent', { date: formatDate(q.sentAt) }) : t('customer.openDeals.quotationDraft')}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title={t('customer.sections.activities')}>
            <ActivityTimeline partyId={party.id} />
          </Section>
        </div>

        <div className="space-y-4">
          <Section title={t('customer.sections.contacts')}>
            <ContactsPanel partyId={party.id} partyName={party.name} contacts={o.contacts} canEdit={canEdit} />
          </Section>
          <Section id="profile" title={t('customer.sections.profile')}>
            <SalesProfileForm
              key={`${party.salesOwnerId}|${party.reorderCycleDays}|${party.reorderSnoozedUntil}`}
              overview={o}
              canEdit={canEdit}
            />
          </Section>
        </div>
      </div>

      <ActivityDialog open={logOpen} onOpenChange={setLogOpen} partyId={party.id} subjectName={party.name} />
      <InquiryDetailDrawer inquiryId={inquiryId} onClose={() => setInquiryId(null)} />
      <QuotationDetailDrawer quotationId={quotationId} onClose={() => setQuotationId(null)} />
    </div>
  );
}
