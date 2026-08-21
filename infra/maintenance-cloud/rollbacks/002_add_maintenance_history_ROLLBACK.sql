-- ============================================================================
-- CLOUD MAINTENANCE PROJECT ONLY.
-- DO NOT RUN AGAINST SELF-HOSTED PESOWISE SUPABASE.
--
-- Reverses infra/maintenance-cloud/migrations/002_add_maintenance_history.sql
-- in full. Destructive: drops the maintenance_history table and every row in
-- it — all recorded maintenance occurrence history is permanently lost.
-- maintenance_status and maintenance_admins (from migration 001) are left
-- otherwise intact; only the two lifecycle-pointer columns added by 002 are
-- dropped from maintenance_status.
-- ============================================================================

begin;

drop trigger if exists maintenance_status_history_sync_trigger on public.maintenance_status;
drop function if exists public.maintenance_status_history_sync();

drop policy if exists "history admins can read their authorized environment"
  on public.maintenance_history;

alter table public.maintenance_status
  drop column if exists current_schedule_history_id,
  drop column if exists current_force_history_id;

drop table if exists public.maintenance_history;

alter table public.maintenance_admins
  drop column if exists can_view_history;

commit;
