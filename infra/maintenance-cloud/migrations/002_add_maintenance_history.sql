-- ============================================================================
-- CLOUD MAINTENANCE PROJECT ONLY.
-- DO NOT RUN AGAINST SELF-HOSTED PESOWISE SUPABASE.
--
-- Adds durable maintenance HISTORY to the Cloud maintenance control plane
-- created by 001_create_maintenance_control_plane.sql. One row per
-- maintenance OCCURRENCE (not a noisy per-poll dump), owner/admin-only,
-- never publicly readable, never directly writable from the browser —
-- every row is created/updated exclusively by a trigger on
-- maintenance_status, in the same transaction as the status mutation that
-- caused it. See docs/maintenance/CLOUD_MAINTENANCE_CONTROL_PLANE.md §36
-- for the full design rationale.
--
-- See infra/maintenance-cloud/README.md before running this anywhere.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. public.maintenance_admins.can_view_history
--
-- Deliberately separate from can_manage_preview/can_manage_production: an
-- operator may be authorized to toggle Preview maintenance without being
-- able to see historical maintenance records at all.
-- ----------------------------------------------------------------------------

alter table public.maintenance_admins
  add column can_view_history boolean not null default false;

comment on column public.maintenance_admins.can_view_history is
  'Separate from can_manage_preview/can_manage_production by design — an '
  'operator may manage maintenance without being authorized to view history.';

-- ----------------------------------------------------------------------------
-- 2. public.maintenance_history
--
-- One row per maintenance OCCURRENCE. Status (Upcoming/Active/Completed/
-- Cancelled for scheduled; Active/Completed for forced) is DERIVED by the
-- reader from these timestamps — no cron job moves a row through states.
-- ----------------------------------------------------------------------------

create table public.maintenance_history (
  id                  uuid primary key default gen_random_uuid(),
  environment         text not null check (environment in ('preview', 'production')),
  kind                text not null check (kind in ('scheduled', 'forced')),

  title               text,
  message             text,

  scheduled_start_at  timestamptz,
  scheduled_end_at    timestamptz,

  actual_started_at   timestamptz,
  actual_ended_at     timestamptz,

  cancelled_at        timestamptz,

  created_at          timestamptz not null default now(),
  created_by          uuid references auth.users(id),

  updated_at          timestamptz not null default now(),
  updated_by          uuid references auth.users(id),

  -- A scheduled occurrence always carries its window; a forced occurrence
  -- always carries when it actually started. Mirrors the maintenance_status
  -- window constraint's own discipline against half-configured state.
  constraint maintenance_history_scheduled_requires_window
    check (
      kind <> 'scheduled'
      or (scheduled_start_at is not null and scheduled_end_at is not null
          and scheduled_end_at > scheduled_start_at)
    ),
  constraint maintenance_history_forced_requires_start
    check (kind <> 'forced' or actual_started_at is not null)
);

comment on table public.maintenance_history is
  'Durable maintenance occurrence history — owner/admin-only, never publicly '
  'readable. One row per occurrence; status is DERIVED (see the frontend '
  'maintenanceHistoryDerivedStatus module), never stored. Written exclusively '
  'by maintenance_status_history_sync() — no application role has a direct '
  'INSERT/UPDATE/DELETE grant on this table. History tracking begins from '
  'this migration''s deployment; nothing before it is backfilled.';

create index maintenance_history_environment_created_at_idx
  on public.maintenance_history (environment, created_at desc);

-- ----------------------------------------------------------------------------
-- 3. public.maintenance_status.current_schedule_history_id /
--    current_force_history_id
--
-- Server-managed lifecycle-grouping pointers. Never in the frontend's
-- writable column grant (unchanged from migration 001 — this migration adds
-- no new columns to that grant) and never selected by the public read query
-- (src/integrations/maintenance-cloud/maintenanceStatusService.ts uses an
-- explicit column list, not select *).
-- ----------------------------------------------------------------------------

