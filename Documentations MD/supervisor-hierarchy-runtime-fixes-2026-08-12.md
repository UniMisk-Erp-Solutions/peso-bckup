# Supervisor Hierarchy Runtime Fixes — Pending-Stage Sync, Role/Tier Divergence, Employee-ID Persistence, Batch Eligibility Gap

**Doc ID:** DOC-091
**Status:** deployed
**Last updated:** 2026-08-12
**Owner / area:** Expense Hierarchy Review, Admin Panel (User Management, Create User)

---

## 1) Summary

Four related defects on `debug/6456-supervisor-auth-runtime`, all touching the same subsystem
(hierarchy review routing and reviewer eligibility), found and fixed in one continuous debug/QA
pass against Production (MicroLink, Mistry And Shah orgs):

1. **Issue 1 — pending-next-stage reviewer never resynced.** A supervisor change after Level 1
   (or Level 2) had already been verified left the still-pending NEXT stage pointing at the OLD
   hierarchy's reviewer forever.
2. **Issue 2 — misleading "run this migration" error on a role/tier mismatch.** A reviewer whose
   role changed before Verify got a hardcoded migration-name error instead of the server's actual
   outcome.
3. **Issue 3 — `admin-create-user` reported success while `employee_id` silently failed to
   persist.** Root cause of the Production Nitin Parmar / employee 2417 duplicate-account
   incident (8 profiles in MicroLink).
