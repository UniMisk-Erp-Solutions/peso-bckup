# Batch Verification Integrity Audit — Bulk Verify Silently Splits Batches

**Doc ID:** DOC-098
**Status:** DEPLOYED TO PRODUCTION, VERIFIED LIVE
**Last updated:** 2026-08-19
**Owner / area:** Review Expenses, `EngineerReview.tsx`, `BatchExpenseReviewPanel.tsx`, `ExpenseService.ts`, MicroLink Production incident

---

## 1) Summary

Two related MicroLink Production incidents — 29-ready/1-waiting (transaction 03864, audited separately, see [DOC-097's sibling report] — not a DOC in this repo, delivered as a chat report) and the current **26-ready/4-waiting** incident — are both caused by the **same architectural defect**: `/review`'s "Bulk Verify" action expands a selected batch only over rows the browser currently holds (`allExpenses`), filters out anything not ready for the current reviewer/tier with zero surfacing, and processes each expense independently (not atomically), reporting only an aggregate success/failure count. When a batch's children span a readiness boundary (some already at a later tier, some not), Bulk Verify can silently advance only *some* of them, leaving the rest indistinguishable from freshly-submitted work until a reviewer notices via the approval confirmation dialog days or weeks later.

**This is READ-ONLY forensic work.** No expense was approved, verified, rejected, overridden, or otherwise mutated by this investigation. All findings come from `SELECT`-only queries against Production, run over SSH.

---

## 2) Current incident (26 ready / 4 waiting)

**Reviewer:** an `engineer`-role MicroLink member (Manager Override is engineer-only, and the modal offers it) — one of Jayesh Panchal (`e8639535-…`) or Jayesh Trivedi (`e5809d00-…`).
**Selected:** 30 concrete targets, ₹5,871.00 total. 26 classified ready, 4 waiting, 0 over limit, 0 completed.

### The four waiting expenses

| # | Transaction | Employee ID | Employee | Amount | Raw status | Tier | Batch |
|---|---|---|---|---|---|---|---|
| 1 | **03197** | 6356 | Vinay Kumar | ₹50.00 | `submitted` | `team_leader` | `efbb8ce0-8af4-4056-9f31-29df6e9bbd9f` |
| 2 | **03198** | 6356 | Vinay Kumar | ₹50.00 | `submitted` | `team_leader` | `efbb8ce0-8af4-4056-9f31-29df6e9bbd9f` |
| 3 | **03199** | 6356 | Vinay Kumar | ₹150.00 | `submitted` | `team_leader` | `efbb8ce0-8af4-4056-9f31-29df6e9bbd9f` |
| 4 | **03200** | 6356 | Vinay Kumar | ₹150.00 | `submitted` | `team_leader` | `efbb8ce0-8af4-4056-9f31-29df6e9bbd9f` |

Sum: ₹400.00. Expense UUIDs: `d6f157f4-30e0-4625-8fed-987a81b32fe5` (03197), `0a4f1261-a394-4286-b755-dd64d7b1378f` (03198), `33c940cf-ee89-404b-b80d-7a007cb72c13` (03199), `8ee2be0b-b095-415d-8914-1a5bacfe31ae` (03200). All assigned to `6d75cd1f-b01f-4d2e-8644-7d34ccc78b1c` (Kunvar Thakor, active `executive`) as both `assigned_engineer_id` and `assigned_reviewer_id`.

### Why they are waiting

Batch `efbb8ce0` has 11 total children, all created and submitted within seconds of each other on 2026-07-13, all originally `submitted`/`team_leader`. On **2026-08-18 08:53:27–08:53:47** (a 20-second window), Kunvar Thakor's Bulk Verify action produced `tier_advanced` / "Bulk verified" audit rows for **7 of the 11** children (transaction numbers 03190–03196), advancing them to `level_2_verified`/`engineer`. The remaining 4 (03197–03200) received **no audit event of any kind** beyond their original creation/submission — Bulk Verify never touched them.

This is not a rejection, not a timeout, not a later regression — it is an omission. The four were never targeted by the request(s) that verified their siblings.

---

## 3) Prior incident (03864) — still unresolved

Transaction **03864** (employee 6541, Chintukumar Choursiya, batch `af905063-4774-4f99-b032-cb919661cba4`) remains at `submitted`/`executive` as of this audit — **34 days after creation**, with no `tier_advanced` audit event, while all 8 of its batch siblings were bulk-verified together on 2026-08-12. Nothing about this expense's state has changed since the first incident report; it has simply never been the specific target of any Bulk Verify action since.

---

## 4) Confirmed: this is a recurring, systemic pattern, not a one-off

A read-only scan of every MicroLink batch currently containing both a `level_2_verified` child and a non-terminal, non-`level_2_verified` sibling found **five** such batches as of this audit:

| Batch | Total children | Waiting | Ready | Employee | Notes |
|---|---|---|---|---|---|
| `af905063-…` | 9 | 1 (03864) | 8 | Chintukumar Choursiya (6541) | Original incident, 34 days unresolved |
| `efbb8ce0-…` | 11 | 4 (03197–03200) | 7 | Vinay Kumar (6356) | **The current 26/4 incident** |
| `2533d467-…` | 2 | 1 (07840) | 1 (07841 verified 2026-08-12) | Chintukumar Choursiya (6541) | Same employee as the original incident, a *different* batch, same defect |
| `a0d86527-…` | 2 | 1 (00518) | 1 (00519 verified 2026-08-14) | Nand Lal Paswan (5944) | |
| `81a542cf-…` | 7 | 0 at time of writing | 7 | Virendrasinh Mahida (6118) | **Self-resolved live during this audit** — see §5 |

Every one of these batches shows the identical signature: some children carry a `tier_advanced`/"Bulk verified" audit row, their siblings from the same batch, created within seconds of each other, do not.

---

## 5) Caught in the act: batch `81a542cf` self-resolving mid-audit

This batch (Virendrasinh Mahida, employee 6118, 7 children: 04790–04796) was queried twice during this audit, minutes apart, and its state changed between the two reads:

- **First read** (~10:57:52 UTC): 2 children (`level_2_verified`) ready, 5 children (`edited`/`executive`) waiting — matching the "mixed batch" signature exactly.
- **Second read** (~11:01 UTC): all 7 children now `level_2_verified`. The audit trail shows *why*: `tier_advanced` events for 04790/04791/04796 landed at 10:18:07–10:18:10 (one Bulk Verify pass), then a **42-minute gap**, then `tier_advanced` for 04792/04793/04794/04795 landed sequentially at 11:00:04–11:00:15 (four seconds apart) — a *second*, separate action.

This is direct, live evidence of the human cost of the defect: the reviewer's first Bulk Verify pass over this batch caught only 3 of 7 children (non-contiguous: 04790, 04791, 04796 — not even the first N or last N), and the reviewer had to notice the gap and manually return ~42 minutes later to finish the rest one at a time. No error, no rejection, no timeout — the first pass simply never targeted the other 4, and the UI gave no indication anything was left undone.

---

## 6) Code-level root cause (confirmed exactly as suspected)

All three suspected defects in `src/pages/EngineerReview.tsx` are present exactly as described:

```ts
// Batch expansion happens ONLY over rows the browser currently holds.
const selectedExpenseTargets = (): Expense[] => {
  const ids = new Set(expandSelectionToExpenseIds(selectedKeys, allExpenses.map(toSelectableRow)));
  return allExpenses.filter((e) => ids.has(e.id));
};

// Readiness pre-filter — anything not ready for THIS reviewer, right now, is
// silently dropped before a request is ever sent. No count, no reason.
const readyNowTargets = (): Expense[] =>
  selectedExpenseTargets().filter((e) => isPendingForCurrentReviewer(e) && !isTerminalReviewStatus(e.status));

const handleBulkVerify = async () => {
  const targets = readyNowTargets();          // pre-filtered — excluded items are invisible here
  let succeeded = 0, failed = 0;
  for (const exp of targets) {                 // sequential, per-expense, NOT atomic
    try { await ExpenseService.verifyExpense(...); succeeded++; }
    catch { failed++; }                         // no transaction id preserved
  }
  toast({ title: `Verified ${succeeded} expense${...}${failed ? `, ${failed} failed` : ""}` });
  // no per-item detail, no "N skipped because not yet at your stage" message
};
```

Confirmed asymmetry with Bulk **Approve**:

```ts
// resolveApprovalTargets() — used ONLY by Bulk Approve — explicitly re-fetches
// every batch's current children fresh from the server, specifically so
// off-page/not-yet-loaded children are included:
const resolveApprovalTargets = async (): Promise<Expense[]> => {
  const byId = new Map<string, Expense>();
  for (const e of selectedExpenseTargets()) byId.set(e.id, e);
  const batchIds = [...selectedKeys].filter(k => k.startsWith("batch:")).map(k => k.slice(6));
  if (batchIds.length > 0) {
    const { data } = await supabase.from("expenses").select(...).in("batch_id", batchIds);
    for (const row of data ?? []) byId.set(row.id, toCoreExpense(row)); // fresh row wins
  }
  return [...byId.values()];
};
```

**Bulk Verify has no equivalent.** It never re-fetches; it only ever sees whatever is already loaded into `allExpenses`, which — per the server-query-mode comment at `EngineerReview.tsx` §28 — can be as small as the current 25-row page.

### `allExpenses` is what shows the split — not a race, not a network failure

The `readyNowTargets()` filter checks `isPendingForCurrentReviewer(e)`, which for a `team_leader`-tier expense (`efbb8ce0`'s 4 waiting children) is only `true` for a reviewer whose own role is `team_leader` or `executive`, viewing at THAT tier. **The reviewer who ran the 08:53 Bulk Verify pass on `efbb8ce0` was Kunvar Thakor, an `executive`** — for an executive, `isPendingForCurrentReviewer` returns `true` for `submitted`/`edited` status regardless of tier match against `team_leader` specifically... but the 4 stragglers ARE `submitted`. This means the readiness filter is **not** definitively what excluded them (their status/role combination should have passed it) — the more likely mechanism is that `03197`–`03200` simply were not present in `allExpenses` at the moment the batch selection was expanded (an `allExpenses` population/ordering gap — e.g. pagination, a stale cached page, or a fetch that returned the 7 already-loaded rows but not these 4). This distinction matters for the fix: it points squarely at **Category A (never targeted / off-page)**, not a readiness-filter false negative, though both defects independently exist in the code and either can produce the same symptom.

---

## 7) Both review surfaces share the non-atomicity problem

The dedicated batch review page (`src/components/BatchExpenseReviewPanel.tsx`, reached via `/expenses/batch/:id/review`) does **not** have the off-page problem — its `loadBatch()` fetches `WHERE batch_id = X` fresh from the server on open, so it always sees every current child. However, its action handler still calls `ExpenseService.processBatchReview()`, which runs `Promise.allSettled` over independent per-expense `verifyExpense`/`approveExpense`/`rejectExpense` calls — **not atomic**, and its own success/failure toast only lists individual errors when *every* item fails; a partial failure (e.g. 7 succeed, 4 fail) surfaces only as an aggregate count, with no per-transaction detail. Both surfaces therefore need the reporting fix in §9; only the checkbox-based `/review` surface needs the off-page fix.

`ExpenseService.verifyExpense` itself, for `team_leader`/`executive` reviewers, delegates to `advanceExpenseTier`, which is a **multi-round-trip client-orchestrated sequence** (fetch expense head → fetch feature flags → fetch reviewer role → fetch employee's reporting-engineer row → …), not a single atomic RPC call. Confirms the transaction boundary is **PER EXPENSE**, not per-batch, not per-selection — exactly as suspected.

---

## 8) Server logs

Bounded log inspection around the confirmed timestamps (2026-08-18 08:53:27–08:53:47 for the `efbb8ce0` incident, and 10:18/11:00 for the self-resolving `81a542cf` batch) found no 4xx/5xx/timeout/RLS-rejection signal — consistent with the conclusion that this is a **client-side selection/targeting gap**, not a server-side rejection or transport failure. Absence of an error log is not being treated as proof a request never existed (per instruction) — it is corroborating, not conclusive, evidence; the audit-log absence (no `tier_advanced` row at all for the 4 stragglers) is the primary, conclusive evidence.

---

## 9) Recommended architecture (design only — not implemented this session)

**Atomic per-batch verification.** When a reviewer selects a batch (whether via `/review` checkboxes or the dedicated batch page), the server should:

1. Resolve **all current non-terminal children** of that batch fresh from the database (never from browser-held state) — mirroring `resolveApprovalTargets()`'s existing pattern, or better, doing it server-side inside a new RPC.
2. Validate every child's eligibility for the calling reviewer's tier.
3. If **all** are eligible: advance the entire batch in **one transaction** — all rows change together, or none do.
4. If **any** child is ineligible: mutate **zero** rows, and return a structured blocker listing exactly which children failed and why (transaction number, employee, current stage) — never a bare aggregate count.

Proposed RPC name: `review_verify_batch_atomic_v1`, modeled on the already-proven pattern from `review_approve_expense_manager_override_v1` (lock rows, `SECURITY DEFINER`, pinned `search_path`, `auth.uid()`-based actor, organization/role/tier checks, no self-review, truthful audit row per child, all-or-nothing).

**Multiple-batch selections** should resolve **per batch**, not as one giant cross-batch transaction: Batch A (9/9 eligible) verifies fully, Batch B (7/8 eligible) blocks entirely and reports its one ineligible child, Batch C proceeds — matching the task's own Phase 18 example.

**Singular (non-batched) selections** remain per-expense; they were never the source of this defect and should not be forced into batch semantics.

### Approval dialog / Bulk Verify UX (design only)

- Waiting items listed individually: transaction #, employee ID + name, batch badge if applicable, current stage, assigned verifier — never just a bare count.
- Split the single "Proceed with approval (30)" action into two explicit steps: **"Approve 26 ready now"** (never calls Manager Override) and a separately-confirmed **"Manager Override 4 waiting"** (second confirmation dialog naming all four).
- Bulk Verify's result toast must name what was skipped, not just what failed: `"Verified 7 expenses. 4 could not be verified: #03197, #03198, #03199, #03200 · Vinay Kumar · still at team_leader stage"` — never silently clear the selection after a partial outcome without saying so.
- "5 batches / 30 expenses selected" instead of a bare "30 selected", since one logical selection key can expand to many concrete expenses.

---

## 10) Data repair

**None required.** All identified waiting expenses (03197–03200, and the still-open 03864, 07840, 00518) are in their **correct** state — they genuinely have not been verified. This is not corrupted data; it is incomplete workflow progress that a correct Bulk Verify action (or a manual follow-up, as happened live for batch `81a542cf`) will resolve normally through the existing, unmodified verification RPCs. No migration, no backfill, no status correction is needed.

---

## 11) Implementation (2026-08-19, `debug/review-batch-verification-integrity`)

The design in §9 was implemented and proven this session. Everything below is
**prototype-only on the debug branch** — not applied to Production, not
merged to `main` or `dev`.

### 11a) Authorization NULL finding (found during proof-testing, not part of the original design)

While transactionally proof-testing the new atomic RPC, an **existing,
currently-deployed** authorization defect was found: `expense_hierarchy_reviewer_can_act(e, v_uid)`
can return SQL `NULL`, not just `true`/`false` — its assignment check
(`e.assigned_reviewer_id = v_uid OR e.assigned_engineer_id = v_uid`) and its
current-supervisor fallback (`p.reporting_engineer_id = v_uid`) each contain
a comparison against a column that is frequently `NULL`
(`assigned_engineer_id` is `NULL` for nearly every pending team_leader/
executive-tier expense), and under SQL three-valued logic `false OR NULL =
NULL`, not `false`.

Every live caller that guards with `IF NOT expense_hierarchy_reviewer_can_act(...) THEN
RAISE EXCEPTION` — including `review_advance_expense_hierarchy_tier` (the
live single-expense hierarchy Verify RPC) and `review_reject_expense` (the
live Reject RPC) — evaluates `NOT NULL` as `NULL`, and PL/pgSQL's `IF` only
enters its branch on a definite `TRUE`. A `NULL` condition silently skips
the `RAISE EXCEPTION`, so the mutation proceeds as if the caller had been
authorized. **In effect: any active team_leader or executive in an
organization could currently verify or reject another team_leader/
executive's assigned expenses, not just their own** — proven live
(`BEGIN`/`ROLLBACK`, zero persistence) against the real Production body of
`review_advance_expense_hierarchy_tier`.

A global audit of every caller of `expense_hierarchy_reviewer_can_act`
(migrations, RLS policies, RPCs) found: the RLS policy caller (§`USING`
clause on `expenses FOR UPDATE`) is unaffected — Postgres treats `NULL` the
same as `false` in a row-filter context, so that one was always safe by
construction. Every `IF NOT ...THEN RAISE EXCEPTION` caller across the
function's revision history shares the same pattern; only the function's
*current, live* body matters, since each historical migration was replaced
by the next. `reviewer_can_act_on_expense(p_expense_id)` uses `IF x THEN
RETURN true; ...; RETURN false;`, which is safe by construction (`NULL`
never enters the positive branch).

**Fix:** `supabase/migrations/20260819150000_fail_closed_hierarchy_reviewer_can_act.sql` —
wraps the unchanged boolean expression in `COALESCE(..., false)`. This can
only ever turn a previously-ambiguous `NULL` into `false`; it cannot turn a
legitimately-authorized case into `false`, because every real "this caller
IS authorized" path in the function compares a stored id to the caller's
own `v_uid` and produces a definite `TRUE` by construction when they match.
Re-proven live post-fix: the exact previously-silent bypass now correctly
raises "You don't have permission to verify this expense at the current
tier", and the row's status is confirmed unchanged.

### 11b) Atomic batch verification RPC

`supabase/migrations/20260819140000_review_verify_batch_atomic_v1.sql` —
`review_verify_batch_atomic_v1(p_batch_id, p_next_approval_tier,
p_next_assigned_reviewer_id, p_next_assigned_engineer_id, p_comment)`.
Resolves batch membership server-side (never trusts a client-supplied
expense-id list), locks every current non-terminal, not-already-
`level_2_verified` child `FOR UPDATE` in deterministic order, prevalidates
every one via `expense_hierarchy_reviewer_can_act` (now fail-closed) plus a
tier-appropriate status check *before any mutation*, and either advances
every eligible child within one transaction — delegating each to the
existing, unmodified `review_advance_expense_hierarchy_tier` so mutation
logic is never duplicated — or mutates nothing and returns
`{ok:false, code:'batch_verification_blocked', blockers:[{expense_id,
transaction_number, employee_id, status, approval_tier, reason}]}`.

Already-`level_2_verified` children (a historically partially-advanced
batch, e.g. `efbb8ce0` itself: 7 already-advanced, 4 still lagging) are
**excluded from locking entirely** — never re-verified, never regressed,
never counted as a blocker; only the genuinely-lagging children are
prevalidated together, so the batch either finishes correctly or the
attempt changes nothing.

A second gap was found and fixed after the first proof pass:
`review_advance_expense_hierarchy_tier` does not itself insert an
`audit_logs` row — that has always been the *client's* job
(`ExpenseService.logAction`), called in a separate request after the RPC
returns, which is not atomic with the mutation even for today's
single-expense Verify. For a batch, N separate client-side audit calls
after the fact would reintroduce exactly the partial-completion risk this
RPC exists to remove. Fixed by writing each child's `audit_logs` row
directly inside the same transaction as its mutation
(`supabase/migrations/20260819140000_review_verify_batch_atomic_v1.sql`,
same file — the fix predates any Production exposure).

**Transactional proof (`BEGIN`/`ROLLBACK`, zero persistence, run against real
Production data and schema):**

| # | Scenario | Result |
|---|---|---|
| A | Full-batch success, already-`level_2_verified` sibling present | `ok:true`, 2 verified, sibling untouched |
| B | Partial block (1 eligible + 1 wrong-status) | `ok:false`, **zero mutation on either row** |
| C | Unauthorized caller (unassigned, not supervisor) | `ok:false`, blocked (this caught the §11a NULL bug) |
| D | team_leader tier path | `ok:true`, correct `level_1_verified` |
| E | Current-supervisor fallback | `ok:true` |
| F | Batch not found | `ok:false`, `batch_not_found` |
| G | Cross-org caller | Exception raised, denied |
| H | Inactive membership | Exception raised, denied |
| — | Audit-write atomicity (2-child batch) | 2 `tier_advanced` rows inserted, correct org/user/action, gone after rollback |
| — | §11a fix re-proof | `review_advance_expense_hierarchy_tier` now correctly denies the previously-silent bypass |

Rollback files: `supabase/rollbacks/20260819140000_review_verify_batch_atomic_v1_rollback.sql`,
`supabase/rollbacks/20260819150000_fail_closed_hierarchy_reviewer_can_act_rollback.sql`.

**Not covered by live proof this session** (honest gap): concurrent duplicate
Verify calls on the same batch, and a simulated mid-loop failure after some
children have already advanced within one call (both are structurally
guaranteed by Postgres's row locking and single-transaction semantics —
`FOR UPDATE` serializes concurrent callers, and any exception anywhere in
the function body rolls back everything already done in that call — but
neither was exercised as an explicit adversarial test).

### 11c) Frontend rewiring

`src/services/ExpenseService.ts` — new `verifyBatchAtomic(batchId, reviewerId,
comment?, options?)`: computes next-tier routing **once per batch**, reusing
the same `approvalHierarchy.ts` logic `advanceExpenseTier` already uses,
from one representative held child (valid because every child of a batch
shares one employee, and routing depends only on the employee's team/
reporting chain), then calls the atomic RPC. Returns a typed
`BatchVerifyResult`.

`src/lib/reviewBulkSelection.ts` — new `splitSelectedKeys(selectedKeys)`:
pure batch-id/singular-id split, unit-tested.

`src/pages/EngineerReview.tsx` — `handleBulkVerify` no longer expands a
batch selection over `allExpenses`. Each selected batch id gets exactly one
`verifyBatchAtomic` call, processed sequentially (not `Promise.all` — the
server is already under heavy load, see §12, and Review actions are
financial-adjacent). Singular selections keep the existing per-expense
`verifyExpense` path. Selection retention: a successful batch/singular id is
removed from the selection; a blocked batch or failed singular row stays
selected. Blocked batches show per-transaction detail (transaction number,
employee, reason) in a dedicated dialog — never an aggregate-only toast.

`src/components/BatchExpenseReviewPanel.tsx` — the dedicated Batch Review
page's Verify action now routes team_leader/executive callers through the
same atomic RPC. Approve/Reject and engineer/admin Verify are unchanged;
this task's proven defect is specifically Verify, and changing financial
Approve/Reject atomicity was out of scope (documented, not silently
altered — both remain per-expense via `ExpenseService.processBatchReview`).

### 11d) Approval dialog redesign

The pre-approval warning dialog (`approvalWarningDialog` in
`EngineerReview.tsx`) was redesigned per the owner's explicit requirement:

- **Primary button "Approve N ready now"** calls `runBulkApproval(c.readyNow, [], ...)` —
  only `classification.readyNow`, zero Manager Override calls, zero waiting-row
  mutation.
- **"View N waiting" toggle** expands an inline, scrollable list (transaction
  number, employee name + ID, batch badge, `waitingReasonLabel` stage text)
  sourced from the already-fresh-resolved `approvalWarning.targets`
  (`resolveApprovalTargets` now also fetches `transaction_number` and
  batch-hydrates employee identity in one query — no N+1).
- **"Manager Override N waiting"** is a separate secondary button, shown
  only when the override capability is effective and waiting rows exist. It
  opens a second `AlertDialog` (`managerOverrideConfirmDialog`) listing every
  waiting item by name, with Cancel / "Override and approve N" — only the
  explicit second confirm calls the override RPC.
- Existing over-limit/terminal exclusion and server-side authorization are
  unchanged.

`src/lib/reviewWaitingReason.ts` (new) — `waitingReasonLabel`, a shared,
pure presentation helper mapping `approval_tier`/`status` to "Waiting for
Team Leader" / "Waiting for Executive" / "Waiting for Manager review" /
"Waiting for Admin" / a generic fallback. Unit-tested.

### 11e) Fleet audit — final, current results

Re-run read-only via the new reusable diagnostic
(`supabase/diagnostics/find_mixed_batch_verification.sql`) across **all**
organizations (not just MicroLink):

- **18** candidate mixed batches found, **all in MicroLink** — confirmed no
  other organization is affected (3 orgs total have any batches; only
  MicroLink shows this pattern).
- **6** of those 18 have genuine (non-draft) lagging children — **9**
  currently-lagging transactions total. The other 12 are draft-only
  children (never submitted — benign, not evidence of a split).
- **Two new splits appeared since the prior session's audit** — transactions
  **09991** (employee 6741, Prem Bahadur, 11 days old) and **01104**
  (employee 4071, Rahulbhai Gopalbhai Saragara, 16 hours old — this one has
  a recent `last_tier_advanced_at`, meaning it is mid-partial-progress right
  now). This is direct, current evidence that the defect is **ongoing and
  recurring**, not historical.
- Batch `134157f2` (employee 6118, Virendrasinh Mahida — the batch caught
  live self-resolving mid-audit in the prior session, §5) is now
  `ALREADY_SELF_RESOLVED_OR_DRAFT_ONLY`, confirming it did complete on its
  own as observed.

**Current lagging expenses (recovery table — normal Verify only, never
Manager Override, per §10's original conclusion):**

| Txn | Employee ID | Employee | Batch | Status | Tier | Age |
|---|---|---|---|---|---|---|
| 03197 | 6356 | Vinay Kumar | `efbb8ce0` | submitted | team_leader | ~7 days |
| 03198 | 6356 | Vinay Kumar | `efbb8ce0` | submitted | team_leader | ~7 days |
| 03199 | 6356 | Vinay Kumar | `efbb8ce0` | submitted | team_leader | ~7 days |
| 03200 | 6356 | Vinay Kumar | `efbb8ce0` | submitted | team_leader | ~7 days |
| 03864 | 6541 | Chintukumar Choursiya | `af905063` | submitted | executive | 34 days |
| 07840 | 6541 | Chintukumar Choursiya | `2533d467` | submitted | executive | 18 days |
| 00518 | 5944 | Nand Lal Paswan | `a0d86527` | submitted | executive | 48 days |
| 09991 | 6741 | Prem Bahadur | `504663aa` | submitted | executive | 11 days |
| 01104 | 4071 | Rahulbhai Gopalbhai Saragara | `6e402cba` | submitted | executive | 16 hours |

**Historical self-resolved signal:** 65 batches in the last 30 days show a
`>5-minute` gap between `tier_advanced` audit-event clusters — this remains
an explicitly-labeled **unconfirmed upper bound** (could include legitimate
two-stage team_leader-then-executive progression, not only splits); only
`81a542cf` was individually confirmed via full audit-trail inspection.

**No repair performed.** Consistent with §10's original conclusion: every
lagging expense above is in its correct, unverified state and will resolve
through normal Verify (now atomic) once actioned — not through Manager
Override, not through a SQL status update.

### 11f) Tests

- DB: 8 original transactional-proof scenarios (A–H) + audit-write
  atomicity + the §11a fix re-proof, all live against Production,
  `BEGIN`/`ROLLBACK`, zero persistence.
- Frontend unit tests (pure logic, no component harness — see gap below):
  `src/lib/__tests__/reviewBulkSelection.test.ts` (`splitSelectedKeys`, 5
  new cases matching the spec's TEST A/C/D/E fixtures),
  `src/lib/__tests__/reviewWaitingReason.test.ts` (8 cases),
  `src/services/__tests__/verifyBatchAtomic.test.ts` (5 cases: role gate,
  `batch_not_found`, batch-id-not-expense-list RPC call shape, success
  mapping, blocked mapping).
- **Gap, reported honestly:** `EngineerReview.tsx` and
  `BatchExpenseReviewPanel.tsx` have no existing component-level test
  harness (no prior `EngineerReview.test.tsx`), and building one for a
  ~4,800-line file was out of scope for this session. The originally-
  requested component-level scenarios (off-page child, multi-batch mixed
  outcome, dialog content, ready-only isolation, override isolation,
  waiting-item findability, Stop) are covered by **manual code review of the
  actual wiring** plus the DB-level transactional proof, not by an automated
  component test. This is a real gap, not a completed item.

### 11g) i18n

English, Hindi, and Gujarati strings added to
`src/locales/{en,hi,gu}/admin.json` under `approvalWarning` (`viewWaiting`,
`hideWaiting`, `batchBadge`, `employeeIdShort`, `approveReadyNow`,
`managerOverride`), plus new `overrideConfirm` and `batchVerifyBlockers`
blocks. All three locales updated in the same commit, not deferred.

### 11h) Quality gates

Targeted new/changed tests: pass (18 new test cases across 3 files). Full
suite: **3,356 of 3,359 pass**; the 3 failures
(`repair6546Level2RoutingAndAudit.test.ts` ×2 — an unrelated old
audit-repair migration's raw-source-text assertion — and
`MaintenanceAdminDashboard.test.tsx` ×1 timeout) were confirmed **pre-
existing on the unmodified tree** (re-ran after stashing all session
changes; identical failures). Typecheck: clean. Build: succeeds. Lint: zero
new errors introduced by this session's changes (spot-checked every flagged
line in the two touched files — all pre-existing `catch (error: any)`/casts
elsewhere in those files); 373 pre-existing errors are unrelated codebase
debt, lint config untouched. `migrations:check`: clean (both new migrations
use proper 14-digit timestamps, no duplicate versions). `security:secrets`:
clean.

### 11i) Server health

Production host: 4 CPU cores, load average ~19 at the time of this session
(severe, chronic — 5 separate Supabase stacks plus ~15 other app stacks
sharing the box), memory/disk healthy. No heavy load test was run against
this host this session; all Production reads were narrow, single-purpose,
transaction-contained. A `plausible-plausible_db-1` container found in a
36-hour restart crash-loop (disk-full at the time, since cleared) was fixed
at the user's explicit request — **unrelated to DOC-098**, documented here
only as the infrastructure follow-up the task asked to keep separate. No
PesoWise service was restarted or otherwise touched.

### 11j) Remaining steps before Production (historical — completed §12)

1. Owner review of this document and the 6 commits on
   `debug/review-batch-verification-integrity`.
2. Apply `20260819140000_review_verify_batch_atomic_v1.sql` and
   `20260819150000_fail_closed_hierarchy_reviewer_can_act.sql` to Production
   (separate, explicit deployment decision — not done this session).
3. Post-apply: re-run the DB transactional proof read-only against the
   *applied* functions (not just the rolled-back draft) as a final sanity
   check, then a narrowly-scoped live retest on one already-known lagging
   transaction (e.g. one of 03197–03200) with the owner present.
4. Merge the frontend commits to `dev`, then `main`, through the normal
   Preview → QA → merge flow — not done this session (branch stayed debug-
   only throughout, per the task's explicit constraint).
5. Component-level frontend tests for `EngineerReview.tsx`'s Bulk Verify
   flow (the gap noted in §11f) would meaningfully raise confidence before
   a Production rollout, though the DB-level proof and code-level review
   already cover the core safety property (atomicity + fail-closed auth).

---

## 12) Production deployment + final correctness fixes (2026-08-19, same day)

Both migrations from §11 were applied to Production this session (separate
prior turn), then re-verified live via `pg_get_functiondef`:
`review_verify_batch_atomic_v1(uuid, text)` — no client-supplied routing
parameters, server-derived tier/reviewer/engineer, `IS NOT TRUE` fail-closed
guard against `expense_hierarchy_reviewer_can_act`, which itself wraps its
logic in `COALESCE(..., false)`. Grants on both functions: no `PUBLIC`/`anon`,
scoped to `authenticated`/`service_role`/owner. A real cross-session
concurrency test (two truly concurrent `docker exec` psql sessions against
synthetic, committed, then fully-deleted rows) confirmed no duplicate
advancement and no duplicate audit row.

### 12a) Two concrete integrity gaps found on final review, both fixed

1. **`EngineerReview.tsx` `resolveApprovalTargets` — fail-open batch
   resolution.** The fresh batch-children fetch (used to build the Bulk
   Approve confirmation dialog) was wrapped in a try/catch with an empty
   catch body, and additionally discarded the Supabase `error` entirely
   (destructuring only `data`). A network failure, an RLS error, or a
   non-throwing Postgrest error all silently fell back to whatever
   partial/stale batch children the browser already held — the confirmation
   dialog a human reviewer approves could then reflect an incomplete batch
   (e.g. 7 of 11 real children) with no signal anything was wrong. Fixed:
   the function now returns a discriminated
   `{ ok: true, targets } | { ok: false }` result; any batch-fetch failure
   fails the WHOLE resolution closed (nothing merged, nothing guessed), and
   `handleBulkApprove` shows "Could not load the complete selected batch. No
   expenses were approved. Retry." instead of proceeding. Singular
   (non-batch) selections are unaffected — Approve stays per-expense and is
   always re-authorized server-side regardless.
2. **`BatchExpenseReviewPanel.tsx` (the dedicated `/expenses/batch/:id/review`
   page) — client eligibility still gated the atomic RPC call.** For Team
   Leader/Executive Verify, the panel computed `eligible("verify")` from
   only the locally *checked* rows and returned before ever calling
   `ExpenseService.verifyBatchAtomic()` when that count was zero — a
   leftover from the pre-atomic-RPC model. Unchecking a child could make a
   reviewer think it was excluded, while the server (once called) verifies
   every eligible current child regardless of local selection. Fixed:
   removed client eligibility as the gate for this action+role combination
   — the RPC is now always called, and the server's own response (success /
   already-complete / blockers) drives the toast. Button
   enablement/label now use a selection-independent count over the whole
   loaded batch (`hierarchyVerifyEligibleCount`) and a clearer "Verify Batch
   (N)" label, so unchecking children no longer changes whether Verify is
   available.

Also hardened `supabase/diagnostics/find_mixed_batch_verification.sql`: its
"advanced sibling" heuristic checked only `level_2_verified`/`approved`,
missing `paid` (further along in the pipeline) — added `paid_count` to both
the classification and the Section 2 `mixed_batches` CTE. Re-run against
Production confirmed this made no difference to current findings (0 batches
have reached `paid` while a sibling lags).

### 12b) Fleet-wide re-audit result: zero genuine open splits

Re-ran the hardened diagnostic against Production, all organizations. Only
one candidate remains: MicroLink batch `6e402cba-9b5f-4d6c-aa62-5d9d09392967`
(employee 4071, transaction 01104). **Individual audit-trail inspection shows
this is not a hidden-verification defect.** Its full history: created and
submitted 2026-07-04 alongside 7 siblings; all 8 bulk-verified together in
one cluster on 2026-08-18 11:53:52 (identical timestamp, same reviewer,
`tier_advanced` audit row present for 01104 too — it was NOT omitted); then,
5 minutes later, 01104 specifically was rejected by the engineer reviewer at
the next tier — a legitimate business rejection, unrelated to Bulk Verify;
then corrected by the employee and resubmitted, landing it back at
`submitted`/`executive` while its never-rejected siblings sit at
`level_2_verified`/`engineer`. This is exactly the "rejected / corrected /
resubmitted child" case this document's own definition of "hidden" (§ Part
15 of the task spec that drove this session) explicitly excludes. Of the 9
historically-flagged transactions, 8 (03197–03200, 03864, 07840, 00518,
09991) are now uniformly `approved` across their batch siblings; the 9th
(01104) is explained above. **No historical recovery action was needed or
taken. SAFE TO RECOVER: 0. NEEDS MANUAL REVIEW: 0.**

### 12c) Live Production proof (real batch, real accounts, this session)

Per explicit owner authorization, two reusable accounts were created in the
`Mistry And Shah` organization for ongoing QA (not deleted — kept for future
reuse, unlike the earlier synthetic concurrency-test rows which were fully
cleaned up per instruction): `Review QA TeamLeader` (employee ID `revqatl`)
and `Review QA Employee` (employee ID `revqaemp`, reporting to the team
leader), both password `qwertyui`. The employee submitted a genuine 22-line
batch (`Submit multiple`, transactions 01305–01326, ₹550.00 total) through
the real Production UI at `pesowise.unimisk.com`. The team leader then
selected the batch (one logical `batch:<id>` selection covering all 22 rows)
and clicked Verify once on the real, deployed `/review` page. Result,
confirmed both in the UI (Pending Review 22→0, Verified 0→22) and via direct
Production DB query: **all 22 children atomically advanced to
`level_1_verified`/`engineer`, exactly 22 `tier_advanced` audit rows (zero
duplicates), zero split**. This is the fix (§12a-2) proven end-to-end against
a real batch well beyond the smallest-necessary size, on the exact code path
(`/review` Bulk Verify → `review_verify_batch_atomic_v1`) that reached
Production this session.

### 12d) Merge and deployment

Commit `850c526` (the two fixes in §12a plus the diagnostic hardening) pushed
to `debug/review-batch-verification-integrity`. Full gate suite re-run:
typecheck clean; 3,356/3,359 tests passing (3 pre-existing, unrelated
failures — a historical repair-script test and an intermittent
maintenance-dashboard timeout — confirmed unchanged across two runs); build
clean; lint errors confined to pre-existing lines outside this session's
diff; migrations:check and security:secrets clean. Merged into `main` (merge
commit `c418216`, `main` unchanged at `dd33053` immediately prior — no
rebase needed), pushed, Vercel Production deployment reached Ready, and
`pesowise.unimisk.com` was smoke-tested live (Admin login, dashboard, zero
console errors, then the full real-batch Verify proof in §12c on the actual
deployed build).

**Status update:** IMPLEMENTED → **DEPLOYED TO PRODUCTION, VERIFIED LIVE**.

---

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-08-18 | 1.0 | Agent | Initial — read-only forensic audit on `debug/review-batch-verification-integrity` (from latest `main`, `dd33053`). Identified the exact 4 currently-waiting expenses (03197–03200, batch `efbb8ce0`, employee 6356), confirmed the prior 03864 incident remains unresolved, found 5 total currently-open mixed-verification batches proving this is a systemic recurring pattern (not a one-off), and captured one batch (`81a542cf`) self-resolving live mid-audit via a delayed manual second pass — direct evidence of the defect's real-world cost. Confirmed the exact code-level root cause: `selectedExpenseTargets()` (used by Bulk Verify) expands batch selections only over browser-held `allExpenses`, with no fresh-fetch fallback (unlike `resolveApprovalTargets()`, used by Bulk Approve, which does fresh-fetch); `readyNowTargets()` silently drops any held-but-not-ready child; `handleBulkVerify` processes per-expense sequentially with only an aggregate success/failure toast. Confirmed the dedicated Batch Review page avoids the off-page gap (fetches its own batch fresh) but shares the same non-atomic, aggregate-only-reporting weakness via `ExpenseService.processBatchReview`'s `Promise.allSettled`. Designed (not implemented) an atomic per-batch verification RPC and dialog UX. **No Production mutation. No code changed. Not merged to main or dev.** |
| 2026-08-19 | 3.0 | Agent | Production deployment day, both migrations from v2.0 applied and verified live (§12). Found and fixed two remaining integrity gaps: `resolveApprovalTargets` fail-open batch resolution in `EngineerReview.tsx` (now fails closed on any fetch error, never falls back to partial/stale data); `BatchExpenseReviewPanel.tsx` Verify still client-eligibility-gated the atomic RPC call (now always calls it, server owns eligibility). Hardened the diagnostic to treat `paid` as an advanced-sibling signal too. Fleet re-audit: zero genuine open splits — the one remaining candidate (01104) is a legitimate reject/resubmit case, not an omission; the other 8 historically-flagged transactions are now uniformly approved. No historical recovery needed. Proved the fix end-to-end on real Production with a real 22-line batch (reusable QA accounts, explicit owner authorization) — atomic, zero split, zero duplicate audit. Merged `debug/review-batch-verification-integrity` into `main` (`c418216`), pushed, Vercel Production deployed and smoke-tested live at `pesowise.unimisk.com`. |
| 2026-08-19 | 2.0 | Agent | Implementation on the same debug branch (§11). Added `review_verify_batch_atomic_v1` (atomic, server-authoritative batch verify, 8 scenarios + audit-atomicity proven live via `BEGIN`/`ROLLBACK`). Found and fixed a live Production authorization defect discovered during proof-testing: `expense_hierarchy_reviewer_can_act` could return SQL `NULL`, silently letting an unauthorized team_leader/executive verify or reject another reviewer's assigned expenses via the existing `IF NOT ... THEN RAISE EXCEPTION` pattern; hardened with `COALESCE(..., false)`, re-proven live. Rewired `/review`'s Bulk Verify and the dedicated Batch Review page's Verify action onto the new RPC (batch-id authority, never browser-held expense lists). Redesigned the approval dialog: ready-only primary approve, waiting-item detail list, Manager Override as a separate action with a second explicit confirmation. Re-ran the fleet audit fully (all orgs, new reusable diagnostic script): confirmed MicroLink-only, found 2 NEW splits since the prior audit (09991, 01104) proving the defect is ongoing/recurring, confirmed `134157f2` self-resolved as observed live in v1.0. 18 new unit tests; full suite 3,356/3,359 pass (3 pre-existing, unrelated failures confirmed via clean-tree re-run); typecheck/build/lint(no new errors)/migrations/secrets all clean. 6 commits pushed to `debug/review-batch-verification-integrity` only. **No Production migration applied. Not merged to main or dev. No real expense mutated.** |
