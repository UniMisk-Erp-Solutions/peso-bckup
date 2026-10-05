# Submitted-Expense Edit Regression Hotfix (MicroLink V1)

**Doc ID:** DOC-126
**Status:** deployed
**Last updated:** 2026-09-10 (rev 3.0)
**Owner / area:** Expenses, MicroLink atomic persistence (DOC-125)

---

## 1) Summary

A production regression, introduced by the DOC-125 MicroLink Atomic Expense
Persistence V1 merge (`bf7be6c`), made it impossible for a MicroLink employee
to edit their own `submitted` expense: they received "This expense can no
longer be edited (status submitted)." and the edit form's own eligibility
check (`canOwnerEditExpenseStatus`) already correctly allows `submitted`, so
only the database rejected it. Hotfix branch:
`hotfix/submitted-expense-edit-regression`, cut from `origin/main` @
`0cc1297`.

---

## 2) Problem / requirement

`_persist_microlink_expense_snapshot_v1` (added in
`20260909100000_microlink_atomic_submission_v1.sql`) gates re-persisting an
existing expense on:

```sql
IF v_existing.status::text NOT IN ('draft','rejected') THEN
  RAISE EXCEPTION 'This expense can no longer be edited (status %).', v_existing.status;
END IF;
```

`'submitted'` was missing from the allowed set. The canonical rule, already
enforced for every non-MicroLink organization by
`canOwnerEditExpenseStatus()` (`src/lib/expenseEditRules.ts`), is:

| status | owner editable | mode |
|---|---|---|
| draft | Y | in-place |
| submitted | Y | in-place |
| rejected | Y | Edit & Resubmit |
| approved | N | — |
| paid | N | — |
| edited | N | — |

The frontend (`ExpenseForm.tsx:895-909`) already gates on
`canOwnerEditExpenseStatus`, so it let the employee open the edit form; only
the MicroLink RPC then refused the write.

---

## 3) Solution

**Rev 1.0 (superseded before Production apply)** simply added `'submitted'`
to the existing `p_action = 'submit'` allowlist. Owner review caught that
this was semantically wrong: `_persist_microlink_expense_snapshot_v1`'s
`'submit'` path unconditionally re-resolves routing
(`_expense_resolve_routing_v1`) and rewrites `approval_tier` /
`assigned_reviewer_id` / `assigned_engineer_id`, and logs a fresh
`expense_submitted` audit row. Checking the ACTUAL legacy client
(`src/pages/ExpenseForm.tsx:1909-1933`) shows that is **not** what happens
today: for an existing expense, `ExpenseService.updateExpense()` always runs,
and `ExpenseService.submitExpense()` (which is what re-resolves routing) is
called **only** when `expenseStatus` is `draft` or `rejected` — never for
`submitted`. A submitted edit only updates core/custom fields and logs
`expense_updated` (`ExpenseService.ts:402`). Rev 1.0 would have silently
rerouted a submitted expense to a different reviewer/engineer whenever the
reporting hierarchy had moved on since the original submission, and would
have duplicated the submission audit trail — a new regression, never applied
to Production.

**Rev 2.0 (this hotfix)** gives the shared atomic engine a third action,
`update_submitted`, alongside `submit` and `save_draft`:

- Reuses every piece of the engine (custom-field upserts, branch cleanup,
  required-field validation via `validate_expense_submission_invariants_v1`,
  the existing revision-bump trigger, idempotency/receipt).
- Does **not** resolve or rewrite routing/status — the UPDATE's `CASE`
  expressions for `status`/`approval_tier`/`assigned_reviewer_id`/
  `assigned_engineer_id` already fire only `WHEN p_action = 'submit'`, so
  `update_submitted` falls through and preserves the existing values with
  zero change to that code.
- Logs `expense_updated`, not `expense_submitted`.
- Refuses any status other than `submitted` (approved/paid/edited stay
  locked, same as before).
- New public wrapper `update_microlink_submitted_expense_v1(jsonb)`.

