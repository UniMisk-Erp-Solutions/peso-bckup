# Custom Field Submission Data-Integrity Incident (Project Unique ID / Project ID / Project Name)

**Doc ID:** DOC-117
**Status:** deployed *(prevention)* · **historical remediation: PENDING**
**Last updated:** 2026-09-07
**Owner / area:** Expenses — custom form fields, submission pipeline (single/edit, batch, admin-delegated)

> ## Incident status
>
> | | |
> |---|---|
> | **PREVENTION** | **DONE — deployed to Production 2026-09-07** |
> | **HISTORICAL RECOVERY** | **PENDING — a separate, not-yet-authorised task** |
>
> The active data-loss leak is closed. Client fixes are merged and the database
> now refuses an incomplete submission *and* refuses any later write that would
> leave a protected expense incomplete. Existing incomplete rows are untouched
> and still require remediation; see §11.

---

## 1) Summary

MicroLink's "Project Unique ID" cascading field group (template → "Project ID" /
"Project Name" dependent branch fields) was intermittently — in one case,
deterministically — losing the dependent values on save, across all four
expense submission paths. Root-caused to three independent client-side defects
plus one server-side gap plus one client write-order bug, all in `useOnDemandOptionBranches`'s
on-demand branch-config fetch and its consumers. Client-side fixes applied on
`hotfix/custom-field-data-integrity`; a new canonical server-side validator +
trigger closes the permanent, browser-independent gap. September 2026 Production
data forensically classified (1,164 complete / 28 both-dependents-missing / 6
UID-itself-missing, 0 partial); no repair has been written or executed —
dry-run classification only, pending owner authorization.

---

## 2) Problem / requirement

**Reported symptom:** for some MicroLink expenses (September 2026 onward),
"Project ID" and "Project Name" — dependent fields revealed once "Project
Unique ID" is selected — are missing even though the parent Project Unique ID
value is present and correct. Always both-or-neither, never just one of the
two.

**Governing constraints for this investigation** (unchanged throughout): no
speculative fixes; no altering expense amounts, balances, approval history, or
status; no Production data mutation until forensics were complete; no
push/merge without explicit authorization; server-side validation must
reproduce the app's *existing* requiredness semantics exactly, not a guessed
rule.

**Acceptance criterion:** not "the UI now waits for the request" — the fix is
complete only when *no expense can enter a submitted/reviewable state while
its authoritative required custom field configuration is incomplete*,
enforced independently of the browser.

---

## 3) Root cause

### 3.1 Standalone (single-expense / edit-resubmit) path

Three independent defects in `src/hooks/useOnDemandOptionBranches.ts` and its
consumers, all stemming from the same design flaw: a **pending** branch-config
fetch and **zero configured branches** both presented identically as
`optionBranches = []`, so every caller that gated on `optionBranches.length > 0`
silently treated "not loaded yet" as "nothing to validate/save."

- **Defect A (dead code):** the hook exposed `isLoading`, but no consumer
  (`ExpenseForm.tsx`, `BatchLineFormFields.tsx`, `BatchSharedCategoryFields.tsx`,
  `AdminSubmitExpense.tsx`) ever read it.
- **Defect B (race, submit-time):** `ExpenseForm.tsx`'s pre-submit validation
  and its `saveFormFieldValues` payload builder both gated on
  `optionBranches.length > 0`. A pending fetch (not yet resolved, not failed)
  looked exactly like "no conditional fields for this template," so
  `visibleBranchIds` computed to an **empty but truthy `Set()`** — and the
  payload builder (`expenseFormFieldPayload.ts`) treats a truthy empty Set as
  "restrict to these IDs," i.e. drop every branch value. One shared
  `optionBranches` array gated *both* Project ID and Project Name together,
  which is exactly why the Production pattern is always both-or-neither.
