# Additive Credit Accounting V3

**Doc ID:** DOC-114
**Status:** in progress
**Last updated:** 2026-09-01
**Owner / area:** Balances, Historical Balance Anchors, Supabase (Production, `evo3o0fdjaroxq7uohrm21cp`)

---

## 1) Summary

Retires the "target anchor" accounting model (`stated_balance - reconstructed_position = automatic adjustment`) for all future balance credits, per explicit owner decision: an imported or admin-entered amount is **always** a delta added to the current balance, never a target the server adjusts toward. Also fixes two related, real bugs found via forensic investigation of a live incident: expense deductions were positioned on their approval timestamp instead of their business date, and the employee-facing ledger displayed raw implementation strings (`historical_balance_update`, `historical_anchor_reversal`) from a reversed credit pair. A rejected old-model test batch (4 batches, 269 anchor rows, 358 ledger rows, 179 employees) was identified by exact provenance and removed from Production after full forensic proof that removal had zero net financial effect on any employee.

---

## 2) Problem / requirement

The owner tested the Tally import wizard live on Production (still running the old target-anchor engine, since the prior Tally hotfix branch was unmerged). The result showed a confusing pair of ledger rows (`historical_balance_update +₹13,289` / `historical_anchor_reversal -₹13,289`) for many employees, with Current Balance not visually reconciling against the shown history. The owner:
1. Rejected target-balance semantics outright — an entered amount must always be additive.
2. Required expense deductions to be dated by the expense's own business date, not its approval date.
3. Required the displayed running balance to be reconstructed chronologically, never trusted from a stored column.
4. Required transaction numbers on expense-deduction rows.
5. Required reversed credits to disappear from normal employee-facing history.
6. Authorized removing the exact rejected test batch's artifacts, with rigorous forensic proof first.

---

## 3) Forensic findings (employee 6238, MicroLink, used as the reference case)

- Employee 6238 (Anilkumar Sharma) showed `historical_balance_update +13,289.00` (07:07:25 UTC) followed by `historical_anchor_reversal -13,289.00` (07:21:24 UTC) — both from the SAME testing session that produced this task, ~14 minutes apart.
- Four related batches were created 07:03–07:21 UTC the same day, all `mode='balance_update'`: `3c5d6090` (204 rows, validated, never applied), `053fbd53` (200 rows, "Pm july.xlsx", applied+reversed), `377a5ffb` (61 rows, "service july.xlsx" — the same file forensically analyzed in the prior Tally hotfix), `94534946` (8 rows, "fms July.xlsx", applied+reversed).
- Across the 3 applied+reversed batches: 269 anchor rows, 358 ledger rows (179 apply + 179 reversal), 179 distinct employees. Every single employee's net effect (`SUM(amount_delta)` across their own apply+reversal pair) was proven to be exactly `0.00` — the reversal fully undid the credit for every one of them, with no exceptions.
- Independent proof: a fresh backup taken 6 minutes **before** the incident began (`20260901T065756Z`, i.e. before `07:03:32`) was restored into a throwaway database `pesowise_pre_additive_fix_audit`. Every one of MicroLink's 415 employees with a valid Employee ID had a `profiles.balance` in that pre-incident backup **byte-identical** to their current Production balance — confirming zero legitimate events occurred in the org between the backup and the incident, and that the incident's net effect was provably zero for every employee, not just 6238.
- Organization-wide reconciliation (canonical `SUM(balance_ledger.amount_delta) + SUM(-expense_balance_deductions.expense_amount)` per employee, vs `profiles.balance`, computed independently of the new engine's own "baseline" shortcut): **414 of 415 reconciled exactly**. The one mismatch, employee `1001` ("MicroLink Admin" — the account used for today's own testing), has zero `balance_ledger` rows, zero `expense_balance_deductions`, and zero approved expenses ever, yet a `-₹517.00` balance — a pre-existing, unrelated data-integrity gap (a balance set through some path entirely outside the ledger/deduction system, predating this incident) that was investigated and **not** touched, per the explicit instruction never to blindly correct a mismatch.

---

## 4) New architecture

