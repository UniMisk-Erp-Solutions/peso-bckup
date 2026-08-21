-- ============================================================================
-- CLOUD MAINTENANCE PROJECT ONLY.
-- DO NOT RUN AGAINST SELF-HOSTED PESOWISE SUPABASE.
--
-- Reverses infra/maintenance-cloud/migrations/001_create_maintenance_control_plane.sql
-- in full. Destructive: drops both tables and all rows in them. There is no
-- PesoWise business data in these tables — only the maintenance-status rows
-- and the admin allow-list — but confirm you intend to remove the maintenance
-- control plane entirely before running this.
-- ============================================================================

begin;

drop trigger if exists maintenance_status_audit_fields on public.maintenance_status;
drop function if exists public.maintenance_status_set_audit_fields();

drop policy if exists "authorized active admins can update their environment" on public.maintenance_status;
drop policy if exists "public can read maintenance status" on public.maintenance_status;
drop policy if exists "self can read own admin row" on public.maintenance_admins;

drop table if exists public.maintenance_status;
drop table if exists public.maintenance_admins;

commit;
