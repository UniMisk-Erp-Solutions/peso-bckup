# Draft Incident — Forensic Audit (stranded drafts / re-submitted expenses)

**ID:** DOC-148 · **Last updated:** 2026-10-16 · **Status:** in progress (fix implemented locally, not deployed) · **Branch:** `audit/draft-incident-2026-10-16`

## 1) Summary
Read-only audit of Production (no data changed). The MicroLink action-scoped idempotency fix is **intact and live** (live function bodies byte-identical to the repo; PK `(idempotency_key, action)`; cross-user replay blocked). The old bug did **not** regress. The current stranded drafts come from a **different** cause: the legacy create-then-submit paths (ExpenseForm for non-MicroLink orgs, and the **batch form for every org including MicroLink**) insert the row as a draft first and only then submit it; when the server-side submit step is rejected or interrupted, the draft is left behind and the client has no way to resume it, so the user re-enters the expense.

## 2) Production facts (2026-10-16)
- 223 draft rows: 159 live, 64 in the Recycle Bin. By org: MicroLink 150, Patidar 55, Bikes auto Hero 11, Mistry And Shah 3, two QA orgs 2+2.
- Created last 24 h / 7 d / 30 d (all, live): 8 (2) / 22 (15) / 117 (53).
- Live drafts by origin: intentional `save_draft` (MicroLink atomic) 25; user-withdrawn 6; legacy "created, never submitted" 123; other 5.
- Last 7 d live drafts: 15 (MicroLink 14, Patidar 1) — all legacy create-never-submitted; 13 of the 15 fail the server's required-custom-field validator today (From/To location, Project Unique ID missing); 12 have a near-identical later submitted sibling; 0 are intentional.
- "Submit succeeded but row is draft": **0** real contradictions. 17 receipts say submit/update_submitted for a draft row; all 17 have an `expense_withdrawn` audit (user withdrawal, status returns to draft). 108 "expense_submitted" notifications on draft rows are all withdrawn rows.
- Mixed draft+submitted batches: **0**. 13 batches contain drafts, all pure-draft batches (failed batches, mostly 2026-09-06/07).
- Re-submit candidates (live draft + same-user later non-draft sibling, score>=9): 55 all-time; 53 carry no unique data (exact duplicate data), 2 hold unique attachments/custom values.

## 3) Idempotency (live vs repo)
`_persist_microlink_expense_snapshot_v1`, `save_microlink_expense_draft_v1`, `submit_microlink_expense_v1`, `update_microlink_submitted_expense_v1`, `submit_microlink_expense_batch_v1`: live bodies IDENTICAL to the latest repo migration (`20261007120000`). Receipt lookup is `idempotency_key = v_key AND action = p_action`; another user's key raises 42501; organization is fixed to MicroLink and membership-checked. First shared-key (draft+submit) receipts appear 2026-10-07 14:46 UTC and both executed correctly. Existing tests (`microlinkDraftThenSubmit.test.ts`, 29 tests) cover shared key, retries, double click and lost response.

## 4) Root causes
1. **Create-then-submit in legacy paths** (`ExpenseForm` legacy branch; `ExpenseService.submitExpenseBatch`). Failure after `createExpense` leaves a draft; `newExpense.id` is a local variable, there is no idempotency key, and a retry inserts a second row (Patidar `2010f726`: draft with 5 attachments, identical submitted row 24 s later).
2. **Server rejects submit for missing required fields** the client did not send (MicroLink batch 2026-10-14 15:51–15:52: 11 lines, 0 custom values, validator "From/To location, Project Unique ID" missing; user re-entered the batch at 17:41 with the fields). Why the client sent none is not proven (config/plan gap suspected).
3. **RLS narrowing 2026-09-22** (`20260922090000` section 3): an owner UPDATE that keeps a row `draft` is now rejected (proved on a throwaway DB, `supabase/tests/draft_incident/rls_draft_update.sql`). Consequences: `submitExpenseBatch`'s unchecked `.update({batch_id})` silently fails — **no batch child has been attached since 2026-09-22** (`expense_batches` still created, ~400/week, children = 0) — and editing a stranded legacy draft (`updateExpense`) fails, so users cannot rescue it from the UI. The recycle-bin migration comment ("never an owner UPDATE policy for a DRAFT row") is contradicted by the data (1,683 children attached in the week of 09-14).
4. **User withdrawals** return rows to draft by design (76 audit rows; 43 in the week of 09-28); 17 were replaced by a new row.
Classification: B + C-not-found + D (batch, via 3) + E (interruption suspected, `45c994fa`) + H (required-field mismatch). Not A (no idempotency regression). Same bug as before: NO.

