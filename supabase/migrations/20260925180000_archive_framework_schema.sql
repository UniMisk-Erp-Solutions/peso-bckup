-- PesoWise archive framework (Phase 5–6 foundation)
-- ADDITIVE ONLY: new schema + tables. No changes to public hot tables.
-- All destructive/copy/purge paths default OFF until archive.archive_settings flags are set.

BEGIN;

CREATE SCHEMA IF NOT EXISTS archive;

COMMENT ON SCHEMA archive IS
  'Cold/warm archive metadata and copied rows. Independent from PITR/WAL/Restic backups.';

-- ---------------------------------------------------------------------------
-- Global safety switches (all default false)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS archive.archive_settings (
  id                    smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  copy_enabled          boolean NOT NULL DEFAULT false,
  purge_enabled         boolean NOT NULL DEFAULT false,
  restore_enabled       boolean NOT NULL DEFAULT false,
  global_dry_run        boolean NOT NULL DEFAULT true,
  max_rows_per_batch    integer NOT NULL DEFAULT 500
    CHECK (max_rows_per_batch BETWEEN 1 AND 5000),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid REFERENCES auth.users (id)
);

INSERT INTO archive.archive_settings (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Retention / allowlist configuration
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS archive.archive_policy (
  table_name                        text PRIMARY KEY,
  date_column                       text NOT NULL,
  hot_retention_months              integer NOT NULL DEFAULT 24
    CHECK (hot_retention_months >= 0),
  warm_retention_months             integer NOT NULL DEFAULT 60
    CHECK (warm_retention_months >= hot_retention_months),
  cold_retention_months             integer
    CHECK (cold_retention_months IS NULL OR cold_retention_months >= warm_retention_months),
  archive_enabled                   boolean NOT NULL DEFAULT false,
  require_terminal_status           boolean NOT NULL DEFAULT false,
  terminal_status_values            text[] NOT NULL DEFAULT '{}',
  legal_hold_supported              boolean NOT NULL DEFAULT true,
  delete_source_after_verified_archive boolean NOT NULL DEFAULT false,
  archive_format                    text NOT NULL DEFAULT 'jsonb_row'
    CHECK (archive_format IN ('jsonb_row', 'parquet_export', 'csv_export')),
  archive_target                    text NOT NULL DEFAULT 'postgres_archive_schema'
    CHECK (archive_target IN (
      'postgres_archive_schema',
      'minio',
      'nas',
      's3_compatible',
      'local_sas'
    )),
  notes                             text,
  created_at                        timestamptz NOT NULL DEFAULT now(),
  updated_at                        timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Batch tracking
-- ---------------------------------------------------------------------------
CREATE TYPE archive.archive_batch_status AS ENUM (
  'draft',
  'preview',
  'copying',
  'copied',
  'verified',
  'failed',
  'purged',
  'restored'
);

CREATE TABLE IF NOT EXISTS archive.archive_batches (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name            text NOT NULL REFERENCES archive.archive_policy (table_name),
  organization_id       uuid,
  started_at            timestamptz NOT NULL DEFAULT now(),
  completed_at          timestamptz,
  cutoff_date           timestamptz NOT NULL,
  row_count_expected    bigint,
  row_count_archived    bigint NOT NULL DEFAULT 0,
  row_count_verified    bigint NOT NULL DEFAULT 0,
  status                archive.archive_batch_status NOT NULL DEFAULT 'draft',
  source_checksum       text,
  archive_checksum      text,
  initiated_by          uuid REFERENCES auth.users (id),
  dry_run               boolean NOT NULL DEFAULT true,
  notes                 text
);

CREATE TABLE IF NOT EXISTS archive.archive_manifest (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id              uuid NOT NULL REFERENCES archive.archive_batches (id) ON DELETE CASCADE,
  source_table          text NOT NULL,
  source_id             uuid NOT NULL,
  organization_id       uuid,
  archived_at           timestamptz NOT NULL DEFAULT now(),
  source_checksum       text NOT NULL,
  archive_checksum      text NOT NULL,
  row_json              jsonb NOT NULL,
  UNIQUE (batch_id, source_table, source_id)
);

CREATE TABLE IF NOT EXISTS archive.archive_errors (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id              uuid REFERENCES archive.archive_batches (id) ON DELETE SET NULL,
  source_table          text,
  source_id             uuid,
  error_code            text NOT NULL,
  error_message         text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- Generic row store (warm tier inside Postgres); preserves IDs in row_json + manifest
CREATE TABLE IF NOT EXISTS archive.archived_row_store (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_schema         text NOT NULL DEFAULT 'public',
  source_table          text NOT NULL,
  source_id             uuid NOT NULL,
  organization_id       uuid,
  row_data              jsonb NOT NULL,
  archived_at           timestamptz NOT NULL DEFAULT now(),
  batch_id              uuid NOT NULL REFERENCES archive.archive_batches (id),
  source_checksum       text NOT NULL,
  verified              boolean NOT NULL DEFAULT false,
  UNIQUE (source_table, source_id)
);

CREATE INDEX IF NOT EXISTS archived_row_store_org_table_idx
  ON archive.archived_row_store (organization_id, source_table, archived_at DESC);

-- ---------------------------------------------------------------------------
-- Legal hold
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS archive.archive_legal_holds (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL,
  entity_type       text NOT NULL,
  entity_id         uuid NOT NULL,
  reason            text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  released_at       timestamptz,
  created_by        uuid REFERENCES auth.users (id)
);

CREATE UNIQUE INDEX IF NOT EXISTS archive_legal_holds_active_uniq
  ON archive.archive_legal_holds (organization_id, entity_type, entity_id)
  WHERE released_at IS NULL;

-- ---------------------------------------------------------------------------
-- Attachment / object cold metadata (no Storage path changes yet)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS archive.attachment_archive_catalog (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attachment_id     uuid NOT NULL,
  organization_id   uuid,
  expense_id        uuid,
  hot_bucket        text,
  hot_path          text,
  archive_provider  text,
  archive_bucket    text,
  archive_path      text,
  checksum          text,
  byte_size         bigint,
  mime_type         text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  archived_at       timestamptz,
  verified          boolean NOT NULL DEFAULT false,
  UNIQUE (attachment_id)
);

-- ---------------------------------------------------------------------------
-- RLS: deny direct client access; RPCs only
-- ---------------------------------------------------------------------------
ALTER TABLE archive.archive_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE archive.archive_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE archive.archive_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE archive.archive_manifest ENABLE ROW LEVEL SECURITY;
ALTER TABLE archive.archived_row_store ENABLE ROW LEVEL SECURITY;
ALTER TABLE archive.archive_errors ENABLE ROW LEVEL SECURITY;
ALTER TABLE archive.archive_legal_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE archive.attachment_archive_catalog ENABLE ROW LEVEL SECURITY;

-- No policies for authenticated → default deny on tables

REVOKE ALL ON SCHEMA archive FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA archive FROM PUBLIC;
GRANT USAGE ON SCHEMA archive TO postgres, service_role;

COMMIT;
