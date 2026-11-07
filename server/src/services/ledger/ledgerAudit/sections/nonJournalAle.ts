// Ledger rows booked to a document instead of a journal, one row per document and fiscal year, for
// the accountant (owner decision #7). Same definition as the health check and the year-close check
// non-journal-ale-duplicate (services/ledger/nonJournalAle.ts). Reported only: whether a double is
// cleaned up is a separate decision, and the ledger balance triggers do not concern it (no gate).

import { businessDayOf } from '../../../../utils/businessDate';
import { findNonJournalAle } from '../../nonJournalAle';
import type { AuditRow, AuditSection } from '../types';

export const nonJournalAleSection: AuditSection = {
  id: 'nonJournalAle',
  title: 'Ledger rows booked to a document instead of a journal',
  gate: null,
  async run(tx, opts) {
    // ALE has no updated_at and these rows come only from old writers, so --since does not apply.
    const { rows } = await findNonJournalAle(tx, { fiscalYearId: opts.fiscalYearId });
    return rows.map<AuditRow>((g) => ({
      section: 'nonJournalAle',
      cause: g.duplicate ? 'also-in-journal' : 'document-only',
      key: `${g.referenceType}:${g.referenceId}@${g.fiscalYearId}`,
      label: g.label,
      date: businessDayOf(g.date),
      amount: g.debit.toFixed(2),
      count: g.rows,
      yearClosed: g.yearClosed,
      gate: false,
      detail: [
        `${g.referenceType} in fiscal year ${g.fiscalYearName}; credit ${g.credit.toFixed(2)}`,
        g.linkedJournal ? `journal ${g.linkedJournal}` : null,
        g.mirroredRows > 0 ? `${g.mirroredRows} row(s) with a twin journal ledger row` : null,
      ].filter(Boolean).join('; '),
    }));
  },
};
