# Full local Supabase backup (read-only)

These steps **copy** data to your PC. They **do not delete or change** anything on Supabase.

## What you need from the Dashboard

Project: **`briypgrgqagbexudarba`** (your live app — must match `VITE_SUPABASE_URL`).

| Item | Where |
|------|--------|
| **Direct DB URL (port 5432)** | Settings → Database → Connection string → URI → **Direct** |
| **Service role key** | Settings → API → `service_role` (for storage download only; never in frontend) |
| **(Optional) S3 keys** | Storage → S3 connection — only if you prefer `aws s3 sync` over our Node script |

Put in `.env` (do not commit):

```env
VITE_SUPABASE_URL=https://briypgrgqagbexudarba.supabase.co
VITE_SUPABASE_PROJECT_ID=briypgrgqagbexudarba
DATABASE_URL=postgresql://postgres:***REMOVED-SENSITIVE-VALUE***@db.briypgrgqagbexudarba.supabase.co:5432/postgres
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
```

**Important:** Your `.env` previously pointed `DATABASE_URL` at project `yttrgclcrfrvlvtpfiso`. Update it to **`briypgrgqagbexudarba`** before backing up production.

## Tools (you already have most)

- `pg_dump` / `psql` — PostgreSQL 18 ✓
- `supabase` CLI ✓
- Node.js (for storage script) ✓
- Optional: AWS CLI or rclone for S3 sync

---

## Step 1 — Database backup

From project root in PowerShell:

```powershell
npm run backup:full
```

Or custom folder:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/full-local-backup.ps1 -OutDir "D:\pesowise_backups\supabase_backup_2026-05-29"
```

Creates (default: `../supabase_backup_<date>/` next to the repo):

```
supabase_backup_2026-05-29/
├── roles.sql
├── schema.sql
├── data.sql
├── full_backup.sql      ← includes auth.users + storage metadata
└── BACKUP_MANIFEST.txt
```

`full_backup.sql` uses `pg_dump --clean --if-exists` so **restore** can drop old objects first. Creating the dump is still **read-only** on the live database.

---

## Step 2 — Storage files (receipts)

SQL dumps **do not** include file bytes in the `receipts` bucket.

```powershell
npm run backup:storage
```

Downloads into:

```
supabase_backup_2026-05-29/
└── storage_backup/
    └── receipts/
        └── ...
```

**Alternative (S3):** Dashboard → Storage → S3 connection, then:

```powershell
aws s3 sync s3://receipts ./storage_backup/receipts `
  --endpoint-url https://briypgrgqagbexudarba.supabase.co/storage/v1/s3
```

---

## Step 3 — Restore to a **new** project (when ready)

Only on a **new** empty project — never run restore scripts against live production unless you mean to replace it.

1. `SET session_replication_role = replica;` (SQL Editor)
2. `psql "$NEW_DB_URL" -f roles.sql`
3. `psql "$NEW_DB_URL" -f schema.sql` (ignore “already exists” on auth/storage)
4. `psql "$NEW_DB_URL" -f data.sql`
5. Re-upload storage: `npm run backup:storage` in reverse (upload script) or `aws s3 sync ./storage_backup/receipts s3://receipts ...`
6. Redeploy Edge Functions, set secrets, update Vercel env to new project URL/keys

---

## Security

- Keep backup folders **outside git** (see `.gitignore`).
- Do **not** put `SUPABASE_SERVICE_ROLE_KEY` in any `VITE_*` variable.
- Rotate DB password and service role if they were ever exposed in chat or commits.
- After restore to a new project, enable RLS review and CAPTCHA before going live.
