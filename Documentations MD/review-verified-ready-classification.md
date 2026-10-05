# Review Expenses — Canonical Manager Approval Readiness

**Doc ID:** DOC-115 (renumbered from DOC-113 on merge to `main` — `main` had
independently registered DOC-113/DOC-114 for the Tally/Additive-Credit work;
see [`index.md`](./index.md)'s Next ID history. The already-applied migration
[`20260902120000_review_canonical_manager_approval_ready.sql`](../supabase/migrations/20260902120000_review_canonical_manager_approval_ready.sql)
still says `DOC-113` in its header comment, left as originally authored per
this project's established provenance convention.)

**Status:** deployed to Production; branch preview pending

**Last updated:** 2026-09-02

**Owner / area:** Review Expenses, Approval Hierarchy, Supabase

## Summary

Bulk Approve classified fully verified final-Manager rows as “waiting” while
individual Review-batch approval worked. The defect was not React, caching,
PostgREST connectivity, or incomplete prerequisite verification. Production
had two different normal-approval decisions:

- the mutation path used `expense_manager_can_review`, which recognizes an
  active Manager through the employee’s reporting/supervisor chain;
- the preview path used `_debug_review_actionability_v1`, which only had the
  row’s persisted assignment UUIDs and required one of them to equal the
  caller.

Historical fully verified rows can retain the immediate Executive in those
assignment columns even when the next active `engineer`-role member in the
reporting chain is the configured business Manager. Consequently the mutation
authorized the Manager but the preview returned `not_assigned_to_caller`.

## Three UI paths

1. Singular Approve: `EngineerReview.approveExpense` → authoritative preview →
   `ExpenseService.approveExpense` → `review_approve_expense_v2` →
   `review_approve_expense`.
2. Individual Review-batch Approve: `BatchExpenseReviewPanel.runBatchAction` →
   `ExpenseService.processBatchReview` → per-row `approveExpense` → the same V2
   mutation. It did not call the toolbar preview RPC, which is why it was a
   useful working control.
3. Toolbar Bulk Approve: `handleBulkApprove` → `resolveApprovalTargets` →
   `classifySelectionServerAuthoritative` →
   `review_preview_approval_targets_v1` → dialog; ready rows then use the same
   V2 mutation.

## Final architecture

Migration
`20260902120000_review_canonical_manager_approval_ready.sql` introduces the
internal helper `_review_manager_normal_approval_ready_v1(expense, user_id)`.
Both normal Manager mutation and Bulk Preview call this exact helper.

The helper requires all of the following:

- a non-null authenticated caller;
- active `engineer` membership in the expense organization;
- canonical Manager visibility via `manager_expense_visible_to_user`, including
  the bounded reporting chain and configured team Manager;
- workflow readiness identical to the mutation contract: when hierarchy is
  enabled, lower Team Leader/Executive tiers are excluded and only the normal
  Manager-stage statuses are accepted; without hierarchy, the existing direct
  Manager statuses are preserved.

Approval limits remain a separate classification because the dialog has a
dedicated Over Limit bucket and the mutation independently enforces the same
organization setting. Manager Override remains a distinct RPC and is not used
for normally ready rows.

The internal helper is `SECURITY DEFINER`, pins `search_path`, is executable by
neither `anon` nor `authenticated`, and can only be reached through the existing
scoped RPCs. The browser RPC grants remain authenticated-only.

## Production evidence and deployment

- The affected business hierarchy was verified from canonical memberships and
  the reporting chain: employee → Executive → Manager.
- Verification audit history proved the Executive tier had completed before
  the affected rows reached `level_2_verified` / `engineer` tier.
- Before the fix, the Manager’s mutation authorization helper returned true
  while preview returned false with `not_assigned_to_caller`. The Executive
  returned false for normal Manager authorization.
- The candidate migration was first applied to the isolated restored audit
  database. Stage-safety, caller-role, no-membership, terminal-state, preview,
  and grant matrices passed there.
- Fresh Production checkpoint:
  `20260902T104502Z-pre-review-canonical-manager-approval`. Its SHA-256 was
  recorded beside the dump and `pg_restore -l` parsed 2,349 lines.
- The first Production apply attempt failed on legacy function ownership and
  rolled back atomically. The same migration then succeeded under the existing
  function-owner database role.
- PostgREST received the `pgrst` reload notification and loaded 262 functions.
- The current 27-ID acceptance population classified 21 ready, 0 waiting, and
  6 terminal (live statuses had changed since the earlier screenshot).
- Representative fully verified rows returned `approve`, `reject`, and
  `correct` for the Manager; the Executive remained denied.
- No expense status, approval record, balance, deduction, or routing metadata
  changed during QA.

## Data conclusion

The previously counted historical assignment rows are **not proven corrupt**.
They may be legacy routing provenance. No mass assignment rewrite was performed
or included in the migration. A future data repair would require a separately
reviewed manifest and contract proof.

## Tests

- SQL contract tests require preview and mutation to call the same helper and
  enforce organization, active membership, stage, grants, and zero routing DML.
- Approval hierarchy tests reject role-mismatched final-tier assignment as an
  authorization override.
- Bulk classification covers 26 ready + 1 terminal.
- The extracted real dialog panel renders the same canonical payload as Ready
  26 / Waiting 0 / Over Limit 0 / Completed 1, enables “Approve 26 ready now”,
  and renders no Manager Override action.

## Post-approval reconciliation follow-up

Owner QA exposed a separate client lifecycle defect after the canonical
classification fix. The warning dialog deliberately remained open after the
approval click, so its stale ready IDs could be submitted again. The mutation
correctly rejected that replay as “already approved”, but the bulk runner
misreported those terminal rows as failures. The page refresh was also
fire-and-forget and retained in-memory, return-navigation, and local-storage
caches, allowing Level 2 Verified rows and obsolete filtered page counts to
remain visible temporarily.

The follow-up closes the one-shot dialog before any approval request, treats a
fresh server “already approved” response as terminal reconciliation rather
than failure, evicts settled rows and reviewer caches, and awaits the canonical
query refresh. If approvals shrink a filtered queue below its current page,
the client clamps to and fetches the new last page. Fully settled batch
selections are cleared; genuinely failed children remain selected and
retryable. This revision changes no SQL, approval authorization, balance logic,
or routing metadata.

## Revision log

| Date | Revision | Notes |
| --- | --- | --- |
| 2026-09-02 | 1.0–1.1 | Initial assigned-reviewer widening and later routing correction; retained in Git history as superseded forensic attempts. |
| 2026-09-02 | 2.0 | Re-verified Production, proved preview/mutation split-brain authorization, deployed the shared canonical helper without data repair, and added payload-to-dialog regression coverage. |
| 2026-09-02 | 2.1 | Fixed post-approval dialog replay, terminal-result reconciliation, reviewer-cache eviction, awaited refresh, and filtered-page clamping; pending owner QA before any merge to `main`. |
