# Database backup (Supabase)

## Option 1: Node script (no Docker, no pg_dump) — **easiest**

1. **Set `DATABASE_URL` in `.env`** (one line). Get it from:
   - Supabase Dashboard → your project → **Project Settings** → **Database**
   - Under **Connection string** choose **URI**, copy it, and replace `[YOUR-PASSWORD]` with your database password.
   - **Format must be:** `postgresql://postgres:***REMOVED-SENSITIVE-VALUE***@db.xxxxx.supabase.co:5432/postgres`  
     (there must be an **`@`** between the password and the host).

2. **Run:**
   ```bash
   npm run db:dump:node
   ```
   Creates `backup.sql` in the project root (schema + data for all tables in `public`).

---

## Option 2: With Docker (Supabase CLI)

1. **Install and start Docker Desktop**: https://docs.docker.com/desktop/install/windows-install/
2. Make sure Docker is **running** (whale icon in system tray).
3. If you see "docker client must be run with elevated privileges", **run your terminal (PowerShell) as Administrator**: right‑click → Run as administrator, then `cd` to the project and run:
   ```bash
   npx supabase db dump -f backup.sql
   ```
   Or: `npm run db:dump`

4. Ensure the project is linked: `npx supabase link` (use Project ref and DB password from Supabase Dashboard).

---

## Option 3: With pg_dump (no Docker)

Use this if you don't want to run Docker.

1. **Install PostgreSQL** (client tools are enough): https://www.postgresql.org/download/windows/  
   During setup, add the **bin** folder to PATH so `pg_dump` is available.

2. **Set your database URL** (one-time):
   - Supabase Dashboard → your project → **Project Settings** → **Database**.
   - Under **Connection string** choose **URI** and copy it.
   - Replace `[YOUR-PASSWORD]` with your database password.
   - Add to project `.env` (do not commit this file if it has secrets):
     ```
     DATABASE_URL=postgresql://postgres.[PROJECT-REF]:***REMOVED-SENSITIVE-VALUE***@aws-0-xx.pooler.supabase.com:6543/postgres
     ```
   Or set in the terminal for one run:
   ```powershell
   $env:DATABASE_URL = "postgresql://postgres.xxx:***REMOVED-SENSITIVE-VALUE***@aws-0-xx.pooler.supabase.com:6543/postgres"
   ```

3. **Run the backup**:
   ```bash
   npm run db:dump:no-docker
   ```
   This creates `backup.sql` in the project root using `pg_dump` (no Docker).