## 5) Cutover comparison (2026-10-07 14:46 UTC)
Before (194 d): 143 live drafts, 25 atomic save-drafts, 107 legacy never-submitted, 6 withdrawn. After (9 d): 16 live drafts, **0** atomic, 16 legacy never-submitted (11 from one batch on 10-14). No atomic-path stranding after the fix.

## 6) Fix plan (not implemented)
1. Restore a narrow owner draft->draft UPDATE door (or an RPC) so batch linking and draft editing work; check the `batch_id` update result and fail the line visibly.
2. Make legacy single and batch submission atomic server-side (reuse the MicroLink pattern with `(key, action)` receipts) or at minimum persist the created id and reuse/resume it on retry.
3. Align client required-field validation with the server validator; surface "saved as draft, fields missing" clearly.
4. Data repair: owner review for the 2 unique-data drafts and the 13 batches; the 53 exact-duplicate drafts can be trashed (soft delete) after snapshotting expense, custom values, attachments, audit logs, receipts and notifications. No hard delete.

## 7) Tests
`src/services/__tests__/draftIncidentKnownDefects.test.ts` (6, `it.fails` pins), `supabase/tests/draft_incident/rls_draft_update.sql` (4 PASS), existing `microlinkDraftThenSubmit` (29) and persistence/snapshot suites (53) pass.

## 8) Implementation (branch `fix/stranded-draft-submit-flow`)

**Status:** implemented and tested locally; **not applied to Production**. Existing drafts untouched; repair is a separate task.

### Submit design (what it is, honestly)
- The generic legacy flow keeps its client-side routing/approval code (not rewritten: no approval-routing change). It is made safe by **identity reuse + server preflight**, not by one transaction. The MicroLink atomic route is untouched.
- **Preflight** `preflight_expense_submission_v1(org, category, values)` runs the server's own validator (`expense_submission_integrity_issues_v1`) against a throwaway row that is rolled back, so nothing is persisted and there is no second copy of the rules. Called by the single form and (per line, before the batch row exists) by the batch form. Only explicit `user_fixable` issues block; an unreachable preflight degrades to the server's final validation.
- **Reuse** (`src/lib/submitAttemptReuse.ts`): the created draft id is held in a ref and sessionStorage with a fingerprint of the expense. A retry updates and promotes the same row; a row an earlier press already committed is not submitted, logged or notified again; a committed row never "satisfies" a different expense. Success is only reported after reading the row back as past `draft`.
- A failed submit still leaves **one** reusable draft (never a second), with an explicit message ("Your draft was preserved ... it will reuse the same expense"). A closed tab with sessionStorage cleared can still orphan a draft; that single case is not closable without a server-side atomic submit (follow-up).

### Draft update security (migration `20261025100000_stranded_draft_submit_flow_v1.sql`)
No RLS policy is changed. Two narrow SECURITY DEFINER RPCs: `update_own_draft_expense_v1` (owner, same org, live DRAFT, 7 whitelisted columns, status never changes; `status`, `user_id`, `organization_id`, `batch_id`, `transaction_number`, approval and assignment columns are refused) and `link_expense_to_batch_v1` (owner of both rows, same org, draft only, idempotent, never moves a row between batches). anon has no EXECUTE.

### Batch behaviour
Every line is preflighted before the batch row exists. A failing batch link now fails that line visibly and nothing further runs for it. A partial failure returns each failed line's expense id; **Retry failed lines** passes a resume state so finished lines are skipped, failed lines reuse their draft (same id, receipts not re-attached), and the same batch row is reused. 10 lines, line 6 fails, retry: 10 rows total.

