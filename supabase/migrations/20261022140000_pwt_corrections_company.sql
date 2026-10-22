-- The Corrections list (Admin -> Tally integration) showed several identical "waiting for the connector" rows for one expense (one per Tally company it was
-- synced to). It now also returns the Tally company of each correction and whether that company's connector is online, offline or not paired,
-- so each row says what it is waiting for. Only pwt_list_deletions_v1 is replaced; no table or data changes.
CREATE OR REPLACE FUNCTION public.pwt_list_deletions_v1(p_organization_id uuid, p_limit integer DEFAULT 25) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.pwt_assert_admin_v1(p_organization_id);
  RETURN COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC) FROM (
    SELECT d.id, d.transaction_number, d.voucher_number, d.voucher_date, d.amount, d.employee_ledger, d.status, d.action, d.attempts, d.error,
           d.detected_via, d.reason, d.tally_company, d.created_at, d.completed_at,
           CASE
             WHEN EXISTS (SELECT 1 FROM public.pwt_connectors c WHERE c.organization_id = d.organization_id AND c.tally_company = d.tally_company
                           AND c.status = 'active' AND c.last_seen_at > now() - interval '2 minutes') THEN 'online'
             WHEN EXISTS (SELECT 1 FROM public.pwt_connectors c WHERE c.organization_id = d.organization_id AND c.tally_company = d.tally_company
                           AND c.status = 'active') THEN 'offline'
             ELSE 'none'
           END AS connector
      FROM public.pwt_deletion_jobs d WHERE d.organization_id = p_organization_id
     ORDER BY d.created_at DESC LIMIT LEAST(GREATEST(p_limit, 1), 100)) x), '[]'::jsonb);
END $$;

REVOKE ALL ON FUNCTION public.pwt_list_deletions_v1(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pwt_list_deletions_v1(uuid, integer) TO authenticated;
