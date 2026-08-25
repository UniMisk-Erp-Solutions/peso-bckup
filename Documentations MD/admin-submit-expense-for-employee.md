# Admin submits an expense on behalf of an employee

**Doc ID:** DOC-107 / DOC-108 / DOC-109 / DOC-110
**Status:** deployed (backup instance) — not applied to Production
**Last updated:** 2026-08-25
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

`290825_1000_org_scoped_audit_logs_select.sql` (DOC-110) — **applied directly
to the backup instance, verified before/after.** `DROP`/`CREATE` on
`audit_logs`' existing SELECT policy; owner/assigned-engineer branches
reproduced unchanged, admin branch now org-scoped via
`organization_memberships` instead of a global `has_role()` check. No new
tables, no new RPCs. Defense in depth — see §4c for why this was confirmed
non-exploitable live even before the fix.

`290825_1100_admin_receipts_storage_insert.sql` (DOC-110) — **applied
directly to the backup instance, verified before/after.** `DROP`/`CREATE` on
`storage.objects`' `receipts_insert_policy`; temp-upload and owner-upload
branches reproduced unchanged, adds a third org-admin `OR` branch mirroring
the `attachments` table's existing admin-bypass policy. This one is a real
fix, not defense-in-depth — the optional attachment feature did not work at
all before it (reproduced the exact RLS failure live, then confirmed it
resolved after applying).

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

## 4b) Org-accurate custom expense fields (DOC-109)

### Problem

Both tabs on this page originally only collected 6 generic fields. But the
employee's own self-submit form (`ExpenseForm.tsx`) supports a full
per-organization custom-field system that admins configure elsewhere: the 6
base fields can be relabeled, hidden, made required, reordered, or turned
into a dropdown with static options (`organization_expense_form_fields`);
extra fields can be assigned to specific categories
(`expense_form_field_templates` + `expense_category_form_fields`, six field
types — text/number/date/textarea/select/checkbox); and a `select` field can
have conditional sub-fields that only appear for a specific chosen option
(`expense_form_field_option_branches`). None of this was visible on this
page — an admin submitting for a MicroLink employee could not record the
required project, which the employee's own form would have demanded.

Real, live severity: **MicroLink** relabels "Destination" to "Customer /
Site Location" as a 2,930-option dropdown, and requires a "Project Unique
ID" select (502 options) on *every* category, which reveals two dependent
branch fields ("Project ID", "Project Name") whose valid values differ for
every one of those 502 projects. **Mistry And Shah** has a similar (messier)
setup. Other orgs use plain defaults.

### Solution

No new SQL migrations. Every table, RPC and validation rule already existed
and was already proven correct by the employee-facing form — the work here
is a second **consumer** of that existing system, not a re-implementation:

- **Single-employee tab**: fetches `organization_expense_form_fields` (base
  overrides) and the selected category's assigned templates/branches,
  exactly mirroring `ExpenseForm.tsx`'s own fetch functions. Renders the 6
  base fields through the existing `BaseExpenseFieldInput` component (which
  already knows how to render a dropdown/number/text override or fall back
  to a default control) and the category's extra fields through the
  existing `CategoryFormFieldsSection` component — the *exact same*
  components the employee's own form renders with, not new UI. Required-ness
  validation before submit reuses the existing `validateVisibleBranchFields`.
- **Bulk CSV/Excel import**: `generateBulkExpenseExcelTemplate.ts` grows
  dynamic columns — the base fields' labels/visibility/required-ness/dropdown
  now come from `organization_expense_form_fields`; one `Field: <name>`
  column per category-assigned template (with a real Excel dropdown for
  `select` types, exactly like the existing Category dropdown); one
  `Branch: <name>` column per **distinct `(parent_template_id, name)`**
  group of conditional branches. `bulkExpenseImportParse.ts` became
  org-config-driven: it recognizes the org's *current* custom base-field
  labels as aliases (not just the English defaults) and dynamically maps
  `Field:`/`Branch:` columns to the org's actual template/branch list.
