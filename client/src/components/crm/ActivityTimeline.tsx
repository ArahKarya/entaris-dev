/** Activity history for a Customer or an Inquiry, newest first, with load-more and delete. */
import { useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Mail, MapPin, MessageCircle, NotebookPen, Phone, Trash2, type LucideIcon } from 'lucide-react';
import api from '@/lib/api';
import { formatDate } from '@/lib/format';
import { crmKeys, currentUserId, type ActivityType, type CrmActivity } from '@/lib/crm';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, LoadingState } from '@/components/shared';

const PAGE_SIZE = 20;

const TYPE_ICON: Record<ActivityType, LucideIcon> = {
  Telepon: Phone,
  WhatsApp: MessageCircle,
  Kunjungan: MapPin,
  Email: Mail,
  Catatan: NotebookPen,
};

interface ActivityTimelineProps {
  partyId?: string;
  inquiryId?: string;
  /** Hide the Inquiry reference (when shown inside that Inquiry). */
  hideInquiry?: boolean;
}

export function ActivityTimeline({ partyId, inquiryId, hideInquiry }: ActivityTimelineProps) {
  const { t } = useTranslation('crm');
  const queryClient = useQueryClient();
  const me = currentUserId();
  const [deleteTarget, setDeleteTarget] = useState<CrmActivity | null>(null);
  const scope = { partyId, inquiryId };

  const query = useInfiniteQuery({
    queryKey: crmKeys.activities(scope),
    initialPageParam: 1,
    queryFn: async ({ pageParam }) =>
      (
        await api.get<{ data: CrmActivity[]; total: number; page: number }>('/crm/activities', {
          params: { ...scope, page: pageParam, limit: PAGE_SIZE },
        })
      ).data,
    getNextPageParam: (last, pages) => (pages.length * PAGE_SIZE < last.total ? last.page + 1 : undefined),
    enabled: !!(partyId || inquiryId),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => api.delete(`/crm/activities/${id}`),
    onSuccess: () => {
      toast.success(t('timeline.deleted'));
      setDeleteTarget(null);
      void queryClient.invalidateQueries({ queryKey: crmKeys.all });
    },
    onError: (err: { response?: { data?: { error?: string } } }) =>
      toast.error(err.response?.data?.error ?? t('timeline.deleteFailed')),
  });

  if (query.isLoading) return <LoadingState />;
  const activities = query.data?.pages.flatMap((p) => p.data) ?? [];
  if (activities.length === 0) return <p className="py-2 text-sm text-muted-foreground">{t('timeline.empty')}</p>;

  return (
    <div className="space-y-2">
      <ol aria-label={t('timeline.label')} className="space-y-0">
        {activities.map((a) => {
          const Icon = TYPE_ICON[a.type] ?? NotebookPen;
          return (
            <li key={a.id} className="group relative flex gap-3 border-l border-border py-2 pl-4">
              <span className="absolute -left-[9px] top-2.5 flex size-[18px] items-center justify-center rounded-sm border border-border bg-card text-muted-foreground">
                <Icon className="size-3" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground/80">{t(`activity.types.${a.type}`)}</span>
                  <span className="num">{formatDate(a.occurredAt)}</span>
                  <span>{t('timeline.by', { name: a.creator.fullName })}</span>
                  {a.source === 'aira' && <span>{t('timeline.viaAira')}</span>}
                  {a.contact && <span>{t('timeline.contact', { name: a.contact.name })}</span>}
                  {!hideInquiry && a.inquiry && <span className="num font-mono">{t('timeline.inquiry', { number: a.inquiry.inquiryNumber })}</span>}
                </p>
                <p className="whitespace-pre-line text-sm text-foreground">{a.summary}</p>
                {a.outcome && <p className="text-sm text-muted-foreground">{a.outcome}</p>}
                {a.nextFollowUpDate && (
                  <p className="text-xs text-muted-foreground">
                    {t('timeline.next', { date: formatDate(a.nextFollowUpDate) })}
                    {a.followUpDoneAt && `, ${t('timeline.done')}`}
                  </p>
                )}
              </div>
              {a.creator.id === me && (
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  className="shrink-0 sm:opacity-0 sm:focus-visible:opacity-100 sm:group-hover:opacity-100"
                  aria-label={t('timeline.delete')}
                  title={t('timeline.delete')}
                  onClick={() => setDeleteTarget(a)}
                >
                  <Trash2 aria-hidden />
                </Button>
              )}
            </li>
          );
        })}
      </ol>
      {query.hasNextPage && (
        <Button type="button" size="sm" variant="ghost" onClick={() => query.fetchNextPage()} loading={query.isFetchingNextPage}>
          {t('timeline.loadMore')}
        </Button>
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={t('timeline.deleteConfirmTitle')}
        description={t('timeline.deleteConfirmDescription')}
        confirmLabel={t('timeline.delete')}
        tone="danger"
        loading={remove.isPending}
        onConfirm={() => { if (deleteTarget) remove.mutate(deleteTarget.id); }}
      />
    </div>
  );
}