### Additive credit core (`supabase/migrations/20260901120000_additive_credit_v3.sql`)

`_balance_apply_credit_core_v3` — the entire formula:
```sql
v_balance_after := v_balance_before + p_amount;
```
No target, no reconstruction, no adjustment math. Locks the profile row, writes an immutable `balance_ledger` row (`entry_type` = `opening_credit` | `balance_credit`), idempotent via `idempotency_key`. `balance_apply_credit_v3` (public, admin-only) wraps it for a single manual credit; `balance_reverse_credit_v3` reverses by subtracting the exact original `amount_delta` (never recomputing anything), is idempotent, and marks the source import batch `reversed` when applicable.

`balance_ledger` gained a `day_position` column (smallint, 0/1/2 — mirrors the pre-existing `balance_historical_anchors.day_position` convention exactly) and widened `entry_type`/`source_type` CHECK constraints (additive only — no old values removed). `balance_import_batches.mode` gained `opening_credit`/`balance_credit`.

### Batch import (`20260901121500_additive_credit_v3_import.sql`)

`balance_validate_import_v3` / `balance_apply_import_v3` / `balance_reverse_import_v3` mirror the v2 staging model without any conflict-detection machinery (an additive credit cannot conflict with anything). A new capability probe, `balance_additive_v3_capabilities_v1`, gates the new UI independently of the old `balance_historical_v2_capabilities_v1` (left completely untouched — the old engine's 9 functions still exist and still work, dormant, for rollback/audit, per explicit instruction not to drop them yet).

### Unified, chronologically-reconstructed timeline (`20260901123000_unified_balance_timeline_v3.sql`)

`get_my_unified_balance_timeline_v3` / `get_org_balance_timeline_v3`:
- Union of `balance_ledger` (minus reversed original+reversal pairs, for **either** engine — old anchor-sourced or new v3 credit-sourced, matched generically via `reversal_of` and via `balance_historical_anchors.status = 'reversed'`, with no employee/org ID ever hardcoded) and `expense_balance_deductions` **joined to `expenses`** for the canonical business date (`expenses.trip_start`) and transaction number (`expenses.transaction_number`) — the exact same fields the Expense table itself displays. Approval time (`expense_balance_deductions.created_at`) is never used for positioning.
- Same-day ordering: `day_position 0` (Opening Credit) < `1` (ordinary events, expense deductions tie-broken by their own transaction number) < `2` (Balance/Tally Credit).
- Running balance: `baseline_before_first_event = current profiles.balance - SUM(all visible deltas)`, then a cumulative window-function sum in chronological order — computed over the **full** event set before pagination (`LIMIT`/`OFFSET` applied in the outer query only), so page 2's running balance is never wrong.

---

## 5) Verification (throwaway DB, then real Production RPCs)

All of the following were proven with real SQL against the pre-incident-restored throwaway database, then re-verified via the actual public RPCs using real `auth.uid()` sessions (via `request.jwt.claim.sub`):
- `₹0 + 45,000 = 45,000`; `-30,000 + 45,000 = 15,000`; the same `+45,000` credit produces different results from different starting balances (never a target).
- Full owner example end to end: July `-30,000` (22 real approved expenses) → 31-Jul credit `+45,000` → August `-30,000` (7 real approved expenses) → `-15,000`.
- Same-day ordering: Opening Credit (`day_position=0`, `00:00:00`) sorts before a same-day Balance Credit (`day_position=2`, `23:59:59.999999`).
- Idempotent apply (retry with the same `idempotency_key` does not double-credit) and idempotent reversal (reversing twice does not double-reverse).
- Non-admin caller correctly rejected.
- Employee 6238's real July/August history run through `get_org_balance_timeline_v3` after applying a new test credit: running balance walks exactly through 22 July expenses (`-3,800` total), the credit, then 7 August expenses (`-1,110` total), and the **last** reconstructed row (`40,090.00`) exactly matches `profiles.balance` after the credit.
- Pagination consistency: page 1 (15) + page 2 (15) produces byte-identical running balances to one unpaginated call for all 29 events.

---

## 6) Production cleanup (executed, atomic, verified)

A fresh checkpoint backup (`20260901T075110Z-pre-additive-credit-v3-and-cleanup`, checksum-verified, `pg_restore -l` confirmed 112 table-data entries) was taken immediately before cleanup, in addition to the pre-incident backup already available. One transaction, scoped by exact batch ID (never by date or `entry_type` alone):
1. Deleted 358 `balance_ledger` rows sourced from the rejected batches' anchors.
2. Deleted 473 `balance_import_rows` (must precede anchor delete — FK from `resulting_anchor_id`).
3. Deleted 269 `balance_historical_anchors`.
4. Deleted 4 `balance_import_batches`.

Pre/post counts matched exactly at every step; `expense_balance_deductions` (13,039), `expenses` approved count (16,771), and `cash_transfer_history` (394) were unchanged; the 5 pre-existing, unrelated `opening_balance` anchors for a different organization were untouched; employee 6238's `balance_ledger` now shows zero rows from the rejected batch; `profiles.balance` for every affected employee was unchanged by the cleanup (net effect was already zero).

---

## 7) Frontend changes

- `ImportBalancesDialog.tsx`: mode selector now offers **Opening Balance Credit** / **Balance Credit** (additive language, no "target"/"adjustment" copy) instead of Opening Balance/Balance Update; both Tally and the starter-sheet path call the v3 validate/apply/reverse RPCs; the old anchor modes remain in the codebase (dormant) only for any already-existing batch, never offered as a new selection.
- `ImportHistoryDialog.tsx`: reversal dispatches to `balance_reverse_import_v3` for the new modes, `balance_reverse_import_v2` for old-mode batches (by `batch.mode`); new mode labels added.
- `EmployeeBalanceHistory.tsx` / `useEmployeeBalanceLedger.ts`: switched to `get_my_unified_balance_timeline_v3`; added a **Transaction** column; running balance now server-reconstructed (`calculated_balance_after`); disclaimer copy corrected (expense deductions ARE now included, dated correctly); new entry-type labels added, old raw strings never shown in normal use.
- New `src/lib/balanceAdditiveV3Capability.ts`: independent capability probe/hook for the v3 engine, mirroring the asymmetric-cache fix from the Tally hotfix (a `ready:false` self-heals after 60s; `ready:true` is permanent).

**Scoped out** (flagged, not fixed): the "Last Credit"/"Recent Credits" cards on the Balance History page still read a separate legacy feed (`get_my_balance_transfer_history`) that does not include v3 credits. Fully satisfying this would need either extending that RPC or deriving the cards from the same v3 timeline already fetched for the ledger card — deferred as a follow-up given this task's time budget, rather than risk a rushed, under-tested change to a separate feature.

---

## 8) Security

Every new RPC: `SECURITY DEFINER`, `SET search_path TO 'public'`, `REVOKE ALL FROM PUBLIC`/`anon`, `GRANT EXECUTE TO authenticated` (internal `_balance_apply_credit_core_v3` additionally revoked from `authenticated`). Admin membership is re-verified server-side inside every mutating RPC (`organization_memberships.role = 'admin'`), never trusted from the client. No employee ID, organization ID, or amount is ever hardcoded in any RPC — proven generic via the same functions correctly handling MicroLink's real 179-employee incident and this doc's synthetic multi-employee tests alike.

---

## 9) What was explicitly NOT done

- The old anchor engine (`balance_apply_historical_anchor_v1` and its 8 sibling functions) was **not** modified or dropped — left dormant for rollback/audit.
- No new real credit was applied to any employee as part of this task (per explicit instruction) — the owner will test/apply the new additive-credit import manually once satisfied.
- `main` not merged. `dev` untouched.

---

## 10) Related docs

- [tally-import-warning-reconciliation.md](./tally-import-warning-reconciliation.md)
- [historical-balance-anchors-v2.md](./historical-balance-anchors-v2.md)
- [historical-balance-v2-phase1-production-activation.md](./historical-balance-v2-phase1-production-activation.md)

---

## 11) Zero-amount rows are a no-op, not an error (2026-09-01, follow-up)

The owner's real 61-row Tally validation table proved signed additive arithmetic was already correct (25 non-zero rows summing to exactly ₹3,818.00, matching the UI's reported Total delta) but surfaced one remaining bug: `balance_validate_import_v3` classified `input_amount = 0` as `'invalid_amount'` ("Amount is missing or zero."). Zero is not a read failure — it means the employee's balance does not change, and must never block an otherwise-valid batch or be counted against `invalid_row_count`.

