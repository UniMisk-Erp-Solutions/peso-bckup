-- DOC-158 forward-fix (security): explicit audit events must not copy a FOREIGN target's identity into the caller's organization.
--
-- record_user_account_audit_event_v1 reads the target snapshot from profiles. For a denied cross-organization attempt the target belongs to
-- another organization, so its name / e-mail / employee id would have been stored in a row readable by the CALLER's administrators.
-- The snapshot now carries identity only when the target is a member of the organization the event is filed under.
-- CREATE OR REPLACE keeps the existing grants (service_role only). Safe to re-run.

BEGIN;

CREATE OR REPLACE FUNCTION public.record_user_account_audit_event_v1(
  p_organization_id uuid, p_target_user_id uuid, p_actor_user_id uuid, p_event_type text, p_source text, p_request_id text,
  p_metadata jsonb DEFAULT NULL, p_field_name text DEFAULT NULL, p_old_value jsonb DEFAULT NULL, p_new_value jsonb DEFAULT NULL,
  p_batch_id text DEFAULT NULL, p_execution_context text DEFAULT 'service_role'
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE p public.profiles%ROWTYPE; s jsonb; v_id uuid := gen_random_uuid(); v_actor_ok boolean; v_in_org boolean;
BEGIN
  IF public._uaa_exec_context() <> 'service_role' THEN RAISE EXCEPTION 'service role only' USING ERRCODE = '42501'; END IF;
  IF p_event_type NOT IN ('password_reset_requested','password_reset_completed','admin_password_reset','password_changed',
        'user_creation_failed','email_change_failed','deactivation_failed','reactivation_failed','password_reset_failed',
        'account_change_denied','auth_ban_failed','auth_unban_failed','auth_sync_recovered','account_identity_changed') THEN
    RAISE EXCEPTION 'event type % is recorded by triggers or is not allowed here', p_event_type;
  END IF;
  IF p_source NOT IN ('user_management','master_admin','bulk_upload','admin_edge_function','auth_admin','auth_recovery','password_reset','account_settings','self_service','system') THEN
    RAISE EXCEPTION 'invalid source';
  END IF;
  IF p_actor_user_id IS NOT NULL THEN
    SELECT EXISTS (SELECT 1 FROM public.profiles WHERE user_id = p_actor_user_id) INTO v_actor_ok;
    IF NOT v_actor_ok THEN RAISE EXCEPTION 'unknown actor' USING ERRCODE = '42501'; END IF;
  END IF;
  SELECT * INTO p FROM public.profiles WHERE user_id = p_target_user_id;
  -- A denial / failure may name a target that is NOT in the organization the row is filed under (a cross-organization attempt).
  -- Never copy such a person's name / e-mail into a row the caller's administrators can read.
  v_in_org := p_organization_id IS NULL
           OR p.organization_id = p_organization_id
           OR EXISTS (SELECT 1 FROM public.organization_memberships WHERE user_id = p_target_user_id AND organization_id = p_organization_id);
  IF v_in_org THEN
    s := jsonb_build_object('name', p.name, 'email', p.email, 'employee_id', p.employee_id,
                            'role', public._uaa_role_of(p_target_user_id, p_organization_id), 'organization_id', COALESCE(p_organization_id, p.organization_id));
  ELSE
    s := jsonb_build_object('target_not_in_organization', true, 'organization_id', p_organization_id);
  END IF;
  INSERT INTO public.user_account_audit_events
    (id, organization_id, target_user_id, actor_user_id, actor_type, event_type, source, request_id, batch_id, field_name,
     old_value, new_value, target_snapshot, actor_snapshot, metadata)
  VALUES
    (v_id, COALESCE(p_organization_id, p.organization_id), p_target_user_id, p_actor_user_id,
     CASE WHEN p_actor_user_id IS NULL THEN 'system' ELSE public._uaa_actor_type(p_actor_user_id, p_organization_id) END,
     p_event_type, p_source, p_request_id, p_batch_id, p_field_name,
     public._uaa_scrub(p_old_value), public._uaa_scrub(p_new_value), public._uaa_scrub(s),
     public._uaa_scrub(public._uaa_actor_snapshot(p_actor_user_id)),
     public._uaa_scrub(COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object('execution_context', p_execution_context)));
  RETURN v_id;
END $$;

COMMIT;
