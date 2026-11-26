#!/bin/bash
# ============================================================
# deploy.sh — Entaris Deployment Script
# Run on the Raspberry Pi / production server
# Usage: bash deploy.sh
#
# Order matters (value ledger, E3-R6): build everything while the old app still serves, then STOP the
# app, migrate, seed and start the new build. The old process must not post stock between the
# migration and the restart: a row it writes after the backfill carries no value_delta and breaks
# book = GL with no approved way to repair it. If a step after the stop fails, the app stays stopped
# (pm2 save keeps that across a reboot); fix the cause and run this script again. After a failed
# migration run first:
#   cd server && npx prisma migrate resolve --rolled-back <migration folder>
# Right before a release that carries a data migration, rerun the drift check and the
# e3-value-baseline dry-run on production and freeze stock postings until this script has finished.
# ============================================================

set -e

APP_NAME="keuangan-erp"

stop_app() {
  if command -v pm2 &> /dev/null; then
    pm2 stop "$APP_NAME" 2>/dev/null || echo "   (PM2: $APP_NAME was not running)"
    pm2 save
    echo "   App stopped via PM2"
  elif systemctl is-active --quiet "$APP_NAME" 2>/dev/null; then
    sudo systemctl stop "$APP_NAME"
    echo "   App stopped via systemd"
  else
    echo "⚠️  No process manager detected: make sure the app is NOT running (stop it by hand), then continue."
  fi
}

echo "🚀 Entaris — Deploy"
echo "========================"

# 1. Pull latest code
echo ""
echo "📥 1/7 Pulling latest code..."
git pull origin main

# 2. Install server dependencies
echo ""
echo "📦 2/7 Installing server dependencies..."
cd server
npm install

# 3. Generate the Prisma client (the builds need it; the app still runs its old build)
echo ""
echo "🧬 3/7 Generating Prisma client..."
npx prisma generate

# 4. Build server and client
echo ""
echo "🔨 4/7 Building server and client..."
npm run build
cd ../client
npm install
npm run build
cd ../server

# 5. Stop the app, then run the database migrations
echo ""
echo "🗃️  5/7 Stopping the app and running database migrations..."
stop_app
npx prisma migrate deploy
# Loose SQL migrations (prisma/migrations/*.sql) are not run by `migrate deploy`. The new
# code reads the columns they add, so stop the deploy here instead of starting it without them.
if ! node -r dotenv/config prisma/apply-loose-sql.mjs; then
  echo "❌ Migrasi SQL lepas gagal. Deploy dihentikan (aplikasi tetap berhenti); perbaiki lalu jalankan ulang: cd server && npm run db:loose"
  exit 1
fi

# 6. Seed database — only when the users table is empty (same check as
#    docker-app-entrypoint.sh), so a redeploy never touches live data.
echo ""
echo "🌱 6/7 Seeding database..."
USER_COUNT=$(node -e "
  require('dotenv').config({ quiet: true });
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  pool.query('SELECT COUNT(*)::int AS c FROM users')
    .then(r => { console.log(r.rows[0].c); pool.end(); })
    .catch(() => { console.log('error'); pool.end(); });
" 2>/dev/null || echo "error")

if [ "$USER_COUNT" = "0" ]; then
  echo "   Database kosong, menjalankan seed data awal..."
  npx prisma db seed || echo "⚠️  Seed gagal. Jalankan manual: cd server && npx tsx prisma/seed.ts"
elif [ "$USER_COUNT" = "error" ]; then
  echo "⚠️  Tidak dapat memeriksa tabel users — seed dilewati. Jalankan manual bila DB baru."
else
  echo "   Database sudah berisi data ($USER_COUNT user), skip seed."
fi

# Value-ledger check: no stock row written without its value after the migration finished. The app
# has been stopped since step 5, so this must print 0; anything else means the old build posted stock.
set +e
node -r dotenv/config - <<'NODE'
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query(`
  SELECT COUNT(*)::int AS c
    FROM stock_movements m
   WHERE m.is_cancelled = false
     AND m.movement_type IN ('In', 'AdjustmentIn', 'Out', 'AdjustmentOut')
     AND m.value_delta = 0 AND m.total_value <> 0
     AND m.created_at > COALESCE((SELECT finished_at FROM _prisma_migrations
                                   WHERE migration_name = '20261112200000_inventory_value_ledger'), 'infinity')`)
  .then((r) => {
    console.log(r.rows[0].c === 0
      ? '   Cek buku nilai: 0 baris stok tanpa nilai setelah migrasi.'
      : `❌ Cek buku nilai: ${r.rows[0].c} baris stok tanpa nilai setelah migrasi. Aplikasi TIDAK dinyalakan; hubungi akuntan/pengembang.`);
    const rows = r.rows[0].c;
    return pool.end().then(() => process.exit(rows === 0 ? 0 : 2));
  })
  .catch((e) => { console.error(e.message); return pool.end().then(() => process.exit(1)); });
NODE
LEDGER_CHECK=$?
set -e
if [ "$LEDGER_CHECK" -eq 2 ]; then
  exit 1
elif [ "$LEDGER_CHECK" -ne 0 ]; then
  echo "⚠️  Cek buku nilai persediaan tidak dapat dijalankan; jalankan manual sebelum memakai aplikasi."
fi

# 7. Start the new build
echo ""
echo "🔄 7/7 Starting server..."
cd ..

# Try PM2 first, then systemd, then just show instructions
if command -v pm2 &> /dev/null; then
  pm2 restart "$APP_NAME" 2>/dev/null || pm2 start server/dist/index.js --name "$APP_NAME"
  pm2 save
  echo "✅ Server started via PM2"
elif systemctl list-unit-files "$APP_NAME.service" 2>/dev/null | grep -q "$APP_NAME"; then
  sudo systemctl restart "$APP_NAME"
  echo "✅ Server started via systemd"
else
  echo "⚠️  No process manager detected."
  echo "   Start manually:  cd server && node dist/index.js"
  echo "   Or install PM2:  npm install -g pm2"
  echo "                    pm2 start server/dist/index.js --name keuangan-erp"
  echo "                    pm2 save && pm2 startup"
fi

echo ""
echo "✅ Deploy complete!"
echo "   Check: curl http://localhost:3001/health"