- **Saving custom-field values, for both tabs**: a *separate* follow-up call
  to the existing `replace_expense_form_field_values` RPC after the base
  expense is created — not a new parameter on `admin_submit_expense_for_employee_v1`
  / `admin_bulk_submit_expenses_v1`. This mirrors the exact pattern
  `ExpenseService.submitExpenseBatch` already uses (create, then separately
  replace custom fields), confirmed correct by reading that RPC's own
  source: its authorization already permits an org admin to write
  custom-field values for *any* expense in their org, not just their own.

### Why collapsing 1,008 raw branch rows to 2 spreadsheet columns is safe

MicroLink's 1,008 `expense_form_field_option_branches` rows are not 1,008
distinct fields — they're 2 field **names** ("Project ID", "Project Name"),
each replicated once per parent project value (~502-506 of them), because
picking a project reveals a project-specific project-ID/name pair. The
roster collapses these to one column per **name** — but keyed on
`(parent_template_id, name)`, not bare name: nothing in the schema
guarantees two branches under *different* parent templates never share a
display name, so a bare-name collapse could silently merge two unrelated
fields. `orgExpenseFieldConfig.ts`'s `groupOptionBranches` detects any such
collision and disambiguates the column header
(`Branch: <parent template> → <name>`) rather than merging silently.

### Why branch columns are plain validated text, not a live cascading dropdown

A true Excel dependent dropdown needs one defined name per parent value —
~500+ for MicroLink — and Excel defined names have real constraints (no
leading digit, no spaces) that raw option values like `"197001M3"` won't
satisfy without lossy sanitizing. Instead, a second **visible** "Reference"
worksheet lists every parent-value → valid-value mapping as a plain,
Ctrl+F-able lookup table (same "extra hidden sheet" mechanism the Category
dropdown already used, just made visible instead of hidden). At import
time, the entered value is still validated against the *exact* branch row
matching that specific row's own parent-field value — an admin who copies
the wrong project's "Project ID" into a row gets rejected with the specific
valid options for the project they actually chose, not silently accepted.

### The historical 1,000-row silent-truncation bug, and how this avoids repeating it

DOC-097 already hit and fixed a bug where an unbounded fetch of
`expense_form_field_option_branches` silently truncated past PostgREST's
default row cap. MicroLink sits at exactly 1,008 raw branch rows — right at
that boundary. `orgExpenseFieldConfig.ts`'s `fetchAllOptionBranches` never
does a single unbounded `select()`; it pages explicitly via `.range()` until
a page returns fewer rows than requested. **Proven, not assumed:**
downloaded the roster, read the "Reference" sheet directly, and counted
**1,009 rows (1,008 data rows + header) — exactly the live count**, with
zero silent loss.

### Known risk, explicitly designed around: two RPC calls, not one transaction

`admin_submit_expense_for_employee_v1` creates the expense as
`status='submitted'` and fires reviewer notifications in the **same
transaction** as creation — before the follow-up custom-field save ever
runs. If that follow-up fails (closed tab, network drop mid-batch), a
required custom field can be **permanently** missing on an already-notified
expense, because `replace_expense_form_field_values` itself never enforces
required-ness server-side. This is the established pattern's known gap
(`ExpenseService.submitExpenseBatch` has the identical gap today), not new.
Mitigation: both tabs surface a **distinct third state** — "expense created,
extra fields failed to save" — with an explicit retry that re-runs *only*
the custom-field save (never re-creates the expense, which would duplicate
it). The single form blocks submitting a new expense until any pending
retry is resolved.

### Verified — real bugs found and fixed during verification

Three real bugs surfaced by end-to-end testing against the live MicroLink
data, all fixed before landing:

1. **i18n namespace mismatch**: `translateBaseFieldConfig`'s internal `t()`
   calls expect `"expenses"` to be the *default* namespace (that's how
   `ExpenseForm.tsx` itself calls it). This page's own `t` defaulted to
   `"admin"`, so every base-field label rendered as a raw
   `"form.fields.category"`-style key instead of "Category". Fixed with a
   namespace-scoped `tExpenses` used only for that call.
