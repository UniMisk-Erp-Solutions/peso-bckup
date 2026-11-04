# Scoped report access: self + team reports with server-derived scope (DOC-147)

**Last updated:** 2026-10-15 · **Status:** in progress (migration not yet applied to Production) · **Branch:** `feature/self-team-reports-secure-scope` · Related: DOC-048 (Team Reports)

## Summary
- **Team Reports** (managers, team leaders, executives) now always contains the caller's **own** expenses plus the employees they are authorized to manage. A manager with zero team members sees their own reports; the "No team members found" dead end is removed.
- **My Reports** (`/my-reports`, employees) reuses the existing Reports page, self-only, Detailed Expense (and Daily Project when `daily_project_expense_report` is on). Verification/Approval tabs are hidden.
- Report scope is **derived server-side from `auth.uid()`**; browser-supplied user ids can only narrow it.
- Gated by the existing `teams_enabled` flag. `approval_hierarchy` is NOT required or changed.

## Security problem fixed
`get_team_expenses_for_members` (SECURITY DEFINER) and `get_expense_submitter_profiles` trusted a client user-id array and were executable by `anon`; the daily-project and export-job RPCs authorized the caller's role but trusted `p_user_ids`/`filters.user_ids` (and `NULL` meant org-wide in team mode). Any caller could request any employee.

## Server design (migration `20261019100000_secure_report_scope_v1.sql`)
`get_my_report_scope_v1(org)` returns, for the caller:
| Role | Scope |
|---|---|
| employee / cashier / other member | self |
| manager (engineer), team leader, executive | self + members of formal teams they lead (when `teams_enabled`) + reporting-chain subordinates (when `teams_enabled` or `approval_hierarchy`) |
| admin | every profile in the organization (existing Admin Reports path unchanged) |
| not an active member of the org | empty |

Hardened (same signatures, CREATE OR REPLACE): `get_team_expenses_for_members`, `get_expense_submitter_profiles` (caller must be an org member; ids must belong to the org), `get_daily_project_report_page_v1`, `create_daily_project_report_export_job_v1`, `create_expense_report_export_job_v1` (employees: detailed report types only; requested ids intersected; out-of-scope request raises 42501), `daily_report_caller_can_view_v1` (employee allowed only in team-scoped mode with `teams_enabled`). Grants: `PUBLIC` and `anon` revoked, `authenticated` + `service_role` granted.

## Tab semantics
| Tab | Employee | Manager / TL / Executive | Admin |
|---|---|---|---|
| Detailed Expense | own only | self + authorized team | org-wide (unchanged) |
| Daily Project | own only, if flag on | self + team, if flag on | org-wide (unchanged) |
| Claim Verification List | hidden | team-scoped (as before) | unchanged |
| Claim Approval List | hidden | team-scoped (as before) | unchanged |

## Approval workflow impact (important)
`_expense_resolve_routing_v1` reads `teams_enabled` and **uses `teams`/`team_members` to pick reviewers for new submissions**. So configuring Patidar teams in My Teams changes who reviews those employees' future expenses. This change does not create teams or set `reporting_engineer_id`; reports do not depend on either. Configure teams deliberately.

## Verification
- Throwaway-Postgres behavioural tests (`supabase/tests/report_scope/`): 30 cases PASS, including employee own/coworker/other-org, manager self/direct report/unrelated/other-org, zero-member manager, formal-team manager, MicroLink-style recursive chain, TL/executive, admin, daily-report and export-job tampering, anon revoked.
- Vitest: `teamReportsScope`, `secureReportScopeMigration`; full suite 282 files / 4,820 tests; 0 new TypeScript errors vs main (620 = 620); build, `migrations:check`, `security:secrets` pass.
- Not run: against the real Production database (test harness mirrors the objects; the migration must be applied by an operator, then re-check with a real Patidar manager and employee).

## MicroLink
MicroLink managers keep the same reportees as before and additionally see their own expenses (the intended business rule). Recursive chain and formal-team logic are the same sources as My Teams. `teams_enabled` is not set for MicroLink, so MicroLink employees do not get the My Reports link.

## View Report (preview) for scoped users
Preview and history RPCs now also allow a scoped user to read **their own** generated reports (migration `20261020100000_report_view_for_scoped_users_v1.sql`). Details and tests: `detailed-expense-report-preview.md` §9h.

## Revision log
| Date | Change | By |
|---|---|---|
| 2026-10-15 | Initial implementation: scope RPC, hardened report RPCs, Team Reports self + team, My Reports. | Claude Code |
| 2026-10-15 | Added View Report authorization migration reference. | Claude Code |