alter table public.maintenance_status
  add column current_schedule_history_id uuid references public.maintenance_history(id),
  add column current_force_history_id    uuid references public.maintenance_history(id);

comment on column public.maintenance_status.current_schedule_history_id is
  'Server-managed only — set/cleared exclusively by maintenance_status_history_sync(). '
  'Never in the frontend UPDATE grant, never needed by the public read query.';
comment on column public.maintenance_status.current_force_history_id is
  'Server-managed only — set/cleared exclusively by maintenance_status_history_sync(). '
  'Never in the frontend UPDATE grant, never needed by the public read query.';

-- ----------------------------------------------------------------------------
-- 4. maintenance_status_history_sync() — the atomic lifecycle trigger
--
-- BEFORE UPDATE so it can set NEW.current_schedule_history_id /
-- current_force_history_id before the row is written, in the SAME
-- transaction as the status mutation that caused it — there is no
-- separate "update status, then insert history" round trip for a client
-- to fail halfway through.
--
-- SECURITY DEFINER is required and deliberate: application roles have no
-- direct INSERT/UPDATE grant on maintenance_history (§6 below) by design —
-- history must be unforgeable via a direct PostgREST call. This function is
-- the ONLY path that can write it. Justified narrowly:
--   - fixed `search_path = ''` and every object schema-qualified (public.*),
--     so it cannot be tricked into resolving an attacker-controlled object;
--   - takes no client-supplied parameters — OLD/NEW come from the trigger
--     context, already constrained by maintenance_status's own column-level
--     UPDATE grant and its RLS policy (an environment-unauthorized or
--     inactive admin's UPDATE is already denied before this trigger ever
--     fires, so by the time it runs the caller is already a legitimate,
--     environment-authorized active admin);
--   - performs only hardcoded INSERT/UPDATE statements against the single
--     maintenance_history table — no dynamic SQL, nothing caller-directed;
--   - actor identity (created_by/updated_by) and timestamps
--     (actual_started_at/actual_ended_at/cancelled_at) are always
--     server-derived (auth.uid()/now()) here, never taken from NEW —
--     the client cannot forge them even indirectly through this function;
--   - EXECUTE is revoked from PUBLIC/anon/authenticated below — it can only
--     ever run as a trigger, never called directly.
-- ----------------------------------------------------------------------------

create function public.maintenance_status_history_sync()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_actor uuid := auth.uid();
  v_new_schedule_id uuid;
  v_new_force_id uuid;
  v_schedule_link_open boolean;
