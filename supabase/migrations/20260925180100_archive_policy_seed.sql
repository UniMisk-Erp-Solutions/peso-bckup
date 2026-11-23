-- Seed archive policies (all archive_enabled = false until ops enable per table)

BEGIN;

INSERT INTO archive.archive_policy (
  table_name,
  date_column,
  hot_retention_months,
  warm_retention_months,
  cold_retention_months,
  archive_enabled,
  require_terminal_status,
  terminal_status_values,
  notes
) VALUES
  (
    'notifications',
    'created_at',
    12,
    36,
    84,
    false,
    false,
    '{}',
    'Read notifications older than hot window; verify Realtime impact before enable.'
  ),
  (
    'audit_logs',
    'created_at',
    24,
    60,
    NULL,
    false,
    false,
    '{}',
    'Compliance-heavy; prefer warm jsonb copy before any purge. Class E.'
  ),
  (
    'generated_reports',
    'last_generated_at',
    6,
    24,
    60,
    false,
    false,
    '{}',
    'Large jsonb payloads; align with expires_at purge RPC DOC-103.'
  ),
  (
    'generated_report_runs',
    'generated_at',
    6,
    24,
    60,
    false,
    false,
    '{}',
    'Light run metadata; move with generated_reports strategy.'
  ),
  (
    'report_export_jobs',
    'created_at',
    1,
    3,
    12,
    false,
    true,
    ARRAY['completed', 'failed', 'cancelled'],
    'Table CREATE not in migration tree; verify schema on target DB before enable.'
  ),
  (
    'expenses',
    'updated_at',
    24,
    60,
    120,
    false,
    true,
    ARRAY['paid', 'rejected'],
    'NEVER enable without expense+EFV+attachment cascade plan. Class A hub.'
  ),
  (
    'expense_form_field_values',
    'updated_at',
    24,
    60,
    120,
    false,
    false,
    '{}',
    'Archive only with parent expense batch. Class C.'
  ),
  (
    'expense_correction_logs',
    'created_at',
    60,
    120,
    NULL,
    false,
    false,
    '{}',
    'Class D — immutable correction evidence; do not auto-archive.'
  ),
  (
    'cash_transfer_history',
    'created_at',
    60,
    120,
    NULL,
    false,
    false,
    '{}',
    'Class D — financial history; ledger-linked.'
  ),
  (
    'balance_ledger',
    'effective_at',
    60,
    120,
    NULL,
    false,
    false,
    '{}',
    'Class D — NEVER auto-archive.'
  ),
  (
    'balance_historical_anchors',
    'effective_date',
    60,
    120,
    NULL,
    false,
    false,
    '{}',
    'Class D — NEVER auto-archive.'
  ),
  (
    'attachments',
    'created_at',
    24,
    60,
    120,
    false,
    false,
    '{}',
    'Class F — use attachment_archive_catalog + Storage tiering; hot path unchanged.'
  ),
  (
    'user_activity_sessions',
    'started_at',
    3,
    12,
    24,
    false,
    false,
    '{}',
    'Class E observability; optional cold export only.'
  ),
  (
    'user_activity_daily_rollups',
    'activity_date',
    6,
    24,
    36,
    false,
    false,
    '{}',
    'Class E aggregated telemetry.'
  )
ON CONFLICT (table_name) DO UPDATE SET
  date_column = EXCLUDED.date_column,
  hot_retention_months = EXCLUDED.hot_retention_months,
  warm_retention_months = EXCLUDED.warm_retention_months,
  cold_retention_months = EXCLUDED.cold_retention_months,
  require_terminal_status = EXCLUDED.require_terminal_status,
  terminal_status_values = EXCLUDED.terminal_status_values,
  notes = EXCLUDED.notes,
  updated_at = now();

COMMIT;
