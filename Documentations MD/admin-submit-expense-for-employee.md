# Admin submits an expense on behalf of an employee

**Doc ID:** DOC-107
**Status:** deployed (backup instance) — not applied to Production
**Last updated:** 2026-08-24
**Owner / area:** Expenses, Admin Panel, Supabase

---

## 1) Summary

A new admin-only page, **Submit for Employee** (`/admin/submit-expense`), lets
an admin pick any employee (search by name, email, or employee ID) and submit
an expense claim directly on that employee's behalf. No receipt/bill photo is
required regardless of amount — the whole point of the flow is a fast,
attachment-free path for admin-entered claims. The expense lands owned by the
employee, status `submitted`, routed through the exact same review pipeline a
self-submitted expense would use, and the employee's own dashboard updates
live. Every such expense carries a permanent, queryable record of which admin
created it, on top of two audit-log entries readable in the expense's own
timeline.

---

## 2) Problem / requirement

Admins had no way to enter an expense for an employee — e.g. a reimbursement
the employee never filed, or a correction where re-asking the employee to log
in and submit isn't practical. Requirements, verbatim from the request:

- Admin picks the employee via a searchable dropdown (name / email / employee
  ID).
- Admin fills the same core fields the employee's own form collects.
- **No bill-photo upload**, even above the org's normal
  `attachment_required_above_amount` threshold — this rule exists to keep
  employees honest about spend they're personally claiming; it has no purpose
  when an admin is the one entering the data.
- The expense shows up, live, in the employee's own dashboard with correct
  status.
- A history/audit trail must say it was created/submitted **by the admin**,
  not the employee.
- Must not touch any other feature.

---

## 3) Solution

### Why a SECURITY DEFINER RPC, not a plain insert

`expenses`' INSERT RLS policy requires `auth.uid() = user_id`. An admin's own
session can never satisfy that for a row owned by someone else — by design.
`admin_submit_expense_for_employee_v1` does its own authorization instead
(active admin in the target org, target is an active member, not an
accountant-cashier, cashier-submission allowed if applicable), the same
pattern `apply_expense_correction` / `review_admin_verify_expense` already
use in this codebase.

### The hierarchy-routing engine is ported, not reinvented

Which reviewer/tier an expense lands on for self-submission is real,
already-tested business logic in
[`src/lib/approvalHierarchy.ts`](../src/lib/approvalHierarchy.ts)
(`resolveInitialAssignment` / `resolveManagingEngineerId`) plus
`ExpenseService.submitExpense`'s engineer-role special case. Reinventing that
in SQL from scratch would risk silently misrouting an admin-submitted expense
— a correctness bug in the *review pipeline*, not just this feature. The
migration ports every branch line-by-line, each annotated with the exact
`ExpenseService.ts` lines it mirrors, so a future change to the hierarchy
engine has a clear list of what else needs updating.

**Proven, not assumed:** tested against a real employee in the MicroLink org
who already had self-submitted expenses on record. The RPC's output for a new
expense for that same employee — `approval_tier`, `assigned_reviewer_id`,
`assigned_engineer_id` — matched their existing rows **exactly**.

### What's deliberately simplified

The notification *branching* in `submitExpense` (lines 1907–1980) has several
overlapping legacy paths for cosmetic wording. Only what actually drives *who
can act* on the expense — `approval_tier` / `assigned_reviewer_id` /
`assigned_engineer_id` — is ported exactly. The notification target is
simplified to "assigned reviewer, else assigned engineer, else every active
admin" — correct in every case, just without the legacy branch's wording
nuances.

**Out of scope for this version:** dynamic per-category custom form fields.
The picker only fills the universal fields the request described (title,
destination, date, purpose, category, amount).

### Provenance, not just an audit-log string

`expenses.created_by_admin_id` (new column, nullable, FK to `auth.users`) is
the structured source of truth: `NULL` for every self-submitted expense, set
to the admin's id otherwise. This is what makes the fact durable and
queryable, separate from the two `audit_logs` rows (`expense_created`,
`expense_submitted`) whose `user_id` is the admin — both **existing** action
types already rendered by `ExpenseDetail.tsx`'s timeline (`enrichAuditLogsWithDisplay`
resolves `user_id` to a display name generically), so the timeline shows the
admin's name against those two events with no UI change required. The
comment text also spells it out: *"Expense created by admin \<name\> on
behalf of \<employee\>."*

### Live on the employee's dashboard

`Dashboard.tsx` updates live via a Supabase Realtime subscription on
`notifications` filtered to the viewer's own `user_id`. Self-submission never
notifies the submitter about their own action — but here the employee isn't
the actor, so the RPC explicitly inserts a `notifications` row
(`type: 'expense_submitted_by_admin'`) targeted at the employee, on top of
the normal reviewer-facing notification.

---

## 4) Key files touched