2. **Annotation-stripping not applied to base-field headers**: the roster
   generator appends `" (required)"` to every column header, including base
   fields — but the parser's header-matching only stripped that annotation
   for `Field:`/`Branch:` columns, not for base-field aliases. Every
   roster-generated base column (e.g. `"Purpose / Title (required)"`) failed
   to map back on upload. Fixed by applying the same stripping to base-field
   alias matching.
3. **Non-nesting-aware paren stripping**: MicroLink's own category names
   contain parens — e.g. `"Travelling (Public and Private Transport)"` — so
   the generator's `"(for: <category list>)"` annotation is itself nested
   inside parens. A `[^()]*`-style regex can't match across that nesting and
   silently failed to strip anything, so every `Field:` column with a
   category-list annotation failed to map back. Fixed by rewriting
   `stripAnnotations` to track paren depth from the end of the string
   instead of using a flat regex.

End-to-end proof, real browser against the live backup DB, all test data
cleaned up afterward:
- **MicroLink single-employee tab**: selected category "Food", confirmed
  "Project Unique ID" renders (required, all 9 categories); selected project
  `197001M3`; confirmed the "Project ID"/"Project Name" branch dropdowns
  appeared with *exactly* that project's options (`326, 506` /
  `Training, Support`); submitted; read `expense_form_field_values` directly
  and confirmed all three rows (one template, two branches) matched exactly,
  with the branch rows correctly resolved to the specific `branch_field_id`
  for parent value `197001M3`.
- **MicroLink base-field dropdown**: confirmed "Customer / Site Location"
  renders as a real searchable combobox (`role="combobox"`, confirmed via
  DOM inspection, not just a screenshot) sourced from the 2,930 configured
  options, with the custom label — not free text, not "Destination".
- **MicroLink roster generation**: downloaded, unzipped, read the raw XML —
  confirmed genuine `<dataValidation type="list">` on the destination column
  (2,930 options), the category column (9), and the `Field: Project Unique
  ID` column (502) — every count matching the live database exactly. The
  visible "Reference" sheet had 1,009 rows, matching the live 1,008 branch
  rows exactly (see above).
- **Bulk import — correct rejection**: a row with `Project Unique ID =
  197001M3` but `Project ID = 4182` (a value valid for a *different*
  project) was rejected in preview with `"Project ID must be one of: 326,
  506 (for Project Unique ID = 197001M3)"` — not silently accepted.
- **Bulk import — stale value silently dropped**: a row on category "Food"
  (which "To location" is not assigned to) with a value entered in the
  `Field: To location` column imported successfully, and
  `expense_form_field_values` for that expense contained **zero** rows for
  "To location" — confirmed dropped, not validated against the wrong
  category, not silently saved either.