**Fix** (`supabase/migrations/20260901140000_additive_v3_zero_noop_validation.sql`, forward-only — the three prior V3 migrations were not touched or replayed): `balance_validate_import_v3` rewritten as a single deterministic CASE-based UPDATE (first-match-wins, replacing 5 sequential UPDATEs that could otherwise overwrite an earlier correct classification):
- `normalized_employee_id IS NULL` / no profile match → `'unknown'` (unchanged)
- `input_amount IS NULL` → `'invalid_amount'` (genuine read failure — unchanged)
- `effective_date IS NULL` → `'invalid_date'` (now checked regardless of amount value, fixing a related ordering bug)
- `input_amount = 0` → **`'no_op'`** ("No balance change.") — new, correct classification
- otherwise (any non-zero signed amount, positive or negative) → `'valid'`

`balance_apply_import_v3` required no change — it already filters `WHERE validation_status = 'valid'`, so a `no_op` row is automatically excluded from the apply loop (no `balance_ledger` row, no `profiles.balance` mutation) purely by never being selected. The RPC's JSON return gained `no_op_row_count` alongside `valid_row_count`/`invalid_row_count`/`total_delta`.

**Frontend** (`BalanceLedgerService.ts`, `ImportBalancesDialog.tsx`): `ImportValidateResultV3`/`ImportValidateResult` gained `no_op_row_count`. The preview-step summary tiles read "Will apply" / "Needs attention" for additive-credit modes (still "Matched" / "Needs fixing" for the dormant anchor modes) and a "No change" tile for no-op rows; the per-row status badge for `no_op` is a neutral secondary badge ("No change"), never a red destructive badge, and never shows the old "Amount is missing or zero." message. The confirm-screen Apply-disabled message now distinguishes cause: `invalid_row_count > 0` still shows "N row(s) need fixing…", but an all-no-op batch (valid=0, invalid=0) shows "Nothing to apply — every row is a zero-amount no-op (no balance change)." instead of a misleading "0 row(s) need fixing." Nothing blocks Apply merely because `total_delta` is negative — a net-negative batch applies normally.

