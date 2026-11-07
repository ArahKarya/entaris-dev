#!/usr/bin/env bash
# Example cron job for merge gate (b) of the ledger balance triggers (E2-R3): run the read-only
# ledger audit every day and keep the CSV next to the database backups.
#
#   LEDGER_AUDIT_SINCE=2026-11-09 ./scripts/ops/ledger-audit-daily.sh
#
# LEDGER_AUDIT_SINCE is the business day the ledger writers of step 4 went live (YYYY-MM-DD). The
# audit only looks at rows created from that day on (open fiscal years are always checked in full).
# Exit code: 0 clean, 1 findings in the gate sections, 2 error. Gate (b) wants a full release cycle
# of exit 0. The script writes nothing to the database.
#
# Crontab example (daily 02:30, run from the repo checkout):
#   30 2 * * * cd /opt/entaris && LEDGER_AUDIT_SINCE=2026-11-09 ./scripts/ops/ledger-audit-daily.sh >> /var/log/entaris-ledger-audit.log 2>&1
set -euo pipefail

SINCE="${LEDGER_AUDIT_SINCE:?set LEDGER_AUDIT_SINCE=YYYY-MM-DD (the day the step 4 ledger writers were deployed)}"
if ! [[ "$SINCE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  echo "LEDGER_AUDIT_SINCE must look like 2026-11-09, got: $SINCE" >&2
  exit 2
fi

# /app/server/backups is the `backups` volume (docker-compose.yml), so the CSV survives the container.
OUT="/app/server/backups/ledger-audit-$(date +%F).csv"

docker compose run --rm app sh -c "cd /app/server && node dist/scripts/repair/e2-ledger-audit.js \
  --section aleGroups --section journalSubCent \
  --since '$SINCE' --gate trigger --out '$OUT'"
