# MicroLink Submitted-Expense Delete/Withdraw Failure — Root Cause + Fix

**Doc ID:** DOC-128
**Status:** in progress (code + migration written; migration NOT applied to Production; not merged to `main`; no browser QA in this session — see §6)
**Last updated:** 2026-09-22
**Owner / area:** Expenses (My Expenses page), MicroLink

---

## 1) Summary

MicroLink employees reported that expenses they tried to remove from "My Expenses" (transaction numbers 22841, 22844, 22846–22850, 23535 — all confirmed `status = 'submitted'`, zero balance deductions, zero review activity, still present in Production) stayed visible after clicking Delete and seeing a "Expense Deleted" success toast. Root cause: a September 9 security migration correctly restricted the owner hard-delete RLS policy on `expenses` to `status = 'draft'` only, but the frontend fix that should have shipped alongside it never reached `main` — `src/pages/Expenses.tsx` still offered "Delete" for `status = 'submitted'` and never checked whether the delete actually removed a row. This doc adds the safe replacement the removed action needed: a **Withdraw** action that recalls a submitted expense to draft (audit trail kept, no balance effect, invisible to reviewers), and rebuilds the draft hard-delete path as one atomic, server-authoritative RPC.

---

## 2) Problem / requirement

- **Reported:** submitted expenses "won't delete" for MicroLink employees.
- **Proven from Production (read-only):** all 8 screenshot transactions exist, all `organization_id = MicroLink`, all `status = 'submitted'`, zero rows in `expense_balance_deductions`, zero reviewer-action rows in `audit_logs` (only `expense_created`/`expense_submitted`).
- **Proven from the live database:** `pg_policy` on `public.expenses` has exactly two `DELETE` policies, both requiring `status = 'draft'` (owner and admin). The January-2025 permissive policies that used to allow deleting a `submitted` expense are gone. RLS is enabled and forced; the January-2025 `expenses`/`attachments` DELETE policies for `status = 'submitted'` are not present in the live policy set for `expenses` (only the two draft-only ones exist).
- **Proven from git history:** the frontend fix (`bf9f195`, hides "Delete" for non-draft) and an earlier, more conservative safety fix (`54cb7d1`, blocks the destructive multi-call delete entirely over a separate 2026-08-17 incident, DOC-096/DOC-078) both exist — on `dev` / `feature/doc-096-recovery` / backup branches — but neither is an ancestor of `main`. `main`'s `src/pages/Expenses.tsx` is older than both.
- **Never existed:** a withdraw/cancel/recall workflow for expenses, anywhere in this codebase's history (checked `git log --all -S/-G` for `withdraw_expense`, `cancel_expense`, `recall_expense`, `unsubmit`, `return_to_draft`, `expense_cancelled`, `withdrawn`, `can_delete`, `expense_delete` — no hits belonging to an expense feature).

### Exact failure mechanism

`Expenses.tsx`'s `handleDeleteExpense` required `status === "submitted"`, then called
`supabase.from("expenses").delete().eq("id", expenseToDelete.id)` with no `.select()`. RLS
filters that DELETE to zero matching rows (the row's status is `'submitted'`, and the only
live DELETE policies require `'draft'`), so PostgREST returns `error: null` — a legitimate
zero-row delete is indistinguishable from a real one at the `error` level. The handler never
checked row count, showed an "Expense Deleted" toast unconditionally, then called
`fetchExpenses()`, which re-fetched the still-present row from the server. The toast lied;
the row never left.

---

## 3) Solution