- **Zero-config sanity check (Bikes auto Hero)**: single form renders the
  plain, unmodified 6-field form (default labels, no "Additional
  Information" section); roster has only the base 9 columns and no
  `Field:`/`Branch:` columns, no "Reference" sheet — confirms this is
  additive, not a regression for orgs with nothing configured.
- All test expenses, their `expense_form_field_values` rows, notifications,
  and audit_logs were deleted afterward; both throwaway test admin accounts
  (MicroLink, Bikes auto Hero) were deleted.

### Key files (new/changed for DOC-109)

| File | Purpose |
|---|---|
| `src/lib/orgExpenseFieldConfig.ts` | Fetches an org's full custom-field config (base overrides, category templates, branches), paginated; groups branches into spreadsheet columns |
| `src/pages/AdminSubmitExpense.tsx` | Single-form tab: dynamic base fields via `BaseExpenseFieldInput`, category fields via `CategoryFormFieldsSection`, follow-up custom-field save with retry |
| `src/lib/generateBulkExpenseExcelTemplate.ts` | Roster generator: dynamic `Field:`/`Branch:` columns, dropdowns for select-type fields, visible "Reference" sheet |
| `src/lib/bulkExpenseImportParse.ts` | Org-config-driven header matching and validation, mirroring the live form's own rules |
| `src/components/BulkExpenseImportPanel.tsx` | Fetches field config, wires the follow-up custom-field save (bounded concurrency, reused `runWithConcurrencyLimit`), third results state + retry |
| `src/lib/adminSubmitExpense.ts` | `saveExpenseCustomFields` — the follow-up RPC wrapper |
| `src/lib/expenseCustomFieldFilters.ts` | `runWithConcurrencyLimit` exported (was module-private) for reuse, not duplicated |

Reused as-is, unmodified: `src/lib/expenseFormConfig.ts`,
`src/lib/translateBaseFieldConfig.ts`, `src/components/BaseExpenseFieldInput.tsx`,
`src/components/CategoryFormFieldsSection.tsx`, `src/lib/conditionalFormFields.ts`,
`src/lib/expenseFormFieldPayload.ts`, `src/lib/organizationFeatureKeys.ts`.

---

## 4c) Optional receipt upload, status-choice popup, and submission history (DOC-110)

### What was added

1. **Optional receipt/photo upload**, single-employee tab only. After a successful
   submission, a skippable "optionally attach a receipt" panel renders the existing
   `FileUpload` component (`src/components/FileUpload.tsx`, unmodified) targeting the
   real `expense_id` just created. No temp-upload/finalize plumbing needed — unlike
   the employee's own form (which renders `FileUpload` with `expenseId="new"` before
   the expense exists), the admin flow always has a real UUID by the time this panel
   renders, so `FileUpload` takes its "insert `attachments` immediately" branch.
   Deliberately does **not** route through `ExpenseService.submitExpense`, which
   would incorrectly reintroduce the amount-based attachment requirement that only
   applies to self-submission — this page has never had that gate, by design.
2. **A status-choice popup on submit** (both tabs): instead of always landing on
   `submitted`, the admin picks **Submitted** / **Verified** / **Approved** in a
   dialog (`src/components/SubmitStatusChoiceDialog.tsx`) shown when they click
   Submit/Import. Reuses existing, already-audited methods —
   `ExpenseService.adminVerifyExpense` (was `private`, now exported — body
   unchanged) and `ExpenseService.approveExpense` (already public, the exact method
   the reviewer-queue Approve button calls) — composed client-side via
   `applyAdminSubmitStatusChoice` (`src/lib/adminSubmitExpense.ts`). **Zero new
   status-transition logic and zero new RPCs** for this part; see the sequencing
   and segregation-of-duties notes below for what *is* new.
3. **A "History" tab** on the same page (`src/components/AdminExpenseHistoryTab.tsx`):
   every expense with `created_by_admin_id IS NOT NULL` in this org, paginated,
   showing employee name, admin name, created date+time as **DD-MM-YYYY · h:mm a**,
   title, category, amount, status. Row click opens a detail drawer with the full
   `audit_logs` trail for that expense, reusing the exact same UUID-safety path
   `ExpenseDetail.tsx` already relies on (`enrichAuditLogsWithDisplay` +
   `ExpenseTimeline`) rather than a new component.

### Two real RLS gaps found and fixed during this work (not pre-planned)

Both were found because the new features are the first things in this codebase to
actually exercise the affected code path from an *admin acting on someone else's
expense* — neither was a known, tracked issue beforehand.

