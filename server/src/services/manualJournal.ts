// Hand-made journals (E2-R3/R4, plan §2.1 L3): the Journal menu (MANUAL) and, later, the journal
// import (IMPORT) post through here. The input is checked for shape only (CreateJournalSchema);
// every amount, balance, account and party rule lives in postJournal and the modules it calls, so
// there is no second validator. Lines a person enters use manualJournalRule: control and tax
// accounts need journal.control, deposit accounts are refused even then, and the party is required
// on a receivable/payable line and refused anywhere else ('strict'). The touched parties'
// outstanding is recalculated afterwards, never incremented.

import type { Prisma } from '@prisma/client';
import { BusinessError } from '../utils/errors';
import { CreateJournalSchema, type CreateJournalInput } from '../utils/schemas';
import { manualJournalRule } from './ledger/accountGuard';
import { postJournal, type PostedJournal } from './ledger/postJournal';

type Tx = Prisma.TransactionClient;

export interface ManualJournalOptions {
  userId: string;
  sourceType: 'MANUAL' | 'IMPORT';
  /** sourceKeys.importGroup(...) for an import group; none for the Journal menu. */
  sourceKey?: string | null;
  /** The poster holds journal.control. */
  canControl: boolean;
}

export async function createManualJournalInTx(
  tx: Tx,
  input: CreateJournalInput,
  opts: ManualJournalOptions,
): Promise<PostedJournal> {
  const parsed = CreateJournalSchema.safeParse(input);
  if (!parsed.success) throw new BusinessError(parsed.error.issues[0].message);
  const body = parsed.data;

  return postJournal(tx, {
    date: new Date(body.date),
    narration: body.narration,
    lines: body.items.map((item) => ({
      accountId: item.accountId,
      debit: item.debit,
      credit: item.credit,
      partyId: item.partyId,
      // A line without its own description shows the narration, as before.
      description: item.description || body.narration,
    })),
    sourceType: opts.sourceType,
    sourceKey: opts.sourceKey ?? null,
    createdBy: opts.userId,
    accountRule: manualJournalRule(opts.canControl),
    partyRule: 'strict',
    partyEffect: 'recalc',
  });
}
