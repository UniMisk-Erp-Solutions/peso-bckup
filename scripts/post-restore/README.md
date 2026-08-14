# Post-backup restore scripts

Run these **after** you reload a Supabase backup (e.g. May 27 5:30 AM).  
They re-apply everything we added **after** that backup date.

## What is included

| Step | What it does |
|------|----------------|
| **20 migrations** | All `supabase/migrations/*.sql` first added to git **after 2026-05-27 05:30** — see `00-RUN-ORDER-AFTER-270526-0530.md` |
| **SQL** `01-after-backup-restore.sql` | URL rewrite to new project (+ grants; run after migrations via `post-restore:migrations:full`) |
| **Storage** `npm run post-restore:storage` | Upload `receipts` files from local backup folder to Supabase Storage |

## Quick start

### Option A — Supabase SQL Editor (easiest for SQL only)

1. Open [Supabase Dashboard](https://supabase.com/dashboard) → your project → **SQL Editor**
2. Open `scripts/post-restore/01-after-backup-restore.sql` in this repo
3. Copy the **entire file** → paste → **Run**
4. On your PC (optional, for receipt images):

```powershell
cd pesowise-main
npm run post-restore:storage
```

### Option B — All 20 migrations + extras + storage (full restore)

Requires `DATABASE_URL` in `.env` and `psql` installed.

```powershell
cd pesowise-main
npm run post-restore:all
```

SQL only (20 migrations + `01-after-backup-restore.sql`):

```powershell
npm run post-restore:migrations:full
```

### Option C — SQL only or storage only

```powershell
npm run post-restore:sql       # database fixes only
npm run post-restore:storage   # upload receipt files only
```

## `.env` required

```env
VITE_SUPABASE_URL=https://kqlqirdneocivumdjtvx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
DATABASE_URL=postgresql://postgres.kqlqirdneocivumdjtvx:***REMOVED-SENSITIVE-VALUE***@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres
```

Optional — custom backup folder:

```env
BACKUP_DIR=C:\Users\nehal\OneDrive\Desktop\Client works\PEso-patodar\supabase_backup_2026-05-30
```

Default backup path if `BACKUP_DIR` is unset:

`../supabase_backup_2026-05-30/storage_backup/receipts`

## Edit project refs (if needed)

In `01-after-backup-restore.sql`, search for:

- `briypgrgqagbexudarba` → old project in backup URLs  
- `kqlqirdneocivumdjtvx` → your current live project  

Replace both if your refs are different.

## After running

1. **Vercel** — `VITE_SUPABASE_URL` + anon key for `kqlqirdneocivumdjtvx`, then redeploy  
2. **Edge Functions** — required for admin user creation (no service role in the browser):
   ```bash
   supabase functions deploy admin-create-user --project-ref kqlqirdneocivumdjtvx
   supabase functions deploy admin-reset-password --project-ref kqlqirdneocivumdjtvx
   supabase functions deploy admin-update-user-email --project-ref kqlqirdneocivumdjtvx
   supabase functions deploy bulk-users-import --project-ref kqlqirdneocivumdjtvx
   ```
   In Supabase Dashboard → Edge Functions → Secrets, set `SUPABASE_SERVICE_ROLE_KEY` (service role, not anon). Each function folder includes `config.toml` with `verify_jwt = false` so browser CORS preflight succeeds; JWT is validated inside the function.
3. **Auth** — redirect URLs for your domains  

## Source migrations (for reference)

This bundle combines:

- `supabase/migrations/20260530120000_fix_public_schema_grants_after_restore.sql`
- `supabase/migrations/20260528183500_manager_visibility_stable_rpc.sql`
- Post-restore URL updates + `GRANT USAGE ON SCHEMA storage`
