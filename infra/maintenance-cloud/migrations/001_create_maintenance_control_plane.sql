-- ============================================================================
-- CLOUD MAINTENANCE PROJECT ONLY.
-- DO NOT RUN AGAINST SELF-HOSTED PESOWISE SUPABASE.
--
-- Creates the entire maintenance control-plane schema in the SEPARATE
-- Supabase Cloud project described in
-- docs/maintenance/CLOUD_MAINTENANCE_CONTROL_PLANE.md. Contains no PesoWise
-- business data, no PesoWise auth users, no organizations, no expenses.
--
-- See infra/maintenance-cloud/README.md before running this anywhere.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. public.maintenance_status
--
-- Exactly two rows will ever exist in V1: 'preview' and 'production',
-- bootstrapped once by this migration (§8/§20 of the architecture doc). The
-- frontend never INSERTs or DELETEs a row — only UPDATE, and only on the
-- five columns explicitly granted below (§9).
-- ----------------------------------------------------------------------------

create table public.maintenance_status (
  environment        text primary key
                        check (environment in ('preview', 'production')),
  force_maintenance  boolean not null default false,
  title              text,
  message            text,
  starts_at          timestamptz,
  ends_at            timestamptz,
  updated_at         timestamptz not null default now(),
  updated_by         uuid references auth.users(id),

  -- No half-configured window: either neither timestamp is set, or both are
  -- set with a positive duration. A client attempting to set only starts_at
  -- (or only ends_at, or an inverted/zero-length window) is rejected at the
  -- database layer, not merely by client-side validation.
  constraint maintenance_status_window_check
    check (
      (starts_at is null and ends_at is null)
      or (starts_at is not null and ends_at is not null and ends_at > starts_at)
    )
);

comment on table public.maintenance_status is
  'Cloud maintenance control plane — one row per environment (preview/production). '
  'Public information by design (readable by anon): title/message/schedule for the '
  'maintenance banner and blocking screen. Never store sensitive infrastructure '
  'detail in title/message. See docs/maintenance/CLOUD_MAINTENANCE_CONTROL_PLANE.md.';

-- ----------------------------------------------------------------------------
-- 2. public.maintenance_admins
--
-- The authorization allow-list. Having a Cloud Auth account (auth.users row)
-- proves nothing on its own — every RLS policy that allows a write checks
-- this table explicitly. Environment authority (§9 of the architecture doc,
-- the security improvement over the original artifact draft) prevents a
-- Preview-only operator from mutating Production via direct PostgREST calls,
-- even though the UI would never offer them that option.
-- ----------------------------------------------------------------------------

