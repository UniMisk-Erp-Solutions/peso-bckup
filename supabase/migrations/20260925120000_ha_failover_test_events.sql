-- Isolated HA failover diagnostic table (no financial data).
CREATE SCHEMA IF NOT EXISTS ha_diag;

CREATE TABLE IF NOT EXISTS ha_diag.failover_test_events (
  id bigserial PRIMARY KEY,
  operation_id text NOT NULL,
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE ha_diag.failover_test_events IS 'Manual HA rehearsal writes only; not used by application.';

GRANT USAGE ON SCHEMA ha_diag TO postgres, supabase_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON ha_diag.failover_test_events TO postgres, supabase_admin;
