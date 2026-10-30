// Shared step of cancelling a customer or supplier deposit application (apply/:id/cancel): void its
// journal, and stop when that journal was already cancelled. An application journal cancelled
// elsewhere (the Journal menu used to unwind customer offsets itself) already gave the invoice
// outstanding and the deposit balance back, so restoring them again would count them twice.

import type { Prisma } from '@prisma/client';
import { BusinessError } from '../utils/errors';
import { voidJournalInTx } from '../utils/journalCancel';
import type { CancelTrail } from '../utils/cancelClaim';

type Tx = Prisma.TransactionClient;
type JournalWithItems = Prisma.JournalEntryGetPayload<{ include: { items: true } }>;

/** Error code: the application's journal is already cancelled; its balances were restored then. */
export const DEPOSIT_APPLICATION_JOURNAL_CANCELLED = 'DEPOSIT_APPLICATION_JOURNAL_CANCELLED';

export const DEPOSIT_APPLICATION_JOURNAL_CANCELLED_MESSAGE =
  'Jurnal aplikasi uang muka ini sudah dibatalkan, jadi saldo invoice dan uang muka sudah dipulihkan saat itu. Aplikasi tidak dibatalkan lagi; hubungi akuntan untuk koreksi.';

/**
 * Voids the application journal (PERIOD_CLOSED when its year is closed). Throws
 * DEPOSIT_APPLICATION_JOURNAL_CANCELLED when it was already cancelled, including by a concurrent
 * cancel that won the claim; the caller's transaction then rolls back its own application claim.
 */
export async function voidDepositApplicationJournalInTx(tx: Tx, journal: JournalWithItems, trail: CancelTrail): Promise<void> {
  const voided = await voidJournalInTx(tx, journal, 'uang muka', trail);
  if (!voided) {
    throw new BusinessError(DEPOSIT_APPLICATION_JOURNAL_CANCELLED_MESSAGE, DEPOSIT_APPLICATION_JOURNAL_CANCELLED);
  }
}
