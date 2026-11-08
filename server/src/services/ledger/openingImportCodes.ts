// Error codes of the opening balance columns of the COA and party imports (routes/import/coa.ts,
// routes/import/parties.ts, services/partyImport.ts).

/** A row would replace a recorded opening balance, and the request did not confirm that row. */
export const OPENING_REPLACE_UNCONFIRMED = 'OPENING_REPLACE_UNCONFIRMED';
/** A row's amount equals the account's running balance (old template), and the request did not confirm that row. */
export const OPENING_RUNNING_BALANCE = 'OPENING_RUNNING_BALANCE';
/** A party row has no receivable/payable direction for its amount, or one its party type does not have (PR-5.12). */
export const PARTY_OPENING_DIRECTION = 'PARTY_OPENING_DIRECTION';
