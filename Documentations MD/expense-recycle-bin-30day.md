# Expense Recycle Bin — 30-Day Soft Delete

**Doc ID:** DOC-129
**Status:** in progress (code + migration applied; daily purge scheduled and proven; branch NOT merged to `main` yet, pending final sign-off)
**Last updated:** 2026-09-22
**Owner / area:** Expenses (My Expenses page), all organizations

---

## 1) Summary

DOC-128 made `delete_draft_expense_v1` correctly refuse to permanently erase a draft that was ever submitted-then-withdrawn, to protect its audit history — but that left an employee with no way to remove such an expense from their active list at all: Delete always failed with "This expense was previously submitted and withdrawn... cannot be permanently deleted." This feature replaces immediate hard-delete with a 30-day Recycle Bin: Delete now soft-deletes (`deleted_at`/`deleted_by`/`purge_after`), Restore brings it back as a draft within 30 days, and an unattended daily job permanently purges anything past its retention window. A withdrawn draft can now be deleted — its history is preserved by the soft delete itself, not by refusing the action.

---

## 2) Problem / requirement

- Delete must no longer mean immediate physical deletion. It means "move to Recycle Bin," 30-day retention, restorable, then automatically purged.
- A previously submitted/withdrawn draft must be allowed to enter the Recycle Bin — that is the entire point.
- Submitted expenses continue to show **Withdraw**, never Delete — the two actions are never combined silently; the path is always Submitted → Withdraw → Draft → Delete → Recycle Bin.
- Financially-posted or reviewed expenses (approved, level_1/2_verified, paid, anything with a balance deduction) remain unreachable by an ordinary employee's Delete, exactly as before.
- No new workflow `status` value. Deletion is an orthogonal lifecycle state (`deleted_at`), never conflated with `status`.

---

## 3) Solution

### Data model (Part C/D)
`expenses.deleted_at` / `deleted_by` / `purge_after` — nullable, additive columns. `status` is never touched by trash/restore beyond what Withdraw already does. Active = `deleted_at IS NULL`. In the bin = `deleted_at IS NOT NULL AND purge_after > now()`. Purge-eligible = `deleted_at IS NOT NULL AND purge_after <= now()`. Existing rows: `ADD COLUMN` with no default, so every pre-existing row is simply `deleted_at = NULL` (active) — metadata-only, no table rewrite, no business row touched. Three partial indexes support the recycle-bin listing and the daily purge scan without touching the (far more common) active-row scan plans.

### RPCs
- **`trash_expense_v1(p_expense_id)`** — owner-only, `status = 'draft'` only (never-submitted or withdrawn-back-to-draft, both eligible), refuses if a balance deduction exists, idempotent, writes an `expense_trashed` audit row. Never touches `attachments`/`audit_logs`/`expense_balance_deductions` — nothing is deleted.
- **`restore_trashed_expense_v1(p_expense_id)`** — owner-only, requires `deleted_at IS NOT NULL AND purge_after > now()`, clears all three trash columns, always returns as **draft** (never resubmits, never re-enters review), writes an `expense_restored` audit row.
- **`list_trashed_expenses_v1(p_organization_id)`** — deliberately `SECURITY INVOKER` (the default): it relies entirely on the *already-live* owner/admin SELECT RLS on `expenses` (no new privilege is created; a trashed row's owner/org-admin visibility is unchanged by this migration).
- **`purge_expired_trashed_expenses_v1()`** — `service_role`-only, never callable by an ordinary client (confirmed live: calling it via PostgREST as `anon` returns `42501 permission denied`, not `PGRST202 not found`, proving it is registered and correctly locked down). Loops `FOR UPDATE SKIP LOCKED` over every `purge_after <= now()` row, rechecks eligibility per-row, writes one `purged_expense_tombstones` row (no FK to `expenses` — every child FK onto `expenses` is `ON DELETE CASCADE`, confirmed live, so an ordinary audit row would vanish with the parent; the tombstone is the only durable record), then deletes the row (cascading every child table automatically). Idempotent — a row already gone or already restored is simply not selected.
- **`mark_tombstone_storage_cleaned_v1(id)`** — `service_role`-only; lets the daily purge script mark a tombstone's Storage cleanup done once the Storage API delete actually succeeds, so a failed cleanup is retried on the next run rather than lost (Part N's "DB deleted, Storage half-failed, no recovery" case is explicitly avoided).