1. **`audit_logs` SELECT — cross-org read gap, confirmed pre-existing but
   currently non-exploitable live.** The tracked migration
   (`20251005171552_...sql`) grants admin visibility via a global
   `has_role(auth.uid(), 'admin')` check with no organization boundary at all.
   `expenses` got an equivalent org-scoped fix
   (`20260513150000_org_admin_expense_select_rls.sql`); `audit_logs` never did.
   **Tested directly against the live database before assuming this was
   exploitable**: because `audit_logs`' policy's own `EXISTS` subquery joins
   through `public.expenses`, and the LIVE `expenses` admin SELECT policy
   (`"Admins can view all expenses"`) has *already* been independently
   hotfixed to be org-scoped — not reflected in any tracked migration file,
   consistent with this codebase's established pattern of untracked live
   hotfixes — cross-org `audit_logs` reads are transitively blocked *today*,
   confirmed empirically (0 rows visible cross-org, 49,983 visible same-org,
   both before and after this fix). Applied anyway as **defense in depth**:
   migration `290825_1000_org_scoped_audit_logs_select.sql` makes
   `audit_logs`' own policy text explicitly org-scoped rather than relying on
   an implicit, fragile dependency on a *different* table's policy staying
   correct forever. Owner/assigned-engineer branches reproduced unchanged.
   Verified no regression: same-org visibility unchanged (49,983 rows before
   and after), cross-org still correctly 0.
2. **`storage.objects` (the `receipts` bucket) INSERT — a real, live blocker
   for the attachment feature itself, not defense-in-depth.** The
   `attachments` *table* already has an org-admin INSERT bypass policy
   ("Admins can insert attachments in their org for restore"), but the
   *storage bucket's own* `receipts_insert_policy` never got the equivalent
   branch — its non-temp path requires `e.user_id = auth.uid()`, i.e. the
   uploader must be the expense's owner. Since `FileUpload.tsx` uploads to
   storage **before** inserting the `attachments` row, an admin's upload
   failed at the storage layer with "new row violates row-level security
   policy" — caught live while testing this exact feature, not found by
   inspection. Fixed by migration
   `290825_1100_admin_receipts_storage_insert.sql`, adding a third org-admin
   `OR` branch mirroring the `attachments` table's existing pattern exactly;
   temp-upload and owner-upload branches reproduced unchanged. **Proven,
   not assumed**: reproduced the failure live (screenshot + exact Postgres
   error text), applied the fix, re-tested the same upload — succeeded, and
   confirmed `attachments.uploaded_by` correctly recorded the *admin's* uid,
   not the employee's.

### Sequencing (the review's #1 flagged risk): status transition must never race ahead of the custom-field save

A row's chosen status transition runs **strictly after** its DOC-109 custom-field
save resolves successfully (or had nothing to save) — never concurrently, never
before. A row whose custom-field save fails must never be verified/approved,
because approving incomplete data would still trigger the atomic balance
deduction (`review_approve_expense_v2`).

- **Single-employee tab**: `pendingCustomFieldRetry` (existing DOC-109 state)
  now also carries `desiredStatus`/`statusComment`. If the custom-field save
  fails, the status transition is skipped entirely for that submission; the
  "Retry saving extra fields" button, on success, *then* applies the
  remembered status choice as a follow-up. A separate
  `lastStatusTransitionFailure` state (distinct from the custom-field one)
  covers the narrower case where custom fields saved fine but the status
  transition itself failed — its own retry re-runs only that step.
- **Bulk-import tab**: `runPostCreationPipeline`'s per-row task runs both
  steps **inside the same task**, step 2 strictly gated on step 1's outcome —
  not two passes over the rows, not one concurrent wave mixing both. A row
  failing custom-field save lands in the existing `customFieldFailures`
  bucket with nothing else attempted; a row whose fields saved but status
  transition failed lands in a new `statusTransitionFailures` bucket, whose
  retry explicitly skips re-saving fields that already succeeded
  (`skipCustomFieldSave: true`).
- **Verified live**: reproducing a genuine *server-side* custom-field-save
  failure (as opposed to the client-side required-field check, which
  correctly blocks the status popup from ever opening — verified live,
  screenshot + exact toast text) needs a network-level fault or a
  concurrently-modified template, neither of which is safely reproducible
  against a shared live instance without real risk. That specific gate was
  verified by tracing the exact control flow in both `performSubmit` and
  `runPostCreationPipeline` (status transition is syntactically inside the
  "custom-field save succeeded" branch in both) rather than by forcing a live
  failure — stated plainly rather than overclaimed.

