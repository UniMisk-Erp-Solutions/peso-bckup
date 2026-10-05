# Organization-Level Mandatory Expense Fields

**Doc ID:** DOC-119
**Status:** deployed *(both invariants live in Production 2026-09-07)*
**Last updated:** 2026-09-07
**Owner / area:** Expenses — submission integrity / Supabase

> DOC-118 is reserved by an unmerged branch (`docs/fix-needed-hierarchy-verified-deadend`).
> This document takes DOC-119 to avoid a collision.

---

## 1) Summary

DOC-117 made the database refuse a submission whose **category form configuration**
is incomplete. This adds a second, independent guarantee: an **organization** can
declare that a form field is mandatory on **every** one of its expenses — every
category, including categories created later — and the database enforces that on
any transition into `submitted`, from any client, RPC or direct SQL.

The mechanism is generic and organization-scoped. No organization name appears
anywhere in it. The first tenant configured to use it is addressed by its stable
UUID in a separate, independently-deployable migration.

---

## 2) Problem / requirement

Requirement: every new expense of one organization must carry its project details
— a parent selector plus two dependent branch fields — before it can become
`submitted`. The browser must not be the final authority, and the rule must hold
for the employee form, edit/resubmit, Admin Submit on Behalf, batch submission,
and any future client or API path.

DOC-117's validator cannot express this, for two structural reasons:

1. **It is per-category.** "Required on every category" can only be written as N
   `expense_category_form_fields` rows kept in sync by hand. A category added
   later silently opts out.
2. **It resolves `expenses.category` (text) to a category row by name.** A row
   whose category string no longer matches any category resolves to **zero**
   assignments — nothing is required and the submission passes unchecked. This is
   not hypothetical: Production carries two such orphan category strings
   (7 expenses, last used July 2026) left behind by category renames.

An audit confirmed there is **no** existing organization-level required-field
table, so per §B of the requirement the correct answer was a small generic one.

---

## 3) Solution

### 3.1 `organization_required_expense_fields` (new table)

| Column | Purpose |
|---|---|
| `organization_id` | scope; FK to `organizations`, `ON DELETE CASCADE` |
| `template_id` | the parent field. Templates carry an **empty `field_key`** in this schema, so the UUID is the only stable handle; display names are never used to identify anything |
| `required` | lets a policy be disabled without deleting its history |
| `required_branch_field_keys text[]` | dependent branches are per-option rows and have no single UUID, but their **`field_key` is stable across every option** — verified in Production at 529 and 525 rows. A branch is required when its own `required` flag is true **or** its `field_key` is listed here |
| `notes`, `created_at`, `updated_at` | provenance |

`UNIQUE (organization_id, template_id)`. RLS enabled, nothing granted to `anon`
or `authenticated`; the enforcement path reads it through `SECURITY DEFINER`.

### 3.2 `validate_expense_org_required_fields_v1(expense_id)`

Reconstructs the requirement entirely from the database:

* returns immediately when the expense's organization has no policy row — a
  genuine no-op for every other tenant;
* requires a **non-blank** value for the parent template — `NULL`, `''` and
  whitespace-only are all rejected, as is a missing row;
* resolves the dependent branches **active for the option actually selected**
  (`parent_option_value = <the saved value>`, `retired_at IS NULL`), never from
  the submitted payload;
* raises `SQLSTATE PW001` with a user-safe MESSAGE, a DETAIL naming the missing
  fields, and a HINT. No SQL, table name, UUID or configuration internal appears
  in anything a user can see.

### 3.3 One canonical rule, two enforcement points

`validate_expense_submission_invariants_v1(expense_id)` is the single rule:
organization policy first, then DOC-117's category validator. Both enforcement
points call it, so the database cannot end up with one rule for "entering
`submitted`" and a subtly different one for "editing values afterwards".

