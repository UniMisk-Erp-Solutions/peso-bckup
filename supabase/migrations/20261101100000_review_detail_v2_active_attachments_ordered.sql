-- Hotfix hotfix/review-attachment-state-race. NOT APPLIED TO PRODUCTION: prepared for separate approval.
-- get_review_expense_detail_v2: return only active attachments, in a deterministic order.
-- The only change from the live definition is the attachments subquery (deleted_at IS NULL, ORDER BY created_at, id).
-- No live screen calls this function today; this removes the latent soft-deleted-attachment leak before one does.
CREATE OR REPLACE FUNCTION public.get_review_expense_detail_v2(p_organization_id uuid, p_expense_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_out jsonb; v_visible boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '28000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships m
    WHERE m.user_id = auth.uid() AND m.organization_id = p_organization_id AND m.is_active = true
  ) THEN
    RAISE EXCEPTION 'not an active member of this organization' USING ERRCODE = '42501';
  END IF;

  -- Re-check visibility; never trust a client-supplied id.
  SELECT EXISTS (
    SELECT 1 FROM public.expenses e
    WHERE e.id = p_expense_id
      AND e.organization_id = p_organization_id
      AND (e.user_id IN (SELECT v.user_id FROM public.reviewer_visible_user_ids_v2(p_organization_id) v)
        OR e.assigned_engineer_id = auth.uid()
        OR e.assigned_reviewer_id = auth.uid())
  ) INTO v_visible;

  IF NOT v_visible THEN
    RAISE EXCEPTION 'expense not visible to this reviewer' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object(
    'version', 2,
    'expense', to_jsonb(e) ||
       jsonb_build_object('sort_at', COALESCE(e.updated_at, e.created_at, 'epoch'::timestamptz)),
    'submitter', COALESCE((
      SELECT jsonb_build_object('user_id',p.user_id,'name',COALESCE(p.name,'Unknown employee'),
               'email',p.email,'employee_id',p.employee_id,'balance',COALESCE(p.balance,0))
      FROM public.profiles p
      WHERE p.user_id = e.user_id AND p.organization_id = p_organization_id), '{}'::jsonb),
    'custom_fields', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('source',c.source,'field_id',c.field_id,
               'field_key',c.field_key,'label',c.label,'value',c.value))
      FROM (
        SELECT 'template'::text AS source, t.id AS field_id,
               COALESCE(t.field_key,t.id::text) AS field_key,
               COALESCE(t.name,t.field_key) AS label, fv.field_value AS value
        FROM public.expense_form_field_values fv
        JOIN public.expense_form_field_templates t ON t.id = fv.template_id
        WHERE fv.expense_id = e.id AND fv.organization_id = p_organization_id
        UNION ALL
        SELECT 'branch', b.id, COALESCE(b.field_key,b.id::text),
               COALESCE(b.name,b.field_key), fv.field_value
        FROM public.expense_form_field_values fv
        JOIN public.expense_form_field_option_branches b ON b.id = fv.branch_field_id
        WHERE fv.expense_id = e.id AND fv.organization_id = p_organization_id
      ) c), '[]'::jsonb),
    'attachments', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id',a.id,'filename',a.filename,
               'content_type',a.content_type,'file_url',a.file_url)
             ORDER BY a.created_at, a.id)
      FROM public.attachments a WHERE a.expense_id = e.id AND a.deleted_at IS NULL), '[]'::jsonb),
    'timeline', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id',al.id,'action',al.action,
               'comment',al.comment,'user_id',al.user_id,'created_at',al.created_at)
             ORDER BY al.created_at)
      FROM public.audit_logs al WHERE al.expense_id = e.id), '[]'::jsonb),
    'corrections', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id',cl.id,'edited_by',cl.edited_by,
               'reason',cl.reason,'created_at',cl.created_at) ORDER BY cl.created_at DESC)
      FROM public.expense_correction_logs cl
      WHERE cl.expense_id = e.id AND cl.organization_id = p_organization_id), '[]'::jsonb)
  ) INTO v_out
  FROM public.expenses e
  WHERE e.id = p_expense_id;

  RETURN v_out;
END;
$function$
;
