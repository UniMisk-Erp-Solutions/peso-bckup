-- ── PesoWise · Follow-up fix for 20260822120000
-- Migration: 20260822140000_drop_search_five_param_overload.sql
--
-- CREATE OR REPLACE FUNCTION only replaces a function with the IDENTICAL
-- parameter list -- adding a new trailing parameter (p_configured_only)
-- creates a SECOND overload instead of replacing the original, even with a
-- DEFAULT on the new parameter. 20260822120000's CREATE FUNCTION succeeded
-- and IS live, but that left two overloads
-- (...(uuid,uuid,text,integer,integer) and
-- ...(uuid,uuid,text,integer,integer,boolean)), which made the migration's
-- own unqualified `COMMENT ON FUNCTION public.search_form_template_parent_options`
-- ambiguous -- it errored and stopped the script before reaching NOTIFY.
-- All actual RPC calls (which always pass all 6 named parameters) resolve
-- unambiguously to the 6-param overload regardless, so this was never a
-- functional break -- just a dangling redundant overload and a missed
-- comment/schema-reload. This migration drops the superseded 5-param
-- overload (the intent was always to replace, not to add an overload) and
-- finishes what 20260822120000 didn't reach.

DROP FUNCTION IF EXISTS public.search_form_template_parent_options(uuid, uuid, text, integer, integer);

COMMENT ON FUNCTION public.search_form_template_parent_options(uuid, uuid, text, integer, integer, boolean) IS
  'DOC-100 UI-parity fix. Adds an optional p_configured_only filter (default '
  'false, fully backward compatible) for the Dependent Fields left-nav''s '
  '"Configured only" toggle -- still one bounded, indexed, grouped query, '
  'never a full download.';

NOTIFY pgrst, 'reload schema';
