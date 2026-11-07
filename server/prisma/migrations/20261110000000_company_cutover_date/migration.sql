-- E2-R11 (PR-5.7a): the one cut-over date of the opening balances. NULL until the first opening
-- balance is posted (services/ledger/openingBalance.ts resolveCutoverDate fills it once, with an
-- audit row); a demo data wipe clears it. DDL only; the existing row stays NULL.
ALTER TABLE "company_settings" ADD COLUMN IF NOT EXISTS "cutover_date" DATE;
