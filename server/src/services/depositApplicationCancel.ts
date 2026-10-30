// Shared step of cancelling a customer or supplier deposit application (apply/:id/cancel): void its
// journal, and stop when that journal was already cancelled. Only the old Journal menu could do
// that: it reversed the ledger and the party's deposit balance, but left the application active,
// the invoice outstanding reduced and the deposit's remaining amount counting it. Cancelling the
// application now would reverse the party's deposit balance a second time, so it is refused and
// the accountant corrects the invoice outstanding by hand.

import type { Prisma } from '@prisma/client';
import { BusinessError } from '../utils/errors';
import { voidJournalInTx } from '../utils/journalCancel';
import type { CancelTrail } from '../utils/cancelClaim';

type Tx = Prisma.TransactionClient;
type JournalWithItems = Prisma.JournalEntryGetPayload<{ include: { items: true } }>;

/** Error code: the application's journal is already cancelled; the invoice outstanding was not restored then. */
export const DEPOSIT_APPLICATION_JOURNAL_CANCELLED = 'DEPOSIT_APPLICATION_JOURNAL_CANCELLED';

export const DEPOSIT_APPLICATION_JOURNAL_CANCELLED_MESSAGE =
  'Jurnal aplikasi uang muka ini sudah dibatalkan di luar modul Uang Muka. Saat itu hanya jurnal dan saldo uang muka mitra yang dibalik; outstanding invoice dan aplikasi ini tidak dipulihkan. Aplikasi tidak dibatalkan lagi agar saldo uang muka tidak dibalik dua kali; minta akuntan mengoreksi outstanding invoice.';

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
