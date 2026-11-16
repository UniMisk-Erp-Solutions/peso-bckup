# PesoWise archive / cold-storage framework

Production-safe, **additive** design. Hot operational data stays in `public.*`. Archive metadata lives in `archive.*`.

## Hot / warm / cold model

| Tier | Location | Purpose |
|------|----------|---------|
| **Hot** | Primary Postgres (SSD) | Active expenses, approvals, balances, config, recent reports |
| **Warm** | `archive.*` schema (same cluster initially) | Copied immutable rows, searchable via RPC |
| **Cold** | MinIO / NAS / 4TB SAS / S3 (future) | Compressed exports, old attachments, log exports |

**Backups (PITR, WAL, Restic) are separate** — archive does not replace disaster recovery.

---

## Safety defaults

| Control | Default |
|---------|---------|
| `archive.archive_settings.copy_enabled` | **false** |
| `archive.archive_settings.purge_enabled` | **false** |
| `archive.archive_settings.restore_enabled` | **false** |
| `archive.archive_settings.global_dry_run` | **true** |
| `archive.archive_policy.archive_enabled` | **false** (all seeded tables) |
| `delete_source_after_verified_archive` | **false** |
| Auto schedules | **none** |
| Source DELETE on copy | **never** |

---

## Eligible vs excluded (summary)

See **`docs/archive/ARCHIVE_CANDIDATE_AUDIT.md`** for the full table.

**Must stay hot (A/D):** `expenses` (hub), `balance_ledger`, `balance_historical_anchors`, `cash_transfer_history`, `expense_correction_logs`, config/membership tables.

**Archive candidates (B/C, policy seeded, disabled):** `notifications`, `generated_reports`, `generated_report_runs`, `report_export_jobs`, eventually terminal `expenses` with cascade plan.

**Never auto (D):** ledger, anchors, correction logs, transfer history.

**Logs (E):** `audit_logs`, `user_activity_*`, Logflare — separate from business archive DB.

**Files (F):** `attachments` + Storage — `attachment_archive_catalog`; hot paths unchanged until fallback exists.

---

## RPC surface (org admin only)

| RPC | Purpose |
|-----|---------|
| `preview_archive_batch_v1` | **Read-only** eligibility counts |
| `copy_archive_batch_v1` | Copy to `archive.archived_row_store` (dry-run unless flags + `p_execute`) |
| `purge_verified_archive_batch_v1` | **Blocked** unless purge flags + force |
| `preview_restore_archive_batch_v1` | Restore dry-run metadata |
| `get_archive_metrics_v1` | Batch / row metrics |
| `get_archived_expenses_v1` | Paginated historical read (explicit UI only) |

Normal app queries **unchanged** — see `src/lib/archive/historicalRead.ts` (not wired to pages).

---

## Partitioning

**Not applied to live tables.** Plan: **`docs/archive/PARTITIONING_PLAN.md`**.

---

## Frontend (Phase 11 — design only)

Future tabs: **Expenses → Current | Archived**, **Reports → Current | Historical**.  
No silent mixing. See **`docs/archive/FRONTEND_UX_PHASE11.md`**.

---

## Final deliverable index (A–N)

### A. Current state audit

- 52 `public` tables created in `supabase/migrations`; `report_export_jobs` referenced but **CREATE not in tree** (UNKNOWN DDL on target DB).
- Row counts: **UNKNOWN** without production `SELECT count(*)`.
- Frontend: heavy `.from('expenses')` (19 files), attachments (12), audit_logs (10); ledger/anchors via RPC only.

### B. Archive candidates

Notifications, generated report snapshots/runs, completed export jobs, old read notifications — **policy seeded, disabled**.

### C. Must stay hot

Expenses workflow, balances, ledger, anchors, org config, active approvals, Realtime subscriptions.

### D. Retention matrix

Configured per table in `archive.archive_policy` (hot/warm/cold months). All `archive_enabled=false`.

### E. Database changes created

Migrations:

- `20260925180000_archive_framework_schema.sql`
- `20260925180100_archive_policy_seed.sql`
- `20260925180200_archive_rpc_framework.sql`

Rollback: `supabase/rollbacks/20260925180000_archive_framework_schema_rollback.sql`

### F. Files created/modified

- `docs/archive/*`, `ARCHIVE_ARCHITECTURE.md`, `ARCHIVE_RUNBOOK.md`
- `src/lib/archive/*` (helpers + tests; **no page changes**)
- `scripts/archive/log-retention-dry-run.sh.example`

### G. Tests added

- `src/lib/archive/eligibility.test.ts` (Vitest)

### H. Migrations created

Three additive migrations (above). **Not applied to production by this repo push alone** — apply via your normal migration process after review.

### I. Dry-run only today

- All previews
- Default `copy_archive_batch_v1` (`p_execute=false`, flags false)
- Purge function returns without deleting
- Restore execute not implemented
- No partition conversion
- No Storage path changes
- No log deletion script execution

### J. Manual approval before production

1. Review audit + policies  
2. Apply migrations on staging  
3. Run preview RPCs per org/table  
4. Enable `archive_enabled` per table **one at a time**  
5. Set `copy_enabled=true`, `global_dry_run=false` only for controlled copy test  
6. Verify checksums / counts  
7. **Never** enable purge without legal/compliance sign-off  

### K. Estimated storage savings

**UNKNOWN** until previews run on production (`eligible_rows` × avg row size).

### L. Risks

- Expense hub FK graph — moving expenses without children breaks reports/RLS  
- `report_export_jobs` schema drift vs migrations  
- Realtime on `notifications` / `expenses`  
- Cross-tenant admin RPC misuse — mitigated by org admin check  
- Copy currently implemented only for **`notifications`** when explicitly executed  

### M. Rollback plan

1. Stop archive jobs  
2. Run schema rollback SQL (drops `archive` schema)  
3. Drop RPCs (included in CASCADE)  
4. Hot data untouched (copy does not delete source)  
5. Remove frontend imports if any added later  

### N. Next safe step

1. Deploy migrations to **staging**  
2. `SELECT preview_archive_batch_v1('notifications', org_id, cutoff, 1000)`  
3. Document eligible counts  
4. Design expense **cascade** archive (EFV + attachments + audit) before enabling `expenses` policy  

---

**PITR / WAL disaster recovery** (separate from archive): `docs/recovery/PITR_ARCHITECTURE.md`.
