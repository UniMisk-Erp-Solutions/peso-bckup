# Deploy Tally Phase 2/3/3.6 to PesoWise backup Supabase (.46)

**Requires explicit production approval.** This target hosts live org data (`pesowise-backup-supabase.unimisk.com`, Coolify service `kar0ro1k6jiyfxzzw7acnsza`).

## 1. Migrations (order)

```text
supabase/migrations/20261005160000_tally_sync_jobs_phase2.sql
supabase/migrations/20261005170000_tally_sync_preparation_phase3.sql
supabase/migrations/20261005180000_tally_sync_background_phase36.sql
```

Apply via `psql` against the stack Postgres or approved `supabase db push` linked project.

## 2. Edge functions (full folders)

Copy into the edge runtime functions volume (same layout as `run-report-export-job`):

```text
supabase/functions/start-tally-sync/
supabase/functions/run-tally-sync-job/
supabase/functions/_shared/tallySync/
supabase/functions/_shared/cors.ts   (if not already present)
```

Restart the Supabase **edge-runtime** container after sync.

## 3. Smoke tests

```bash
# Worker drain (service role bearer)
curl -s -X POST "$SUPABASE_URL/functions/v1/run-tally-sync-job" \
  -H "Authorization: Bearer $SERVICE_ROLE" -H "Content-Type: application/json" -d '{}'
# Expect: {"claimed":false} — NOT 500 entrypoint error

node scripts/tally-integration/validate-remote-pipeline.mjs
```

## 4. Ops backstop

Periodically (external scheduler):

- `POST /functions/v1/run-tally-sync-job` with `{}` to drain queued jobs
- `SELECT recover_stale_tally_sync_jobs_v1();` for stuck `processing`
