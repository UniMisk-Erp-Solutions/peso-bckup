# Safe restore — ownership questions (answer before tightening RLS)

Run `290529_1200_safe_grants_rls_urls_after_restore.sql` first. If verification shows **policy_count = 0** on any app table, also run `master_migration/12_fix_all_rls_policies_comprehensive.sql`.

Please confirm these (reply in chat):

## 1. `public.user_roles` (legacy; no `organization_id`)

Current app uses `organization_memberships.role` as source of truth.

- **A)** Keep `user_roles` as legacy read-only per `user_id = auth.uid()` only  
- **B)** Master-admin / service_role only  
- **C)** Drop table usage entirely (policies deny all for authenticated)

## 2. `public.strategies` (global reference; no tenant column)

- **A)** `authenticated` SELECT only (current safe script)  
- **B)** Also allow `anon` SELECT for unauthenticated marketing pages  
- **C)** Master-admin write; everyone else read-only via RLS

## 3. `public.contact_leads` (marketing form)

- **A)** `anon` INSERT only; SELECT/UPDATE/DELETE via `is_master_admin()` (current design)  
- **B)** Disable `anon` entirely (form broken until Edge Function)  
- **C)** `authenticated` INSERT allowed too

## 4. `public.master_admin_memberships`

- **A)** Only rows where `user_id = auth.uid()` AND `is_master_admin()` checks (current migration)  
- **B)** No client access; service_role / SQL only

## 5. `public.locations` vs `engineer_locations`

`locations` has `organization_id` in production schema; old migrations had `USING (true)`.

- **A)** Org-scoped via `organization_memberships` (recommended — in `12_fix`)  
- **B)** Global catalog shared across all tenants

## 6. `receipts` storage bucket `public = true`

Public bucket allows direct URL access without passing RLS API checks.

- **A)** Keep public read URLs; writes only via authenticated org-scoped policies (current)  
- **B)** Set bucket `public = false` and use signed URLs only (more secure; app changes)

## 7. Dev login RPC `list_organizations_for_dev_login()`

Safe script grants `anon` EXECUTE if the function exists.

- **A)** Keep for local/dev  
- **B)** Remove `anon` grant in production (comment out Part 4 dev block)

## 8. Tables added after your backup (May 27 05:30)

If Section 2 migrations are not applied yet, these may be missing policies:

- `expense_batches`, `expense_correction_logs`, `teams`, `team_members`, `organization_features`

Confirm Section 2 + 3 were run, or we generate policies for these in a follow-up file.
