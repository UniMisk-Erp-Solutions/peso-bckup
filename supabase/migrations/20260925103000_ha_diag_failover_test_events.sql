-- Optional diagnostic table for controlled HA write tests (apply only during approved failover test).
-- Schema: ha_diag — not part of normal app migrations on production unless explicitly approved.

CREATE SCHEMA IF NOT EXISTS ha_diag;

CREATE TABLE IF NOT EXISTS ha_diag.failover_test_events (
  id bigserial PRIMARY KEY,
  event_type text NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE ha_diag.failover_test_events IS 'HA failover write probe only; no financial data';