**Business-rule finding (task §0–§1):** the intended, currently-enforced rule is **A** — draft
expenses may be hard-deleted, submitted expenses may not (proven by the live RLS policy set
and the September 9 migration's own commit message, which explicitly closed the "owner can
delete their own submitted expense" gap as a financial-history risk). No existing withdraw
workflow was ever built (checked exhaustively — see §2). Per the task's own guidance ("If it
does NOT exist: design the safest workflow"), this doc implements one, matching the safe model
the task describes: submitted → Withdraw (recall to draft, kept in history, no balance effect,
removed from every reviewer queue) · approved/deducted → no delete, ever.

**Design decision — reuse `draft`, don't add a new status.** `draft` already has every
property "withdrawn" needs: editable, resubmittable (through the existing submit RPCs, which
already handle `rejected → submitted`; nothing new was needed there), excluded from every
reviewer-visibility RLS policy (all key off `submitted`/`edited`/`verified`/`level_1_verified`/
`level_2_verified`/`approved`, never `draft`), and already shown in the "All" tab per DOC-127.
`expense_status_transition_allowed_v1` (the canonical state-machine rule, DOC-122) only guards
*leaving* `draft`; a transition *from* any non-draft status — including `submitted → draft` —
was already legal, just never used by anything. Reusing it avoids inventing a new
half-supported enum value and the 19+-file audit that would require (the same reasoning
`54cb7d1` used to reject a new soft-delete column).

**New server-side objects** (migration
`supabase/migrations/20260922090000_expense_withdraw_and_safe_draft_delete_v1.sql`, **not
applied to Production**):

- `withdraw_submitted_expense_v1(p_expense_id, p_comment)` — SECURITY DEFINER RPC. Locks the
  expense row first (`SELECT ... FOR UPDATE`, the same lock ordering every review RPC in this
  schema already uses), checks ownership + active org membership, checks
  `status = 'submitted'` (idempotent no-op if already `'draft'`), defense-in-depth checks that
  no `expense_balance_deductions` row and no reviewer-action `audit_logs` row exists, sets
  `status = 'draft'`, and writes an `expense_withdrawn` audit_logs row. Never deletes anything.
- `delete_draft_expense_v1(p_expense_id)` — SECURITY DEFINER RPC. Same lock/ownership/org
  checks, requires `status = 'draft'`, and — the one rule that matters — **refuses to delete a
  draft that was ever submitted** (checked via an `expense_submitted` audit_logs row), so a
  withdrawn-then-abandoned expense keeps DOC-078's "no browser code can physically delete a
  linked receipt" guarantee exactly like a submitted expense does. Only a draft that was NEVER
  submitted may be permanently erased. Deletes attachments + audit_logs + the expense row
  atomically in one transaction, and returns the attachment storage paths (+ `batch_id`/
  `organization_id`, for a batch line item) so the client can do best-effort Storage cleanup
  and the pre-existing batch-aggregate resync afterwards. Idempotent (already-gone is success).
- One-line RLS hardening on `"Users can update their own submitted expenses"`: its `WITH CHECK`
  never actually constrained the new row's `status`, so an ordinary client UPDATE could already
  have silently moved a submitted expense to `draft` (or anywhere else) with no audit trail and
  none of the RPC's checks. Added `AND status = 'submitted'::expense_status` to `WITH CHECK`.
  Pure narrowing — every legitimate use of this policy (editing a submitted expense's fields)
  already leaves `status` untouched, and both new RPCs are `SECURITY DEFINER` and bypass RLS
  entirely, so neither is affected.

**Frontend** (`src/pages/Expenses.tsx`, `src/lib/expenseEditRules.ts`,
`src/lib/expenseWithdrawAndDelete.ts` — new):

- `canOwnerHardDeleteExpenseStatus(status)` — `true` only for `'draft'` (matches the RLS
  policy exactly; the dropdown no longer offers Delete for anything the server will refuse).
- `canOwnerWithdrawExpenseStatus(status)` — `true` only for `'submitted'`.
- The dropdown now shows **Withdraw** for a submitted expense and **Delete** for a draft
  (never both, never neither, for any status in the enum — asserted by a test).
- Both handlers call the new RPCs through `expenseWithdrawAndDelete.ts` (never a raw
  `.from("expenses").delete()`/`.update()` again), check the RPC's own error and its `ok`
  field — there is no "0 rows, no error" outcome left to misinterpret — and only then show a
  success toast and refetch. A destructive-action failure now surfaces a real, specific error
  (e.g. "This expense was previously submitted and withdrawn... cannot be permanently
  deleted") instead of a false success.
- Confirmation dialogs updated: Withdraw's copy states plainly that nothing is deleted, the
  balance is unaffected, and the expense returns to Drafts.

**Deliberately out of scope for this pass:** the mobile "My Expenses" view
(`MobileExpenseListView`/`MobileExpenseCard`) has no delete/edit/withdraw menu at all today —
confirmed by reading both files — so there is no mobile duplicate of this bug to fix, only a
pre-existing, separate feature gap (mobile users currently have no way to remove *any*
expense). Flagged as a follow-up, not implemented here, to keep this fix to its actual
incident.

---

## 4) Key files

```
src/pages/Expenses.tsx
src/lib/expenseEditRules.ts
src/lib/expenseWithdrawAndDelete.ts                              (new)
src/lib/__tests__/expenseEditRules.test.ts                       (new)
src/lib/__tests__/expenseWithdrawAndDelete.test.ts               (new)
supabase/migrations/20260922090000_expense_withdraw_and_safe_draft_delete_v1.sql   (new, NOT applied)
```

---

## 5) Database / migrations

`supabase/migrations/20260922090000_expense_withdraw_and_safe_draft_delete_v1.sql` — **written,
reviewed, NOT applied to Production** (per this repo's convention: the user runs SQL manually).
Adds two new functions (`withdraw_submitted_expense_v1`, `delete_draft_expense_v1`) and replaces
one existing RLS policy (`"Users can update their own submitted expenses"`) with a narrower
version. Contains its own install-time `DO $verify$` block (function existence,
`expense_status_transition_allowed_v1('submitted','draft')` still true, and the RLS hardening
took effect) and reuses the existing canonical transition rule rather than adding a second one.

No Production DDL or DML was executed in this session. Apply this file manually, then reload
PostgREST's schema cache (`NOTIFY pgrst, 'reload schema'` or the Supabase dashboard's reload
action) so `withdraw_submitted_expense_v1`/`delete_draft_expense_v1` become callable via
`supabase.rpc(...)`.

---

## 6) Test plan

Automated (this session): `src/lib/__tests__/expenseEditRules.test.ts` (9 tests — every status
in the enum against both new predicates, proving they're mutually exclusive) and
`src/lib/__tests__/expenseWithdrawAndDelete.test.ts` (11 tests — correct RPC name/params,
idempotent replay for both actions, error propagation with the server's own message, best-effort
Storage cleanup that never fails the whole action, batch aggregate resync data surfaced
correctly). `npx tsc --noEmit`: 0 errors (0 in the touched files). `npm run build`: succeeds.
`npm run migrations:check` / `npm run security:secrets`: clean. Full suite:
4250/4251 passing — the one failure (`MaintenanceAdminDashboard — preview environment >
redirects to login when not authorized`, a 5000ms timeout) is an unrelated, pre-existing flake:
it passes standalone (11/11) when run in isolation, and touches nothing this change modified.

**Not performed this session (disclosed, not silently skipped):** the SQL migration was not
applied to any reachable database (no live Postgres/Supabase connection available for
mutation testing in this pass; Production DML/DDL was 0 throughout, by design), so the RPCs'
actual runtime behaviour (row locking under concurrency, the RLS hardening's real effect,
idempotency against a live row) is proven by static review and unit tests against a mocked
client, not by execution. No live-browser QA was performed against a Preview deployment.

### Manual QA steps (once the migration is applied and this branch is deployed to Preview)

1. As a MicroLink employee, create a synthetic expense and submit it (never use the real
   screenshot transactions for this).
2. Open "My Expenses" → three-dot menu on that row → confirm it shows **Withdraw**, not
   Delete.
3. Click Withdraw → confirm the dialog copy → confirm: row now shows status Draft, balance
   unchanged, a toast says "Expense Withdrawn".
4. Reload the page → confirm the expense is still Draft (survives refetch).
5. Open the three-dot menu again → confirm it now shows **Delete**, not Withdraw.
6. Click Delete → confirm: the RPC refuses ("previously submitted and withdrawn... cannot be
   permanently deleted") — this expense must NOT be erasable, because it has real submission
   history.
7. Create a second synthetic expense, leave it as Draft without ever submitting, then Delete
   it → confirm it is actually gone (reload, refetch) and any attached receipt is removed from
   Storage.
8. As a reviewer, confirm a withdrawn (now-draft) expense no longer appears in the review
   queue, and confirm withdrawing an expense someone just approved is rejected with a clear
   "already reviewed" error (simulate the race: approve first, then attempt withdraw on the
   same row).
9. Cross-org: confirm a different organization's employee cannot withdraw or delete this
   expense (RPC raises "You don't have permission").
10. Confirm the real screenshot transactions (22841, 22844, 22846–22850, 23535) are untouched
    throughout this QA — they were never mutated during diagnosis and must not be used as test
    subjects.

---

## 7) Related docs

- DOC-122 — Expense State-Machine Integrity + Transaction-Number Guarantee (the canonical
  `expense_status_transition_allowed_v1` rule this fix relies on, unmodified).
- DOC-127 — Exact Month+Year Expense Filtering (confirms drafts are not excluded from the
  "All" tab's list — the same list a withdrawn expense will now appear in).
- DOC-126 — Submitted-Expense Edit Regression Hotfix (the existing, unrelated
  `update_microlink_submitted_expense_v1` edit-while-submitted path this fix does not touch).

---

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-09-22 | 1.0 | Claude Code | Initial diagnosis + fix. Root cause proven from Production (read-only), git history and live RLS. New Withdraw/safe-delete RPCs + frontend wiring + 20 new tests. Migration written but NOT applied; branch not merged to `main`; no live-browser QA yet. |
