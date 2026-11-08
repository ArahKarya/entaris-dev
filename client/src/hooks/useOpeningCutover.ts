import { useQuery } from '@tanstack/react-query';
import api from '@/lib/api';

/**
 * The opening balance cut-over date (YYYY-MM-DD) from GET /settings/company, or null while it loads
 * or when no fiscal year is open. An opening deposit must carry this date; the server refuses others.
 */
export function useOpeningCutover(enabled: boolean): string | null {
  const { data } = useQuery({
    queryKey: ['settings', 'opening-cutover'],
    queryFn: async () => {
      const res = await api.get('/settings/company');
      const cutover = res.data?.openingCutover as { day: string } | null | undefined;
      return cutover?.day ?? null;
    },
    enabled,
  });
  return data ?? null;
}
