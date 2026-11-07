import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../lib/api', () => ({ default: { get } }));

import JournalDetailDrawer from './JournalDetailDrawer';

const journal = (reversedBy: { id: string; entryNumber: string } | null) => ({
  id: 'je-1',
  entryNumber: 'JV-STT-209901-0001',
  date: '2099-01-10T03:00:00.000Z',
  status: 'Submitted',
  narration: 'STT',
  items: [],
  user: { fullName: 'Ani' },
  reversedBy,
});

function renderDrawer(body: unknown) {
  get.mockImplementation(async (url?: string) => ({ data: String(url).startsWith('/attachments') ? [] : body }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <JournalDetailDrawer journalEntryId="je-1" onClose={() => {}} />
    </QueryClientProvider>,
  );
}

describe('JournalDetailDrawer', () => {
  beforeEach(() => get.mockReset());

  it('names the reversing journal of a paired legacy STT cancel', async () => {
    renderDrawer(journal({ id: 'je-2', entryNumber: 'JV-STT-209901-0001-CXL' }));
    expect(await screen.findByText(/(Dibalik oleh|Reversed by) JV-STT-209901-0001-CXL/)).toBeInTheDocument();
  });

  it('shows no reversal note for an ordinary journal', async () => {
    renderDrawer(journal(null));
    expect(await screen.findByText('STT')).toBeInTheDocument();
    expect(screen.queryByText(/Dibalik oleh|Reversed by/)).toBeNull();
  });
});
