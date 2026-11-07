-- E2-R8 (PR-4.12): history of balance-sheet system account role moves. A move with nothing to
-- reclass posts no journal, so the old account is recorded here to stay a former role account.
-- DDL only, new table: cannot fail on data.

CREATE TABLE IF NOT EXISTS "system_account_role_moves" (
    "id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "from_account_id" TEXT NOT NULL,
    "to_account_id" TEXT,
    "moved_by" TEXT NOT NULL,
    "reason" TEXT,
    "moved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "system_account_role_moves_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "system_account_role_moves_role_from_account_id_idx"
    ON "system_account_role_moves"("role", "from_account_id");
