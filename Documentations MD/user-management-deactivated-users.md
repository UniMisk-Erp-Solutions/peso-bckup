# DOC-153 — User Management: deactivated users were invisible

Last updated: 2026-10-21

## Summary
User Management -> Deactivated (and the deactivated rows in All) showed "No users match your search" for Patidar Travels although the organisation has deactivated members.

## Production evidence (read-only, Patidar Travels)
19 memberships: 17 active, 2 deactivated (both engineers: one with a balance, none with a team or supervisor). 18 profiles in the org (16 active / 2 inactive). Both deactivated members are auth-banned. No membership/auth/profile state mismatches, no duplicate memberships. One ACTIVE employee has a profile whose `organization_id` is NULL, so the page cannot list them in any tab (data issue, not modified here).

## Source of truth
`organization_memberships.is_active` is authoritative: it gates access and seat counting, and the `admin-set-user-auth-status` edge function re-reads it before banning/unbanning. `profiles.is_active` / `deactivated_at` and `auth.users.banned_until` are kept in step by `deactivate_organization_member_v2` / `reactivate_organization_member_v1` and the edge function. REMOVED = no membership row. The UI treats a user as deactivated if EITHER membership or profile says inactive.

## Root cause
`fetchUserManagementList` kept only profiles that had an entry in a role map built from `organization_memberships ... .eq("is_active", true)` (`fetchOrgMembershipRolesMap`, also cached by the page via `useOrgMembershipRoles`). A deactivated member has an inactive membership, so it was dropped before the Active / Deactivated / All filter ran. The tab filter was correct; the data never reached it.

## Fix
- `fetchOrgMembershipStateMap`: all memberships of the org with `{role, is_active}`.
- `fetchUserManagementList`: lists profiles that have ANY membership row in this org; `is_active` = membership active AND profile not inactive; role from the membership. No inner joins on team/supervisor/balance (profiles are the base rows).
- `matchesUserStatus`: the single status rule; applied BEFORE pagination (the whole list is loaded once, then filtered, then paged).
- Tab labels show counts: Active (N) / Deactivated (N) / All (N).

## Reactivation and sole-admin (rolled-back Production tests on the QA org)
Same membership row, role, balance, supervisor, teams, profile count and expenses preserved. A deactivated admin is not counted as an active admin; the last active admin cannot be deactivated (self-deactivation refused, guard under advisory lock in `deactivate_organization_member`); reactivated admin keeps the admin role.

## Key files
`src/lib/orgUsers.ts`, `src/pages/UserManagement.tsx`, `src/lib/__tests__/userManagementStatusList.test.ts`.

## Database
None. (Console fixes: `20261027100000_profiles_notification_settings_v1.sql`, applied to Production 2026-10-21.)

## Revision log
| Date | Rev | Change | By |
|------|-----|--------|----|
| 2026-10-21 | 1.0 | Root cause, fix, tests. | Claude Code |
