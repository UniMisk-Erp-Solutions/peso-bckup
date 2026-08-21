-- ── PesoWise · Security hardening: close a defense-in-depth gap on every
-- ── admin-only Form Field Template RPC
-- Migration: 20260822150000_revoke_anon_from_admin_form_template_rpcs.sql
--
-- Discovered while applying this session's migrations: this database has a
-- default-privileges rule that automatically grants EXECUTE on every newly
-- created function in the public schema to anon/authenticated/service_role
-- (a standard self-hosted Supabase convention). Every admin-only RPC's own
-- migration only ever did `REVOKE ALL ... FROM PUBLIC` -- which revokes the
-- PUBLIC pseudo-role's blanket grant, but NOT the specific per-role grant
-- that default privileges applies directly to `anon` at CREATE time. The
-- result: `anon` has raw EXECUTE at the database ACL level on every admin
-- Form Field Template RPC, going back to functions created in earlier
-- phases of this project, not just this session's.
--
-- This was NOT an active data-exposure vulnerability -- every one of these
-- functions independently checks `role = 'admin'` against
-- organization_memberships keyed on auth.uid(), which is NULL for an
-- unauthenticated (anon) caller, so the in-function check already rejects
-- every anon call with "Permission denied". But relying solely on an
-- in-function check instead of also closing the outer grant is exactly the
-- kind of gap defense-in-depth exists to catch, and Part 34 of this
-- feature's own spec was explicit: "admin RPCs admin-only+same-org... no
-- PUBLIC, no anon." This migration makes that true at the grant level too,
-- for every currently-affected function -- including the two save RPCs
-- from the ORIGINAL (pre-this-session) DOC-097 work, since they have the
-- identical gap.

REVOKE ALL ON FUNCTION public.create_form_template_parent_option(uuid, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.delete_form_template_parent_option(uuid, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_form_template_editor_summary(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_form_template_legacy_orphan_groups(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_form_template_parent_option_configuration(uuid, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_form_template_parent_option_configurations_batch(uuid, uuid, text[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rename_form_template_parent_option(uuid, uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.save_form_template_parent_options_batch_atomically(uuid, uuid, text[], jsonb, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.search_form_template_parent_options(uuid, uuid, text, integer, integer, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.save_parent_option_branch_configuration_atomically(uuid, uuid, text, text, jsonb, text, text) FROM PUBLIC, anon;

-- V1 whole-template save (still used for brand-new templates) -- same gap,
-- same fix. Signature verified live via \df before writing this.
REVOKE ALL ON FUNCTION public.save_option_branch_configuration_atomically(uuid, uuid, timestamp with time zone, jsonb, jsonb, text, text) FROM PUBLIC, anon;

-- Re-affirm the intended grant explicitly on every one of them (harmless if
-- already present -- GRANT is idempotent).
GRANT EXECUTE ON FUNCTION public.create_form_template_parent_option(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_form_template_parent_option(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_form_template_editor_summary(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_form_template_legacy_orphan_groups(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_form_template_parent_option_configuration(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_form_template_parent_option_configurations_batch(uuid, uuid, text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rename_form_template_parent_option(uuid, uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_form_template_parent_options_batch_atomically(uuid, uuid, text[], jsonb, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.search_form_template_parent_options(uuid, uuid, text, integer, integer, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_parent_option_branch_configuration_atomically(uuid, uuid, text, text, jsonb, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_option_branch_configuration_atomically(uuid, uuid, timestamp with time zone, jsonb, jsonb, text, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
