// Side-effect imports of the year-close checks other modules register (services/fiscalYearClose.ts
// keeps the registry and the built-in checks). Imported by index.ts and by
// scripts/repair/e1-close-baseline.ts, which refuses check ids it does not know; one line per module.
import './ledger/arSubledgerCloseChecks';