| File | Role |
|---|---|
| `supabase/migrations/20260824100000_admin_submit_expense_for_employee.sql` | `created_by_admin_id` column + index; hierarchy-routing SQL port; the RPC |
| `src/lib/adminSubmitExpense.ts` | thin client wrapper around the RPC |
| `src/pages/AdminSubmitExpense.tsx` | the page: employee picker, form, submit |
| `src/App.tsx` | route `/admin/submit-expense`, admin-only |
| `src/components/AppSidebar.tsx` | "Submit for Employee" nav entry |
| `src/locales/{en,hi,gu}/nav.json`, `admin.json` | new translation keys |

No existing file's behavior changed — the four browser-paging queries, review
pipeline, and every other page are untouched.

---

## 5) Database / migrations

`20260824100000_admin_submit_expense_for_employee.sql` — **user runs SQL
manually.**

- `ALTER TABLE expenses ADD COLUMN created_by_admin_id uuid NULL REFERENCES auth.users(id)` + partial index.
- Nine `_admin_submit_*` helper functions (private, no grants) — the
  hierarchy-engine port. Called only by the main RPC.
- `admin_submit_expense_for_employee_v1(p_organization_id, p_employee_id, p_title, p_destination, p_trip_start, p_trip_end, p_category, p_amount, p_purpose)`
  — `SECURITY DEFINER`, granted to `authenticated` (rejects non-admins itself,
  same pattern as `create_expense_report_export_job_v1`).

No changes to `report_export_jobs` or anything from DOC-104/105/106 — this is
a fully independent feature sharing no migration dependency with that work.

---

## 6) Test plan

### Backend — verified directly against the backup database

| Check | Result |
|---|---|
| Routing parity vs. a real employee's existing self-submitted expenses | **Exact match** — `approval_tier`, `assigned_reviewer_id`, `assigned_engineer_id` all identical |
| Non-admin caller | rejected (`42501`) |
| Admin submitting for self | rejected, points to the regular Add Expense page |
| Empty title | rejected |
| Zero/negative amount | rejected |
| Employee not in caller's org | rejected |
| Employee with role `engineer` | routed directly to admin queue (`assigned_engineer_id NULL`), matching `submitExpense`'s engineer branch |
| Audit logs | both rows present, actor = admin, comment names admin and employee |
| Notifications | reviewer/engineer/all-admins fan-out present; separate employee notification present |

### Frontend — real browser, real login, real click-through

No project skill existed for running this app; verified via a Playwright
driver against a live dev server pointed at the backup instance, logged in
through the actual `/auth` login form (not a bypassed session) as a
throwaway test admin created solely for this run.

- Employee search: typing filtered the list live (419 → matching subset);
  selection worked.
- **Confirmed zero file-upload UI anywhere on the page** — `input[type=file]`
  count: 0. The only text match for "attachment/receipt/upload" was the
  page's own explanatory copy, not a control.
- Form filled (title, destination, date, category, purpose, amount `750` —
  above the org's `500` bill-photo threshold) and submitted.
- Success toast appeared; form fully reset afterward (screenshotted both
  states).
- Console errors / network failures on the page itself: **none.** (An
  unrelated `ERR_BLOCKED_BY_ORB` on the organization-logo image is a
  pre-existing header-level issue on every page, not caused by this feature.)
- The resulting `expenses` row was confirmed in the database:
  `status = 'submitted'`, `created_by_admin_id` set, correct amount.

**Cleanup:** every test expense, audit log, notification, and the throwaway
test admin (auth user + profile + membership) were deleted after verification.
Zero trace remains in the backup instance.

Full suite: background run in progress at time of writing; report the result
before this doc is finalized. Expectation, based on the isolated scope of
this change (new files + one new nullable column + new RPC, nothing existing
modified), is no regression.

---

## 7) Known gaps

- **Not applied to Production.** Backup instance only, per explicit
  instruction — this feature was built for `peso-backup.vercel.app`
  evaluation, not for immediate production rollout.
- **No mobile nav entry.** The page is reachable by direct URL on mobile;
  no link was added to `MobileBottomNav.tsx` / `MobileMoreSheet.tsx` to keep
  the change scoped to what was asked.
- **Custom form fields are not collected** by this page (see §3). The
  `replace_expense_form_field_values` RPC already supports an admin-authorized
  path if this is wanted later — it wasn't wired in for this first version.
- A local `.env` now exists in the working tree (gitignored, not committed)
  pointing at the backup Supabase instance, created solely to run the dev
  server for the verification pass above.

---

## Revision log

| Date | Change | By |
|---|---|---|
| 2026-08-24 | DOC-107 — admin submit-on-behalf-of-employee feature: migration, RPC (routing engine ported from approvalHierarchy.ts and proven against real data), page, nav entry; verified end-to-end in a real browser session against the backup instance; all test data cleaned up | Claude |
