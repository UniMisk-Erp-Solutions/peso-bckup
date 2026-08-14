# Deploy Edge Functions on Coolify (self-hosted Supabase)

Bulk user upload, admin create user, password reset, and similar admin actions call **Edge Functions**.  
The database and CSV can be correct, but upload will fail until function **code files** exist on the Coolify server.

## Symptom

- Toast: **Bulk upload failed** / Edge Function non-2xx
- API response body contains:
  `could not find an appropriate entrypoint`
- `hello` works at `/functions/v1/hello` but `bulk-users-import` returns 500

This means Kong routes exist, but `bulk-users-import/index.ts` (and other functions) were **never copied** to the edge-runtime volume.

## What must exist on the server

Coolify mounts:

```text
./volumes/functions  →  /home/deno/functions
```

Each function needs:

```text
volumes/functions/bulk-users-import/index.ts
volumes/functions/admin-create-user/index.ts
volumes/functions/_shared/cors.ts          (used by admin-create-user)
... etc.
```

From this repo, source is: `supabase/functions/`

## Option A — SSH + rsync (recommended)

On your PC (Git Bash or WSL), from the repo root:

```bash
# Replace with your Coolify SSH user/host and service path
COOLIFY="root@YOUR_SERVER"
REMOTE="/data/coolify/services/YOUR_SUPABASE_SERVICE_ID/volumes/functions"

rsync -avz --delete \
  --exclude main \
  --exclude hello \
  ./supabase/functions/ \
  "$COOLIFY:$REMOTE/"
```

Find `YOUR_SUPABASE_SERVICE_ID` on the Coolify server:

```bash
ls /data/coolify/services/
# look for the folder that contains volumes/functions/hello
```

Restart edge runtime (container name contains `supabase-edge-functions`):

```bash
ssh root@YOUR_SERVER "docker ps --format '{{.Names}}' | grep edge-functions | xargs -r docker restart"
```

## Option B — Coolify UI (manual)

1. Coolify → your Supabase stack → **Persistent Storage**
2. Open `volumes/functions`
3. For each folder under `supabase/functions/` in this repo (except `main` if Coolify already has it):
   - Create folder `bulk-users-import`
   - Upload `index.ts` from the repo
4. Upload `_shared/cors.ts` for admin functions
5. Restart the **supabase-edge-functions** container

## Verify

```bash
curl -s -X POST "https://pesowise-supabase.unimisk.com/functions/v1/bulk-users-import" \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Authorization: Bearer YOUR_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"rows":[]}'
```

- **Before deploy:** `could not find an appropriate entrypoint`
- **After deploy:** `rows[] is required` or auth error (function is running)

## Functions required for Pesowise admin

| Function | Used for |
|----------|----------|
| `bulk-users-import` | CSV bulk user upload |
| `admin-create-user` | Create single user |
| `admin-reset-password` | Reset password |
| `admin-update-user-email` | Change email |
| `resolve-employee-login` | Employee ID login |
| `send-account-created-email` | Optional welcome email |

Coolify’s edge container already sets `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` via compose — you usually **do not** need extra secrets once files are in place.

## After functions are deployed

1. Use **`ML USERS-pesowise-bulk.csv`** (employee_id format)
2. Dry-run first
3. Upload in batches if needed (large CSV)

Supervisors (`5022`, `3542`, etc.) must already exist as users with matching `employee_id` in `profiles`.