* **Entering the workflow** — `trg_validate_expense_custom_fields_on_submit()`,
  DOC-117's existing wrapper, now delegates to it. The two `DEFERRABLE INITIALLY
  DEFERRED` constraint triggers on `public.expenses` are **not recreated**, so
  their firing rules, deferral semantics and historical-data guarantees carry
  over exactly as already proven.
* **Staying complete** — a new deferred constraint trigger on
  `expense_form_field_values` (§3.5).

Policy-first ordering is deliberate: for a tenant that opted in, the
deterministic `PW001` / `PW002` message is what surfaces, rather than the generic
`23514` check-violation the category validator raises.

### 3.4 Client (§J)

`formatApiError` gains `isOrgRequiredFieldsError` and, for `PW001`, combines the
message with the DETAIL so the user is told **which** project details are
missing. Every other error formats exactly as before. Requiredness display needed
no change: all ten active categories already mark the parent field required
(nine explicitly, one through the `assignment.required ?? template.required`
fallback the client already implements). Client validation remains convenience
only; the database is authoritative.

---

## 3.5) The second invariant — post-submission stripping

The status-transition triggers answer only *may this expense ENTER `submitted`?*
An expense already inside the workflow could still have its values rewritten with
no status change, and nothing re-validated. That is not theoretical:
`replace_expense_form_field_values` authorises the **owner** to rewrite values
while status is `draft`, `submitted` or `rejected`, and a Production expense was
observed submitted complete at 10:55 and stripped of both dependent project
values at 10:59 the same morning — with the browser's own draft still holding
them.

### Writers audited (repository and live `pg_proc`)

| Writer | Deletes | Inserts | Can touch a submitted expense |
|---|---|---|---|
| `replace_expense_form_field_values` | yes | yes | **yes** — owner, while `draft`/`submitted`/`rejected` |
| `replace_expense_form_field_values_by_reviewer` | yes | yes | **yes** — reviewer correction path |
| `admin_restore_upsert_form_field_values` | no | yes | yes — admin restore |
| `admin_submit_expense_for_employee_v2` | — | — | delegates to the above |
| PostgREST direct | RLS has no DELETE policy; UPDATE is permitted on one's own expense | | **yes, for UPDATE** |

All three SQL writers are `SECURITY DEFINER` and do their delete-then-insert
inside a single transaction, which is exactly what makes a **deferred** guard the
right shape: judged on the final state, a complete swap passes and an incomplete
one rolls the whole call back.

### Protected statuses

Taken from the live `expense_status` enum and the real review gates:
`submitted`, `under_review`, `verified`, `level_1_verified`, `level_2_verified`,
`approved`, `paid`. Deliberately **excluded**: `draft`, `rejected`, `edited` —
the states in which the app legitimately lets a user hold an incomplete expense
while editing. Re-entering `submitted` from any of those is gated by the
status triggers, so an incomplete edit can never be promoted.

### Design

One `DEFERRABLE INITIALLY DEFERRED` constraint trigger on
`expense_form_field_values` covering INSERT, UPDATE and DELETE. It resolves the
owning expense from `OLD` on DELETE and from `NEW` otherwise, and checks **both**
sides of an UPDATE that moves a row between expenses so a row cannot be stolen
away and leave the old expense incomplete. It then calls the same canonical
`validate_expense_submission_invariants_v1` the status triggers call — there is
one rule in the database, not two.

Installing it validates nothing retroactively: it fires only on future row
events.

### Fail-closed configuration check (§16/§17)

A policy that lists `project_id` and `project_name` now also requires that
**exactly one active branch definition exists** for each key, for the option
actually selected. Zero definitions means an administrator created an option
without the mandatory dependent field; accepting the expense would silently
bypass the policy. More than one is ambiguous. Both raise **`PW002`**:
*"Required project configuration is incomplete. Please contact an administrator."*

### Two decisions worth recording

**`ON DELETE RESTRICT` on `template_id`** — a MUST-HAVE policy must not be
silently cascaded away by deleting the template it protects. Removing a policy is
now an explicit `DELETE` from the policy table. Deleting the *organization* still
cascades naturally.

**Canonical option membership (§19) is deliberately NOT enforced.** The template
does carry an authoritative 524-entry option list, and every value used in the
last 60 days is in it. But enforcing membership would mean that retiring an
option later blocks any further edit of already-submitted expenses that used it —
exactly the retroactive invalidation §19 warns against, made concrete by the new
post-submission guard. The fail-closed `PW002` check already makes the four
unreachable orphan options harmless, so membership enforcement would add risk
without adding protection.

---

## 4) Key files

```
supabase/migrations/20260907120000_organization_required_expense_fields.sql        # generic mechanism
supabase/migrations/20260907121000_enable_project_fields_policy_for_microlink.sql  # single-tenant enablement (data)
src/lib/formatApiError.ts                                                          # PW001 recognition + presentation
src/lib/__tests__/orgRequiredExpenseFieldsPolicy.test.ts                           # 20 tests
```

---

## 5) Database / migrations

Two files, deliberately separable so the mechanism can be deployed and observed
before any tenant is enforced, and so enablement is revertible with a one-row
`DELETE` that touches no validator.

`20260907120000` — `CREATE TABLE IF NOT EXISTS`, one index, one `updated_at`
trigger on the new table, `ENABLE ROW LEVEL SECURITY`, `REVOKE`/`GRANT`, two
`CREATE OR REPLACE FUNCTION`, `COMMENT`. **No DML against any business table. No
destructive DDL. No historical scan.**

`20260907121000` — a single guarded `INSERT … ON CONFLICT DO UPDATE` into the new
policy table. It refuses to install if the organization, the template, or either
dependent `field_key` is absent, so a wrong-database apply fails loudly instead of
silently doing nothing. It reads no business table and writes none.

The user runs SQL manually. `NOTIFY pgrst, 'reload schema'` is included.

---

## 6) Pre-enablement audit (read-only, 2026-09-07)

Every active category of the target organization, with 60-day usage:

| Category | expenses | last 60d | parent field on the form | effective required | can enforce |
|---|---|---|---|---|---|
| Travelling (Public and Private Transport) | 15,780 | 14,327 | yes | true | **YES** |
| Petrol Expense (Bike and Car) | 1,789 | 1,570 | yes | true | **YES** |
| Hotel/Guest House | 629 | 595 | yes | true | **YES** |
| Other ( Xerox, Printing, Courier, Stationery & Medical ) | 230 | 206 | yes | true | **YES** |
| Material Purchase | 130 | 116 | yes | true | **YES** |
| Mobile Recharges | 61 | 58 | yes | true | **YES** |
| Food | 35 | 34 | yes | true | **YES** |
| Local Manpower | 22 | 21 | yes | true | **YES** |
| Laptop Rent | 17 | 17 | yes | true | **YES** |
| Incentive | 5 | 5 | yes | NULL → template `true` | **YES** |

Dependent branch coverage over the same window: **237 distinct project options
used; 237 expose Project ID; 237 expose Project Name; 0 missing a dependent.**
236 of 237 already flag both branches required — the single exception
(2 uses) is covered by `required_branch_field_keys`, which is exactly why that
column exists.

**No actively-used category or option is unable to satisfy the policy**, so the
audit gate passes.

Two orphan category strings exist (7 expenses, last used July 2026) with no
matching category row. They are the concrete reason the policy is organization-
scoped rather than category-scoped; the acceptance matrix has a case for them.

---

## 7) Test plan

**Acceptance matrix — executed against a restored Production database**
(`20260905T185741Z-pre-custom-field-validator`, sha256 `5817f96e…`, 24,018
expenses / 92,104 field values / 1,912 branches), with all three migrations
applied, every case wrapped in `BEGIN … SET CONSTRAINTS ALL IMMEDIATE … ROLLBACK`
so the deferred triggers genuinely fire and nothing persists. **The React
frontend is bypassed entirely — this is the direct database path.**

| # | Case | Expected | Result |
|---|---|---|---|
| P1 | all three values complete | PASS | ✅ |
| P2 | parent field missing | FAIL | ✅ |
| P3 | Project ID missing | FAIL | ✅ |
| P4 | Project Name missing | FAIL | ✅ |
| P5 | both dependents missing | FAIL | ✅ |
| P6 | whitespace-only Project ID | FAIL | ✅ |
| P7 | whitespace-only Project Name | FAIL | ✅ |
| P8 | **incomplete draft may still be saved** | PASS | ✅ |
| P9 | draft completed → submitted | PASS | ✅ |
| P10 | rejected → submitted while incomplete | FAIL | ✅ |
| P11 | admin-delegated shape (insert `submitted` **then** values, one txn) | FAIL atomically | ✅ |
| P12 | batch of 3, one line incomplete | whole txn fails | ✅ |
| P12b | batch of 3, all complete | PASS | ✅ |
| P13 | approved historical incomplete row, unrelated UPDATE | not blocked | ✅ |
| BYP | orphan category string can no longer bypass | FAIL | ✅ |
| **J / J2 / J3** | **submitted + complete → DELETE Project ID / Project Name / the parent** | **FAIL + rollback** | ✅ |
| **K / K2 / K3** | **submitted + complete → set NULL / `''` / `'   '`** | **FAIL + rollback** | ✅ |
| **L / L2 / M** | **level_2_verified / level_1_verified / approved → strip** | **FAIL** | ✅ |
| **N** | **submitted → ATOMIC replacement with another complete project** | **PASS** | ✅ |
| O / P | draft / rejected field deletion still allowed | PASS | ✅ |
| Q | editable + incomplete → submitted | FAIL | ✅ |
| **R** | **new option configured with `project_id` but no `project_name`** | **FAIL — PW002 config** | ✅ |
| **S** | **same new option, fully configured + complete values** | **PASS** | ✅ |
| T / T2 | control tenant unaffected, incl. deleting values of a submitted expense | PASS | ✅ |
| FK | deleting a policy-referenced template | RESTRICTED | ✅ |

**28 / 28 as specified**, on a fresh restore with the full final migration
sequence applied from scratch. Performance: a realistic 5-field replacement on a
protected expense, including deferred validation at commit, ran in **≤ 30 ms**. Historical fingerprint after installing the policy:
expenses 24,018, field values 92,104 — identical to the restore. Throwaway
database dropped.

Observed error shape:

```
ERROR:  PW001: Required project details are incomplete.
DETAIL: Missing: Project Unique ID.
HINT:   Complete the required project details before submitting this expense.
```

**Repository gates:** 20/20 new unit tests; TypeScript **616 errors = the exact
pre-existing baseline, 0 new**; `npm run build` PASS; `npm run migrations:check`
PASS (246 files); `npm run security:secrets` clean.

**Not yet done:** Vercel Preview smoke test, fresh pre-deploy Production backup,
Production apply, post-deploy observation.

---

## 8) Deliberately out of scope

* **No historical repair.** Existing incomplete expenses — recoverable,
  ambiguous and unrecoverable alike — are untouched. Enforcement is forward-only.
* **No change to the review workflow.** Team Leader / Executive verification,
  Manager approval, Manager Override, balances, Tally and reports are all
  untouched. This controls exactly one question: *may this expense enter
  `submitted`?*
* **Historical incomplete rows.** Untouched, deliberately. Both invariants are
  forward-looking; nothing existing is scanned, validated or repaired.

---

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-09-07 | 1.0 | Claude Code | Created. Generic organization-scoped mandatory-field mechanism plus single-tenant enablement, after a read-only audit confirmed all 10 active categories and all 237 project options used in 60 days can satisfy the policy. Reuses DOC-117's single deferred trigger entry point rather than adding a competing one; closes the orphan-category bypass that the category-driven validator structurally cannot see. 17/17 acceptance cases on a restored Production database with deferred triggers forced to fire; control tenant unaffected; historical rows unchanged. Not applied to Production. |
---

## 9) Production deployment record (2026-09-07)

| | |
|---|---|
| Merged to `main` | **`534d8e1cf962ac8f36198166627804fa61876a61`** |
| Pre-deploy backup | `~/pesowise-safe-backups/20260907T110816Z-pre-org-required-fields.dump` — 29,473,239 B, sha256 `51e6d268e598595f78afd28da5a56a08b5addf62b09eaa57a72202e5a3801491`, 2,349 TOC entries (archive readable) |
| Transactional dry run | **PASS** — inspected in-transaction, rolled back, prior state confirmed restored |
| Generic mechanism `20260907120000` | **LIVE** |
| Enablement `20260907121000` | **LIVE** |
| Applied as | `supabase_admin` — the dry run caught that `postgres` is not a superuser here and does not own `public.expenses` or the DOC-117 functions |
| Business rows changed | **0** — `expenses`, `expense_form_field_values`, `approved`, `approved_total` identical before and after both migrations |

### Live objects verified after deployment

`organization_required_expense_fields` (RLS enabled, `template_id` FK
`ON DELETE RESTRICT`), `validate_expense_org_required_fields_v1`,
`validate_expense_submission_invariants_v1`,
`trg_validate_expense_custom_fields_on_submit` (confirmed delegating to the
canonical rule), `trg_protect_required_fields_after_submission`,
`_expense_status_is_protected_v1`, and three constraint triggers — two on
`expenses`, one on `expense_form_field_values` — all
`DEFERRABLE INITIALLY DEFERRED` and enabled.

Policy row: one, for the target organization, `Project Unique ID`,
`required = true`, `required_branch_field_keys = {project_id, project_name}`.

### Configuration audit at deployment

**524 / 524 selectable project options safe; 0 unsafe.** Four branch groups are
configured with `project_id` but no `project_name`; all four are absent from the
template's canonical 524-entry option list, are therefore unselectable, and have
never been used. They are exactly what the fail-closed `PW002` check exists for.

### Behaviour verified on live Production (all rolled back)

| Check | Result |
|---|---|
| Strip a submitted, complete expense | **REJECTED** |
| Complete submission | **ACCEPTED** |
| Incomplete submission | **REJECTED** |
| Atomic complete replacement | **ALLOWED** |
| Draft editing | **ALLOWED** |
| Another tenant | **UNAFFECTED** |

### Error contract

* `PW001` — *"Required project details are incomplete."* + DETAIL naming the
  missing fields. The user can fix this.
* `PW002` — *"Required project configuration is incomplete. Please contact an
  administrator."* The user cannot fix this; an administrator must.

Neither exposes SQL, table names, UUIDs or constraint internals.

### Live evidence

The first four real submissions after enablement (16:46 IST) were **all
complete**; zero incomplete rows entered the workflow.

### Cross-tenant impact of the value-table guard

The guard applies the generic category-requiredness rule to **every** tenant, not
only the one with a policy row. Measured across all protected expenses at
deployment:

| Organization | Protected expenses | Historically incomplete | Share |
|---|---|---|---|
| MicroLink | 18,548 | 37 | 0.20% |
| Patidar Travels | 2,973 | 0 | 0.00% |
| Bikes auto Hero | 1,421 | 0 | 0.00% |
| Mistry And Shah | 1,296 | 2 | 0.15% |
| Trial | 7 | 0 | 0.00% |

**39 rows organization-wide.** A future custom-field edit to one of those rows
will be blocked until the missing value is supplied. All 39 are genuinely
incomplete historical data, **not** a retroactive configuration change: for the
two non-MicroLink rows the requiring assignment was created 2026-05-18 and the
expenses in 2026-06-22/30, so the requirement predates them. No compatibility
concern was found, and the invariant was not weakened.

### Frontend deployment

Vercel Production is **READY** on `cd7a021a91d875df1931362ce9f4a47d0ebb8640`
(the documentation commit on top of the merge `534d8e1`), auto-deployed from
`main`.

Verified functionally rather than by trusting the dashboard: the live site
serves `assets/formatApiError-ClXfgEu0.js` — the same content-hashed chunk name
`main` builds locally — and that chunk contains `const f="PW001"` together with
the recognition helper and the message-plus-details combination. The client
therefore understands both policy error codes in Production.

Worth recording for the next person: `formatApiError` is a lazily-loaded chunk
and is **not** referenced from `index.html`. Grepping only the entry bundles
gives a false negative; the chunk list has to be read out of the entry bundle
itself.
| 2026-09-07 | 2.1 | Claude Code | Corrected the frontend record. The client PW001/PW002 mapping IS deployed: Vercel Production is READY on cd7a021 and serves assets/formatApiError-ClXfgEu0.js, the same content-hashed chunk main builds, containing const f="PW001". An earlier reading that it was missing was wrong — it grepped only the entry bundles, and formatApiError is a lazily-loaded chunk not referenced from index.html. |