### Why no new RLS policy was needed for `deleted_at` itself
Checked live before writing a single line: there has never been an owner UPDATE policy for a **draft** row at all except "Users can submit their draft expenses" (`status='draft' → status='submitted'` only). Editing a draft's fields — and now trashing/restoring one — has therefore never been reachable via a raw client UPDATE; it already required a SECURITY DEFINER RPC. `deleted_at`/`purge_after` inherit that same closed door for free. Proven live with a real attempt: an authenticated owner's raw `UPDATE expenses SET deleted_at = now() ...` on their own draft returns `ERROR: new row violates row-level security policy for table "expenses"` — a loud, explicit rejection, not a silent no-op.

### Superseding the old hard-delete path (Part H)
`delete_draft_expense_v1` (DOC-128) is **not dropped** — its dependencies weren't re-audited for removal — but `authenticated`'s `EXECUTE` grant is revoked, closing the only client-reachable hard-delete bypass. Confirmed live: `has_function_privilege('authenticated', 'delete_draft_expense_v1(uuid)', 'EXECUTE')` is now `false`.

### A real bug found and fixed during this migration's own QA
`withdraw_submitted_expense_v1` (DOC-128)'s "no review activity on record" defense-in-depth check enumerated an allow-list of expected `audit_logs` actions that predates this feature's two new ones (`expense_trashed`, `expense_restored`). Without a fix, an expense that had ever been through one ordinary trash→restore cycle could never be withdrawn again afterwards — it would wrongly report "review activity on record." Found by the QA harness itself (attempting to withdraw a synthetic expense for cleanup), fixed by widening the allow-list in a new `CREATE OR REPLACE FUNCTION` in this same migration (the already-applied DOC-128 file was not edited, per instruction).