### Segregation of duties (Approved specifically)

The same admin who creates the expense on an employee's behalf can, in the same
popup, also approve it — no independent human review happens at any point. Two
cheap, zero-schema-change mitigations, adopted directly from the design review:

- A non-empty comment is **required** specifically when "Approved" is chosen
  (optional for Verified/Submitted) — comment is already a first-class
  parameter on both reused methods.
- The comment sent to `adminVerifyExpense`/`approveExpense` is always
  prefixed with `"[Admin self-approved own submission-on-behalf-of]"` — the
  admin choosing the status here is always the same admin recorded in
  `created_by_admin_id`. Zero schema change; makes the exact scenario
  greppable in `audit_logs.comment` / visible in the new History detail
  drawer, rather than indistinguishable from an ordinary reviewer approval.
  **Confirmed live** in `expenses.admin_comment` for every Verified/Approved
  test row.

Whether to further *restrict* which admins may choose "Approved" (vs. only
"Verified") is a genuine policy decision, not a code-safety one — left open
per the user's explicit, repeated request for this exact capability; noted
here for whoever owns that policy call later.

### Verified — real browser against the live backup DB (MicroLink), all test data and the throwaway admin cleaned up afterward

- **Approved — the money-movement invariant, the single most important test
  in this whole feature**: submitted an expense for ₹555 with "Approved"
  chosen. Confirmed `expenses.status = 'approved'`, `approved_at` set,
  `admin_comment` carries the self-approval marker + the typed reason;
  `expense_balance_deductions` has exactly one row
  (`balance_before = -6128.00`, `expense_amount = 555.00`,
  `balance_after = -6683.00`); `profiles.balance` for the employee matches
  `balance_after` exactly. Cleaned up and balance restored afterward.
- **Verified**: confirmed `status = 'verified'`, self-approval marker present,
  no balance movement (no `expense_balance_deductions` row).
- **Client-side required-field gate**: left "Project Unique ID" (required on
  every MicroLink category) blank, clicked Submit — the status popup never
  opened; the exact "Project Unique ID is required" validation error showed
  instead. Confirms the popup is unreachable with invalid form data, the
  first line of defense for the sequencing invariant above.
- **Bulk, "Verified" chosen for the whole batch**: two rows, both with
  distinct custom-field values (different Project ID/Project Name pairs for
  the same "Project Unique ID"). Confirmed both landed on
  `status = 'verified'` with the self-approval marker, *and* both rows'
  custom-field values were saved correctly and independently — the two-step
  per-row pipeline runs correctly for a real multi-row batch, not just a
  single row.
- **Attachment**: uploaded a receipt via the optional panel; confirmed
  `attachments.uploaded_by` is the *admin's* uid (not the employee's),
  `storage_path` rooted at the expense's UUID folder (the direct-insert
  path, not the temp path).
- **History tab**: confirmed new admin-submitted rows appear with real
  employee/admin names (not raw UUIDs) in DD-MM-YYYY · h:mm a format; opened
  the detail drawer, confirmed the audit timeline renders via the reused
  `ExpenseTimeline` component.

### Key files (new/changed for DOC-110)

| File | Purpose |
|---|---|
| `src/components/SubmitStatusChoiceDialog.tsx` | Shared status-choice popup, used by both tabs |
| `src/components/AdminExpenseHistoryTab.tsx` | History tab: paginated list + audit-trail detail drawer |
| `src/lib/adminSubmitExpense.ts` | `applyAdminSubmitStatusChoice` — composes the two reused `ExpenseService` methods, builds the self-approval-marker comment |
| `src/services/ExpenseService.ts` | `adminVerifyExpense` exported (was `private`) — body unchanged |
| `src/pages/AdminSubmitExpense.tsx` | Status dialog wiring, sequencing fix on `pendingCustomFieldRetry`, optional attachment panel, History tab entry |
| `src/components/BulkExpenseImportPanel.tsx` | `runPostCreationPipeline` (two-step per-row gate), `statusTransitionFailures` bucket + retry |
| `supabase/migrations/290825_1000_org_scoped_audit_logs_select.sql` | `audit_logs` SELECT admin-branch org-scoping (defense in depth) |
| `supabase/migrations/290825_1100_admin_receipts_storage_insert.sql` | `receipts` bucket admin-upload branch (real fix — the feature did not work without it) |