create table public.maintenance_admins (
  user_id                uuid primary key references auth.users(id) on delete cascade,
  is_active              boolean not null default true,
  can_manage_preview     boolean not null default true,
  can_manage_production  boolean not null default false,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

comment on table public.maintenance_admins is
  'Authorization allow-list for the Cloud maintenance control plane. Managed '
  'out-of-band (trusted Cloud project administration) in V1 — no INSERT/UPDATE/'
  'DELETE grant is given to any application role. Not publicly enumerable: no '
  'anon policy at all, and authenticated users may only SELECT their own row.';

-- ----------------------------------------------------------------------------
-- 3. Server-derived audit fields — never client-forged
--
-- The client is never granted UPDATE on updated_at/updated_by (§4 grants
-- below), so it cannot set them directly. This trigger stamps both on every
-- UPDATE regardless, so a write that only specifies e.g. force_maintenance
-- still gets a truthful, server-generated audit trail.
--
-- SECURITY INVOKER (the default — not specified as DEFINER), deliberately:
-- auth.uid() reads the calling role's own JWT claim, which is already
-- available to that role without any elevated privilege, and this trigger
-- does not need to read or write anything the invoking (already
-- RLS-authorized) role could not already read or write itself. There is no
-- privilege-escalation reason to mark this SECURITY DEFINER, so it is not.
-- ----------------------------------------------------------------------------

create function public.maintenance_status_set_audit_fields()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

comment on function public.maintenance_status_set_audit_fields() is
  'Stamps updated_at/updated_by server-side on every maintenance_status UPDATE. '
  'SECURITY INVOKER (default): auth.uid() and now() need no elevated privilege, '
  'and this function touches nothing the invoking RLS-authorized role could not '
  'already touch directly. search_path pinned to empty for safety regardless.';

create trigger maintenance_status_audit_fields
  before update on public.maintenance_status
  for each row
  execute function public.maintenance_status_set_audit_fields();

-- ----------------------------------------------------------------------------
-- 4. Row Level Security + explicit, minimal grants
--
-- Do not rely on permissive default grants — every privilege is stated here.
-- ----------------------------------------------------------------------------

alter table public.maintenance_status enable row level security;
alter table public.maintenance_admins enable row level security;

-- --- maintenance_status -----------------------------------------------------

revoke all on public.maintenance_status from public, anon, authenticated;

-- SELECT: public information by design (§17 of the architecture doc).
grant select on public.maintenance_status to anon, authenticated;

-- UPDATE: column-level grant — the client may write ONLY these five columns.
-- environment/updated_at/updated_by are excluded from this grant entirely,
-- so a client cannot include them in an UPDATE statement at all (a Postgres
-- permission error, not merely an RLS denial) — this is the primary
-- enforcement mechanism for "environment mutation: DENY", independent of and
-- in addition to the RLS policy below.
grant update (force_maintenance, title, message, starts_at, ends_at)
  on public.maintenance_status to authenticated;

-- No INSERT, no DELETE grant to anon or authenticated, ever. The two rows
-- are created once by this migration (§5 below) and never recreated from
-- the frontend.

create policy "public can read maintenance status"
  on public.maintenance_status
  for select
  using (true);

-- Both USING and WITH CHECK, per the environment-authority model: an active
-- admin may UPDATE a row only for an environment they are authorized to
-- manage. WITH CHECK re-validates the same condition against the
-- post-update row — belt-and-suspenders even though environment itself
-- cannot change (blocked by the column grant above), so this stays correct
-- if that constraint is ever loosened.
create policy "authorized active admins can update their environment"
  on public.maintenance_status
  for update
  using (
    exists (
      select 1 from public.maintenance_admins ma
      where ma.user_id = auth.uid()
        and ma.is_active = true
        and (
          (maintenance_status.environment = 'preview' and ma.can_manage_preview = true)
          or (maintenance_status.environment = 'production' and ma.can_manage_production = true)
        )
    )
  )
  with check (
    exists (
      select 1 from public.maintenance_admins ma
      where ma.user_id = auth.uid()
        and ma.is_active = true
        and (
          (maintenance_status.environment = 'preview' and ma.can_manage_preview = true)
          or (maintenance_status.environment = 'production' and ma.can_manage_production = true)
        )
    )
  );

-- --- maintenance_admins ------------------------------------------------------

revoke all on public.maintenance_admins from public, anon, authenticated;

-- No anon access at all — not publicly enumerable.
-- authenticated may SELECT only, restricted by RLS to their own row.
grant select on public.maintenance_admins to authenticated;

-- No INSERT/UPDATE/DELETE grant to any application role. Admin allow-list
-- management is out-of-band (trusted Cloud project administration) in V1 —
-- see infra/maintenance-cloud/README.md.

create policy "self can read own admin row"
  on public.maintenance_admins
  for select
  using (user_id = auth.uid());

-- ----------------------------------------------------------------------------
-- 5. Bootstrap exactly two rows — never created from the frontend.
-- ----------------------------------------------------------------------------

insert into public.maintenance_status (environment, force_maintenance, starts_at, ends_at)
values
  ('preview', false, null, null),
  ('production', false, null, null);

commit;
