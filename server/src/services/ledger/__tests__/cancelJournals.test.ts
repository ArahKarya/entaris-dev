import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Prisma } from '@prisma/client';

const voidJournalInTx = vi.hoisted(() => vi.fn());
vi.mock('../../../utils/journalCancel', () => ({ voidJournalInTx }));

import { cancelJournalsInTx, JOURNAL_ALREADY_REVERSED, type JournalWithItems } from '../cancelJournals';
import { BusinessError } from '../../../utils/errors';

const tx = {} as Prisma.TransactionClient;
const journal = (entryNumber: string, reversedById: string | null = null) =>
  ({ id: `id-${entryNumber}`, entryNumber, reversedById, items: [] }) as unknown as JournalWithItems;

describe('cancelJournalsInTx', () => {
  beforeEach(() => voidJournalInTx.mockReset());

  it('voids each journal in order with the label and trail, and returns the ones it voided', async () => {
    voidJournalInTx.mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const trail = { cancelledById: 'u1', cancelReason: 'Salah input' };
    const js = [journal('JV-A'), journal('JV-A-CORR'), journal('JV-A-R2')];

    expect(await cancelJournalsInTx(tx, js, { label: 'penerimaan barang', trail })).toEqual(['JV-A', 'JV-A-R2']);
    expect(voidJournalInTx.mock.calls).toEqual(js.map((j) => [tx, j, 'penerimaan barang', trail]));
  });

  it('rejects a journal that already has a reversal before voiding any', async () => {
    const err = await cancelJournalsInTx(tx, [journal('JV-A'), journal('JV-B', 'id-cxl')], { label: 'jurnal' }).catch((e) => e);
    expect(err).toBeInstanceOf(BusinessError);
    expect(err.code).toBe(JOURNAL_ALREADY_REVERSED);
    expect(err.message).toContain('JV-B');
    expect(voidJournalInTx).not.toHaveBeenCalled();
  });

  it('does nothing for a document without journals', async () => {
    expect(await cancelJournalsInTx(tx, [], { label: 'pembayaran' })).toEqual([]);
    expect(voidJournalInTx).not.toHaveBeenCalled();
  });
});
