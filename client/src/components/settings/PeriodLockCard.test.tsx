import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { get, put, perms } = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  perms: { journalEdit: false, caps: [] as string[] },
}));
vi.mock('@/lib/api', () => ({ default: { get, put } }));
vi.mock('@/lib/permissions', () => ({
  can: (module: string, action = 'view') => action === 'view' || (module === 'journal' && perms.journalEdit),
  cap: (name: string) => perms.caps.includes(name),
}));
vi.mock('@/lib/date', () => ({ todayLocal: (add = 0) => (add === -1 ? '2096-04-24' : '2096-04-25') }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { PeriodLockCard } from './PeriodLockCard';
import { movesLockBack } from '@/lib/periodLock';

const state = {
  lockDate: '2096-03-31',
  updatedAt: '2096-04-02T03:00:00.000Z',
  updatedBy: { id: 'u1', fullName: 'Ani Admin' },
  logs: [
    { id: 'l1', oldDate: null, newDate: '2096-03-31', reason: null, createdAt: '2096-04-02T03:00:00.000Z', user: { id: 'u1', fullName: 'Ani Admin' } },
  ],
};

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PeriodLockCard />
    </QueryClientProvider>,
  );
}

/** The DD/MM/YYYY text box of the date input. */
const dateBox = () => screen.getByPlaceholderText(/hh\/bb\/tttt|dd\/mm\/yyyy/i);
const saveButton = () => screen.getByRole('button', { name: /simpan kunci|save lock/i });

beforeEach(() => {
  get.mockReset();
  put.mockReset();
  get.mockResolvedValue({ data: state });
  put.mockResolvedValue({ data: {} });
  perms.journalEdit = false;
  perms.caps = [];
});

describe('movesLockBack', () => {
  it('is true for an earlier date or clearing, false for the first lock or moving forward', () => {
    expect(movesLockBack('2096-03-31', '2096-02-28')).toBe(true);
    expect(movesLockBack('2096-03-31', null)).toBe(true);
    expect(movesLockBack(null, '2096-03-31')).toBe(false);
    expect(movesLockBack('2096-02-28', '2096-03-31')).toBe(false);
  });
});

describe('PeriodLockCard', () => {
  it('shows the lock date and history read-only without period.lock', async () => {
    perms.journalEdit = true;
    renderCard();
    expect(await screen.findByTestId('period-lock-current')).toBeTruthy();
    expect(get).toHaveBeenCalledWith('/period-lock');
    expect(screen.getByText('Ani Admin', { selector: 'td' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /simpan kunci|save lock/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /buka kunci|remove lock/i })).toBeNull();
  });

  it('hides the form for period.lock without journal edit', async () => {
    perms.caps = ['period.lock'];
    renderCard();
    await screen.findByTestId('period-lock-current');
    expect(screen.queryByRole('button', { name: /simpan kunci|save lock/i })).toBeNull();
  });

  it('moves the lock forward without a reason', async () => {
    perms.journalEdit = true;
    perms.caps = ['period.lock'];
    renderCard();
    await screen.findByTestId('period-lock-current');
    fireEvent.change(dateBox(), { target: { value: '20042096' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(put).toHaveBeenCalledWith('/period-lock', { lockDate: '2096-04-20', reason: null }));
  });

  it('asks for a reason before moving the lock back, then sends it', async () => {
    perms.journalEdit = true;
    perms.caps = ['period.lock'];
    renderCard();
    await screen.findByTestId('period-lock-current');
    fireEvent.change(dateBox(), { target: { value: '28022096' } });
    fireEvent.click(saveButton());
    expect(await screen.findByText(/alasan wajib diisi|reason \(at least 5 characters\) is required/i)).toBeTruthy();
    expect(put).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole('textbox', { name: /alasan|reason/i }), { target: { value: 'Koreksi biaya Maret' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(put).toHaveBeenCalledWith('/period-lock', { lockDate: '2096-02-28', reason: 'Koreksi biaya Maret' }));
  });

  it('removing the lock needs a reason too', async () => {
    perms.journalEdit = true;
    perms.caps = ['period.lock'];
    renderCard();
    await screen.findByTestId('period-lock-current');
    const clear = screen.getByRole('button', { name: /buka kunci|remove lock/i });
    fireEvent.click(clear);
    expect(put).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', { name: /alasan|reason/i }), { target: { value: 'Audit ulang Q1' } });
    fireEvent.click(clear);
    await waitFor(() => expect(put).toHaveBeenCalledWith('/period-lock', { lockDate: null, reason: 'Audit ulang Q1' }));
  });

  it('refuses today or a later date on the client', async () => {
    perms.journalEdit = true;
    perms.caps = ['period.lock'];
    renderCard();
    await screen.findByTestId('period-lock-current');
    fireEvent.change(dateBox(), { target: { value: '25042096' } });
    fireEvent.click(saveButton());
    expect(await screen.findByText(/harus sebelum hari ini|must be before today/i)).toBeTruthy();
    expect(put).not.toHaveBeenCalled();
  });

  it('lists the history with the change and its author', async () => {
    renderCard();
    const table = await screen.findByRole('table', { name: /riwayat perubahan|change history/i });
    expect(within(table).getByText(/tanpa kunci|no lock/i)).toBeTruthy();
    expect(within(table).getByText('Ani Admin')).toBeTruthy();
  });
});