Reused as-is, unmodified: `src/components/FileUpload.tsx`,
`src/components/ExpenseTimeline.tsx`, `src/lib/auditLogDisplay.ts`,
`src/lib/supabaseInQuery.ts` (`fetchProfileNamesByUserIds`),
`src/lib/expenseCustomFieldFilters.ts` (`runWithConcurrencyLimit`,
`MAX_CUSTOM_FIELD_CONCURRENCY`), `src/lib/approvalHierarchy.ts`
(`isAdminApprovableStatus`).

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
- **DOC-109**: custom-field save is a *separate* RPC call from expense
  creation, not one transaction — a required custom field can be
  permanently missing on an already-created, already-notified expense if
  the follow-up call fails and is never retried. Explicitly designed
  around, not hidden — see §4b's "Known risk" subsection for the mitigation
  (distinct third result state, explicit retry that never re-creates the
  expense).
- **DOC-109**: conditional branch nesting beyond depth 1
  (`parent_branch_id` pointing to another branch, not a template) is
  supported by the schema (`MAX_CONDITIONAL_BRANCH_DEPTH = 3`) but not by
  this feature's spreadsheet column generation or bulk-import validation —
  `fetchAllOptionBranches` only fetches root branches
  (`parent_branch_id IS NULL`). No live organization uses nesting today
  (confirmed directly against the database before implementing), so this is
  a deliberate scope boundary, not an untested edge case silently ignored —
  but if an org configures nested branches in the future, this page's
  bulk-import path will not represent them until extended. The
  single-employee tab is unaffected: it renders `CategoryFormFieldsSection`
  directly, which already supports nesting for the live form.
