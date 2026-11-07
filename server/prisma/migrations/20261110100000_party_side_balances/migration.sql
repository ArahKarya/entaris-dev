-- E2-R13 / E5-R3 (PR-5.9a): party receivable and payable per side (services/ledger/partySides.ts).
-- DDL and backfill in one migration: the code that reads the columns ships with it, and a failure
-- here stops the boot instead of being logged and skipped like loose SQL. Idempotent: running it
-- again changes nothing.

ALTER TABLE "parties" ADD COLUMN IF NOT EXISTS "receivable_outstanding" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "parties" ADD COLUMN IF NOT EXISTS "payable_outstanding" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "parties" ADD COLUMN IF NOT EXISTS "opening_receivable" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "parties" ADD COLUMN IF NOT EXISTS "opening_payable" DECIMAL(15,2) NOT NULL DEFAULT 0;

-- Direct only the clean opening amounts: a Customer's to the receivable side, a Supplier's to the
-- payable side, when positive and no Receive/Pay payment of the party (any status) may have cut it.
-- A payment remainder lowers opening_outstanding without a side (services/paymentSubmit.ts), so a
-- payment with an unallocated rest, or a cancelled one (its allocations are deleted on cancel),
-- leaves the party undirected. Both, negative amounts (old imports without a journal) and those
-- parties keep their opening undirected (opening_outstanding - opening_receivable - opening_payable),
-- which still counts towards outstanding, until the accountant reviews e2-party-opening-audit.
-- Rows already directed are skipped, so a second run does nothing.
UPDATE "parties" p
   SET "opening_receivable" = CASE WHEN p."partyType" = 'Customer' THEN p."opening_outstanding" ELSE 0 END,
       "opening_payable"    = CASE WHEN p."partyType" = 'Supplier' THEN p."opening_outstanding" ELSE 0 END
 WHERE p."partyType" IN ('Customer', 'Supplier')
   AND p."opening_outstanding" > 0
   AND p."opening_receivable" = 0
   AND p."opening_payable" = 0
   AND NOT EXISTS (
     SELECT 1
       FROM "payments" pay
      WHERE pay."party_id" = p."id"
        AND pay."payment_type" IN ('Receive', 'Pay')
        AND (pay."status" = 'Cancelled'
             OR pay."amount" - COALESCE((SELECT SUM(a."allocated_amount")
                                           FROM "payment_allocations" a
                                          WHERE a."payment_id" = pay."id"), 0) > 0.01)
   );

-- Side columns from the documents (not Draft or Cancelled) and the opening amounts, as
-- computePartySides without the manual party adjustment: e2-party-side-recalc --apply, run in the
-- same release, adds it. outstanding_amount is left as it is until then.
UPDATE "parties" p
   SET "receivable_outstanding" =
         CASE WHEN p."partyType" = 'Supplier' THEN p."opening_receivable"
              ELSE p."opening_outstanding" - p."opening_payable" + COALESCE(si."outstanding", 0) END,
       "payable_outstanding" =
         CASE WHEN p."partyType" = 'Supplier' THEN p."opening_outstanding" - p."opening_receivable" + COALESCE(pi."outstanding", 0)
              WHEN p."partyType" = 'Both' THEN p."opening_payable" + COALESCE(pi."outstanding", 0)
              ELSE p."opening_payable" END
  FROM "parties" base
  LEFT JOIN (
    SELECT "party_id", SUM("outstanding") AS "outstanding"
      FROM "sales_invoices"
     WHERE "status" NOT IN ('Draft', 'Cancelled')
     GROUP BY "party_id"
  ) si ON si."party_id" = base."id"
  LEFT JOIN (
    SELECT "party_id", SUM("outstanding") AS "outstanding"
      FROM "purchase_invoices"
     WHERE "status" NOT IN ('Draft', 'Cancelled')
     GROUP BY "party_id"
  ) pi ON pi."party_id" = base."id"
 WHERE base."id" = p."id";
