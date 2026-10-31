/**
 * Which journals the Journal menu may cancel, by source type. Mirrors MENU_CANCELLABLE_SOURCES in
 * server/src/services/ledger/journalSource.ts: journals a person made (by hand, by import, from a
 * template or from the cash book). Everything else, an unknown (null) source included, is
 * cancelled from its source document; the server also rejects module-linked hand-made journals.
 */
export const MENU_CANCELLABLE_SOURCES: ReadonlySet<string> = new Set(['MANUAL', 'IMPORT', 'RECURRING', 'CASH_BOOK']);

/** True when the Journal menu may cancel a journal with this source type. */
export function isMenuCancellable(sourceType: string | null | undefined): boolean {
  return !!sourceType && MENU_CANCELLABLE_SOURCES.has(sourceType);
}
