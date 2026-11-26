/**
 * Journals of the value true-up and the zero-stock sweep of a cancel (E3-R8, PR-6.5a). The value
 * ledger posts no journal (inventoryLedger.ts): reverseMovement / reverseDocumentMovements with
 * trueUp 'replay' write one Revaluation row per reversed movement whose value_delta is
 * trueUp − toCogs, and the caller posts that amount here, so book = GL.
 *
 * One journal per such row, through postJournal: DR the item's inventory account / CR COGS for a
 * value that comes back to the book, the mirror for one that leaves it. Dated the row's day (the day
 * of the cancel, owner decision #3; postJournal checks that period), numbered JV-YYYYMM-NNNN, not
 * JV-<document>-*, so a later edit or cancel of the document does not void it with the document's
 * own journals. sourceKeys.inventoryTrueUp(movement taken back).
 *
 * LOCK ORDER (stockLocks.ts): call it after every reversal of the operation (their SM numbers are
 * taken) and before the caller voids or posts other journals: postJournal takes the JV number, then
 * the account locks.
 */
import type { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { BusinessError } from '../../utils/errors';
import { postJournal } from '../ledger/postJournal';
import { DOCUMENT_RULE } from '../ledger/accountGuard';
import { sourceKeys } from '../ledger/journalSource';
import { cogsAccountFor } from '../ledger/systemRoleAccounts';
import { inventoryAccountFor } from './itemMasterGuard';
import { linkMovementJournal, type ReverseResult } from './inventoryLedger';

type Tx = Prisma.TransactionClient;

export interface ReversalJournalContext {
  userId: string;
  /** Shown in the narration, e.g. 'STT STT-202604-0001'. */
  documentLabel: string;
}

/** Posts the journal of every reversal that wrote a true-up / sweep row; returns their journal ids. */
export async function postReversalValueJournals(
  tx: Tx,
  results: readonly ReverseResult[],
  ctx: ReversalJournalContext,
): Promise<string[]> {
  const settled = results.filter((r) => r.sweep && !new Decimal(r.sweep.valueDelta.toString()).isZero());
  if (settled.length === 0) return [];
  const cogs = await cogsAccountFor(tx);
  const ids: string[] = [];
  for (const result of settled) {
    const row = result.sweep!;
    const item = await tx.inventoryItem.findUniqueOrThrow({ where: { id: row.itemId }, select: { name: true, accountId: true } });
    const inventoryAccountId = await inventoryAccountFor(tx, item);
    if (!inventoryAccountId) throw new BusinessError('Akun Persediaan belum dipetakan di Akun Sistem.');
    const amount = new Decimal(row.valueDelta.toString());
    const value = amount.abs().toString();
    const narration = `Koreksi nilai persediaan: pembatalan ${result.movement.movementNumber} (${ctx.documentLabel}) - ${item.name}`;
    const [debitId, creditId] = amount.gt(0) ? [inventoryAccountId, cogs.id] : [cogs.id, inventoryAccountId];
    const { journal } = await postJournal(tx, {
      date: row.date,
      narration,
      lines: [
        { accountId: debitId, debit: value, credit: 0, description: narration },
        { accountId: creditId, debit: 0, credit: value, description: narration },
      ],
      sourceType: 'SYSTEM_DOC',
      sourceKey: sourceKeys.inventoryTrueUp(result.movement.id),
      createdBy: ctx.userId,
      accountRule: DOCUMENT_RULE,
      partyRule: 'off',
      expectFiscalYearId: row.fiscalYearId,
    });
    await linkMovementJournal(tx, row.id, journal.id);
    ids.push(journal.id);
  }
  return ids;
}
