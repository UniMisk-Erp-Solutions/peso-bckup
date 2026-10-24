-- Tally History: the job list also returns the balance import batch each Sync from Tally created (and its status),
-- so the screen can show per-employee rows and offer "Reverse import" like Import History. Read-only, additive.
CREATE OR REPLACE FUNCTION public.pwt_inbound_list_jobs_v1(p_organization_id uuid, p_limit integer DEFAULT 10) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.pwt_assert_admin_v1(p_organization_id);
  RETURN COALESCE((SELECT jsonb_agg(to_jsonb(j) ORDER BY j.created_at DESC) FROM (
    SELECT pj.id, pj.status, pj.tally_company, pj.created_at, pj.completed_at, pj.vouchers_fetched, pj.imported_count, pj.already_imported_count,
           pj.skipped_count, pj.unmatched_count, pj.failed_count, pj.flagged_count, pj.imported_amount, pj.progress_current, pj.progress_total, pj.error,
           pj.batch_id, b.status AS batch_status
      FROM public.pwt_inbound_jobs pj
      LEFT JOIN public.balance_import_batches b ON b.id = pj.batch_id
     WHERE pj.organization_id = p_organization_id
     ORDER BY pj.created_at DESC LIMIT LEAST(GREATEST(p_limit, 1), 50)) j), '[]'::jsonb);
END $$;
