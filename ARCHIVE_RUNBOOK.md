# Archive runbook (manual ops)

**Defaults: DRY RUN. No purge. No production DELETE.**

## Prerequisites

- Org admin user in `organization_memberships` (`role = 'admin'`)
- Migrations `20260925180000`–`20260925180200` applied on target DB
- Staging validation before production

## 1. Preview (safe)

```sql
SELECT public.preview_archive_batch_v1(
  'notifications',
  '<organization_uuid>'::uuid,
  (now() - interval '12 months'),
  1000
);
```

Other preview tables: `audit_logs`, `generated_reports`, `generated_report_runs`, `expenses` (warnings only), `report_export_jobs` (if table exists).

## 2. Archive dry-run (API default)

```sql
SELECT public.copy_archive_batch_v1(
  'notifications',
  '<organization_uuid>'::uuid,
  (now() - interval '12 months'),
  500,
  false  -- p_execute
);
```

Returns JSON with `dry_run: true` and embedded preview.

## 3. Execute copy (requires explicit flags)

**Only after approval:**

```sql
UPDATE archive.archive_settings SET
  copy_enabled = true,
  global_dry_run = false,
  updated_at = now()
WHERE id = 1;

UPDATE archive.archive_policy SET
  archive_enabled = true,
  updated_at = now()
WHERE table_name = 'notifications';

SELECT public.copy_archive_batch_v1(
  'notifications',
  '<organization_uuid>'::uuid,
  (now() - interval '12 months'),
  500,
  true
);
```

Source rows **remain** in `public.notifications` (copy-only).

## 4. Verify

```sql
SELECT public.get_archive_metrics_v1('<organization_uuid>'::uuid);

SELECT COUNT(*) FROM archive.archived_row_store
WHERE organization_id = '<organization_uuid>';
```

Compare `row_count_archived` on `archive.archive_batches` to preview `eligible_rows`.

## 5. Export to cold storage (future)

Use `archive_target` in policy + worker (not automated). Env keys: see `src/lib/archive/archiveEnv.ts`.

## 6. Purge source (NOT enabled)

```sql
SELECT public.purge_verified_archive_batch_v1('<batch_uuid>', false);
-- Always returns executed=false unless purge_enabled + p_force (still blocked in v1)
```

## 7. Restore preview

```sql
SELECT public.preview_restore_archive_batch_v1('<batch_uuid>'::uuid);
```

Full restore RPC: **not implemented** — manual SQL restore from `archived_row_store` only with change control.

## 8. Rollback framework

```bash
# After explicit approval only:
psql ... -f supabase/rollbacks/20260925180000_archive_framework_schema_rollback.sql
```

Hot tables unaffected if copy never purged.

## 9. Log retention (separate)

See `scripts/archive/log-retention-dry-run.sh.example` — **do not run** against production without export.

## 10. Legal hold

```sql
INSERT INTO archive.archive_legal_holds (organization_id, entity_type, entity_id, reason, created_by)
VALUES ('<org>', 'expense', '<expense_uuid>', 'litigation hold', auth.uid());
```

Held entities excluded from preview counts where implemented.
