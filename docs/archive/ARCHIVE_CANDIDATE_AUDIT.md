# Archive candidate audit (read-only, from repo migrations + src)

Row counts: **UNKNOWN** (requires production SQL).  
RLS/RPC depth: see migrations; frontend counts are `.from('table')` files only (RPC deps **UNKNOWN** unless noted).

| TABLE | PURPOSE | PK | DATE_COLUMN | ROW COUNT | ARCHIVE CLASS | RISK | RECOMMENDED RETENTION (policy seed) |
|-------|---------|-----|-------------|-----------|---------------|------|-------------------------------------|
| expenses | Core claims | id | updated_at | UNKNOWN | A (hub) | Critical | hot 24m — **archive_enabled false** |
| expense_form_field_values | Custom fields | id | updated_at | UNKNOWN | C | High | with expense cascade only |
| audit_logs | Expense audit trail | id | created_at | UNKNOWN | E | High | hot 24m, copy disabled |
| expense_correction_logs | Correction evidence | id | created_at | UNKNOWN | D | High | do not auto-archive |
| notifications | User alerts | id | created_at | UNKNOWN | B/C | Medium | hot 12m — disabled |
| report_export_jobs | Export job rows | id | created_at | UNKNOWN | C | Medium | DDL UNKNOWN in migrations |
| generated_reports | Report snapshots | id | last_generated_at | UNKNOWN | B | Medium | hot 6m — disabled |
| generated_report_runs | Per-run log | id | generated_at | UNKNOWN | B | Low | hot 6m — disabled |
| cash_transfer_history | Transfers | id | created_at | UNKNOWN | D | High | do not auto-archive |
| balance_ledger | Immutable ledger | id | effective_at | UNKNOWN | D | Critical | NEVER |
| balance_historical_anchors | Anchor engine | id | effective_date | UNKNOWN | D | Critical | NEVER |
| attachments | Receipt metadata | id | created_at | UNKNOWN | F | High | catalog only; hot paths unchanged |
| expense_form_field_value_history | EFV history | id | created_at | UNKNOWN | E | Medium | append-only |
| user_activity_sessions | Session telemetry | id | started_at | UNKNOWN | E | Low | optional export |
| user_activity_daily_rollups | Daily rollups | id | activity_date | UNKNOWN | E | Low | optional export |

FK/RPC/frontend detail: see conversation audit agent output in repo history or expand via `grep supabase/migrations`.

**Tables MUST REMAIN HOT (non-exhaustive):** `organization_memberships`, `organization_expense_form_fields`, `expense_batches`, `balance_*` (except export), `profiles`, `settings`, active drafts.

**NEVER ARCHIVE AUTOMATICALLY:** ledger, anchors, correction logs, transfer history, master admin tables.