begin
  -- A linked schedule is only still "open" for in-place editing if it has
  -- not itself already naturally expired — an expired-but-still-linked
  -- schedule must never be silently overwritten by a brand new one (owner
  -- requirement: "AFTER EXPIRED SCHEDULE, OWNER CREATES NEW SCHEDULE ->
  -- Create a NEW history row. Never mutate the old completed history
  -- record."). No DB cron clears this pointer on expiry — this check is
  -- how the trigger itself stays correct without one.
  v_schedule_link_open := (
    old.current_schedule_history_id is not null
    and old.starts_at is not null
    and old.ends_at is not null
    and old.ends_at > v_now
  );

  -- ===== SCHEDULED LIFECYCLE =====
  if new.starts_at is not null and new.ends_at is not null then
    if v_schedule_link_open then
      if new.title is distinct from old.title
         or new.message is distinct from old.message
         or new.starts_at is distinct from old.starts_at
         or new.ends_at is distinct from old.ends_at
      then
        -- Same upcoming/active occurrence, edited in place — never a
        -- duplicate row just because the owner fixed a typo.
        update public.maintenance_history
        set title = new.title,
            message = new.message,
            scheduled_start_at = new.starts_at,
            scheduled_end_at = new.ends_at,
            updated_at = v_now,
            updated_by = v_actor
        where id = old.current_schedule_history_id;
      end if;
      -- new.current_schedule_history_id already carries old's value forward
      -- (the client never sets this column) — nothing to change.
    else
      insert into public.maintenance_history
        (environment, kind, title, message, scheduled_start_at, scheduled_end_at, created_by, updated_by)
      values
        (new.environment, 'scheduled', new.title, new.message, new.starts_at, new.ends_at, v_actor, v_actor)
      returning id into v_new_schedule_id;
      new.current_schedule_history_id := v_new_schedule_id;
    end if;
  else
    -- NEW carries no schedule window.
    if v_schedule_link_open then
      -- An upcoming/active schedule is being explicitly cleared: Cancelled.
      update public.maintenance_history
      set cancelled_at = v_now,
          updated_at = v_now,
          updated_by = v_actor
      where id = old.current_schedule_history_id;
      new.current_schedule_history_id := null;
    elsif old.current_schedule_history_id is not null then
      -- Pointer was already stale (naturally expired/completed) — detach it
      -- without touching the completed history record itself.
      new.current_schedule_history_id := null;
    end if;
  end if;

  -- ===== FORCED LIFECYCLE =====
  if new.force_maintenance then
    if old.force_maintenance and old.current_force_history_id is not null then
      if new.title is distinct from old.title or new.message is distinct from old.message then
        update public.maintenance_history
        set title = new.title,
            message = new.message,
            updated_at = v_now,
            updated_by = v_actor
        where id = old.current_force_history_id;
      end if;
    else
      insert into public.maintenance_history
        (environment, kind, title, message, actual_started_at, created_by, updated_by)
      values
        (new.environment, 'forced', new.title, new.message, v_now, v_actor, v_actor)
      returning id into v_new_force_id;
      new.current_force_history_id := v_new_force_id;
    end if;
  else
    if old.force_maintenance and old.current_force_history_id is not null then
      update public.maintenance_history
      set actual_ended_at = v_now,
          updated_at = v_now,
          updated_by = v_actor
      where id = old.current_force_history_id;
      new.current_force_history_id := null;
    end if;
  end if;

  return new;
end;
$$;

comment on function public.maintenance_status_history_sync() is
  'SECURITY DEFINER: the only path that may write maintenance_history — no '
  'application role has a direct grant on that table. Takes no client input '
  'beyond the already-RLS-authorized NEW/OLD trigger row; actor/timestamps '
  'are always server-derived. See the migration file for the full '
  'justification. EXECUTE is revoked from PUBLIC/anon/authenticated below.';

create trigger maintenance_status_history_sync_trigger
  before update on public.maintenance_status
  for each row
  execute function public.maintenance_status_history_sync();

revoke execute on function public.maintenance_status_history_sync() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 5. Row Level Security + explicit, minimal grants for maintenance_history
--
-- anon: zero access, no policy at all.
-- authenticated non-admin, or admin without can_view_history: zero access.
-- active admin with can_view_history=true: SELECT only, only for
--   environments they are separately authorized to manage (preview needs
--   can_manage_preview, production needs can_manage_production) — reuses
--   the exact environment-authority pattern from migration 001's
--   maintenance_status UPDATE policy.
-- No INSERT/UPDATE/DELETE grant to any application role, ever — only the
--   SECURITY DEFINER trigger above can write.
-- ----------------------------------------------------------------------------

alter table public.maintenance_history enable row level security;

revoke all on public.maintenance_history from public, anon, authenticated;

grant select on public.maintenance_history to authenticated;

create policy "history admins can read their authorized environment"
  on public.maintenance_history
  for select
  using (
    exists (
      select 1 from public.maintenance_admins ma
      where ma.user_id = auth.uid()
        and ma.is_active = true
        and ma.can_view_history = true
        and (
          (maintenance_history.environment = 'preview' and ma.can_manage_preview = true)
          or (maintenance_history.environment = 'production' and ma.can_manage_production = true)
        )
    )
  );

commit;
