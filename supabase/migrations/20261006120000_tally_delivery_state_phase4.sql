-- Phase 4: Tally delivery state (mapping/XML foundation). No Tally transport.

CREATE TABLE IF NOT EXISTS public.tally_delivery_state (
  organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  delivery_key        text NOT NULL,
  delivery_kind       text NOT NULL,
  last_content_hash   text,
  tally_remote_id     text,
  last_action         text NOT NULL DEFAULT 'pending',
  last_job_id         uuid REFERENCES public.tally_sync_jobs(id) ON DELETE SET NULL,
  peso_deleted_at     timestamptz,
  cancel_strategy     text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, delivery_key),
  CONSTRAINT tally_delivery_state_kind_check
    CHECK (delivery_kind IN (
      'accounting_expense',
      'accounting_balance_event',
      'report_metadata',
      'daily_metadata'
    )),
  CONSTRAINT tally_delivery_state_action_check
    CHECK (last_action IN (
      'pending', 'create', 'skip', 'update', 'cancel_planned'
    ))
);

COMMENT ON TABLE public.tally_delivery_state IS
  'Per-org delivery ledger for Tally mapping. Populated only after successful Tally ack in later phases; Phase 4 uses for CREATE/SKIP/UPDATE decisions.';

CREATE INDEX IF NOT EXISTS tally_delivery_state_org_updated_idx
  ON public.tally_delivery_state (organization_id, updated_at DESC);

ALTER TABLE public.tally_delivery_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY tally_delivery_state_admin_select_v1
  ON public.tally_delivery_state
  FOR SELECT
  TO authenticated
  USING (public.tally_sync_admin_can_view_v1(organization_id));

REVOKE ALL ON public.tally_delivery_state FROM PUBLIC;
GRANT SELECT ON public.tally_delivery_state TO authenticated;
GRANT ALL ON public.tally_delivery_state TO service_role;

-- Future PesoWise org ↔ Tally company pairing (connector phase).
CREATE TABLE IF NOT EXISTS public.tally_org_connector_config (
  organization_id     uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  connector_device_id text,
  tally_company_name  text,
  is_active           boolean NOT NULL DEFAULT false,
  config              jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.tally_org_connector_config IS
  'Phase 4 placeholder: maps organization to connector device and Tally company. Not populated by sync UI.';

ALTER TABLE public.tally_org_connector_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY tally_org_connector_config_admin_select_v1
  ON public.tally_org_connector_config
  FOR SELECT
  TO authenticated
  USING (public.tally_sync_admin_can_view_v1(organization_id));

REVOKE ALL ON public.tally_org_connector_config FROM PUBLIC;
GRANT SELECT ON public.tally_org_connector_config TO authenticated;
GRANT ALL ON public.tally_org_connector_config TO service_role;
