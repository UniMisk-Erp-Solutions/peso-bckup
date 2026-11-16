-- Remove any default or historical broad grants from the quarantine RPC.
-- Access remains available to authenticated users; the function also enforces
-- auth.uid() and the organization-scoped Tally admin authorization helper.
REVOKE ALL ON FUNCTION public.admin_quarantine_tally_delivery_batches_v1(uuid, uuid[], text)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.admin_quarantine_tally_delivery_batches_v1(uuid, uuid[], text)
  TO authenticated;
