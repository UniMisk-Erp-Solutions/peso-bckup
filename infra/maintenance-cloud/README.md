# ⚠️ CLOUD MAINTENANCE PROJECT ONLY — DO NOT RUN AGAINST SELF-HOSTED PESOWISE SUPABASE

**Everything under `infra/maintenance-cloud/` targets a SEPARATE, independent
Supabase Cloud project — created and used ONLY for the maintenance control
plane described in
[`docs/maintenance/CLOUD_MAINTENANCE_CONTROL_PLANE.md`](../../docs/maintenance/CLOUD_MAINTENANCE_CONTROL_PLANE.md).**

- **Do NOT** run any file here against the self-hosted PesoWise Supabase
  project (the one `VITE_SUPABASE_URL` / `supabase/migrations/` point at).
- **Do NOT** move, copy, or symlink any file here into `supabase/migrations/`.
  That directory belongs to the self-hosted PesoWise database and is scanned
  by `npm run migrations:check` for that project specifically — mixing in
  Cloud-only SQL would corrupt that tooling's assumptions.
- This SQL contains **no PesoWise business data, no PesoWise auth users, no
  organizations, no expenses** — nothing about the normal application. It
  defines exactly two small tables used to answer one question: "is
  PesoWise in maintenance?"

---

## What's here

```
infra/maintenance-cloud/
  README.md                                          (this file)
  SECURITY_TEST_CHECKLIST.sql                        RLS/grants proof, read-only-safe (BEGIN...ROLLBACK)
  migrations/
    001_create_maintenance_control_plane.sql          apply to the Cloud project
  rollbacks/
    001_create_maintenance_control_plane_ROLLBACK.sql  reverses the above
```

## How to apply (manual, via the Cloud project's own SQL editor or psql)

1. Open the **Supabase Cloud project's** SQL editor (or connect via `psql`
   using **that project's** connection string — never the self-hosted one).
2. Run `migrations/001_create_maintenance_control_plane.sql` in full.
3. Confirm the two bootstrap rows exist:
   ```sql
   select environment, force_maintenance, starts_at, ends_at from public.maintenance_status;
   -- expect exactly: preview | false | null | null
   --                 production | false | null | null
   ```
4. Follow the read-only-safe security checks in
   [`SECURITY_TEST_CHECKLIST.sql`](./SECURITY_TEST_CHECKLIST.sql) before trusting
   this project in any deployment.

To reverse: run `rollbacks/001_create_maintenance_control_plane_ROLLBACK.sql`
against the **same Cloud project**.

## Public sign-up policy (manual Cloud project setup — do this once)

This Cloud project is **not** a public user-auth system. It exists only to
authenticate a short, deliberately small list of maintenance operators.

- Create maintenance-admin Auth users **deliberately**, one at a time, via
  the Supabase Cloud Dashboard (Authentication → Users → Add user) or the
  Cloud project's own Auth API — never through a public sign-up form.
- **Disable public/self-service sign-ups** after bootstrapping the first
  admin: Supabase Dashboard → Authentication → Providers → Email →
  disable "Allow new users to sign up" (and leave every other provider
  disabled unless a specific need arises).
- **No PesoWise employees are copied here.** This project has zero
  knowledge of the self-hosted PesoWise `profiles`/`organization_memberships`
  tables.
- **No Cloud Auth account becomes a maintenance admin automatically.**
  Having an account in this project's `auth.users` proves nothing on its
  own — RLS on `public.maintenance_status` only grants `UPDATE` to a user
  with a matching, `is_active = true` row in `public.maintenance_admins`
  (inserted manually, out-of-band, by a trusted project administrator — see
  the owner setup package in the implementation report for the exact SQL).
  **RLS remains authoritative even if a non-admin Cloud Auth account somehow
  exists** — a signed-in-but-unlisted user can `SELECT` (the row is public
  information by design, §17 of the architecture doc) but can never
  `UPDATE`, `INSERT`, or `DELETE`.