**Verification**: 8 SQL test cases against the pre-incident-restored throwaway database (`pesowise_pre_additive_fix_audit`), inside `BEGIN...ROLLBACK`, simulating real `auth.uid()` sessions — mixed +1000/-2000/0 batch classified valid=2/no_op=1/invalid=0/total_delta=-1000; a no-op row's `calculated_new_balance` equals `current_balance_snapshot` exactly; negative-total batches apply their 2 valid rows and never the no-op row; a no-op row never receives a `ledger_entry_id`; a negative-amount credit reversal restores the exact original balance with no `abs()`; a genuinely NULL amount still classifies `invalid_amount`, never `no_op`. Applied to real Production after a fresh checksum-verified backup (`20260901T085456Z-pre-zero-noop-validation-fix`); PostgREST reloaded and `balance_additive_v3_capabilities_v1()` re-verified `ready: true` post-migration. `main` not merged; `dev` untouched; no real balance mutated by this task (validate/preview only against the owner's real 61-row batch).

---

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-09-01 | 1.0 | Claude Code | Initial doc: retired target-anchor semantics for new credits, fixed expense deduction dating and running-balance reconstruction, cleaned up the rejected old-model test batch after full forensic proof of zero net financial effect across 179 employees, org-wide reconciliation 414/415 (1 pre-existing unrelated admin-account anomaly, investigated and left untouched). |
| 2026-09-01 | 1.1 | Claude Code | Follow-up fix: `input_amount = 0` was wrongly classified `invalid_amount`; reclassified as `no_op` throughout SQL validator, batch counts, Apply eligibility, and UI (§11). |