- **DOC-109**: `ask_once_per_batch` (a category-template flag meaning "ask
  once per interactive batch, apply to every line") has no effect on the
  flat bulk-import spreadsheet — each row already carries its own explicit
  value in its own column, so the data is correct either way; only the
  batch-wizard's "ask once" UX convenience doesn't carry over. Confirmed 11
  live assignments use this flag (mostly MicroLink's "Project Unique ID")
  and verified this doesn't change validation or storage semantics.
- **DOC-110**: creation and the status transition are two separate RPC
  calls, not one transaction — the creation RPC fires reviewer notifications
  in the same transaction as creation, before the follow-up
  verify/approve call ever runs. If that call fails, a chosen "Verified"/
  "Approved" status can remain un-applied on an already-notified expense
  (it stays at `submitted`, not silently wrong-but-terminal) — explicitly
  designed around with the `lastStatusTransitionFailure`/
  `statusTransitionFailures` retry states described in §4c, not hidden.
- **DOC-110**: whether to restrict which admins may choose "Approved" (vs.
  only "Verified", forcing a second person to approve) is an open policy
  question, not a code-safety one — see §4c's segregation-of-duties note.
  Currently any org admin who can reach this page can create-and-approve in
  one action, per the user's explicit request for this exact capability.
- **DOC-110**: a genuine server-side custom-field-save failure (as distinct
  from the client-side required-field check, which is verified live) was
  not reproduced live against the shared backup instance — verified by
  tracing the control flow instead. See §4c's sequencing section for the
  exact reasoning; flagged here so this isn't mistaken for a live-proven
  case elsewhere in this document.
- **DOC-110**: no audit_logs entry is written for an attachment upload
  (true for both this admin flow and the employee's own upload — pre-
  existing, not a regression introduced here). The History tab's detail
  drawer will not show a "receipt attached" line in its timeline.

---

## Revision log

| Date | Change | By |
|---|---|---|
| 2026-08-24 | DOC-107 — admin submit-on-behalf-of-employee feature: migration, RPC (routing engine ported from approvalHierarchy.ts and proven against real data), page, nav entry; verified end-to-end in a real browser session against the backup instance; all test data cleaned up | Claude |
| 2026-08-24 | DOC-108 — bulk CSV/Excel import added to the same page as a second tab; new RPC calls the DOC-107 RPC per row (zero changes to it); proven at 1,000 rows via direct SQL (989/11 split, 7.4s, zero orphaned data) and at 220 rows through the real browser UI (both CSV and .xlsx paths); confirmed the existing `AdminExpenseImportPanel`/`expenseImport.ts` is an unrelated JSON restore tool and left untouched; all test data and the throwaway admin cleaned up | Claude |
| 2026-08-24 | DOC-108 follow-up — added a per-organization pre-filled roster download (.xlsx) with a real Excel dropdown on Category (new `exceljs` dependency, added after asking the user directly since the existing `xlsx` package can only read data validation, not write it); switched the Date column to DD-MM-YYYY per explicit instruction, converted client-side to ISO before the RPC call to avoid Postgres DateStyle ambiguity; proved on the live database that the roster contains zero cross-organization employee data (413/413 name+ID pairs matched MicroLink exactly) and that a day-≤12 date (05-08-2026) resolves correctly to 2026-08-05, not 2026-05-08; unzipped the generated file and confirmed the dropdown's `<dataValidation>` XML is genuinely present | Claude |
| 2026-08-25 | DOC-109 — org-accurate custom expense fields on both tabs: base-field label/visibility/required/dropdown overrides, category-assigned custom fields (all 6 types), and conditional branch fields, reusing the employee self-submit form's own components/RPCs rather than reimplementing them (see §4b); zero new SQL migrations. Found and fixed three real bugs during live verification: an i18n namespace mismatch leaking raw translation keys, missing annotation-stripping on base-field header matching, and a naive paren-stripping regex that broke on category names (e.g. MicroLink's "Travelling (Public and Private Transport)") that are themselves parenthesized. Proved end-to-end against MicroLink's live data: exact single-form + DB parity for a dependent-dropdown chain (Project Unique ID → Project ID/Project Name), a bulk-import row correctly rejected for a branch value from the wrong parent option, a stale wrong-category value correctly and silently dropped, safe pagination proven to recover exactly 1,008/1,008 branch rows (avoiding the DOC-097 1,000-row silent-truncation bug), and a zero-config org (Bikes auto Hero) confirmed completely unaffected. All test data and both throwaway admin accounts cleaned up | Claude |
| 2026-08-25 | DOC-110 — optional receipt upload (single tab, reuses `FileUpload` unmodified, no new RLS needed for the `attachments` table), a status-choice popup on submit (Submitted/Verified/Approved, both tabs) composing two existing `ExpenseService` methods with zero new status-transition logic, and a History tab (paginated admin-submitted-expense list + full audit-trail detail drawer, reusing `ExpenseTimeline`/`enrichAuditLogsWithDisplay`). Found and fixed two real RLS gaps: `audit_logs` SELECT's admin branch was globally unscoped (defense-in-depth fix, confirmed non-exploitable live today because `expenses`' own admin policy was already independently hotfixed to be org-scoped) and the `receipts` storage bucket's INSERT policy had no admin-bypass branch at all — a genuine live blocker for the attachment feature, reproduced with the exact Postgres RLS error before fixing it. Proved the money-movement invariant end-to-end: an "Approved" choice produced the exact atomic balance deduction (`expense_balance_deductions` row + `profiles.balance` matching to the rupee) DOC-089 exists to guarantee; proved the sequencing gate that blocks a required-field-incomplete row from reaching approval (client-side path verified live, server-side path verified by tracing the code, documented honestly as such); proved bulk status choice applies correctly across a real multi-row batch alongside DOC-109's custom-field pipeline. All test data, balance changes, and the throwaway admin cleaned up | Claude |
