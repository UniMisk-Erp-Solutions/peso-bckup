-- DOC-099 — bulk balance import: batch, row, and mapping-profile schema.
--
-- FUTURE_PLANS.md #16-17. Admin-only artifacts throughout -- employees never
-- see an import batch, row, or mapping profile; they see the resulting
-- balance_ledger entries via their own history surface (a separate,
-- read-only RPC, not these tables).

CREATE TABLE IF NOT EXISTS public.balance_import_batches (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  mode                  text        NOT NULL CHECK (mode IN ('historical_opening', 'allocation')),
  status                text        NOT NULL DEFAULT 'draft'
                                     CHECK (status IN ('draft', 'validated', 'applying', 'applied', 'failed', 'reversed')),

  original_filename     text        NOT NULL,
  source_storage_path   text,
  source_sha256         text,
  mapping_profile_id    uuid,
  default_effective_date date,
  note                  text,

  created_by            uuid        NOT NULL REFERENCES auth.users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  validated_at          timestamptz,
  applied_at            timestamptz,
  applied_by            uuid REFERENCES auth.users(id),
  reversed_at           timestamptz,
  reversed_by           uuid REFERENCES auth.users(id),

  row_count             integer     NOT NULL DEFAULT 0,
  valid_row_count        integer     NOT NULL DEFAULT 0,
  invalid_row_count      integer     NOT NULL DEFAULT 0,
  total_delta            numeric(14,2) NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS balance_import_batches_org_idx
  ON public.balance_import_batches (organization_id, created_at DESC);

COMMENT ON TABLE public.balance_import_batches IS
  'DOC-099. One row per uploaded spreadsheet import. status is set/advanced '
  'only by server RPCs (validate/apply/reverse); draft/validated rows never '
  'mutate any balance.';

CREATE TABLE IF NOT EXISTS public.balance_import_rows (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id              uuid        NOT NULL REFERENCES public.balance_import_batches(id) ON DELETE CASCADE,
  row_number            integer     NOT NULL,

  raw_employee_id       text,
  normalized_employee_id text,
  raw_email             text,
  normalized_email      text,
  matched_user_id       uuid,

  current_balance_snapshot numeric(14,2),
  input_amount          numeric(14,2),
  calculated_new_balance numeric(14,2),
  effective_date        date,
  note                  text,

  validation_status     text        NOT NULL DEFAULT 'pending'
                                     CHECK (validation_status IN (
                                       'pending', 'valid', 'unknown', 'ambiguous',
                                       'invalid_amount', 'duplicate', 'no_op'
                                     )),
  validation_code       text,
  validation_message    text,

  ledger_entry_id       uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT balance_import_rows_batch_row_unique UNIQUE (batch_id, row_number)
);

CREATE INDEX IF NOT EXISTS balance_import_rows_batch_idx
  ON public.balance_import_rows (batch_id, row_number);
CREATE INDEX IF NOT EXISTS balance_import_rows_matched_user_idx
  ON public.balance_import_rows (matched_user_id) WHERE matched_user_id IS NOT NULL;

COMMENT ON TABLE public.balance_import_rows IS
  'DOC-099. One row per spreadsheet line. Raw identity fields are limited to '
  'what reconciliation needs -- the full uploaded spreadsheet is never '
  'duplicated into this table; the original file lives in private Storage '
  '(see balance_import_batches.source_storage_path).';

CREATE TABLE IF NOT EXISTS public.balance_import_mapping_profiles (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name                  text        NOT NULL,
  -- { "Spreadsheet Column Header": "pesowise_field" } e.g. {"EMP CODE": "employee_id", "Allocation Amount": "amount"}
  header_mapping        jsonb       NOT NULL,
  is_default            boolean     NOT NULL DEFAULT false,
  created_by            uuid        NOT NULL REFERENCES auth.users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT balance_import_mapping_profiles_org_name_unique UNIQUE (organization_id, name)
);

COMMENT ON TABLE public.balance_import_mapping_profiles IS
  'DOC-099. Reusable, per-organization spreadsheet column mapping '
  '(FUTURE_PLANS.md #17). Never hard-code a specific company''s spreadsheet '
  'format in application code -- this table is the only mapping mechanism.';

-- Guarded on import into peso-bckup: a bare ADD CONSTRAINT aborts a re-run
-- after a mid-sequence failure. Postgres has no ADD CONSTRAINT IF NOT EXISTS,
-- so the existence check is explicit.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'balance_import_batches_mapping_profile_fkey'
      AND conrelid = 'public.balance_import_batches'::regclass
  ) THEN
    ALTER TABLE public.balance_import_batches ADD CONSTRAINT balance_import_batches_mapping_profile_fkey
      FOREIGN KEY (mapping_profile_id) REFERENCES public.balance_import_mapping_profiles(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- RLS -- admin-only, organization-scoped, throughout. No employee access to
-- any of these three tables under any policy.
-- ---------------------------------------------------------------------------

ALTER TABLE public.balance_import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.balance_import_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.balance_import_mapping_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins manage org import batches" ON public.balance_import_batches;
CREATE POLICY "Admins manage org import batches"
  ON public.balance_import_batches FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid() AND om.organization_id = balance_import_batches.organization_id
        AND om.role = 'admin' AND om.is_active = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid() AND om.organization_id = balance_import_batches.organization_id
        AND om.role = 'admin' AND om.is_active = true
    )
  );

DROP POLICY IF EXISTS "Admins manage org import rows" ON public.balance_import_rows;
CREATE POLICY "Admins manage org import rows"
  ON public.balance_import_rows FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.balance_import_batches b
      JOIN public.organization_memberships om ON om.organization_id = b.organization_id
      WHERE b.id = balance_import_rows.batch_id
        AND om.user_id = auth.uid() AND om.role = 'admin' AND om.is_active = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.balance_import_batches b
      JOIN public.organization_memberships om ON om.organization_id = b.organization_id
      WHERE b.id = balance_import_rows.batch_id
        AND om.user_id = auth.uid() AND om.role = 'admin' AND om.is_active = true
    )
  );

DROP POLICY IF EXISTS "Admins manage org mapping profiles" ON public.balance_import_mapping_profiles;
CREATE POLICY "Admins manage org mapping profiles"
  ON public.balance_import_mapping_profiles FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid() AND om.organization_id = balance_import_mapping_profiles.organization_id
        AND om.role = 'admin' AND om.is_active = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid() AND om.organization_id = balance_import_mapping_profiles.organization_id
        AND om.role = 'admin' AND om.is_active = true
    )
  );

REVOKE ALL ON TABLE public.balance_import_batches FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.balance_import_rows FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.balance_import_mapping_profiles FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.balance_import_batches TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.balance_import_rows TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.balance_import_mapping_profiles TO authenticated;

NOTIFY pgrst, 'reload schema';
