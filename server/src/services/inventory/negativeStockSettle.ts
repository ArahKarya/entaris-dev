/**
 * Journal of the negative-stock settlement (E3-R9, PR-6.6). Goods that went out past zero stock were
 * valued at the average then (outboundValue); when goods come in, inventoryLedger.postInbound
 * re-values the part the inbound covers at the inbound's price (negativeSettlement), writes one
 * Revaluation row (NEGATIVE_STOCK_SETTLE_REFERENCE, adjusting the inbound row) and posts its journal
 * here, so every inbound path (receipts, manual movements, returns, stock counts, production output,
 * opening import) books it without a change of its own. This is the one journal the value ledger
 * posts: it belongs to the inbound row, not to the caller's document.
 *
 * DR COGS / CR the item's inventory account when the covered goods cost more at the inbound price,
 * the mirror when less. Dated the inbound's day in its fiscal year, numbered JV-YYYYMM-NNNN (not
 * JV-<document>-*: a later edit or cancel of the document does not void it with its own journals),
 * sourceKeys.inventoryNegativeSettle(inbound row). A cancel of the inbound, or of the outbound row
 * whose window it settled, takes the effect back through its value true-up (reverseMovement with
 * trueUp 'replay'), so this journal is never voided.
 *
 * LOCK ORDER (stockLocks.ts): called by postInbound under the item lock, after the settlement row's
 * SM number; the series of the inbound's month is already held by the inbound row (and, for a
 * caller that journals first, the JV series too).
 */
import type { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { BusinessError } from '../../utils/errors';
import { postJournal } from '../ledger/postJournal';
import { DOCUMENT_RULE } from '../ledger/accountGuard';
import { sourceKeys } from '../ledger/journalSource';
import { cogsAccountFor } from '../ledger/systemRoleAccounts';
import { inventoryAccountFor } from './itemMasterGuard';

type Tx = Prisma.TransactionClient;

/**
 * True when the item still has legacy deferred-COGS queue rows open (Pending / PartiallySettled of an
 * invoice that is not cancelled). Owner decision #6: such an item is left out of the settlement
 * until those rows are cleared (E3-PR13/14), because the legacy auto-settle (still run by production
 * output until PR-6.12) re-values the same oversold units.
 */
export async function hasOpenLegacyCogsQueue(tx: Tx, itemId: string): Promise<boolean> {
  const open = await tx.cogsBackfillQueue.findFirst({
    where: {
      inventoryItemId: itemId,
      status: { in: ['Pending', 'PartiallySettled'] },
      salesInvoice: { status: { not: 'Cancelled' } },
    },
    select: { id: true },
  });
  return open !== null;
}

export interface NegativeSettleJournalInput {
  item: { name: string; unit: string; accountId: string | null };
  /** The settlement's change to stock_value: − DR COGS / CR inventory, + the mirror (not 0). */
  amount: Decimal;
  /** The inbound row that settles; the journal's sourceKey. */
  inbound: { id: string; movementNumber: string };
  /** The short quantity the inbound covered (narration). */
  covered: Decimal;
  date: Date;
  fiscalYearId: string;
  userId: string;
}

/** Posts the settlement journal through postJournal and returns its id. */
export async function postNegativeSettleJournal(tx: Tx, i: NegativeSettleJournalInput): Promise<string> {
  const inventoryAccountId = await inventoryAccountFor(tx, i.item);
  if (!inventoryAccountId) throw new BusinessError('Akun Persediaan belum dipetakan di Akun Sistem.');
  const cogs = await cogsAccountFor(tx);
  const value = i.amount.abs().toString();
  const narration = `Penyelesaian stok minus ${i.covered.toString()} ${i.item.unit}: ${i.inbound.movementNumber} - ${i.item.name}`;
  const [debitId, creditId] = i.amount.lt(0) ? [cogs.id, inventoryAccountId] : [inventoryAccountId, cogs.id];
  const { journal } = await postJournal(tx, {
    date: i.date,
    narration,
    lines: [
      { accountId: debitId, debit: value, credit: 0, description: narration },
      { accountId: creditId, debit: 0, credit: value, description: narration },
    ],
    sourceType: 'SYSTEM_DOC',
    sourceKey: sourceKeys.inventoryNegativeSettle(i.inbound.id),
    createdBy: i.userId,
    accountRule: DOCUMENT_RULE,
    partyRule: 'off',
    expectFiscalYearId: i.fiscalYearId,
  });
  return journal.id;
}
