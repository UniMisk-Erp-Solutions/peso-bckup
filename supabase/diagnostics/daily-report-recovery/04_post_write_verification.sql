-- Daily Project Report — post-write verification.
-- LAYER 4 of 4. READ-ONLY. Run only after a Layer 3 execution the owner has
-- explicitly chosen to commit. Substitute :organization_id before running.

-- ── A. Re-run Layer 1's tier breakdown -- "submitted_on_expense" should have
-- grown by exactly the number of rows Layer 3 inserted; "unresolved" should
-- have shrunk by the same amount. No other tier should move. ────────────────
-- (Paste 01_read_only_analysis.sql's query A here and diff against its
-- pre-write output.)

-- ── B. Exact rows touched, if a recovered_via tag column exists ────────────
SELECT expense_id, organization_id, branch_field_id, field_value, recovered_via
FROM public.expense_form_field_values
WHERE organization_id = :'organization_id'::uuid
  AND recovered_via = 'daily-report-recovery-2026-08-27'
ORDER BY expense_id;

-- ── C. Cross-organization write check -- must return zero rows always ──────
SELECT count(*) AS cross_org_leak
FROM public.expense_form_field_values
WHERE recovered_via = 'daily-report-recovery-2026-08-27'
  AND organization_id <> :'organization_id'::uuid;

-- ── D. No Class C/D/E/F value was ever written -- every recovered value must
-- still match what the read-time fallback alone would compute today ────────
-- (Re-run 02_prepared_materialization_dry_run.sql's candidate query with the
-- same :organization_id; it should now return zero rows, because every
-- candidate it would have found is already persisted. A non-zero result
-- here after a Layer 3 run indicates either a partial write or new data
-- arriving since -- investigate before assuming success.)
