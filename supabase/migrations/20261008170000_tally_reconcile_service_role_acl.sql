-- Reconciliation is an audited admin UI operation and must run as the signed-in user.
-- The function validates auth.uid() plus the organization's admin scope; service_role
-- callers do not participate in this flow and must not retain an older broad EXECUTE grant.
BEGIN;

REVOKE ALL ON FUNCTION public.reconcile_tally_delivery_batch_v1(uuid, text, text)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_tally_delivery_batch_v1(uuid, text, text)
  TO authenticated;

COMMIT;
