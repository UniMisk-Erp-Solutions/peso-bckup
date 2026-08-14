# How to get your Supabase backup

Your database URL was missing an **`@`** between the password and the host. The correct format is:

```
postgresql://postgres:***REMOVED-SENSITIVE-VALUE***@HOST:PORT/postgres
```

**Correct URL for your DB (password + host):**
```
postgresql://postgres:***REMOVED-SENSITIVE-VALUE***@db.yttrgclcrfrvlvtpfiso.supabase.co:5432/postgres
```

---

## Option A: Use the exact URI from Supabase Dashboard (recommended)

1. Open **https://supabase.com/dashboard** and select the project you want to backup.
2. Go to **Project Settings** (gear) → **Database**.
3. Under **Connection string** choose **URI**.
4. Copy the string. It looks like:  
   `postgresql://postgres.[REF]:***REMOVED-SENSITIVE-VALUE***@aws-0-XX.pooler.supabase.com:6543/postgres`  
   or  
   `postgresql://postgres:***REMOVED-SENSITIVE-VALUE***@db.[REF].supabase.co:5432/postgres`
5. Replace **`[YOUR-PASSWORD]`** with your database password: **`<DB_PASSWORD_FROM_ENV>`**.
6. Put the result in your project `.env` as:
   ```
   DATABASE_URL=postgresql://postgres:***REMOVED-SENSITIVE-VALUE***@...rest of URI...
   ```
   Make sure there is an **`@`** between the password and the host.
7. Run:
   ```bash
   npm run db:backup
   ```
   Backup will be written to **`backup.sql`** in the project root.

---

## Option B: Use pg_dump (if PostgreSQL is installed)

If you have **PostgreSQL** installed (so `pg_dump` is in your PATH), run this in a terminal (one line):

**Windows (PowerShell):**
```powershell
pg_dump "postgresql://postgres:***REMOVED-SENSITIVE-VALUE***@db.yttrgclcrfrvlvtpfiso.supabase.co:5432/postgres" -f backup.sql --no-owner --no-privileges
```

**If the host `db.yttrgclcrfrvlvtpfiso.supabase.co` does not resolve**, use the **Connection string (URI)** from the Dashboard (Option A) and replace the URL in the command above with that URI (with password filled in).

---

## If you see "ENOTFOUND" or "getaddrinfo failed"

The hostname in your URL is not resolving. That usually means:

- The **project ref** in the URL is wrong, or  
- The project is **paused** or removed, or  
- Supabase uses a **pooler host** for your project (e.g. `aws-0-XX.pooler.supabase.com`).

**Fix:** In the Supabase Dashboard, open that project → **Settings** → **Database** → copy the **Connection string (URI)** and use that exact URI (with your password) in `.env` as `DATABASE_URL`, then run `npm run db:backup`.