4. **Issue 4 (found during this session's browser QA of Issues 1–3) — Batch Review silently
   blocked executive-tier Level 2 verification.** The dedicated Batch Review page's client-side
   eligibility map never learned about `level_1_verified`, so an executive selecting a
   Level-1-verified batch line always saw "0 eligible expenses" — while the identical action on
   the identical expense succeeded through the single-expense review dialog. Confirmed live via a
   real Production QA A/B (expense 00098 single vs 00099/00100 batch, same reviewer, same status).

---

## 2) Problem / requirement

### Issue 1 — stale pending-stage reviewer

The existing sync trigger (`20260812121000_sync_pending_expenses_on_supervisor_change.sql`, from
an earlier fix in this branch) deliberately only resyncs never-yet-verified rows (`status IN
(submitted, edited, under_review)`) to avoid rewriting completed hierarchy history. That left a
real gap: once Level 1 (or Level 2) completes and the employee's hierarchy changes afterward,
`assigned_reviewer_id`/`assigned_engineer_id` for the still-pending NEXT tier keep pointing at the
OLD hierarchy's reviewer forever — the same "stale snapshot vs current hierarchy" shape as the
original incident, one tier later.

### Issue 2 — misleading migration-name error

`ExpenseService.verifyExpense` derived the caller's approval tier from the expense's possibly
stale `approval_tier` snapshot rather than the caller's CURRENT role. When those disagreed (e.g. a
reviewer's role changed to `executive` after being assigned at `team_leader`), the client predicted
one status, the server (authoritative) returned another, and the mismatch was reported as "Run
Supabase migration `20260524260000_fix_hierarchy_verify_status_by_role`…" — a migration that was
already live. The message named the wrong cause and gave the reviewer nothing actionable.

### Issue 3 — admin-create-user discarded the profile-update result

`admin-create-user` (Edge Function) wrote `profiles.employee_id` via `.update(profileUpdate)`
without ever reading the result or checking for an error, then unconditionally returned
`success: true`. Because `profiles.employee_id` is unique per organization
(`idx_profiles_organization_employee_id_unique`), every retry after the owner saw "success" but no
saved `employee_id` created a NEW `auth.users` row and a NEW `organization_memberships` row, none
of which could ever persist the id. Live Production (MicroLink) evidence: 8 "Nitin Parmar" profiles,
only the first (2026-08-11 11:55:19) correctly holding `employee_id = '2417'`, the other 7 created
over the following ~17 hours with `employee_id = ''`.

### Issue 4 — Batch Review's hardcoded status map never learned `level_1_verified`

`src/lib/batchExpenseReview.ts`'s `engineerActionsForExpense` was extended in commit `937a957`
(2026-07-06) to add `level_2_verified → [reject, approve]` for the engineer/manager tier, but the
parallel case for the **executive** tier — `level_1_verified → [reject, verify]` — was never added
to `hierarchyReviewerActionsForExpense`, which both `team_leader` and `executive` share. That
function only ever returned `[reject, verify]` for `status IN (submitted, edited)` — the
team_leader's own trigger statuses — so an executive could never see a `level_1_verified` batch
line as eligible for anything. Selecting such lines on the Batch Review page always showed "No
eligible expenses selected" / "Verify 0 expenses", with no error toast and no indication anything
was wrong — a **silent** dead end. The single-expense review dialog was unaffected because it reads
eligibility from the server's `available_actions` (see `src/features/reviewActions/actionEligibility.ts`),
not from this hardcoded client map.

---

## 3) Solution

### Issue 1 — extend the existing sync trigger, don't add a second algorithm

`20260812140000_sync_pending_next_stage_on_supervisor_change.sql` extends the SAME trigger
function (`sync_pending_expenses_on_supervisor_change`, `CREATE OR REPLACE`, no new trigger) with
two more blocks, mirroring the same priority rules `src/lib/approvalHierarchy.ts` already uses at
verify time:

- **Block 2** — resyncs `status = 'level_1_verified' AND approval_tier = 'executive'` rows to the
  CURRENT correct executive (`resolveExecutiveReviewerId`'s priority: new supervisor if
  role=executive, else that supervisor's own boss if role=executive, else `teams.executive_user_id`).
- **Block 3** — resyncs `status = 'level_2_verified' AND approval_tier = 'engineer'` rows the same
  way for the manager/engineer tier (`resolveReviewerForTier('engineer', ...)`'s priority).

Neither block ever writes to `status` (verified by the migration's own SET-clause guard) and both
are idempotent (`IS DISTINCT FROM`) and self-review-guarded (`<> NEW.user_id`). Completed history —
who verified Level 1/2, when, and their comment — is never touched.

### Issue 2 — trust the server's actual outcome, derive tier from current role

`ExpenseService.ts`: tier is now derived from a freshly re-verified `currentRole` (via
`fetchMembershipRole`) on every branch, not the expense's stale `approval_tier` snapshot. The
misleading hardcoded migration-name error string was removed entirely; a genuine no-op (server
returns the expense unchanged) now throws an honest "did not advance" error instead. The
audit-log tier label is derived from the server's actual returned `status`, never the pre-RPC
client guess.

### Issue 3 — verify the write, roll back only what this call created

`admin-create-user/index.ts`: pre-checks the Employee ID for a conflict in this organization BEFORE
creating any auth user (catches the common case with a clean 409, no rollback needed). The
`profiles.employee_id` update now reads back `{ data: updatedProfile, error: profileUpdateError }`
and derives `employeeIdPersisted = !employeeId || updatedProfile?.employee_id === employeeId`. Any
of `profileUpdateError`, missing `updatedProfile`, or a not-actually-persisted `employee_id` rolls
back ONLY the `auth.users` row this invocation just created (`serviceClient.auth.admin.deleteUser(userId)`)
and returns a 409 for the duplicate-ID case, 400 otherwise — never a false `success: true`. The
success response now echoes `employee_id: updatedProfile.employee_id ?? null` so the caller can
verify what was actually saved.

### Issue 4 — add the missing executive-tier case, mirroring the engineer-tier one

`src/lib/batchExpenseReview.ts`: `hierarchyReviewerActionsForExpense` now takes the caller's role
and adds `role === "executive" && status === "level_1_verified" → [reject, verify]`, directly
mirroring the pattern `engineerActionsForExpense` already uses one tier later
(`level_2_verified → [reject, approve]`). A `team_leader` on a `level_1_verified` row still gets no
actions (that tier is no longer theirs — matches the single-expense dialog's own gating). The
`submitted`/`edited` branch is unchanged for both roles, so Level 1 batch verification is
unaffected. This is presentation-only, matching the codebase's established pattern
(`actionEligibility.ts`'s own docstring: "PRESENTATION ONLY... ExpenseService re-checks role, tier,
assignment and approval limits server-side on every call, and that is the check that counts.") — the
real authority remains `review_advance_expense_hierarchy_tier` / `expense_hierarchy_reviewer_can_act`,
already proven correct for this exact transition via the single-expense flow in the same QA pass.

---

## 4) Key files

```
supabase/migrations/20260812140000_sync_pending_next_stage_on_supervisor_change.sql
supabase/functions/admin-create-user/index.ts
src/services/ExpenseService.ts
src/lib/batchExpenseReview.ts
src/components/BatchExpenseReviewPanel.tsx   (caller of expensesEligibleForBatchAction — unchanged)
```

---

## 5) Database / migrations

- `20260812140000_sync_pending_next_stage_on_supervisor_change.sql` — Issue 1. Applied to
  Production (owner-authorized) 2026-08-12 via `psql -f` over SSH+docker (this project's
  established manual-apply convention; `supabase_migrations.schema_migrations` is not used for
  these applications). No migration required for Issues 2–4 (application-code-only fixes).
- One-time Production data repair (operational, not a migration): the 8 duplicate "Nitin Parmar"
  MicroLink profiles were consolidated onto the intended account
  (`emp.ml.2417.a72ec8ed3db2@users.unimisk.com`, `employee_id = '2417'`) after a fresh backup and a
  previewed, minimal, transactional 2-row `employee_id` swap. No `auth.users` row was deleted; the
  7 unused duplicate memberships were deactivated, not removed. Reported separately to the owner
  (see the Production Repair + Hierarchy QA report for this session) — not duplicated here since
  it is data, not schema/code.

---

## 6) Test plan

- [x] `src/services/__tests__/syncPendingNextStageOnSupervisorChange.test.ts` — Issue 1 SQL source
      guards (block boundaries, idempotency, self-review guard, org scoping, audit text).
- [x] `src/services/__tests__/advanceExpenseTierRoleAuthority.test.ts` — Issue 2 (server-authoritative
      outcome accepted over a stale client-role guess; honest no-op error; no migration-name string).
- [x] `supabase/functions/admin-create-user/__tests__/adminCreateUserEmployeeId.test.ts` — Issue 3
      source guards (pre-check ordering, result checked not discarded, persisted-check, scoped
      rollback, 409 vs 400, echoed `employee_id`).
- [x] `src/lib/__tests__/batchReviewHierarchyEligibility.test.ts` — Issue 4 (new): executive can
      batch-verify `level_1_verified`; team_leader cannot; `submitted`/`edited` unaffected for both
      roles; terminal statuses stay empty for both; `expensesEligibleForBatchAction` end-to-end for
      one representative row.
- [x] Live Production browser QA (debug Vercel Preview, QA accounts, real click-through, DB-verified
      after each step — not UI-trusted alone):
  - [x] 6-account QA hierarchy (Manager → 2 Executives → 2 Team Leaders → 1 Employee) created and
        verified against the DB.
  - [x] Single + 2-line batch expense submitted, Level 1 verified by Team Leader A through the real
        UI.
  - [x] Admin-driven supervisor transfer (Team Leader A → B) via User Management.
  - [x] Confirmed via DB: all 3 expenses stayed `level_1_verified` (no history rewrite), reviewer
        moved from old Executive A to new correct Executive B; `expense_hierarchy_reviewer_can_act`
        flips ALLOW/DENY correctly; Executive A's live `/review` page dropped to 0 assigned.
  - [x] Executive B's `/review` page showed all 3 as actionable (matching the DB authority check).
  - [x] Single-expense Level 2 Verify (expense 00098) succeeded through the real dialog: status →
        `level_2_verified`, correct downstream routing, truthful audit entry naming the tier and
        confirming Level 1 history is unchanged.
  - [x] Batch Level 2 Verify (00099/00100) via the dedicated Batch Review page reproduced Issue 4
        live (0 eligible, no toast) before the fix; not yet re-verified live after the fix — the
        fix is covered by the new unit tests above and mirrors the already-proven engineer-tier
        pattern exactly, but a follow-up live click-through re-confirmation on the Preview is
        recommended before merging to `main`.
- [ ] Issue 2 live regression (role changed before Verify, single + batch) — remaining for this QA
      pass; not yet exercised in the browser this session.
- [ ] Employee-ID prevention mechanical test (unique ID persists; duplicate ID → clean 409, no
      ghost account) — remaining for this QA pass.

---

## 7) Related docs

- Prior fix in the same trigger family:
  `supervisorReassignmentAuthority.test.ts` covers
  `20260812120000_fix_pending_expense_supervisor_reassignment.sql` and
  `20260812121000_sync_pending_expenses_on_supervisor_change.sql` (the never-yet-verified sync this
  doc's Issue 1 extends).
- Batch Review eligibility history: DOC-011 (`batch-expense-bugs.md`, duplicate submission +
  visibility), `batch-review-and-production-fixes-june-2026.md`, `batch-review-ux-july2026.md`.

---

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-08-12 | 1.0 | Agent | Initial doc covering Issues 1–3 (already implemented/tested this branch) plus Issue 4, found and fixed live during this session's Batch Review browser QA of Issue 1. |