### Required-field parity
The client no longer guesses: the server answers via preflight before anything is created. Save Draft (MicroLink atomic) is unchanged and still accepts incomplete fields.

### Withdrawal
Withdrawn rows are plain drafts; editing now works (`update_own_draft_expense_v1`) and resubmitting reuses the same id. No history semantics changed.

### Validation
Local DB acceptance (`supabase/tests/draft_incident/acceptance*.sql`): 22 PASS. Vitest: new `strandedDraftRegression`, `submitAttemptReuse`, `batchSubmitRetry`; full suite green. Read-only monitor: `supabase/tests/draft_incident/monitor_stranded_drafts.sql`.

## 9) Implementation part 2 - server-side submission identity (closes the last gap)

**Gap:** after part 1, if the browser lost ALL local state between draft creation and retry, nothing knew the draft id and the next Submit inserted another row.

**Fix:** one logical submission = `(organization_id, user_id, client_submission_id)` = ONE row, enforced by a partial UNIQUE index (migration `20261026100000_server_side_submission_identity_v1.sql`).
- Existing identifiers audited: none could identify a logical attempt (MicroLink `idempotency_key` is per-RPC-action and MicroLink only; transaction numbers exist only after submit; amount/date/title are explicitly not used).
- `resolve_or_create_expense_v1`: authenticates, applies the same insert authorization as the INSERT policy, looks up the caller's own row, otherwise `INSERT ... ON CONFLICT DO NOTHING` and re-reads (the loser of a race resolves to the winner's row). A live draft replay refreshes the draft in place; an already-submitted row is returned untouched (`idempotent_replay`, no second submit/audit/notification); a Recycle-Bin row is reported (`in_recycle_bin`), never resurrected or duplicated. Only the 7 draft-editable fields are accepted.
- Batch: `resolve_or_create_expense_batch_v1` (one batch per `client_batch_id`); each line's id is derived server-side from `md5(client_batch_id || ':' || line_index)::uuid`, so retrying line 6 after a restart resolves to the same row.
- `claim_client_submission_id_v1`: a legacy draft with no id is given one only when its owner continues it; never overwritten, never inferred, no backfill.
- Client: `clientSubmissionIdRef` (single form) and `clientBatchIdRef` (batch form). The single-form id is saved inside the browser's recoverable form (localStorage), so a restored form resumes the same expense. **Correctness does not depend on sessionStorage** (all `sessionStorage` helpers were removed; tests clear it). If every browser state is lost and the user opens a blank form, that is a NEW logical submission by design - similarity is never used to merge.
- Latent bug fixed on the way: `loadExpenseFormDraft` returned `undefined` after any reload because `fromMemory?.pendingSubmit !== false` is true when memory is empty, so it never read localStorage. It now requires a real entry, which is what makes the durable restore real.
- Routing semantics: unchanged (the client submit step still resolves approval routing). MicroLink atomic RPCs and receipts: unchanged. No RLS policy changed.
- Batch form has no durable content restore, so after a reload there is no form to retry from; the server guarantee holds for any client that keeps the batch id, and the already-created lines remain editable drafts.

**Validation (all local, nothing applied to Production):** DB acceptance 22 + 22 PASS; real concurrency test (8 sessions, 4,800 racing calls, 600 rows, 0 disagreements, 600 audit rows); vitest 289 files / 4,897 tests; build, migrations:check, security:secrets pass; TypeScript 620 = main.

## Revision log
| Date | Rev | Change | By |
|------|-----|--------|----|
| 2026-10-16 | 1.0 | Read-only Production audit; no data changed. | Claude Code |
| 2026-10-26 | 1.1 | Implementation section: preflight + identity reuse + narrow draft/batch RPCs + batch resume. Not applied to Production. | Claude Code |
| 2026-10-26 | 1.2 | Part 2: server-side logical submission identity (unique index + resolver RPCs), batch identity, localStorage-durable id, load-draft bug fix. Not applied to Production. | Claude Code |