Client (`ExpenseForm.tsx`, `microlinkExpensePersistence.ts`) now picks the
action explicitly — `isSubmittedEdit = isEditing && expenseStatus ===
"submitted"` calls `updateSubmittedMicroLinkExpense`, everything else keeps
calling `submitMicroLinkExpense` — mirroring the legacy
`isEditing`/`expenseStatus` branching instead of inferring the action from a
server error. `submit_microlink_expense_v1` itself now refuses a re-submit of
an already-`submitted` expense (status allowlist unchanged: `draft`,
`rejected` only), so the old path can no longer double as an edit path.
Post-save UX for a submitted edit shows "Expense saved" and returns to
`/expenses/:id`, not "Expense submitted / Transaction ####" as if it were a
fresh submission.

`assign_transaction_number` only fires when `status` actually transitions
(`OLD.status IS DISTINCT FROM NEW.status`), so a submitted→submitted edit
never reallocates a transaction number regardless of action.

---

## 4) Key files

```
supabase/migrations/20260909172000_microlink_v1_allow_submitted_edit.sql
supabase/migrations/20260909200000_singular_expense_correction_rpc.sql
supabase/tests/microlink_atomic_submission_v1_acceptance.sql   (sections L, M)
supabase/tests/singular_expense_correction_acceptance.sql
src/services/microlinkExpensePersistence.ts   (updateSubmittedMicroLinkExpense)
src/services/__tests__/microlinkExpensePersistence.test.ts
src/pages/ExpenseForm.tsx   (action selection + submitted-edit UX)
```

---

## 5) Database / migrations

- `supabase/migrations/20260909172000_microlink_v1_allow_submitted_edit.sql` —
  applied to Production 2026-09-09. Additive: widens the
  `expense_submission_receipts.action` CHECK constraint to admit
  `'update_submitted'`, `CREATE OR REPLACE`s `_persist_microlink_expense_snapshot_v1`,
  and adds the new `update_microlink_submitted_expense_v1` wrapper function
  with its grants. No table drops, no data migration.
- `supabase/migrations/20260909200000_singular_expense_correction_rpc.sql` —
  applied to Production 2026-09-10. Creates `expense_form_field_value_history`
  (new table + RLS + indexes), `fn_archive_expense_form_field_value` +
  `trg_efv_archive_changes` (safety-net trigger), an idempotent baseline
  snapshot insert, and `apply_singular_expense_correction` with its grants.
  No table drops, no destructive DML — the baseline insert only adds rows
  guarded by a `NOT EXISTS` check.

---

## 6) Test plan

- [x] `npm run migrations:check` — clean
- [x] `npm run security:secrets` — clean
- [x] `npx tsc --noEmit -p .` — clean
- [x] `npm run build` — clean
- [x] Focused: `src/services/__tests__/microlinkExpensePersistence.test.ts` — 22/22 pass
- [x] Full suite (excluding stray untracked `_fixdoc/`/`_julydoc/` snapshot dirs) — 4054/4054 pass
- [x] SQL acceptance test `supabase/tests/microlink_atomic_submission_v1_acceptance.sql`
      sections L/M, and the standalone owner-edit regression re-check on a
      2026-09-10 throwaway restore of Production: same expense id/transaction
      number, no duplicate, `expense_submitted` delta 0, `expense_updated`
      delta 1, idempotent retry adds no second `expense_updated`,
      `submit_v1` refuses an already-submitted expense, approved blocked,
      PW409 on stale revision, routing untouched even after forcing a
      different reviewer/engineer onto the row directly.
- [x] SQL acceptance test `supabase/tests/singular_expense_correction_acceptance.sql`
      — see section 7 below for the full second-incident test matrix.
- [ ] Manual Preview QA: open a submitted MicroLink expense as its owner,
      edit a field, save; confirm no error toast, same expense id, custom
      fields intact, "Expense saved" UX (not "submitted / Transaction ####").
      Also QA reviewer/admin "Save correction" (Flow B, section 7).
- [ ] Post-deploy Production verification of the first real submitted-edit
      and first real correction attempt.

---

## 7) Second incident: reviewer/admin correction RPC 404 (PGRST202)

While the owner QA'd the Preview for the above fix, a **separate** pre-existing
gap surfaced: reviewer/admin "Save correction" called
`POST /rest/v1/rpc/apply_singular_expense_correction` and got `404 PGRST202`.

