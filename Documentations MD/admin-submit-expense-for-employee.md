# Admin submits an expense on behalf of an employee

**Doc ID:** DOC-107 / DOC-108
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

The same page's second tab (**DOC-108**) does the same thing at scale: upload
a CSV or Excel file — one row per employee expense — and submit hundreds or
thousands of them in a handful of clicks, each one going through the exact
same routing, audit trail and live-dashboard notification as a single manual
entry. See §4a for the full design and the 1,000-row proof.

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
| `supabase/migrations/20260824140000_admin_bulk_submit_expenses_for_employees.sql` | DOC-108: `admin_bulk_submit_expenses_v1` — calls the RPC above per row |
| `src/lib/bulkExpenseImportParse.ts` | DOC-108: CSV/Excel parsing, header mapping, client-side row validation |
| `src/components/BulkExpenseImportPanel.tsx` | DOC-108: upload → preview → chunked submit → results UI, its own component so it cannot affect the single-employee form |
| `public/templates/bulk-expense-import-template.csv` | DOC-108: downloadable column-format template |
| `src/lib/generateBulkExpenseExcelTemplate.ts` | DOC-108: builds the org-scoped pre-filled roster with a real Excel dropdown, using the new `exceljs` dependency |

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

`20260824140000_admin_bulk_submit_expenses_for_employees.sql` — **user runs
SQL manually, after the migration above.**

