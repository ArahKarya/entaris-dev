-- E3-R6 (PR-6.4a): value-only stock movement (quantity 0, warehouse NULL). Its own folder so no later
-- statement in the same transaction uses the new value. Nothing writes it until the value ledger (6.4b1).
ALTER TYPE "StockMovementType" ADD VALUE IF NOT EXISTS 'Revaluation';