**Root cause:** `supabase/migrations/290707_2000_singular_correction_safety.sql`
(the RPC, its `expense_form_field_value_history` audit table, and its archive
trigger) was authored but its own header says "DO NOT apply automatically...
run manually after verifying in staging" — it was **never applied to
Production**. Confirmed via live `pg_proc`/`pg_class`/`pg_trigger` checks, not
a PostgREST cache issue.

**Why not a straight replay:** rehearsing the historical file against a
throwaway restore fails immediately — `ERROR: invalid input value for enum
app_role: "manager"`. The current `app_role` enum is `(admin, engineer,
employee, cashier, team_leader, executive)`; the historical migration's RLS
policy and RPC authorization both hard-code
`role IN ('admin','manager','executive','team_leader')`, predating the
current canonical hierarchy helper `expense_hierarchy_reviewer_can_act(e,
uid)` (already live, used by the live `apply_expense_correction`).

**Fix — new forward migration**
`supabase/migrations/20260909200000_singular_expense_correction_rpc.sql`:
same table/trigger/baseline/RPC as the historical file, with authorization
replaced to match the live `apply_expense_correction` contract exactly
(admin, assigned engineer, or `expense_hierarchy_reviewer_can_act`).

**A second, more serious gap found by rehearsal, then fixed:** the deferred
constraint trigger `protect_required_fields_after_submission`
(`20260907120000`) — which normally guards `expense_form_field_values`
writes — explicitly treats `status = 'edited'` as an *unguarded* editable
status, and `apply_singular_expense_correction` sets exactly that status on
every correction. So the deferred guard silently skips the correction RPC's
own writes. Verified against a real expense (`aed3ae99...`, employee 5022,
txn `19935`): a correction that cleared "Project Unique ID" committed with no
error. A first fix (call `validate_expense_submission_invariants_v1`
unconditionally) was itself wrong — proven by the same real expense, which
predates the "From location"/"To location" requirement and has neither: full
current-policy validation blocked even a title-only correction unrelated to
From/To.

**Final design — baseline-aware, no-regression validation:** compare the
canonical structured diagnostic `expense_submission_integrity_issues_v1`
before and after the correction, in the same transaction, by identity
(`issue_code + issue_source + template_id + branch_field_id + field_key` —
never text or counts). An after-issue is rejected only when it is genuinely
new (no matching identity before) or concerns a template/branch this
correction actually touched (so a legacy defect cannot be mutated into a
different, or the same, defect and wave through as "not new"). Untouched
pre-existing legacy debt survives unchanged. Verified against real fixtures
in a throwaway restore: title-only edit on a legacy-incomplete expense
passes; stripping Project UID/ID/Name rejects with full atomic rollback;
partial and full legacy repair both pass; category-change-activates-new-
requirement rejects unless satisfied; Project-UID-change-with-stale-
dependents rejects, with-valid-dependents passes; a touched field mutated
into a *different* invalid value still rejects.

Also re-verified on the same restore: the `update_microlink_submitted_expense_v1`
owner-edit path (section 3 above) is unaffected — same id/txn/routing,
correct audit deltas, PW409, approved blocked — and legacy (non-MicroLink)
submitted-expense editing still works via its plain `UPDATE` path.

---

## 9) Related docs

- [atomic-expense-persistence-v2.md](./atomic-expense-persistence-v2.md) — DOC-125, the V1 architecture this hotfixes.

---

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-09-10 | 3.0 | Agent | Added the reviewer/admin correction RPC 404 incident (section 7): deployed the previously-unapplied `apply_singular_expense_correction` with its stale `app_role` literal corrected, then closed a real required-field-bypass gap found by rehearsal with a baseline-aware no-regression validator. Both migrations applied to Production after backup + throwaway restore + full test matrix + transactional dry run. |
| 2026-09-09 | 2.0 | Agent | Superseded rev 1.0's single-line fix (never applied to Production) after owner review found it would re-route a submitted expense's reviewer/engineer and duplicate the submission audit event. Replaced with a dedicated `update_submitted` action (`update_microlink_submitted_expense_v1`) that preserves routing/status and logs `expense_updated`, matching verified legacy client behavior. |
| 2026-09-09 | 1.0 | Agent | Root-caused and fixed the submitted-expense edit regression on `hotfix/submitted-expense-edit-regression`. |