- `admin_bulk_submit_expenses_v1(p_organization_id, p_rows jsonb)` —
  `SECURITY DEFINER`, granted to `authenticated`. One upfront admin check
  (avoids N identical "not permitted" errors on a non-admin's whole batch),
  then per-row employee resolution and a per-row call into
  `admin_submit_expense_for_employee_v1`, isolated by `BEGIN/EXCEPTION`.
  Rejects a call with more than 250 rows outright.

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

Full suite (DOC-107): 3,409 passed. 6 failures — the same 5-file pre-existing
baseline (proven unrelated by reverting every change earlier in the session
and re-running to an identical result) plus one already-confirmed-flaky test.
No regression.

---

## 4a) Bulk import — CSV/Excel (DOC-108)

The same page's second tab, **Bulk Import (CSV/Excel)**, submits many
admin-on-behalf-of-employee expenses from one spreadsheet — the scenario
described: an admin with a file of 1,000+ employees, each needing one expense
entered for them.

### Why it calls the existing RPC instead of repeating its logic

`admin_submit_expense_for_employee_v1` (DOC-107) is untouched — not one line
changed. The new function, `admin_bulk_submit_expenses_v1`, loops a `jsonb`
array of rows and calls that existing function once per row, each call
wrapped in its own `BEGIN/EXCEPTION` block. This is the same per-row isolation
pattern already used elsewhere in this codebase by
`save_form_template_parent_option_configurations_batch_atomically`
(`20260822100000_form_template_bulk_batch_operations.sql`): one bad row's
`SQLERRM` is captured and returned as that row's error; every other row in the
batch still commits. Every imported expense gets the identical hierarchy
routing, audit trail and employee notification a single admin-submitted
expense gets, because it *is* the same code path, called in a loop.

### Employee identification, and why ambiguity is a hard error

Each row identifies its employee by **Employee ID** (primary) or **Email**
(fallback) — never by name; `profiles.employee_id` has no `UNIQUE` constraint
on the live schema, so a duplicate is a real possibility, not a theoretical
one. Both existing bulk-import precedents in this codebase
(`expenseImport.ts`, `bulk-users-import`) resolve a duplicate as "last match
wins" and never tell the admin. That is wrong for a payroll-adjacent feature:
zero matches and multiple matches are both treated as a hard per-row error —
"no employee found" / "matches N different people, fix the duplicate" —
never a silent guess.

### Scale, proven not assumed

The request specifically described 1,000+ rows, so that is what was tested,
twice:

1. **1,000 rows via direct SQL** (5 chunks of 200, mixed real employees, with
   11 deliberately invalid rows seeded at predictable positions): **989
   succeeded, 11 failed** — matching the seeded count exactly. Total wall
   time **7.4 seconds**. Every side effect checked: 989 expenses (all
   `status='submitted'`, all `created_by_admin_id` set), exactly 1,978 audit
   log rows (2 per success), exactly 1,978 notifications (reviewer/admin +
   employee, 989 each), and **zero** orphaned rows for any of the 11 failed
   inputs.
2. **220 rows through the real browser UI** (CSV, 4 rows with a missing
   amount caught client-side before submission, 3 rows with an unknown
   employee ID caught server-side): preview correctly showed 216/220 ready;
   results correctly showed 213/216 succeeded, with the exact 3 failing rows
   and their exact server error messages rendered in a results table. A
   6-row **.xlsx** file was also imported through the same UI to prove the
   Excel code path independently of the CSV path — 6/6 succeeded.

Client-side validation catches structural problems (missing required field,
non-`DD-MM-YYYY` date, non-positive amount) before any network call; identity
existence can only be checked server-side, so those rows pass preview and
fail at import with a specific reason — exactly what the 220-row test proved.

### Chunking

The server rejects a single call carrying more than 250 rows
(`admin_bulk_submit_expenses_v1`'s own guard). The client
(`submitBulkExpensesForEmployees` in `src/lib/adminSubmitExpense.ts`) chunks
at 200 rows per call and awaits each chunk before sending the next — a
transient failure only ever affects the one chunk in flight, and the UI's
progress bar advances chunk by chunk.

### Column format

Two downloads sit next to the file picker:

1. **Download template** (`/templates/bulk-expense-import-template.csv`) —
   a static, generic example with two rows demonstrating both identification
   methods. Useful for building a file from scratch or a quick reference.
2. **Download employee roster (.xlsx)** — see below; the primary artifact for
   the 1,000+-employee scenario this feature exists for.

Headers are matched case-insensitively with common aliases (e.g. `Emp ID`,
`Expense Date`, `Vendor / Location` all map correctly) — see
`HEADER_ALIASES` in `src/lib/bulkExpenseImportParse.ts` for the full list.

| Column | Required | Format | Notes |
|---|---|---|---|
| **Employee Name** | — | text | Display only — never validated or sent to the server; present so the admin can visually confirm they're on the right row |
| **Employee ID** | One of Employee ID / Email required | text | Matches `profiles.employee_id` exactly |
| **Employee Email** | — | text | Fallback identifier if Employee ID is blank |
| **Title** | Yes | text | |
| **Destination** | Yes | text | Vendor / location |
| **Date** | Yes | `DD-MM-YYYY` | India-standard, per explicit instruction — e.g. `24-08-2026`. Converted to ISO client-side before the RPC call (see below) |
| **Category** | Yes | text, or pick from the dropdown in the roster file | Must match an active category name in the organization |
| **Amount** | Yes | plain number `> 0` | No currency symbol, no thousands separator (`1250.50`, not `₹1,250.50`) |
| **Purpose** | No | text | |

**Why DD-MM-YYYY is converted to ISO before it ever reaches the RPC, not sent
as-is:** PostgreSQL's date parsing depends on the server's `DateStyle`
setting (default `ISO, MDY`) — a string like `05-08-2026` sent unconverted
would be read as **May 8th**, not August 5th, for any day ≤ 12. The client
(`parseDDMMYYYYToIso` in `bulkExpenseImportParse.ts`) parses and validates
the DD-MM-YYYY text, round-trips it through a real `Date` object to catch
non-existent dates (`31-02-2026` is rejected, not silently rolled over to
March), and only ever sends the RPC an unambiguous `YYYY-MM-DD` string.
**Proven, not assumed:** uploaded a file with `05-08-2026` through the real
browser UI and confirmed the resulting database row's `trip_start` is
`2026-08-05` — exactly right, not `2026-05-08`.

### The pre-filled employee roster and its real Excel dropdown

**Download employee roster (.xlsx)** (`generateBulkExpenseExcelTemplate` in
`src/lib/generateBulkExpenseExcelTemplate.ts`) generates, entirely
client-side, a workbook pre-filled with every employee already loaded for
this page — one row per employee, Name / Employee ID / Email filled in,
the six expense-detail columns left blank for the admin to type into.

**Why `exceljs` was added as a new dependency.** The `xlsx` package already
used elsewhere in this codebase can only *read* Excel data validation, not
write it — confirmed by inspecting the installed 0.18.5 build directly: the
only `dataValidation`-handling code is inside the XML *parser*, with no
corresponding writer path. Writing a genuine dropdown is a paid-tier
SheetJS feature. Asked the user directly rather than silently deciding: add
`exceljs` (a well-established, MIT-licensed library built for exactly this)
versus dropping the dropdown for a plain notes column. Chose `exceljs`.

*Dependency note:* `npm audit` reports one new advisory from this addition
— `exceljs → uuid`, moderate severity, "missing buffer bounds check when a
custom buffer is provided to `uuid.v3/v5/v6`." `exceljs`'s own file-writing
path only calls `uuid.v4()` with no custom buffer, so this specific
advisory's trigger condition isn't reachable through how this feature uses
the library. No non-major-downgrade fix exists yet. Every other
high/critical entry `npm audit` reports (`react-router`, `vitest`, `jspdf`,
`xlsx`, `vite`, `tar`, …) predates this change and is unrelated to it.

**Why the category dropdown references a hidden sheet instead of an inline
list:** Excel's inline `formula1` list is capped at roughly 255 characters
— fine for a handful of categories, but not guaranteed for every
organization. The generator writes a `veryHidden` `Categories` sheet (not
just `hidden` — not reachable via Excel's normal "Unhide Sheet" dialog) and
points the dropdown at that range instead.

**Why this can never mix two organizations' employees.** The generator
function takes `employees: OrganizationUserRow[]` and `categories: string[]`
as plain arguments — it has no concept of "organization" and performs no
query of its own. `AdminSubmitExpense.tsx` passes it the *exact same*
`employees`/`categories` state already loaded via
`fetchOrganizationUsers(organizationId)` for the single-employee tab's
picker on this same page — one org-scoped source of truth, not a second
query that could drift.

**Proven, not assumed — directly on the live multi-tenant database, not
inferred from code review:**
- Downloaded the roster as the MicroLink admin via the real browser, then
  unzipped the resulting file and read its raw XML directly: a genuine
  `<dataValidation type="list">` element, `formula1` = `Categories!$A$1:$A$9`
  (MicroLink's actual category count), covering every data row; the
  `Categories` sheet's `state="veryHidden"` in `workbook.xml`.
- Extracted every (Employee Name, Employee ID) pair from the downloaded
  file and matched it against `profiles` on the live database: **413 of 413
  pairs matched a MicroLink profile exactly; 0 matched any other
  organization.** (An earlier, cruder check — employee_id alone, without the
  name — found 2 coincidental matches in other orgs; `profiles.employee_id`
  has no `UNIQUE` constraint, so the same short ID string can legitimately
  belong to different people in different organizations. That was a
  methodology artifact, not a real leak, and the name+ID pair check that
  replaced it is the correct proof.)
- Identifier coverage: 413 rows had both Employee ID and Email, 11 had Email
  only (employees without an Employee ID) — 0 rows with neither.

### Not touched

`AdminExpenseImportPanel.tsx` / `src/lib/expenseImport.ts` were investigated
and confirmed to be a **separate, unrelated feature** — a JSON backup/restore
tool for expenses that already exist with fixed UUIDs, architecturally
nothing like this one (direct client-side `upsert()`, no hierarchy routing,
no `created_by_admin_id`). Neither that file nor `AdminPanel.tsx` was
modified.

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
- **DOC-108**: no name-based employee matching (Employee ID or Email only) —
  deliberate, per the ambiguity concern in §4a, not an oversight.
- **DOC-108**: custom form fields are not collected here either, same scope
  limit as the single-employee tab.
- **DOC-108**: no per-row supervisor/team preview before import — routing is
  computed at submit time by the same engine the single form uses, but the
  admin cannot see in advance which reviewer a given row will land on.
- **DOC-108**: adds `exceljs` as a new dependency, specifically to write a
  real Excel dropdown (the existing `xlsx` package can only read one — see
  §4a). Introduces one new moderate-severity transitive advisory
  (`exceljs → uuid`) whose trigger condition (`uuid.v3/v5/v6` with a custom
  buffer) isn't reachable through how this feature calls the library — see
  §4a for the full explanation. The user was asked directly and chose this
  over dropping the dropdown.
- **DOC-108**: `fetchOrganizationUsers` (reused, pre-existing, unmodified)
  is not filtered by `organization_memberships.is_active`, so the roster can
  include a small number of employees beyond the org's *active* membership
  count — the same list the employee picker already showed before this
  feature existed. Not a cross-org concern (proven in §4a); noted here only
  because the raw counts don't match at a glance.

---

## Revision log

| Date | Change | By |
|---|---|---|
| 2026-08-24 | DOC-107 — admin submit-on-behalf-of-employee feature: migration, RPC (routing engine ported from approvalHierarchy.ts and proven against real data), page, nav entry; verified end-to-end in a real browser session against the backup instance; all test data cleaned up | Claude |
| 2026-08-24 | DOC-108 — bulk CSV/Excel import added to the same page as a second tab; new RPC calls the DOC-107 RPC per row (zero changes to it); proven at 1,000 rows via direct SQL (989/11 split, 7.4s, zero orphaned data) and at 220 rows through the real browser UI (both CSV and .xlsx paths); confirmed the existing `AdminExpenseImportPanel`/`expenseImport.ts` is an unrelated JSON restore tool and left untouched; all test data and the throwaway admin cleaned up | Claude |
| 2026-08-24 | DOC-108 follow-up — added a per-organization pre-filled roster download (.xlsx) with a real Excel dropdown on Category (new `exceljs` dependency, added after asking the user directly since the existing `xlsx` package can only read data validation, not write it); switched the Date column to DD-MM-YYYY per explicit instruction, converted client-side to ISO before the RPC call to avoid Postgres DateStyle ambiguity; proved on the live database that the roster contains zero cross-organization employee data (413/413 name+ID pairs matched MicroLink exactly) and that a day-≤12 date (05-08-2026) resolves correctly to 2026-08-05, not 2026-05-08; unzipped the generated file and confirmed the dropdown's `<dataValidation>` XML is genuinely present | Claude |
