# MicroLink expense submission / attachment incident

**Doc ID:** DOC-140  
**Status:** in progress (fix on branch PR #8; server migration must be applied to Production with the deploy)  
**Last updated:** 2026-10-07  
**Owner / area:** Expenses / MicroLink atomic submission / idempotency  

---

## 1) Summary

MicroLink employees reported that a new expense was saved as a **draft** after pressing Submit and had to be opened and submitted a second time. The audit found a **latent generic defect in the server idempotency design**, triggered by the client's "attach the bill first, then submit" flow. It is **not** an upload failure; PDF uploads work.

- **Server defect (root):** the receipt table is keyed by `idempotency_key` alone and the replay branch of `_persist_microlink_expense_snapshot_v1` answers any repeated key with the stored receipt **without checking which action wrote it**.
- **Client defect (trigger):** the draft call and the submit call of one logical attempt used the **same key**, so the submit was answered with the draft's receipt (`status: draft`, `replayed: true`) and never ran.
- **Client defect (false success):** a "committed" outcome, and later a read-back status mismatch, were treated as success/warning, so the form said "Expense submitted" for a draft.

This is now fixed on **both** sides. A client-only fix would have left the server able to replay the wrong action for any old cached client, so the server fix is the one that closes the system.

> Engineering rule (new): **"the request succeeded" is not "the intended state transition happened."** Every state-changing flow must assert the resulting business state (status, row count, read-back), not just that the call returned.

## 2) Symptoms

- Submit on a new expense that needs a bill (MicroLink requires one above the configured amount) ends with the expense in Draft while the form reports success.
- The employee reopens the draft and submits again, which works.

## 3) Root cause (confirmed in code, live function text, live data)

1. `expense_submission_receipts` had `PRIMARY KEY (idempotency_key)`.
2. At the top of `_persist_microlink_expense_snapshot_v1`, the replay branch did `WHERE idempotency_key = v_key` and returned the stored receipt (checking only the user). It ignored `p_action`.
3. `ExpenseForm.submitMicroLinkAtomically` called `save_microlink_expense_draft_v1` then `submit_microlink_expense_v1` with the same key.
4. The submit returned HTTP 200 / `committed: true` / `status: draft` / `replayed: true`. The client trusted "committed".

Live proof (rolled-back transaction on Production, 2026-10-07): with a shared key, the old server answered the submit with the draft receipt and the expense row stayed `draft`; with the migration applied inside the same transaction, the same sequence executed the submit and the row became `submitted`.

## 4) Why it appeared without a code change, and why it looked MicroLink-only

- No code regressed. The defect has existed since the atomic V1 path went live (migration dated 2026-09-09; the oldest stranded draft is from 2026-09-11).
- It is only reachable on the path "new expense **and** a bill is required **and** files are attached". MicroLink's `attachment_required_above_amount` is ₹499, so most MicroLink expenses above that go through draft-first; every other organization has a ₹50 threshold **and** uses the legacy submit path, which does not use these receipts at all. The V1 RPCs are routed only for the MicroLink organization (`usesAtomicSubmissionV1`). So the generic server flaw was reachable by one tenant only.
- It surfaced "suddenly" because 193 of the 231 affected expenses were silently rescued by the employee's own second submit (median ~96 s). Reports started when enough employees did not notice the draft (38 expenses). Increasing volume and the workaround, not a deploy, explain the timing; a more precise trigger date cannot be proven from the available data.

## 5) Evidence (aggregates, last 30 days, MicroLink)

- 231 expenses used the draft-first flow. 193 were later submitted by a manual second submit; 38 remain drafts (all 38 have attachments and exactly one `save_draft` receipt and no `submit` receipt).
- Ages of the 38: 12 created in the last 24 h, 9 between 1 and 7 days, 17 older. **New ones are still accumulating until the fix is deployed.**
- 256 of 259 attachments in that flow were linked within 30 s of the draft: the upload/attach step succeeded; the drafts stalled at the submit call.
- The draft step wrote no `expense_created` audit row, so an audit-based timeline could not see these expenses (observability gap).
- Date locking is enabled; the stranded drafts do not match a lock rejection (a rejection is an error, not a replay).

## 6) Why earlier audits missed it

The failure produced **no error anywhere**: HTTP 200, no exception, no RLS denial, no trigger failure, no database error, nothing for GlitchTip. The backend replayed a *valid, successful* receipt for the wrong action. Audits that look for exceptions, failed requests, RLS/trigger/constraint errors or error-tracker events find nothing, because nothing failed. Two gaps:

- **Testing gap:** tests asserted "the call returned committed" instead of "the expense is now submitted", and none modelled the server's replay rule across two actions.
- **Observability gap:** the form handled the mismatch itself (toast + success screen); there was no semantic check (requested submit, actual draft) reported anywhere, and Postgres logs only `fatal`.

## 7) Expense state machine (MicroLink atomic path)

| Action | Allowed from | Result | Notes |
|---|---|---|---|
| `save_draft` | new, `draft`, `rejected` | `draft` (a draft save never moves a submitted expense backwards) | rejected from `submitted` and later with "can no longer be edited" |
| `submit` | new, `draft`, `rejected` | `submitted` | resolves routing, sets tier/reviewer; the function verifies `status = 'submitted'` before writing the receipt |
| `update_submitted` | `submitted` only | stays `submitted` | in-place edit; no routing, no second submission event |
| any | stale `expected_revision` | rejected `PW409` | optimistic concurrency |

Invalid transitions (editing `approved`/`paid`/`under_review`/`verified` expenses, `update_submitted` on a draft) raise before any write. A SUBMIT request now returns success only when the canonical status is `submitted`; otherwise the server raises, and the client additionally refuses to announce success unless the receipt and the read-back both say `submitted`.

## 8) Fix

### Server (migration `20261007120000_microlink_receipts_action_scoped_idempotency.sql`)

- **Receipt identity is `(idempotency_key, action)`**: `PRIMARY KEY (idempotency_key, action)`. A draft receipt and a submit receipt can coexist under one raw key.
- **Replay is scoped to the requested action** (`WHERE idempotency_key = v_key AND action = p_action`). An old cached client that reuses one key for draft and submit now gets its submit **executed once** (and its retries replayed), never answered with the draft receipt.
- Cross-user guard kept and extended to any action under the key.
- **Response contract** on every response: `expense_id`, `requested_action`, `receipt_action`, `actual_status` (canonical status of the expense row), `idempotency_result` (`executed` | `replayed`), plus the existing fields.
- `get_expense_submission_result_v1(p_idempotency_key, p_action DEFAULT NULL)`: action-aware reconciliation lookup (default prefers `submit` over `update_submitted` over `save_draft`); `REVOKE FROM PUBLIC`, `GRANT TO authenticated, service_role`.
- The function body is the **live Production definition** with only the replay block, one declaration and the final RETURN changed. The migration verifies its own result (composite PK and action-scoped replay) and is safe to re-run. No FK references the receipts table (checked), no duplicate keys, 2,715 rows.
- **Deploy order:** apply the migration to Production **before or together with** the frontend deploy, then reload the PostgREST schema cache. The client tolerates both orders: it falls back to the key-only lookup if the action-aware one is not yet there.

### Client (PR #8)

- `microlinkAttachFirstFlow.ts` (extracted so it is testable): the draft step uses its **own** key (`draftAttemptKeyRef`); any draft/attach failure aborts before the submit and keeps the keys so a retry resumes the same draft and the same files.
- `microlinkExpensePersistence.ts`: action-aware `lookupSubmissionResult(key, action)` with fallback; receipt contract fields; `unsubmittedReceiptMessage` and `semanticMismatchTags`.
- `ExpenseForm.tsx`: a committed submit whose receipt is not a `submit`/`submitted` receipt, or a read-back status mismatch, now **throws** "saved as a draft but NOT submitted" instead of announcing success.

## 9) Idempotency rules (going forward)

1. A receipt's identity includes **what operation it is for**, not only the caller's key.
2. A replay may return a stored result only for the same operation by the same user.
3. A different operation under the same key executes under its own receipt (or is rejected explicitly) — never answered with another operation's result.
4. Responses state the operation requested, the operation that produced the result, and the canonical resulting state.
5. Clients must not treat "committed" as success; they check the resulting state. A single logical attempt with several mutating steps uses a distinct key per step.

## 10) Attachment behaviour

- Finalize is idempotent by deterministic destination `expenseId/filename` (it probes for the destination before writing), so retries do not duplicate files; abort after upload, finalize timeout and a repeated attempt re-attach the same files.
- If the attach step fails after the draft exists, nothing is submitted; the next click resumes the same draft (same draft key) and re-attaches, then submits once.
- A partial finalize (some files fail) is a separate pre-existing weakness (see §13).

## 11) Existing stranded drafts (read-only classification, no mutation)

38 drafts: all have attachments and a `save_draft` receipt with no `submit` receipt (the stranded-by-this-bug signature). 12 are under 24 h old, 9 are 1–7 days, 17 are older. They are **not** modified by this fix. Employees can open them from My Expenses and submit; any bulk action needs a separate, explicitly approved plan (per-expense review of category, project fields, date lock and tier).

## 12) GlitchTip correlation and semantic monitoring

**Where.** GlitchTip 6.0 runs on the Olympus host (web, worker, Postgres 16, Redis). All containers healthy; the host rebooted 2026-10-05. Source-map extraction errors recur (frames may stay minified); ingestion is otherwise healthy.

**Did GlitchTip confirm the cause? No, and it could not have.** The failure is a *successful* replayed receipt: no exception is thrown, and GlitchTip stores only uncaught exceptions and explicit `reportError` calls (toasts and console are breadcrumbs, DOC-090). The submit flow had no `reportError`. In the incident windows GlitchTip holds no events.

**Ingestion gap.** Daily event partitions are missing for 2026-08-23 to 2026-09-29, so no event bodies survive for the period when the drafts accumulated. The scheduler now creates partitions automatically. Nothing on Olympus was modified.

**Unrelated findings preserved.** Older "Failed to upload file: Failed to fetch" issues (July–Aug 10); `ReferenceError: toast is not defined` in `Layout.tsx` recurring (not fixed here, separate change); one stale-chunk load failure.

**Instrumentation.** `microlinkSubmitMonitoring.ts` reports via `reportError` each way the attach-first flow can leave a draft: `draft_save`, `attach_receipts`, `submit` (rejected), `submit_unconfirmed`, `submit_not_submitted`. Tags: flow, stage, organization slug, attachment count, coarse attachment kinds, server error code, and for a semantic mismatch **`requested_action`, `receipt_action`, `actual_status`** (enumerated values only); release and environment come from `reportError`. No amount, name, user/expense id, file name or URL is attached (unit-tested). Target after deploy: zero `microlink_atomic_submit` / `submit_not_submitted` events.

## 13) Other flows (inventory)

- **No other operation replays by key across different actions.** Admin submit/bulk (composite key + payload hash), balance ledger (`organization + key + source_type`), imports (batch status), money-return/transfer (status under row lock), withdraw/delete/trash (state-based) were reviewed.
- Weaker spots noted, **not changed here** (out of scope, separate tickets): balance credit v3 replay compares only `source_type` (latent, no UI caller found); `cashier_return_money_to_admin_v2` has no idempotency key.
- "Success shown without checking resulting state" candidates (not changed here, severity from the review): `MoneyReturnService` reject (direct update with no status guard, HIGH), `Expenses.tsx` money-return success without `ok` check (HIGH), `Balances.tsx` add-funds/adjust/bulk-add toasts ignoring `already_applied`/skipped rows (HIGH, latent), `AdminPanel` direct status updates without row-count check (MED), partial receipt finalize still proceeding to submit (MED), plus lower items.

## 14) Tests

- `src/services/__tests__/microlinkDraftThenSubmit.test.ts` (both a legacy and an action-scoped fake server; every test asserts expense status/count): reproduction of the bug, client fix, **old cached client with one shared key (submit executes once)**, per-action replay, double click, lost response after commit (action-scoped lookup), lookup fallback and defense in depth, semantic-failure helpers, PDF matrix (success; failure before the attachment row; finalize timeout; abort after upload; same attempt repeated with no duplicate expense or file; multiple PDFs submit once), draft rejected/unknown, and source guards for the migration.
- `src/lib/__tests__/microlinkSubmitMonitoring.test.ts`: coarse attachment kinds, no identifying data, semantic tags.
- Live Production verification of the new server semantics in a **rolled-back** transaction (draft receipt cannot satisfy a submit with the same raw key; replay; double submit creates one expense; another user cannot use the key; lookup with and without action).

## 15) Verification status and post-deploy plan

- Local: targeted tests, full suite, TypeScript (no new errors against fresh `origin/main`), build, migrations check, secrets scan (results in the PR description).
- Not done here: a real authenticated end-to-end on Production.
- After deploy (as a MicroLink account): (a) an amount below the threshold with no attachment, (b) above ₹499 with an image, (c) with a PDF, (d) with several attachments — one Submit each, expect `submitted`. Monitor: new MicroLink drafts with a `save_draft` receipt and no `submit` receipt should stop appearing; no `submit_not_submitted` events in GlitchTip. Tabs left open on the old bundle are covered by the server fix; a hard refresh gets the client fix.

## 16) Follow-ups

- Audit-log events for the draft save and for a replayed/failed submit.
- Raise Postgres logging above `fatal` for errors.
- Clean up old `temp/` receipt objects.
- Fix the separate `toast is not defined` in `Layout.tsx`.
- Review the weaker idempotency/"wrong state shown as success" items in §13.

## 17) Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-10-07 | 1.0 | Claude Code | Forensic audit, root cause, client fix and regression tests. |
| 2026-10-07 | 1.1 | Claude Code | GlitchTip (Olympus) correlation; safe error capture in the submit flow. |
| 2026-10-07 | 2.0 | Claude Code | Systemic fix: action-scoped receipts migration, response contract, action-aware lookup, extracted attach-first flow, semantic monitoring, full test matrix, idempotency inventory, state machine, why audits missed it. |