- **Defect C (deterministic, not a race — the dominant cause):** the
  edit/resubmit bootstrap (`ExpenseForm.tsx`'s `fetchExpense`) called
  `fetchCategoryFormFields(category)` with **no options**, before the
  previously-saved template values were even loaded — so its own,
  already-correct `preserveFormValues` prefetch path (which *does* fetch
  branch definitions for an already-selected option) never had anything to
  prefetch. Only previously-saved branch *values* loaded
  (`loadBranchFieldValuesForExpense`); branch *definitions* never did.
  `optionBranches` stayed permanently `[]` for that render — not until a
  fetch resolves, but for the entire session, unless the user happened to
  reopen the dropdown. Every edit/resubmit of an expense with conditional
  fields was guaranteed to drop them on save.
- **Defect D (reconciliation gap):** `CategoryFormFieldsSection`'s
  `handleTemplateSelectChange` fired the async branch fetch, then
  *synchronously* recomputed `branchValues` against whatever `optionBranches`
  happened to hold at that instant (stale, or empty) — no effect ever
  re-derived branch values once the real config arrived on a later render.
- **Defect E (no latest-selection-wins guarantee):** the hook had no
  request-generation tracking or cancellation. Selecting UID-A then quickly
  UID-B, with A's request resolving after B's, could let A's stale result
  overwrite B's already-resolved one.

### 3.2 Server-side gap (all four paths)

`replace_expense_form_field_values` (the one RPC every path ultimately calls
to persist values) does an unconditional `DELETE` + `INSERT` with **zero
completeness/required-field validation** — a gap the codebase's own
`admin_submit_expense_for_employee_v2` migration header already documented as
"a PRE-EXISTING, system-wide gap." The browser was the only thing ever
checking completeness, and it was checking it four different, inconsistently
correct ways (see §3.4).

### 3.3 Batch-specific write-order defect (separate from §3.1, real, and worse)

`ExpenseService.submitExpenseBatch` called `this.submitExpense(expenseId, userId)`
— which transitions the expense to **`status = 'submitted'`** — *before*
`this.replaceExpenseFormFieldValues(expenseId, organizationId, payload)`. These
are two separate, sequential Supabase round trips (not one transaction). If
the later custom-field write failed for any reason (including, before this
incident's fixes, an incomplete payload silently computed from Defect B), the
`catch` block marked only that *batch line* as failed in the UI result — but
the expense row was **already, permanently, sitting in the database as
`submitted`** with incomplete or absent custom field values, with no rollback.
This is the most likely mechanism behind the confirmed Production batch
cluster (4 sibling expenses sharing one correctly-propagated Project Unique ID,
all missing both dependents): the batch's own shared-field capture mechanism
(`BatchSharedCategoryFields` → `applyBatchFieldPlanToLines`) was traced in full
and found structurally sound — it awaits a fresh, per-selected-value branch
fetch before every advance/submit — the defect was downstream, in write order,
not in the shared-field UI itself.

### 3.4 Requiredness semantics — proven, not guessed

Per the explicit instruction not to guess what `expense_category_form_fields.required = NULL`
means (e.g. for the "Incentive" category), the existing rule was traced from
code and tests before any validator was written:

```
effectiveRequired = assignment.required ?? template.required
```

Confirmed identically in `BatchLineFormFields.tsx:100`,
`expenseBatchValidation.ts:336,380`, `loadCorrectionCustomFields.ts:135,268`,
and directly asserted by tests `CC-5`/`CC-6` in
`src/lib/__tests__/correctionCustomFields.test.ts`. For "Incentive"
(`assignment.required = NULL`), this resolves to the *template's* own
`required = true` for the Project Unique ID template — i.e. it is effectively
required there too, via the existing rule, not a new one. The Incentive
category's own data was not modified.

Branches (`expense_form_field_option_branches`) have no assignment-override
layer — `branch.required` alone is authoritative, confirmed via
`validateVisibleBranchFields` (`conditionalFormFields.ts:161`).

A field whose effective `show_on_submit` resolves false
(`assignment.show_on_submit ?? template.show_on_submit ?? true`) is never
asked at submit time by any client path and must never block submission —
confirmed via `ExpenseForm.tsx`'s `fetchCategoryFormFields` filter and
`batchFieldPlan.ts`'s `isAssignmentVisible`.

---

## 4) Solution

### 4.1 Client — explicit state machine, not `[]`-inference

`src/hooks/useOnDemandOptionBranches.ts` rewritten: per-template status
`{ state: "unconfigured"|"loading"|"ready"|"error", forValue }`, plus a
per-template monotonic generation counter for latest-selection-wins (a slow
response for a superseded selection is discarded, never applied). New
`isResolvedFor(templateId, value)` / `isLoadingFor` / `hasErrorFor` are the
only sanctioned way to know if a given selection's config is known — never
`optionBranches.length`.

`src/components/CategoryFormFieldsSection.tsx` (shared by all four submission
UIs): `handleTemplateSelectChange` no longer synchronously recomputes branch
values against stale/empty config. A `useEffect` reconciles `branchValues`
only once **every** currently-selected select-type template's config is
confirmed `ready` (via new `isOptionResolved` prop) — a still-loading sibling
template can never cause an already-answered field to be wiped. New
`isOptionLoading`/`isOptionErrored` props render an inline
"Loading project information…" / retry hint.

`src/pages/ExpenseForm.tsx`:
- Edit/resubmit bootstrap reordered: existing template values are loaded
  **before** `fetchCategoryFormFields` runs, and passed as
  `preserveFormValues` — reusing that function's own already-correct prefetch
  path instead of adding new plumbing. This closes Defect C at its exact
  origin.
- `saveFormFieldValues` and the pre-submit validation block now call
  `isResolvedFor` for every currently-selected select-type template and
  **throw** (blocking save/submit) if any is unresolved, instead of silently
  computing `visibleBranchIds = new Set()`.

`src/pages/AdminSubmitExpense.tsx` (previously the weakest path — zero
required-field validation, and a payload built from a *different*, eagerly
loaded, `getVisibleBranchIds`-unfiltered config source): now builds its
payload from the same on-demand `optionBranches` + `getVisibleBranchIds` the
other paths use, and gained `customFieldValidationError()` blocking submit on
a missing required field or an unresolved/errored selection.

`src/components/BatchLineFormFields.tsx` / `BatchSharedCategoryFields.tsx`:
already the most defensive (await a fresh fetch before every advance/submit);
now also pass `isOptionResolved`/`isOptionLoading`/`isOptionErrored` through
for consistency with the shared component's new reconciliation gate.

### 4.2 Batch write-order fix

`src/services/ExpenseService.ts`'s `submitExpenseBatch`: `replaceExpenseFormFieldValues`
now runs **before** `submitExpense` (was after). A failed custom-field write
now leaves the expense a harmless leftover **draft** (never reaches
`submitted`), instead of a permanently incomplete, already-submitted row.

### 4.3 Server — canonical validator + trigger (the permanent guarantee)

New migration `20260905150000_validate_expense_custom_fields_on_submit.sql`:

- `validate_expense_custom_fields_for_submission_v1(p_expense_id)` — the
  **one** canonical validator, reused by construction (see below) by all four
  submission paths. Derives category, assignments, templates, and the
  authoritative branch configuration for whatever value is actually saved
  entirely from the database; reproduces `assignment.required ?? template.required`
  and the `show_on_submit` filter exactly as proven in §3.4; resolves the
  exact active branch chain for a saved select value via a depth-limited
  (`MAX_CONDITIONAL_BRANCH_DEPTH = 3`) recursive walk; raises on any missing
  required value.
- `trg_validate_expense_custom_fields_on_submit()` + two **`DEFERRABLE
  INITIALLY DEFERRED` constraint triggers** (`AFTER INSERT`, `AFTER UPDATE OF
  status`, split because Postgres disallows referencing `OLD` in a WHEN clause
  on a trigger that also fires for INSERT) on `public.expenses`, firing only
  when a row's status transitions into `'submitted'`. Deferred to commit
  time specifically because `admin_submit_expense_for_employee_v2` inserts
  the expense row as `'submitted'` and writes custom field values
  *afterward*, all in one transaction — an immediate trigger would falsely
  reject that already-atomic, already-correct RPC. A validation failure
  rolls back the entire transaction (the status change, and for the admin
  RPC, the whole expense + audit + notification insert set).
- Scoped to fire only on an actual transition into `submitted` (not every
  subsequent edit of an already-submitted row), to avoid retroactively
  blocking unrelated edits to legacy expenses.
- Does not modify `replace_expense_form_field_values` or
  `admin_submit_expense_for_employee_v2` — purely additive, forward-only.

This is the layer that makes the acceptance criterion actually true
regardless of the browser: any future or currently-unknown client bug, or a
direct API call, hits the same guarantee.

---

## 5) Key files

```
src/hooks/useOnDemandOptionBranches.ts
src/components/CategoryFormFieldsSection.tsx
src/components/BatchLineFormFields.tsx
src/components/BatchSharedCategoryFields.tsx
src/pages/ExpenseForm.tsx
src/pages/AdminSubmitExpense.tsx
src/services/ExpenseService.ts   (submitExpenseBatch write-order fix)
supabase/migrations/20260905150000_validate_expense_custom_fields_on_submit.sql
src/lib/__tests__/editResubmitBranchDataLoss.test.ts        (characterization test)
src/hooks/__tests__/useOnDemandOptionBranches.test.ts        (new)
src/components/__tests__/CategoryFormFieldsSectionReconciliation.test.tsx  (new)
```

---

## 6) Database / migrations

- `20260905150000_validate_expense_custom_fields_on_submit.sql` — **NOT
  applied to Production.** Owner runs manually / authorizes apply. Additive
  only; no existing function body modified. Reload PostgREST schema cache
  after applying (standard convention for this repo).
- No repair migration exists or has been written. See §8.

---

## 7) Test plan

- [x] Characterization test proving the exact `optionBranches=[]` mechanism
      (`editResubmitBranchDataLoss.test.ts`) — 2/2 passing.
- [x] Hook-level deferred-promise tests: pending-fetch visibility, resolution,
      **latest-selection-wins** (generation counter), failed-fetch state,
      caching (`useOnDemandOptionBranches.test.ts`) — 5/5 passing.
- [x] `CategoryFormFieldsSection` reconciliation gate: no premature wipe while
      unresolved; correct reconciliation once resolved; a sibling template's
      value survives an unrelated pending selection
      (`CategoryFormFieldsSectionReconciliation.test.tsx`) — 3/3 passing.
- [x] Existing suites re-run clean with zero regressions:
      `BatchLineFormFieldsIsolation`, `expenseBatchValidationPlan`,
      `batchCustomFieldValidation`, `oncePerBatchInvariants`,
      `expenseFormFieldPayload`, `adminSubmitExpense`,
      `adminSubmitExpenseSqlContract`, `ExpenseService.test.ts` (batch
      write-order fix, 11/11 passing).
- [ ] Full end-to-end `ExpenseForm.tsx` edit-mode integration test (mount +
      mocked Supabase chains proving the bootstrap prefetch and a
      blocked-while-pending save) — **attempted and explicitly deferred**,
      not faked: the page touches ~15 distinct Supabase table/RPC call
      shapes during mount alone; a deterministic mock covering all of them
      is a separate, larger effort. Tracked as an open gap, not silently
      skipped.
- [ ] Server-side validator/trigger — **not yet executed against any
      database** (no migration applied). Recommended pre-apply verification:
      a `BEGIN...ROLLBACK`-wrapped test inserting/updating a synthetic
      expense with a deliberately incomplete required custom field, asserting
      the transaction is rejected, then with a complete one, asserting it
      commits — before applying to Production.
- [ ] Remaining enumerated Phase 5 scenarios not yet each individually
      test-named (several are covered in substance by the above): required
      Project ID/Name missing → server rejects (needs the migration applied
      + a live/rollback-wrapped SQL test, not yet run); delegated admin
      submission invariant parity (covered by `AdminSubmitExpense.tsx`'s new
      `customFieldValidationError`, not yet given its own dedicated test
      file).

---

## 8) September 2026 dry-run classification (READ-ONLY — no repair performed)

MicroLink, September 2026, 10 relevant categories, Project Unique ID template
`51181324-68cc-4174-bbe0-4834e5e22c48`:

| Bucket | Count | Meaning |
|---|---|---|
| A (all three present) | 1,164 | Correct |
| B (ID missing only) | 0 | — |
| C (Name missing only) | 0 | — |
| D (UID present, both dependents missing) | 28 | See below |
| E (UID itself absent) | 6 | Not investigated further — no signal to infer from; never guessed |

**D-bucket subdivision** (28/28 have `any_branch_required = true` for the
exact selected value — these are genuine required-data violations, not
optional-field gaps):

| Classification | Count | Standalone | Batch |
|---|---|---|---|
| `DETERMINISTIC_REPAIR_CANDIDATE` (exactly one historical (Project ID, Project Name) pair for that UID value, org-wide) | 18 | 11 | 7 |
| `AMBIGUOUS_MULTIPLE_PAIRS_DO_NOT_GUESS` (2 distinct historical pairs exist for the same UID value) | 10 | 4 | 6 |
| `UNRECOVERABLE_NO_HISTORICAL_EXAMPLE` | 0 | — | — |

One `AMBIGUOUS` group's two-pairs-per-UID pattern recurs across ~2,798–2,881
supporting rows org-wide — flagged as a possibly separate, pre-existing
data-quality observation about that specific UID value's real-world reuse,
not investigated further and not part of this incident's fix.

**No repair has been proposed as SQL, backed up, or executed.** Per
instruction, deterministic candidates are not to be auto-applied without a
separate, explicit, owner-approved repair step (backup every affected row
first, transactional, before/after reconciliation, never touch
amount/balance/status/approval history).

---

## 9a) Pre-Production safety audit (2026-09-06)

A second pass audited this migration line-by-line before any Production apply,
tested it against a real, freshly-restored throwaway copy of Production, and
built the previously-deferred edit-mode integration test.

- **Migration review**: confirmed no data-changing DML anywhere in the
  migration (only `CREATE OR REPLACE FUNCTION`, `COMMENT`, `REVOKE`,
  `DROP TRIGGER IF EXISTS`, `CREATE CONSTRAINT TRIGGER`); no destructive DDL;
  two separate INSERT/UPDATE constraint triggers (required because Postgres
  disallows referencing `OLD` in a WHEN clause on a trigger that also fires
  for INSERT); both correctly scoped to fire only on an actual transition
  into `submitted` (`OLD.status IS DISTINCT FROM NEW.status`), confirmed by
  code-reading `ExpenseService.updateExpense`'s actual payload (never
  includes `status`), so ordinary field edits never re-trigger validation.
- **Security fix found and applied**: `validate_expense_custom_fields_for_submission_v1`
  defaulted to PUBLIC/anon/authenticated EXECUTE (Postgres's default for new
  functions) despite being an internal-only helper meant to run solely via
  the trigger — an external caller could have probed arbitrary expense IDs
  across organizations for custom-field completeness and field names. Fixed
  with explicit `REVOKE ALL ... FROM PUBLIC/anon/authenticated`; verified via
  `has_function_privilege` before (all `true`) and after (all `false`) in the
  throwaway database. The trigger's own internal `PERFORM` call is unaffected
  (a SECURITY DEFINER caller's EXECUTE check runs against its own effective
  role, not the original end-user role).
- **Isolated database test — real Production data**: restored the most recent
  PesoWise backup (`20260905T103153Z-pre-full-expense-detail.dump`, 23,904
  expenses / 91,592 custom field values) into a throwaway database
  (`pesowise_throwaway_test`) on the same Postgres instance as Production —
  never touching the real `postgres` database. Applied the migration cleanly
  (idempotent on re-apply). Ran a 16-scenario validation matrix as fully
  isolated, synthetic-fixture transactions (separate categories/templates per
  scenario group to avoid cross-test fixture contamination), each forcing the
  deferred constraint trigger with `SET CONSTRAINTS ALL IMMEDIATE`. All 16
  passed exactly as expected: complete parent+branch (PASS), missing required
  parent (FAIL), missing required branch (FAIL), optional branch missing
  (PASS), parent switch A→B with A-only required field never required for B
  (PASS) and B's own required field enforced (FAIL when missing), all four
  `assignment.required`/`template.required` combinations (matching CC-4/5/6/7),
  zero-branch select template (PASS), an unrelated field edit on an
  already-submitted row after its required value was since deleted (PASS —
  proves no re-validation), the same for an approved row (PASS),
  rejected→resubmit missing required (FAIL), and — the specific scenario the
  deferred (not immediate) trigger design exists for — the
  `admin_submit_expense_for_employee_v2` write order itself (INSERT the row
  directly as `submitted`, THEN insert custom field values, same transaction):
  PASS when complete, and a row-count check after the incomplete variant's
  rollback confirmed **zero rows persisted** — proving atomicity.
- **Performance**: `EXPLAIN (ANALYZE, BUFFERS)` against the real, restored
  data proved every one of the validator's queries already has a supporting
  index (`uq_form_field_values_expense_template`, `uq_form_field_values_expense_branch`,
  `idx_option_branches_root_field_key`, etc.) — every predicate resolves via
  an Index Scan or Index Only Scan, sub-millisecond each. A full validator
  call against a real, non-synthetic submitted MicroLink expense using the
  actual 1,058-row Project Unique ID branch table measured 19ms. No index
  added — none needed.
- **Lock/deadlock safety**: the validator is read-only (SELECT/PERFORM only),
  so it cannot deadlock against the triggering statement's own row lock, and
  cannot recursively re-fire itself (it never writes to `expenses`).
- **Mandatory edit/resubmit integration test built** (previously deferred):
  `src/pages/__tests__/ExpenseFormEditResubmitBranchPreservation.test.tsx`
  mounts the real `ExpenseForm` page on the real `/expenses/:id/edit` route
  with a table-dispatching fake Supabase client, exercising genuine
  production code end to end. Two tests, both passing and stable across
  repeated runs: (1) branch definitions are prefetched on mount, the
  previously-saved Project ID/Project Name values render correctly, and
  resubmitting sends a payload that still contains all three values; (2) a
  premature resubmit attempted while the branch fetch is deliberately held
  open is blocked — the RPC is never called — and a second resubmit after the
  fetch resolves succeeds normally.
- Origin/main had not advanced since the branch was created
  (`a46979e10934eaeee94ae5a3c1f3fbc3f809c8aa` both times) — no merge/rebase
  was needed before this audit.

## 9) Related docs

- [`custom-form-fields-review-display.md`](./custom-form-fields-review-display.md) (DOC-001) — stale relative to the on-demand fetch architecture this incident touches; its deploy checklist ("has rows") is satisfied by a partially-complete payload and should be revisited alongside any future DOC-001 update.
- [`cascading-options-bulk-import.md`](./cascading-options-bulk-import.md) (DOC-005) — stale test plan (visual-only, no race/timing coverage); not updated by this incident.
- [`form-template-scalability-admin-browse-employee-search.md`](./form-template-scalability-admin-browse-employee-search.md) (DOC-099) — introduced `useOnDemandOptionBranches` itself; this incident is effectively DOC-099's on-demand fetch pattern's first completeness bug.

---

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-09-05 | 1.0 | Claude Code | Initial — root cause (5 defects: A/B/C/D/E client-side + server gap + batch write-order), client fixes on `hotfix/custom-field-data-integrity`, canonical server validator + deferred constraint trigger migration (NOT applied), September dry-run classification (28 D-rows: 18 deterministic / 10 ambiguous / 0 unrecoverable), 10 new/updated tests passing, no Production mutation. |
---

## 11) Final deployment status (2026-09-07)

Superseding every "not applied" / "pending explicit apply" note above.

| Item | State |
|---|---|
| `20260905150000_validate_expense_custom_fields_on_submit.sql` | **LIVE in Production** — validator + two `DEFERRABLE INITIALLY DEFERRED` constraint triggers on `public.expenses` |
| Client fixes (branch-loading state machine, edit/resubmit bootstrap, stale-response guard, batch write ordering, admin validation) | **merged to `main`** in `18bd424` |
| Canonical submission validator | **LIVE** — now reached through `validate_expense_submission_invariants_v1`, the single rule shared by both enforcement points |
| Post-submission protection | **LIVE** — DOC-119 adds a deferred constraint trigger on `expense_form_field_values`, so values can no longer be stripped from an expense already inside the review/approval workflow |
| Client bundle | **deployed** — Vercel Production READY on `cd7a021`, serving the PW001/PW002 error mapping |
| Historical remediation | **NOT performed.** No row was repaired as part of any deployment |

**Verified live after deployment:** stripping a submitted expense is rejected; an
atomic complete replacement still succeeds; draft editing is unaffected; other
tenants are unaffected; and the first real submissions after enablement were all
complete. Business fingerprints (`expenses`, `expense_form_field_values`,
`approved`, `approved_total`) were identical before and after every step.

**What is still open:** the historical rows identified in §8 — the directly
recoverable population, the ambiguous rows, and the unrecoverable client-loss
rows including the one whose values never reached the server. Those are a
separate task and remain deliberately untouched.

See DOC-119 for the organization-policy mechanism and the post-submission guard.
| 2026-09-07 | 1.2 | Claude Code | Closure. Recorded FINAL deployment truth, superseding the stale "migration not applied / main not merged" notes: 20260905150000 is live in Production, the client fixes are merged in main 18bd424, the canonical validator is live and now shared with DOC-119's post-submission guard, and NO historical repair was performed. Separated PREVENTION (done) from HISTORICAL RECOVERY (pending). |