### Active-read audit (Part K)
A full-codebase inventory was done first (every `.from("expenses")` / `FROM public.expenses` call site, client and SQL). **Patched** (the explicitly in-scope, highest-traffic contracts): My Expenses (`get_my_expenses_page_v1` + the client's own count/list/month-range queries), the live Review Expenses reviewer queue (`count_reviewer_visible_expenses` + `list_reviewer_visible_expenses_page`), Batch Review's two fetch queries, Accountant Approved Expenses (defense-in-depth — approved expenses can't be trashed today), and the dashboard pending-approvals RPC + its client fallback. **Deliberately left alone**, confirmed historical/accounting: `report_balance_timeline_rows_v3` (the Detailed Expense ledger, keyed off `expense_balance_deductions`, never live `status`) and `report_expense_rows_v1` (Claim Verification/Approval snapshot exports). **Flagged, not touched, needs an explicit owner decision**: My Teams' approved-tile, Daily Project Report, Analytics trend chart, Old Money's trend chart, Admin Submission History, the `UserManagement.tsx` per-employee drill-down, and the legacy client-merge reviewer-queue fallback paths still wired into `EngineerReview.tsx` (`managerReviewExpenses.ts`, `hierarchyReviewExpenses.ts`) — these are lower-risk than they sound: **trash is draft-only, and a draft has always been excluded from every reviewer query by its status filter alone**, independent of `deleted_at`, so leaving them unpatched creates no live gap for the actual product requirement today. Widening this list later needs no schema change, only another `CREATE OR REPLACE`.

### Frontend
`src/lib/expenseRecycleBin.ts` (new) — `trashExpense`, `restoreTrashedExpense`, `listTrashedExpenses`, plus `daysUntilPurge`/`purgeCountdownLabel` for the exact "29 days remaining / Deletes tomorrow / Deletes today" wording. `src/pages/Expenses.tsx`'s Delete action now calls `trashExpense` (never `deleteDraftExpense` again), with copy updated to "Move to Recycle Bin?" / "Expense Moved to Recycle Bin." A new **Recycle Bin** tab (`src/components/ExpenseRecycleBinPanel.tsx`, new) sits alongside "All Expenses"/"Drafts", using the existing table/badge design system, showing Destination/Amount/Expense Date/Deleted On/Days Remaining/Restore — no "Delete Permanently" button in this UI, per the product decision to keep purge fully automatic.

### Purge worker (Part N)
No `pg_cron` (or any Postgres scheduler extension) is installed on this self-hosted instance — checked live, confirmed absent. This project already has an established pattern for exactly this kind of job (DOC-111's report-export dispatch): a host crontab entry calling `docker exec ... psql` directly, no new HTTP surface, no duplicated secret. `scripts/purge-trashed-expenses.sh` mirrors that pattern precisely — daily, calls `purge_expired_trashed_expenses_v1()`, then retries Storage cleanup for any tombstone still marked `storage_cleanup_done = false` (today's or a previous run's), using the `service_role` key read fresh from the edge-functions container's own environment. Overlap-protected with a non-blocking `flock` (same idiom as `supabase-backup.sh`) — proven live by holding the lock externally and confirming a concurrent invocation skips cleanly rather than running twice.

**Installed and proven, not just prepared**: deployed to `/home/webadmin/purge-trashed-expenses.sh`, crontab entry added (`17 3 * * *`, a low-traffic window, logged to `/home/webadmin/purge-trashed-expenses.log`), without disturbing the existing `report-worker-dispatch.sh` entry. Before installing, the script was run manually end-to-end against real synthetic data multiple times, which caught and fixed a **real bug**: this self-hosted Storage API returns HTTP **400** at the transport layer for a "delete a non-existent object" request, even though its own JSON body correctly reports `"statusCode":"404"` — the script's original naive HTTP-status check (`200`/`204`/`404` = success) treated every "already gone" cleanup as a failure and would have retried it forever. Fixed to also treat a body containing `"error":"not_found"` as success regardless of the wire status code, confirmed against a real object: upload → genuine `200` delete confirmed, and a repeat delete of the same (now-gone) object confirmed the exact `400`/`not_found` shape that triggered the bug. Re-verified full round trip afterward: a synthetic expense with a genuinely-uploaded Storage object, trashed, expired, purged, and the real object confirmed actually removed from Storage (a second, independent `GET .../object/info/...` lookup returned `404` after the run).

---

## 4) Key files

```
supabase/migrations/20260922120000_expense_recycle_bin_v1.sql   (new, APPLIED to the shared DB)
scripts/purge-trashed-expenses.sh                                (new, NOT installed on the crontab)
src/lib/expenseRecycleBin.ts                                     (new)
src/components/ExpenseRecycleBinPanel.tsx                        (new)
src/lib/expenseEditRules.ts                                       (canOwnerTrashExpenseStatus added)
src/pages/Expenses.tsx                                            (Delete -> trash_expense_v1; Recycle Bin tab)
src/components/BatchExpenseReviewPanel.tsx                        (deleted_at IS NULL added, 2 queries)
src/pages/AccountantApprovedExpenses.tsx                          (deleted_at IS NULL added)
src/lib/dashboardStats.ts                                         (deleted_at IS NULL added, 2 queries)
src/lib/__tests__/expenseRecycleBin.test.ts                       (new)
src/lib/__tests__/expenseEditRules.test.ts                        (canOwnerTrashExpenseStatus tests added)
```

---

## 5) Database / migrations

`supabase/migrations/20260922120000_expense_recycle_bin_v1.sql` — written, dry-run tested (`BEGIN...ROLLBACK`, verified 0 business-row impact and full revert), backed up (fresh `pg_dump -Fc`, `pg_restore --list` validated), and **applied to the shared Production/Preview database**. Adds 3 columns + 3 partial indexes to `expenses`, 1 new table (`purged_expense_tombstones`, RLS enabled, org-admin SELECT only), 5 new functions, and `CREATE OR REPLACE`s 5 existing functions (4 active-read filters + the `withdraw_submitted_expense_v1` allow-list fix) byte-for-byte from their live definitions plus exactly the stated change each. Revokes `authenticated`'s `EXECUTE` on `delete_draft_expense_v1`. Its own install-time `DO $verify$` block checks all of the above, including that not a single pre-existing row was marked deleted by the migration itself.

No PostgREST restart needed — `NOTIFY pgrst, 'reload schema'` was sent and confirmed received in the container logs; all 5 new RPCs verified live via direct calls returning `42501 permission denied` (registered, correctly locked down) rather than `PGRST202` (not found).

---

## 6) Test plan

Automated: `expenseRecycleBin.test.ts` (13 tests: RPC param/result shape, idempotent trash/restore, error propagation, `daysUntilPurge`/`purgeCountdownLabel` exact wording) + `canOwnerTrashExpenseStatus` added to `expenseEditRules.test.ts` (mutual-exclusivity with hard-delete/withdraw across every status). 37 total expense-action tests passing. `tsc`: 0 errors. `npm run build`: clean. `migrations:check`/`security:secrets`: clean.

**Live synthetic QA (read the full transcript for exact output) — all of the following were run against the real shared database with genuinely authenticated `authenticated`-role sessions (JWT-claim simulation, matching this project's own established validation convention), using only synthetic org/user/expense fixtures, never the real screenshot transactions:**

- [x] New draft → trash → disappears from `get_my_expenses_page_v1` → appears in `list_trashed_expenses_v1`.
- [x] Restore → disappears from the bin → reappears in the active list, status still `draft`.
- [x] Submitted expense → `trash_expense_v1` correctly refused ("Only a draft expense can be moved to the Recycle Bin... withdrawn first").
- [x] **The actual reported bug**: Submitted → Withdraw → Draft → Delete **succeeds** (previously refused outright by `delete_draft_expense_v1`).
- [x] Recycle Bin lists the withdrawn-then-trashed expense.
- [x] Restore it → draft → resubmit succeeds → full 5-event audit history intact (submitted, withdrawn, trashed, restored, submitted again) — nothing lost.
- [x] Balance unchanged throughout (`0.00` → `0.00`, 0 deduction rows) at every step.
- [x] Reviewer-queue filter proven with a constructed edge case: two otherwise-identical `submitted` rows, one forced `deleted_at IS NOT NULL` — the reviewer RPC returns the control row and excludes the trashed one.
- [x] Cross-user trash/restore denied ("You don't have permission...").
- [x] Cross-org trash/restore denied.
- [x] Direct `deleted_at`/`purge_after` mutation by the owner denied by RLS with a loud `ERROR: new row violates row-level security policy` (not a silent 0-row no-op).
- [x] Expired item: `restore_trashed_expense_v1` refused ("retention period... expired"); `purge_expired_trashed_expenses_v1()` purges it.
- [x] Receipt (synthetic attachment) survives a trash→restore cycle intact; on permanent purge it cascades away and its storage path is correctly captured in the tombstone (`storage_cleanup_done = false`, ready for the purge script's retry).
- [x] Idempotency: a second `purge_expired_trashed_expenses_v1()` call finds nothing (0 purged).
- [x] **Race safety, real concurrent sessions** (not simulated): submit-vs-trash — the submit won the lock, trash blocked then correctly failed once it saw the fresh `submitted` status; restore-vs-purge — the purge won the lock, restore blocked then correctly failed with "Expense not found" once the row was truly gone. Neither race left an inconsistent state.
- [x] The 8 real screenshot transactions (22841, 22844, 22846–22850, 23535) re-checked byte-identical after every phase of this work — untouched throughout.

All synthetic fixtures created for this QA were cleaned up afterward (withdrawn, trashed, and purged for real, or the actors deleted outright) — nothing artificial was left behind beyond DOC-128's own pre-existing, intentionally-permanent, clearly-marked residue.

**Re-verified at the final release gate** (a second, independent QA pass, same shared database, current live code, all synthetic): the exact critical business flow end-to-end with full audit history and financial safety, active-list filtering, reviewer-queue filtering (including a fresh withdraw+trash+restore-stays-draft cycle against a real assigned reviewer), 6 security-denial cases (other-user, cross-org, unauthenticated ×2, direct RLS mutation, ordinary-user purge-call), a real concurrent-session submit-vs-trash race, idempotent double-trash/restore, receipt survival through trash+restore, and 30-day expiry + purge + idempotent re-purge. All passed; balance and deduction counts unchanged throughout. A precise byte-level audit of `withdraw_submitted_expense_v1` (the one function patched via a standalone snippet rather than the full migration file) found and fixed a real, if purely cosmetic, drift — an intermediate file write had silently introduced Windows CRLF line endings into the live function body; re-applied from the git-tracked file directly, confirmed byte-identical afterward.

**Not done in this session**, disclosed rather than silently skipped: live browser/UI click-through (the Preview is gated by Vercel's own SSO; the user explicitly chose to proceed on backend+code evidence only rather than share access), and the full remediation of every "needs owner decision" active-read call site listed in §3 above.

---

## 7) Related docs

- DOC-128 — MicroLink Submitted-Expense Delete/Withdraw Failure (the Withdraw action and the `delete_draft_expense_v1` refusal this feature replaces).
- DOC-111 — Report Export Worker Automatic Dispatch (the host-crontab + direct-`docker exec` pattern this feature's purge script mirrors).
- DOC-122 — Expense State-Machine Integrity (the canonical `expense_status_transition_allowed_v1` rule this feature never modifies — `deleted_at` is deliberately orthogonal to it).

---

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-09-22 | 1.0 | Claude Code | Initial implementation. Migration applied to the shared Production/Preview database (dry-run + backup + install-time verify all passed). Full synthetic QA (15+ scenarios incl. 2 real concurrent-session races) passing. A real pre-existing gap in `withdraw_submitted_expense_v1`'s audit allow-list found and fixed during QA. Purge script written, not yet installed on the crontab. Branch not merged to `main`, pending sign-off per explicit instruction. |
