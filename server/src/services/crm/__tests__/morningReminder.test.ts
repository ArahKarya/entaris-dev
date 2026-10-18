import { describe, expect, it } from 'vitest';
import { formatReminder, isReminderDue, REMINDER_TOP_ITEMS } from '../morningReminder';
import type { FollowupItem, FollowupResult } from '../followups';
import type { CrmSettingsView } from '../settings';

const settings: CrmSettingsView = {
  reminderEnabled: true,
  reminderTime: '07:30',
  reminderDays: [1, 2, 3, 4, 5, 6],
  quotationNoReplyDays: 3,
  reorderToleranceFactor: 1.5,
  reorderMinInvoices: 3,
  lastReminderOn: null,
};

// Monday 2026-10-19 in WIB (+07:00) at the given local time.
const mondayAt = (hhmm: string) => new Date(`2026-10-19T${hhmm}:00.000+07:00`);

describe('isReminderDue', () => {
  it('sends from the configured time within the window', () => {
    expect(isReminderDue(settings, mondayAt('07:29'))).toBe(false);
    expect(isReminderDue(settings, mondayAt('07:30'))).toBe(true);
    expect(isReminderDue(settings, mondayAt('10:29'))).toBe(true);
    expect(isReminderDue(settings, mondayAt('10:30'))).toBe(false);
  });

  it('skips days not selected, days already sent and a disabled reminder', () => {
    const sunday = new Date('2026-10-18T08:00:00.000+07:00');
    expect(isReminderDue(settings, sunday)).toBe(false);
    expect(isReminderDue({ ...settings, lastReminderOn: '2026-10-19' }, mondayAt('08:00'))).toBe(false);
    expect(isReminderDue({ ...settings, lastReminderOn: '2026-10-17' }, mondayAt('08:00'))).toBe(true);
    expect(isReminderDue({ ...settings, reminderEnabled: false }, mondayAt('08:00'))).toBe(false);
  });
});

function item(overrides: Partial<FollowupItem>): FollowupItem {
  return {
    kind: 'inquiry',
    id: 'x',
    partyId: null,
    partyName: 'CV Lumbung',
    title: '',
    documentNumber: null,
    dueOn: '2026-10-19',
    overdueDays: 0,
    ownerId: null,
    ownerName: null,
    phone: null,
    note: null,
    ...overrides,
  };
}

describe('formatReminder', () => {
  it('returns null when there is nothing to do', () => {
    const empty: FollowupResult = { today: '2026-10-19', items: [], counts: { inquiry: 0, party: 0, quotation: 0, reorder: 0 } };
    expect(formatReminder(empty)).toBeNull();
  });

  it('summarises counts and lists the most overdue first', () => {
    const result: FollowupResult = {
      today: '2026-10-19',
      items: [
        item({ kind: 'inquiry', documentNumber: 'INQ-1', partyName: 'A', overdueDays: 1 }),
        item({ kind: 'reorder', partyName: 'B', overdueDays: 9 }),
      ],
      counts: { inquiry: 1, party: 0, quotation: 0, reorder: 1 },
    };
    const text = formatReminder(result)!;
    expect(text.title).toBe('Tindak lanjut hari ini: 2');
    expect(text.message).toContain('1 inquiry, 1 Customer telat order.');
    expect(text.message.indexOf('B (lewat 9 hari)')).toBeLessThan(text.message.indexOf('INQ-1: A'));
  });

  it('caps the list and says how many are left', () => {
    const items = Array.from({ length: REMINDER_TOP_ITEMS + 3 }, (_, i) => item({ partyName: `P${i}` }));
    const text = formatReminder({ today: '2026-10-19', items, counts: { inquiry: items.length, party: 0, quotation: 0, reorder: 0 } })!;
    expect(text.message).toContain('...dan 3 lainnya.');
  });
});
