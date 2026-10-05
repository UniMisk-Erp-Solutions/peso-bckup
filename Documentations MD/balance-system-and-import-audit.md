# Balance System Audit + Bulk Import / Ledger Architecture

**Doc ID:** DOC-103
**Status:** in progress
**Last updated:** 2026-08-24 (renumbered from DOC-099 — see index.md's 2026-08-24 revision-log entry: `main` had independently allocated DOC-099 to Form Template Scalability and DOC-100 to Bulk Import/Matrix/Preset Parity before this branch merged)
**Owner / area:** Balances, `Balances.tsx`, `BalanceTransferOfferService`, cashier cash transfer, bank transfer offers, employee balance history, `feature/bulk-balance-import-ledger`

---

## 1) Summary

Before implementing the bulk employee balance / spreadsheet import feature described in `FUTURE_PLANS.md` §16–§18, this document audits the **existing** balance mutation architecture end-to-end: the admin "Add Amount" flow, the admin "Edit balance" direct-set flow, the existing "Bulk Add" UI, the cashier cash-transfer path, the bank-transfer offer/acceptance system, and the employee-visible balance history. The audit is based on a full read of every file that mutates or reads `profiles.balance`, `money_assignments`, `cash_transfer_history`, `balance_transfer_offers`, and `expense_balance_deductions`, plus direct inspection of the live RLS policies and function definitions on Production.

**Headline finding:** the default cashier cash-transfer path (used whenever an organization has not explicitly enabled `transfer_recipient_acceptance`) is genuinely unsafe money-handling code today. It performs an uncoordinated debit, an uncoordinated credit, and a best-effort (in one function) or entirely absent (in a second, parallel function) compensating rollback — all as three-to-five independent, sequentially-awaited browser `supabase.from("profiles").update(...)` calls, with **no database transaction, no row locking, and no server-side pairing or amount-conservation check**. Postgres RLS on `profiles` permits any admin or cashier to write the `balance` column directly with no `WITH CHECK` clause constraining the value, and `cash_transfer_history`/`money_assignments` are directly client-writable with no linkage back to an actual balance mutation. The one place in this feature area that already gets this right — `accept_balance_transfer_offer`, the bank-transfer-offer acceptance RPC — is a genuine `SECURITY DEFINER`, single-transaction function, but even it omits `FOR UPDATE` locking on the `profiles` rows it mutates. A separate, already-proven-correct template exists in this same codebase (`review_approve_expense_v2`, DOC-089) that this feature's new RPCs are modeled on directly.

This document is committed on its own, before any schema or RPC code, per the project's mandatory audit-first workflow for this feature.

---

## 2) Problem / requirement

`FUTURE_PLANS.md` §16–§18 requires a bulk employee balance / fund-allocation spreadsheet importer with two distinct modes (historical opening-balance migration, and recurring allocation), an immutable audit ledger, organization-specific column mapping, a permanent private source-file archive, and an upgraded employee-visible balance history. The explicit constraint from the owner: **do not build the importer by automating the existing browser-orchestrated `addAmountToUser()` hundreds of times** — a single canonical, server-authoritative financial mutation architecture is required, and the existing manual "Add Amount" / "Edit balance" / "Bulk Add" flows must be migrated onto it too, not left as a second, unsafe path running in parallel with a new safe one.

---

## 3) Current architecture — exact findings

### 3.1 Cashier "Add Amount" (`addAmountToUser`, `src/pages/Balances.tsx:588-953`)

Only reachable when the org feature flag `transfer_recipient_acceptance` is **off** (the system default — the flag must be explicitly enabled per organization). When on, this function short-circuits into the safe `BalanceTransferOfferService.proposeOffer` RPC path instead (see §3.4).

With the flag off, the exact sequence is:

1. **Read cashier balance** — from in-memory React state `cashierBalance` (`Balances.tsx:571-574`/`284-285`), not a fresh locked DB read.
2. **Debit cashier** — `supabase.from("profiles").update({ balance: cashierBalance - amountToAdd }).eq("user_id", user.id)` (`Balances.tsx:726-738`). This call's result is **not checked for zero affected rows** — if RLS silently filters it, the code still marks `deductionPerformed = true`.
3. **Calculate new employee balance in the browser** — `(currentRow.balance || 0) + amountToAdd` (`Balances.tsx:746-747`), from client-held state.
4. **Credit employee** — a second, independent `supabase.from("profiles").update({ balance: newBalance })...` (`Balances.tsx:750-754`).
5. **Rollback on failure** — only if step 4 throws or returns zero rows, a **third**, independent `UPDATE` restores the cashier to `startingCashierBalance`, a value captured in JS before step 2 (`Balances.tsx:756-779`). This rollback is itself unchecked and unatomic: if it is also silently RLS-filtered, or the browser tab closes between steps, the cashier's money is permanently lost with no compensating record — a real money-destruction bug, not theoretical.
6. **Separate `money_assignments` INSERT** (`Balances.tsx:798-805`) and **separate `cash_transfer_history` INSERT** (`Balances.tsx:860-877`) — both wrapped in `// Don't throw error - ... is not critical for the transaction`, i.e. failures here are silently swallowed after the balance mutation has already committed, letting the audit trail diverge from what actually happened to the money.

There is **no** database transaction and **no** `supabase.rpc(...)` call anywhere in this function (confirmed: zero occurrences of `.rpc(` in `Balances.tsx`). Every step is its own independent HTTP request / independent Postgres transaction, structured only by a JS `try/catch`.

### 3.2 Admin "Edit balance" (`updateBalance`, `Balances.tsx:955-1113`)

A **second, independent** implementation of the same debit/credit shape, reachable from the admin-only "Edit" pencil on each row. It is **worse** than §3.1: when a cashier uses it to add funds, it debits the cashier (`Balances.tsx:987-996`) with **no rollback at all** if the subsequent recipient `UPDATE` then fails or is RLS-filtered to zero rows (`Balances.tsx:999-1009`) — money is simply gone, no compensating write anywhere. It sets the target balance to an absolute, client-computed value (a direct overwrite, not a delta), and only logs to `cash_transfer_history` for positive deltas — a downward correction is never logged at all.

### 3.3 Existing "Bulk Add" (`Balances.tsx:1909-2184`)

Admin-only UI. With `transfer_recipient_acceptance` off (the reachable default path for most orgs), it runs a **strictly sequential `for...of` loop**, one plain `profiles.update({ balance: currentBalance + bulkAmount })` per selected user, each independently `try/catch`-wrapped:

- **Not atomic across the batch.** Employee 1 can succeed while employee 2 fails; `successCount`/`errorCount` are tallied and reported as partial success ("Added amount to N user(s), M failed").
- **No idempotency guard of any kind.** No unique constraint, no idempotency key. A double-click past the (client-only) `bulkAdding` disable guard, a reopened dialog, or a network retry will double-credit every affected user — nothing in the schema would reject it.
- The local `rows` UI state is optimistically bumped for **every** selected user regardless of whether their individual DB write actually succeeded, so a failed row can display an incorrect balance until the next refetch.
- Does not reuse `addAmountToUser` — it is a third, separately-maintained inline copy of the same unsafe pattern (though, being admin-only credit-only, it has no cashier-debit leg).

### 3.4 Bank Transfer Offer / Acceptance (`BalanceTransferOfferService.ts`, `supabase/migrations/080608_1430_balance_transfer_offers.sql` + later redefinitions)

This is the one part of the existing system with real server-side atomicity. `propose_balance_transfer_offer` only `INSERT`s a `'pending'` row into `balance_transfer_offers` — no balance moves at offer time (confirmed both by the function body and by explicit design-intent comments: `"Pending balance allocation offers... balances change only on accept"`). `accept_balance_transfer_offer` is a single `SECURITY DEFINER` RPC, called via exactly one `supabase.rpc("accept_balance_transfer_offer", { p_offer_id })` from the browser: it locks the offer row `FOR UPDATE`, validates status/recipient, credits the recipient, debits the sender if applicable, writes `money_assignments`/`cash_transfer_history`, and marks the offer accepted — **all inside one PL/pgSQL function invocation**, so a mid-way failure rolls back everything. This is a materially sounder design than §3.1–§3.3.

**Two gaps remain even here:** (a) the recipient/sender `profiles` rows are read with plain `SELECT`s, **not `FOR UPDATE`** — only the offer row itself is locked, so a lost-update race against a concurrent acceptance or a concurrent direct balance edit on the same profile row is possible; (b) a migration-filename-ordering hazard was found: `20260621140000_form_fields_display_v2_and_self_transfer.sql` adds an "admin self-transfer applies immediately" branch to `propose_balance_transfer_offer`, but two lexically-later-sorting, non-ISO-named migrations (`290529_1600...sql`, `290529_1700...sql`) redefine the same function again **without** that branch — meaning the live, actually-applied definition of `propose_balance_transfer_offer` may not contain the self-transfer behavior its own migration comment describes. This is flagged for awareness; it is unrelated to the balance-import feature and was not changed by this work.

`cashier_return_money_to_admin` (`290529_1700_cashier_accountant_mode.sql:434-541`) follows the same atomic-but-unlocked-profile-reads pattern as `accept_balance_transfer_offer`.

### 3.5 RLS reality on the mutation surfaces

Direct inspection of live Production policies confirms the code-level findings:

- **`profiles`**: `"Admins can update any profile"` and `"Cashiers can update managed profiles"` both permit `UPDATE` of the entire row — including `balance` — with **no `WITH CHECK` clause constraining the new value**. Postgres RLS is row-level only; there is no column-level privilege restriction on `balance` specifically, and no trigger validates or logs changes to it. **Any admin or cashier can set any reachable profile's balance to any value directly from the browser console today**, completely bypassing `Balances.tsx`'s UI-only self-transfer/role checks.
- **`money_assignments`** and **`cash_transfer_history`**: both directly client-`INSERT`-able by any admin/cashier, with only a `CHECK (amount > 0)` on the latter — nothing ties either row to a real, successful, paired balance mutation.
- **`balance_transfer_offers`**: correctly locked down — `"Mutations only via SECURITY DEFINER RPCs"`, client INSERT/UPDATE policies are explicitly absent; only the RPCs (which `EXECUTE`-grant to `authenticated`) can write.
- **`expense_balance_deductions`** (DOC-089): the strictest and correct pattern already in this codebase — `REVOKE ALL ... GRANT SELECT`, no client INSERT path at all, `UNIQUE(expense_id)` making double-deduction structurally impossible, written only by the `SECURITY DEFINER` `review_approve_expense_v2`.
- A tangential, out-of-scope finding: `has_role()` (used by several of these RLS policies) checks a separate, **non-organization-scoped** `user_roles` table, distinct from the newer `organization_memberships.role` pattern that `review_approve_expense_v2`, DOC-098's Review RPCs, and this feature's new RPCs all use. The two systems can in principle diverge. Not touched by this work; noted for a future security pass.

### 3.6 Employee balance history (`EmployeeBalanceHistory.tsx`, `get_my_balance_transfer_history`)

A single, narrowly-scoped, well-guarded RPC: `SECURITY DEFINER`, `auth.uid()`-derived caller identity, active-membership check, employee-role-only gate, org feature-flag gate (`employee_transfer_history`), and a hard row filter `WHERE cth.recipient_id = v_uid` — an employee can only ever see **received** rows from `cash_transfer_history`, server-side pagination (offset/limit, clamped to max 100), `COUNT(*) OVER()` for total. This is **explicitly and deliberately not a full ledger**: the page's own docstring states expense deductions live on a separate, unread path (`expense_balance_deductions`, which the RPC never touches and which has no employee-read RLS policy at all today); there is no opening-balance concept, no reversal concept, and no "sent" transfers in this view. The codebase already documents this as intentional scoping, not an oversight — extending it in place would conflict with that stated intent, so the new ledger is a **parallel, additive** view rather than a rewrite of this RPC.

### 3.7 The known-good template already in this codebase

`review_approve_expense_v2` (`supabase/migrations/20260808140000_atomic_expense_approval_balance_deduction.sql`) is the pattern every new RPC in this feature follows: lock the "parent" row first (there: the expense; here: the import batch or the offer-equivalent), then lock the exact `(organization_id, user_id)` profile row(s) `FOR UPDATE` — never `LIMIT 1`, always fail closed on 0 or >1 matches — do the arithmetic in SQL against the locked value, explicitly check the `UPDATE` affected a row (guarding the exact "PostgREST doesn't error on an RLS-filtered zero-row UPDATE" failure mode this same migration's own incident writeup documents), write immutable evidence with a uniqueness constraint that makes double-processing structurally impossible, and do all of it inside one `SECURITY DEFINER` function call.

---

## 4) Solution — canonical architecture (implemented in this branch)

- **`balance_ledger`** — one immutable, append-only row per balance-affecting event across the whole system (manual add, adjustment, cashier transfer in/out, bank transfer, historical import, allocation import, reversal). `before`/`delta`/`after` always reconcile; no client-supplied before/after value is ever trusted.
- **Canonical manual RPCs** — `balance_add_funds_v1`, `balance_transfer_cash_v1`, `balance_adjust_v1` — replace the browser-orchestrated `addAmountToUser`/`updateBalance` paths, following the §3.7 template exactly (lock order, `FOR UPDATE`, SQL arithmetic, explicit zero-row guard, ledger write in the same transaction).
- **Import batch/row tables + `balance_apply_import_v1`** — preview/validate client-side (or via a read-only server helper), then one atomic, all-or-nothing, idempotent server RPC applies the whole batch, locking every affected profile row up front in deterministic order.
- **Legacy compatibility** — `cash_transfer_history`/`money_assignments` continue to receive rows from the new RPCs (dual-write in the same transaction) so existing read surfaces (Cashier Transactions, Reports, CSV export) keep working unchanged during the transition; they are not deleted or rewritten in V1.
- **Private source archive** — a new, non-public Supabase Storage bucket for uploaded import files, following the existing `expense-attachments` bucket's RLS-policy pattern.

Full schema, RPC signatures, and migration list are in §5 and the code itself; this document records the audit and the resulting design decision, not a line-by-line schema dump (see the migrations for the authoritative definitions).

---

## 5) Key files

```
Documentations MD/balance-system-and-import-audit.md   (this file)
supabase/migrations/20260819160000_balance_ledger.sql
supabase/migrations/20260819161000_balance_manual_rpcs.sql
supabase/migrations/20260819162000_balance_import_schema.sql
supabase/migrations/20260819163000_balance_import_apply_rpc.sql
supabase/migrations/20260819164000_balance_import_storage.sql
src/services/BalanceLedgerService.ts
src/services/BalanceImportService.ts
src/pages/Balances.tsx (rewired; two new admin-only buttons + dialog mounts added)
src/components/balances/ImportBalancesDialog.tsx  (new — 7-step import wizard)
src/components/balances/ImportHistoryDialog.tsx   (new — history + reversal UI)
```

(Authoritative list — see commit history on `feature/bulk-balance-import-ledger` for the exact final set of files touched.)

### 5.1 Frontend UI (this revision)

`ImportBalancesDialog.tsx` implements the 7-step wizard (Type → Starter sheet →
Upload → Mapping → Validation/Preview → Confirm → Result) described in the
product spec. Money only moves in the explicit Apply step
(`applyImportBatch`, called from the Confirm step's button) — every earlier
step (`createImportBatch`, `uploadImportSourceFile`/`attachSourceStoragePath`,
`insertImportRows`, `validateImportBatch`, `getImportRows`) is staging/preview
only and never mutates `profiles.balance`. The Apply button is disabled
whenever `ImportValidateResult.apply_disabled` is `true`, with the blocking
row count shown inline. Employee ID is carried as `string | null` end-to-end
(`cellToString`, never `Number()`/`parseInt`) from spreadsheet cell through
`StagedImportRow.rawEmployeeId`; the generated starter sheet also force-sets
the Employee ID column's cell type to `"s"` so Excel cannot strip leading
zeros on re-open. Column mapping auto-suggests via case-insensitive header
heuristics (`guessFieldForHeader`) but always remains admin-editable via a
per-column `<Select>`. Spreadsheet parsing uses the existing `xlsx` dependency
(`XLSX.read(buffer, { type: "array", cellFormula: false })`, `header: 1`) —
no formulas are evaluated, only cell values are read.

`ImportHistoryDialog.tsx` lists batches via `getImportBatches`, resolves
`created_by` to a name with one best-effort follow-up `profiles` query
(falls back to the raw id), expands a row to show `getImportRows` detail
(before/input/after/ledger reference), and drives `reverseImportBatch` behind
a required-reason confirmation, surfacing `reversed_count` and any `blocked`
employees with their reasons. A reversed batch's row is never removed or
hidden — `loadBatches()` is re-run after reversal so the row stays visible
with its updated status.

Both dialogs are wired into `Balances.tsx` as two new admin-only buttons
("Import Balances", "Import History") next to the existing "Add to Multiple
Users" button; `onImportApplied` calls the page's existing `fetchProfiles`
so the balances table reflects the import immediately. No existing handler
(`addAmountToUser`, `updateBalance`, the Bulk Add submit handler) was
modified by this revision.

---

## 6) Test plan

- [ ] Employee identity matching: exact ID, leading-zero ID, trimmed ID, unknown ID, duplicate ID in file, email fallback, ambiguous identity, name-only must not match.
- [ ] Historical mode: 0→1000, 500→1000 (delta +500), 1000→500 (delta -500), no fake transfer-history row created.
- [ ] Allocation mode: 1000+500=1500, decimal precision.
- [ ] Atomicity: one invalid row among 500 → zero mutations.
- [ ] Idempotency: double-Apply / retry → exactly one financial change.
- [ ] Concurrency: two legitimate allocations to the same employee never lost-update.
- [ ] Cashier transfer: insufficient balance → zero mutation; recipient-side failure → sender not debited.
- [ ] Security: employee cannot import; cross-org denied; inactive membership denied.
- [ ] Reversal: normal reversal, double-reversal blocked, later-activity safeguard.
- [ ] Ledger: immutable, `before + delta = after`, correct actor/org/source.

See §7 for actual QA results.

---

## 7) Live QA results (Mistry And Shah, real HTTP/RPC end-to-end)

Run against the local dev build pointed at real Production
(`pesowise-supabase.unimisk.com`), authenticated as the real Mistry And Shah
admin (owner-authorized use of that account for this QA) and two new
synthetic accounts created through the app's own `/admin/users` "Create
User" flow (`DOC100 QA Cashier 1` / `DOC100QACASH1`, `DOC100 QA Employee 1` /
`DOC100QAEMP1`), plus one existing already-synthetic QA fixture
(`DOC100QAEMP2` re-labelled from a prior QA session's zero-balance account).
No SQL was run against Production for any of this — every mutation below
went through the app's real authenticated Supabase client (PostgREST →
SECURITY DEFINER RPC), the same path the deployed frontend uses.

- **Admin Add**: exercised via this org's pre-existing transfer-offer flow
  (`transferAcceptanceEnabled` is on for Mistry And Shah, so `addAmountToUser`
  correctly routes other-recipient adds through `propose/accept_balance_transfer_offer`
  rather than `balance_add_funds_v1` directly — see finding below). ₹100 admin→employee
  offer proposed, accepted as the employee, balance moved 0→100 correctly.
  **Finding**: `balance_ledger` stays empty for this path (offer/accept was
  intentionally left untouched per Part F — "do not casually rewrite existing
  bank-transfer logic"), so orgs with transfer-acceptance on will not see
  ledger entries for admin/cashier adds unless routed through Edit Balance or
  Import. Documented as a known V1 gap, not fixed this pass.
- **Adjust Balance** (`balance_adjust_v1`, via the Edit Balance dialog —
  not gated by transfer-acceptance): 100→250 (reason required, delta +150).
  Confirmed live in both the dual-written legacy `cash_transfer_history` row
  and the new `balance_ledger` entry (`entry_type=manual_adjustment`,
  `balance_after=250`, correct note) rendered on the employee's own Balance
  History page. PASS.
- **Cashier cash transfer** (`balance_add_funds_v1`, cash mode, called via
  the authenticated cashier's own session): cashier 20→15, employee 260→265.
  Verified both `balance_ledger` rows (`cash_transfer_out`/`cash_transfer_in`,
  linked, idempotency key suffixed `:out`/`:in`) and the dual-written
  `cash_transfer_history` row (`transfer_type=cashier_to_employee`). PASS.
- **Self-transfer guard**: admin attempting to add funds to their own account
  via the direct-add action was correctly rejected server-side
  ("Cannot add funds to your own account via this action"). PASS.
- **Two-row allocation import**: uploaded a CSV (`doc100qaemp1 +10`,
  `doc100qacash1 +20`) through the real 7-step wizard — Preview correctly
  showed both rows `Valid` with exact current/input/resulting balances and
  total delta ₹30; Apply credited both accounts exactly once
  (employee 250→260, cashier 0→20) and returned `changed_count: 2`. PASS.
  **Bug found and fixed during this test**: `BalanceImportService.createImportBatch`
  never set `created_by` on the INSERT, which is `NOT NULL` — every Apply
  attempt failed silently in the UI (wizard appeared to hang on the mapping
  step with no visible error; the real error, found via React fiber
  inspection, was `null value in column "created_by" ... violates not-null
  constraint`). Fixed by fetching `supabase.auth.getUser()` and including
  `created_by: user.id` in the insert. Re-tested clean after the fix.
- **Duplicate Apply**: re-invoked `applyImportBatch` on the same batch id
  after it was already applied — returned `already_applied: true` with the
  cached summary, zero additional mutation (balances unchanged). PASS.
- **Invalid-row atomicity**: batch with one valid row + one row referencing
  `DOC100-NOT-REAL` — Preview correctly flagged the row `Unknown employee`
  / "No employee found for the given ID/email"; Confirm step's Apply button
  was disabled (`disabled=true` confirmed via DOM inspection) with a
  "1 row(s) need fixing" message. Also called `applyImportBatch` directly
  (bypassing the disabled button) to confirm server-side enforcement: raised
  `Row 2: no matching employee found for employee_id=DOC100-NOT-REAL
  email=<NULL>`, target employee's balance unchanged (260 before and after).
  PASS at both UI and RPC layer.
- **MicroLink safety**: zero rows touched or created in MicroLink's
  organization throughout this QA pass (all batches/ledger rows scoped to
  Mistry And Shah's `organization_id`).

Not exercised live this pass (covered instead by the earlier BEGIN/ROLLBACK
proof suite against Production, which passed 6/6 targeted tests for
`balance_add_funds_v1`/`balance_adjust_v1` before this session's live QA):
idempotency-key replay of a manual add (proof-tested, not re-run live),
reversal (`balance_reverse_import_v1`), leading-zero employee ID matching,
name-only-must-not-match. Left for the owner's manual QA pass per the
"keep QA small and fast" instruction — the underlying RPC logic for all of
these is unchanged from what was proof-tested.

---

## 8) Correctness hardening pass (pre-owner-QA review)

Two new additive migrations (`20260819170000_balance_manual_rpc_hardening.sql`,
`20260819171000_balance_import_reversal_archive_hardening.sql`) — the
already-applied `20260819161000`/`20260819163000` migrations are left as
history; these `CREATE OR REPLACE` the same function signatures. Live on
Production, verified via targeted tests through the real authenticated app
client (Mistry And Shah only):

1. **Admin cash semantics fixed.** The first cut of `balance_add_funds_v1`
   debited ANY caller in cash mode, including admin — a regression versus
   current MAIN, where Admin Add Amount has never debited the admin's own
   balance. Now only a cashier's cash-mode add debits the caller.
   Verified: admin cash-add to an employee leaves the admin's own balance
   byte-for-byte unchanged (`actor_balance_after` returns `null`); cashier
   cash-add still debits the cashier correctly.
2. **Cashier authorization moved server-side.** Balances.tsx's UI checks
   (no self, no admin target, no cashier target, assigned-engineer zone
   scoping) are now enforced inside the RPC itself — a cashier calling the
   RPC directly (bypassing the UI) cannot fund an admin or another cashier.
   Admin remains organization-scoped only. Verified live: cashier→admin
   denied, cashier→cashier denied, cross-org target denied — all zero
   mutation.
3. **Idempotency lookup is now organization-scoped**, resolved after the
   caller's org rather than before. A key reused across two different
   organizations can no longer produce a false `already_applied`.
   (Cross-org isolation verified by code review, not live — a live test
   would require acting as a MicroLink caller, which is off-limits.)
4. **Import reversal is now genuinely all-or-nothing.** A pre-flight pass
   checks every affected employee for later ledger activity with ZERO
   mutation; if any are blocked, the whole call fails closed (batch stays
   `applied`, zero balance change, zero reversal rows) instead of reversing
   some employees and skipping others. Verified live: reversing the earlier
   QA import batch (which now has later activity from subsequent QA
   actions) correctly blocks with both affected employees listed and zero
   balance change; a fresh batch with no later activity reverses cleanly.
5. **Source archive is now required before Apply, server-side.**
   `balance_apply_import_v1` fails closed if `source_storage_path` is
   `NULL`, regardless of what the UI enforces. `ImportBalancesDialog.tsx`'s
   archive upload changed from best-effort (swallowed error, continued
   anyway) to required (a failure stops the wizard on the upload step; the
   admin retries by clicking Continue again — no special UI state needed).
   Verified live: a batch created without an archive is correctly rejected
   at Apply with zero mutation.
6. **`source_sha256` is now computed and enforced.** The wizard hashes the
   file client-side (`crypto.subtle.digest`) before staging, checks for an
   existing applied duplicate (client-side early warning) and persists the
   hash to the batch; `balance_apply_import_v1` independently re-checks the
   same organization+mode+hash combination server-side before Apply.
   Verified live: uploading the identical file as a second "new" batch is
   blocked with the original batch id and applied date, zero mutation.
7. **Import lock order is now truly deterministic.** The row-resolution/
   validation pass now takes zero locks; only after every row has passed
   validation are the complete distinct affected profiles locked in
   ascending `user_id` order (was previously row-encounter order, which
   depended on spreadsheet row ordering). Whole-batch atomicity re-verified
   live with the restructured RPC (one valid + one unknown row → zero
   mutation).
8. **Import History "Employee" column fixed.** Was displaying
   `raw_email` under an "Employee" header; now shows the actual matched
   employee's name via one bounded batched `profiles` lookup (not N+1),
   keyed off `matched_user_id`.
9. **Row limit added.** Files over 5,000 non-empty rows are rejected before
   staging with an explicit count-based message.
10. **Reversal copy updated** in `ImportHistoryDialog.tsx` to state the
    all-or-nothing rule plainly instead of implying a partial "may be
    skipped" outcome.

**Explicitly deferred as follow-up, not blocking this pass** (per owner
instruction): saved/reusable column-mapping profiles UI
(`balance_import_mapping_profiles` already exists in schema; a
save/choose/set-default UI for it is a real feature addition, not a
correctness fix).

**Explicitly out of scope, untouched**: DOC-098 review/approval
architecture. One known follow-up noted for a future, separately-scoped
pass: approval Ready/Waiting preview classification in the review UI still
uses a frontend `isPendingForCurrentReviewer` heuristic instead of the
canonical server `is_actionable` value — tracked as
"REVIEW FOLLOW-UP: server-authoritative approval preview classification",
not touched here. **Closed in §10 below.**

---

## 10) Second punch-list pass — location auth, import concurrency/limits, review preview, expense deductions

Six new additive migrations (20260819172000–178000), applied live. All
targeted correctness tests below passed against real Production, Mistry And
Shah only, via the app's own authenticated client — no raw SQL DML.

1. **Location-based cashier authorization** (`20260819172000`). The
   engineer-only server hardening from `20260819170000` didn't reproduce
   Balances.tsx's `cashier_assigned_location_id` path (location takes
   priority over the direct-engineer fallback, via `engineer_locations`).
   Added, matching the audited frontend's own precedence exactly. Verified
   live: engineer-in-location ALLOW, employee-in-location ALLOW,
   employee-outside-location DENY, admin/cashier targets still DENY. An
   unrelated pre-existing data quirk was found incidentally (a
   `cash_transfer_history_recipient_role_check` constraint doesn't accept
   `executive` as a recipient role) — not caused by and out of scope for
   this fix, noted for a separate pass.
2. **`source_sha256` now required unconditionally** (`20260819174000`) —
   was previously skipped whenever the column was left NULL.
3. **Duplicate-file protection made concurrency-safe** (`20260819174000`) —
   a partial unique index on `(organization_id, mode, source_sha256) WHERE
   status='applied'` gives a structural, database-level guarantee (not a
   race-prone SELECT-then-UPDATE) that two batches carrying the identical
   file can never both reach `applied`; the second transaction's own status
   UPDATE fails on the unique index and the whole transaction (including
   any balance mutations already performed) rolls back.
4. **5,000-row cap enforced server-side** in both
   `balance_validate_import_v1` and `balance_apply_import_v1`
   (`20260819174000`) — the UI check alone could be bypassed via direct
   PostgREST staging. Verified live with a 5,001-row batch.
5. **Client-staged input separated from server-owned state** via
   column-level grants (`20260819176000`) on `balance_import_batches` /
   `balance_import_rows` — an admin's own session can no longer directly
   `UPDATE status/applied_at/applied_by/.../ledger_entry_id` etc.; only the
   SECURITY DEFINER RPCs (which run as the function owner, unaffected by
   grants on `authenticated`) can. Verified live: a direct client
   `UPDATE ... SET status='applied'` is denied with
   `permission denied for table balance_import_batches`; the normal wizard
   staging flow (which only ever touches the still-granted columns) is
   unaffected.
6. **Archived object existence + ownership verified**, not just a non-NULL
   path string (`20260819174000`) — `balance_apply_import_v1` now checks
   the stored path's own `{organization_id}/{batch_id}/...` prefix matches
   the batch, and that a `storage.objects` row for that exact bucket+name
   actually exists, before any mutation. Verified live: a batch with a
   path pointing at a different batch id is denied; a batch with a real,
   correctly-owned archived file still applies normally (positive control).
7. **`balance_ledger.user_id` retention fixed** (`20260819177000`) — was
   `ON DELETE CASCADE` to `auth.users`, meaning a hard-deleted user's entire
   ledger history would silently vanish. This app is not purely
   deactivation-based: a historical one-time migration already hard-deleted
   `auth.users` rows directly, and the Supabase Dashboard's own
   Authentication > Users > Delete action can too, entirely outside this
   app's code. Changed to `ON DELETE RESTRICT` (matching
   `actor_user_id`, which was already safe with no explicit CASCADE) — a
   user with any ledger history is now permanently un-hard-deletable.
   `organization_memberships.is_active` (normal offboarding) is a
   completely separate mechanism, unaffected.
8. **Server-authoritative approval preview** (`20260819173000`, new
   read-only `review_preview_approval_targets_v1`). Reuses the exact same
   canonical helpers the live review queue already uses
   (`_debug_review_assert_reviewer_v1`, `_debug_review_caller_context_v1`,
   `_debug_review_handoff_ids_v1`, `_debug_review_actionability_v1`) for a
   caller-supplied set of expense IDs — no review authorization rule is
   reimplemented. Wired into `EngineerReview.tsx`'s
   `classifySelectionServerAuthoritative`, replacing the frontend
   `isPendingForCurrentReviewer` heuristic at both call sites that gate an
   actual approval decision (bulk `handleBulkApprove` and singular
   `approveExpense`) — the other 11 `isPendingForCurrentReviewer` call sites
   (labels/row styling only) were left untouched, matching the confirmed
   small blast radius. Fails closed on any preview error: no dialog, no
   approval, a retry toast only. `review_verify_batch_atomic_v1`,
   `review_approve_expense_v2`, Manager Override, and review queue
   pagination were not touched. Verified live: the RPC returns correct
   `is_actionable`/`actionable_stage`/`actionable_reason` for real terminal,
   admin-approvable, and cross-scope expenses; `npx tsc --noEmit` clean.
9. **Employee balance history now includes expense deductions**
   (`20260819178000`, new read-only `get_my_expense_deductions_v1`, employee
   -own-row-only, mirrors `get_my_balance_ledger_v1`'s exact security shape).
   `useEmployeeBalanceLedger` now merges `balance_ledger` and
   `expense_balance_deductions` into one chronologically-sorted list
   (client-side merge; each source keeps its own server-side pagination).
   `review_approve_expense_v2` and the deduction write path/UNIQUE(expense_id)
   guard are untouched. Not separately re-verified via a live approved-expense
   click-through in this pass (would require constructing a full
   submit→approve scenario) — correctness relies on RPC-level review (applied
   without SQL error, same proven security shape) and a clean typecheck.

**Branch cleanup audit** (item 13): `scripts/_ssh_apply_balance_migrations.py`,
`_ssh_verify_balance_install.py`, and `_ssh_credentials.py` reviewed —
no literal passwords/keys/QA credentials in any of them (confirmed via
grep), `.local-sensitive-data/` confirmed untracked, `security:secrets`
clean. Determined all three are legitimate, reusable operational tooling
(matching this repo's existing `_ssh_*.py` convention) rather than
throwaway debugging artifacts — kept, not removed.

**Security review** (item 11): every new/changed function in this pass
verified for `auth.uid()` requirement, active-membership requirement, role
requirement, organization isolation, and `REVOKE ... FROM PUBLIC, anon` +
`GRANT ... TO authenticated` only. `review_preview_approval_targets_v1` uses
the stricter `SET search_path = ''` (matching the review-function family it
was modeled on). The balance-family functions (172000/174000/178000) keep
`SET search_path = public`, matching their own existing sibling functions —
reviewed and confirmed not exploitable: every table reference in this
codebase's new functions is schema-qualified (`public.`/`auth.`/`storage.`),
and the small number of unqualified calls are all `pg_catalog` builtins
(`count`, `lower`, `trim`, `format`, `now`, `coalesce`, etc.), which Postgres
always searches first regardless of `search_path`. Left as-is rather than
churned to `''` purely for style, per "do not blindly change working code."

---

## 12) Financial path closure pass — every remaining legacy `profiles.balance` mutation path

A fresh repo-wide scan for direct `profiles.balance` writes (grep for
`.from("profiles")...update(...balance`, `SET balance`, and every
`money_return`/`balance_transfer_offer`/`money_assignments` reference)
found two remaining browser-orchestrated financial paths outside the
canonical RPC architecture, plus several smaller gaps. All closed via 6 new
additive migrations (`20260820100000`–`150000`), applied live.

1. **`MoneyReturnService.approveReturnRequest`** was still fully
   client-orchestrated: read both balances, computed both new values in the
   browser, PATCHed `profiles` twice with a manual best-effort rollback on
   the second PATCH's failure, and never wrote `balance_ledger`. Replaced
   with one atomic RPC, `approve_money_return_request_v2` (`20260820130000`):
   locks the request and both profile rows, resolves the amount from the
   request (never the browser), verifies sufficient balance only after
   locking, debits requester/credits cashier, writes `balance_ledger`
   evidence (new `source_type='money_return'`, added via an additive
   `ALTER TABLE ... DROP/ADD CONSTRAINT` on the existing CHECK — the table
   itself was not touched), `cash_transfer_history`, and FIFO-consumes
   `money_assignments`, all in one transaction. Insufficient balance at
   approval time rejects the request server-side with zero balance
   mutation, matching the prior UX exactly (verified live: cashier balance
   and employee balance both provably unchanged by the rejected attempt).
   `MoneyReturnService.rejectReturnRequest` was audited and left as a direct
   RLS-protected status update — it never touches money and the existing
   policy (`cashier_id = auth.uid()` and cashier/admin role) is already
   correctly scoped, so a new RPC would be unnecessary weight.

2. **`accept_balance_transfer_offer`** locked only the offer row, then read
   both profile balances with a plain `SELECT` (no `FOR UPDATE`) and `SET` a
   calculated value — a lost-update race under concurrent acceptance — and
   never wrote `balance_ledger` at all. This function (and
   `propose_balance_transfer_offer`) predate this session's SSH-applied
   migration set and are owned by a different Postgres role than the one
   this session's DDL channel connects as; `CREATE OR REPLACE` on those
   exact names fails with "must be owner of function", and escalating to a
   different connecting role to force it through was refused as an
   unauthorized workaround. Shipped instead as new, freshly-owned functions
   — `propose_balance_transfer_offer_v2` / `accept_balance_transfer_offer_v2`
   (`20260820120000`) — matching this codebase's own established `_v2`
   convention. `BalanceTransferOfferService.ts` now calls the v2 names
   exclusively (`reject`/`cancel` were unaffected, unchanged). accept_v2
   locks the offer, re-verifies recipient/status, re-verifies both parties
   are still active org members, locks the affected profile row(s) in
   deterministic ascending-`user_id` order, re-reads balances only after
   the locks, and writes `balance_ledger` evidence
   (`source_type='bank_transfer_offer'`, `source_id=offer.id`) in the same
   transaction as the balance UPDATE(s), `cash_transfer_history`, and
   `money_assignments`. **Known limitation, documented rather than hidden:**
   the old `propose_balance_transfer_offer` / `accept_balance_transfer_offer`
   remain present server-side — their `EXECUTE` grant could not be revoked
   for the same ownership reason — but are no longer called by any
   sanctioned application path. Fully retiring them requires a one-time
   DBA-privileged ownership reassignment outside this session's available
   access, tracked as a follow-up.
3. **Shared cashier-scope helper** (`public._cashier_target_authorized_v1`,
   `20260820100000`): `propose_balance_transfer_offer_v2` previously had its
   own engineer-only authorization copy, independent of
   `balance_add_funds_v1`'s (already location-aware) rule. Extracted into
   one helper both now call, so UI direct Add and transfer-offer proposal
   can never diverge again. `balance_add_funds_v1` itself was also
   re-pointed at this helper (`20260820110000`) — verified live with no
   behavior change (location-scoped engineer/employee ALLOW cases still
   pass, cashier→admin offers still DENY).
4. **`balance_add_funds_v1` bank-transfer validation** (`20260820110000`):
   previously only checked the source bank account when
   `p_source_bank_account_id` happened to be non-null, and never checked
   `is_active`. Now `bank_transfer` mode REQUIRES an account, which must
   belong to the caller's organization and be active, verified live (NULL
   account and an inactive account both DENIED).
5. **Legacy `cash_transfer_history` role compatibility**
   (`public._legacy_transfer_history_role_v1`, `20260820100000`):
   `cash_transfer_history_recipient_role_check` only recognizes
   `admin/cashier/engineer/employee` — it predates the `team_leader`/
   `executive` roles. The transfer-offer accept path already normalized
   this; `balance_add_funds_v1` did not, which was the actual root cause of
   the "exe" (`role='executive'`) constraint violation noted as an
   out-of-scope quirk in the prior pass. Now normalized consistently across
   `balance_add_funds_v1`, `accept_balance_transfer_offer_v2`, and the new
   money-return RPC. Verified live: admin cash-add to an executive-role user
   now succeeds (previously failed).
6. **Import audit records were still client-DELETE-able**
   (`20260820140000`): the prior staging-grants migration removed direct
   `UPDATE` of server-owned import columns but left table-level `DELETE`
   granted. Revoked entirely; a new admin-only
   `balance_cancel_draft_import_v1` RPC is now the only deletion path, and
   only for a batch that was never applied/reversed and has zero attached
   ledger entries. Verified live: direct client `DELETE` on an applied
   batch denied ("permission denied for table balance_import_batches"), the
   RPC also denies an applied batch, and a genuine empty draft batch
   cancels cleanly via the RPC (positive control).
7. **Unified, correctly-paginated employee balance history**
   (`get_my_unified_balance_history_v1`, `20260820150000`): the previous
   pass's `useEmployeeBalanceLedger` paginated `balance_ledger` and
   `expense_balance_deductions` independently then merged client-side,
   which cannot guarantee correct page boundaries once both sources have
   enough history. Replaced with one read-only RPC that `UNION ALL`s both
   sources BEFORE ordering/paginating. `useEmployeeBalanceLedger.ts` and
   `BalanceLedgerService.ts` simplified accordingly (the now-unused
   `getMyExpenseDeductions` client wrapper was removed as dead code; the
   underlying `get_my_expense_deductions_v1` RPC itself was left in place).
   Verified live: a real employee's history now returns one correctly
   chronologically-ordered page spanning `manual_add`, `manual_adjust`,
   `bank_transfer_offer`, `money_return`, and `import_batch` source types
   with a single consistent `total_count`.
8. **Saved import column mappings** (`ImportBalancesDialog.tsx`,
   `BalanceImportService.ts`): implemented Save/Choose/Set-default/Delete
   against the already-existing `balance_import_mapping_profiles` table (no
   schema change needed — RLS was already admin-only, organization-scoped).
   A file's headers are matched against the organization's default profile
   automatically on upload (falls back to automatic header guessing for any
   unmatched or missing profile); the applied profile id is attached to the
   batch via the already-client-writable `mapping_profile_id` column.
9. **Review approval-limit staleness — audited, no code change needed**:
   the frontend's `engineerApprovalLimit` (used only for the approval
   dialog's Ready/Waiting bucketing) is UI convenience state. The actual
   mutation path (`review_approve_expense_v2`, via the shared
   `engineer_approval_limit` check already present in
   `20260702120000_expense_review_admin_approve_rpc.sql`) re-reads
   `organization_settings.engineer_approval_limit` fresh at approval time
   and `RAISE EXCEPTION`s unconditionally if a non-hierarchy manager's
   expense exceeds it — independent of whatever the browser believed. A
   stale frontend limit can only make the dialog's bucketing overly
   cautious, never let an over-limit approval through; no new RPC or Review
   change was needed or made.
10. **Concurrency safety (offer acceptance, money-return approval)** —
    verified by code review, not a live two-connection race (impractical in
    this session's QA harness): both new/rewritten RPCs lock every affected
    row `FOR UPDATE` in deterministic ascending-`user_id` order before any
    read used for arithmetic, matching the same pattern already proven
    correct for `balance_add_funds_v1` and the import-apply RPCs earlier
    this session.

All 6 migrations applied live to Production with zero errors. Targeted
Mistry And Shah QA (synthetic fixtures only, zero MicroLink mutations)
covered: admin cash offer accept (admin wallet unchanged), cashier cash
offer accept (sender debit + recipient credit + both-sided ledger,
confirmed via admin's org-wide ledger read after confirming the employee's
own RLS-scoped view correctly showed only their own row), bank-transfer
offer accept (sender wallet unchanged), cashier→admin offer proposal
(denied), money-return approve (atomic, ledger+history+status), money-return
insufficient-balance-at-approval (zero mutation, correctly rejected with the
original reason string), bank-transfer with a null/inactive source account
(both denied), executive-role cash-transfer-history compatibility (fixed),
import-batch delete protection (all three sub-cases), unified balance
history pagination, and the cashier-scope-helper refactor (no regression).
`npx tsc --noEmit`, `npm run build:keep-maps`, `npm run migrations:check`,
and `npm run security:secrets` all clean; `eslint` on every touched file has
only pre-existing or already-established-convention `any`-cast findings, no
new categories.

`profiles.balance` direct-write lockdown remains deliberately NOT applied.
`main` remains unmerged.

---

## 13) Production draft-batch repair, exhaustive owner QA, and one more real defect found

**Production draft-batch repair (MicroLink, owner-authorized).** A single
abandoned draft expense (`a5eeb713-...`, never submitted, zero attachments/
form values/corrections/deductions/notifications, only an `expense_created`
audit row) shared `batch_id` with a real 10-line submitted batch
(transactions 12200–12209, ₹690), blocking the reviewer from acting on the
real batch. Read-only forensics confirmed every stated invariant exactly
(exact amounts, exact NULL fields, exact sibling count/total). The guarded,
transactional, single-row `UPDATE ... SET batch_id = NULL` repair (detach
only — `expenses_batch_id_fkey` is `ON DELETE SET NULL`, so a standalone
draft is a structurally valid state; no submission fabricated) was fully
drafted and syntax-proven against the read-only equivalent, but this
session's execution sandbox blocked the actual DML statement — the same
blocked-DML boundary already established earlier in this session for raw
`UPDATE`/`INSERT` against Production tables. **Not applied.** The exact SQL
is preserved for the owner (or a session with broader Bash permissions) to
run directly.

**A third browser-orchestrated financial path found and fixed.** An
independent, fresh re-scan of the full `origin/main...HEAD` diff (not
reusing any prior pass's grep summary) found `Expenses.tsx`'s "cashier
returns money to admin" flow (immediate, no approval needed) was still
fully client-orchestrated: two unlocked, independent
`.from("profiles").update({balance: ...})` PATCHes with no rollback if the
second failed after the first succeeded, and a best-effort
`cash_transfer_history` insert. Fixed with a new
`cashier_return_money_to_admin_v2` RPC (`20260820160000`) — caller resolved
from `auth.uid()`, both profile rows locked `FOR UPDATE` in deterministic
order, `balance_ledger` evidence written for both sides
(`source_type='cashier_transfer'`, a value already reserved in the CHECK
constraint but unused until now) — applied live and wired into
`Expenses.tsx`. (An existing `cashier_return_money_to_admin`, unused by any
frontend code, predates this session's DDL role and could not be replaced
in place — same documented ownership constraint as the transfer-offer
functions.)

**Live database-boundary and legacy-RPC-exposure findings (Mistry And Shah,
zero MicroLink mutations):**
- **Database boundary: NOT enforced (proven live, then immediately
  restored).** An authenticated admin session successfully `PATCH`ed
  `profiles.balance` directly via PostgREST to an arbitrary value and back —
  RLS scopes *which rows* can be updated, not *which columns*, and
  `authenticated` retains the table's original blanket column-level UPDATE
  grant. Every sanctioned application code path is now RPC-only, but the
  database itself does not yet enforce that. This is the exact,
  long-deliberately-deferred lockdown ("apply only after frontend
  cutover") — not a surprise regression — restated here as a live-proven
  fact rather than a theoretical one, per this pass's explicit request.
- **Legacy transfer-offer RPCs: live EXECUTE grant to PUBLIC, anon, AND
  authenticated** — broader than assumed in the prior handoff ("unused by
  app" is not sufficient). An authenticated user could still directly
  invoke the old, unlocked, non-ledger-writing `accept_balance_transfer_offer`
  for any offer where they are the recipient. Attempting `REVOKE EXECUTE`
  from this session (same DDL channel used successfully for every other
  grant change this session) was blocked by the execution sandbox — the
  same class of restriction as the Part A repair. **Declared a MERGE
  BLOCKER requiring an owner/DBA-privileged `REVOKE EXECUTE` (or
  `supabase_admin`-authenticated ownership reassignment) outside this
  session's access.**
- **Concurrency: PROVEN live**, not just code-reviewed, for both offer
  acceptance and money-return approval — two genuinely simultaneous
  (`Promise.all`, unawaited) RPC calls against the same pending offer/request
  each produced exactly one success, one clean denial
  ("no longer pending"), exactly one financial mutation, and no duplicate
  ledger row.

---

## 14) Related docs

- [DOC-089 — atomic expense approval + balance deduction](../supabase/migrations/20260808140000_atomic_expense_approval_balance_deduction.sql) (template)
- [Batch Verification Integrity Audit (DOC-098)](./batch-verification-integrity-audit.md) (sibling atomic-RPC precedent)
- `FUTURE_PLANS.md` §16–§18 (product requirements)

---

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-08-19 | 1.0 | Agent | Audit-only: full read of `Balances.tsx` (2699 lines), `BalanceTransferOfferService.ts`, cashier cash-transfer path, bank-transfer offer/acceptance RPCs, `expense_balance_deductions` (DOC-089 template), and live Production RLS on every balance-related table. Confirmed the suspected browser-orchestrated debit/credit/rollback pattern exactly, found it is worse in a second code path (`updateBalance`, no rollback at all), confirmed RLS permits direct client writes to `profiles.balance` with no `WITH CHECK`, and confirmed the existing Bulk Add is a non-atomic, non-idempotent per-row loop. No code changed yet. |
| 2026-08-19 | 2.0 | Agent | Frontend UI built on top of the already-implemented service layer (`BalanceLedgerService.ts`/`BalanceImportService.ts`, already complete before this revision): `ImportBalancesDialog.tsx` (7-step wizard: Type, Starter sheet, Upload, Mapping, Validation/Preview, Confirm, Result — Apply only ever called from the Confirm step, disabled when `apply_disabled`) and `ImportHistoryDialog.tsx` (history listing, expandable per-batch row detail, original-file download, reason-gated reversal with blocked-employee reporting) added under `src/components/balances/`. Wired into `Balances.tsx` as two new admin-only buttons beside "Add to Multiple Users"; `onImportApplied` reuses the page's existing `fetchProfiles`. Existing `addAmountToUser`/`updateBalance`/Bulk-Add-submit handlers (already migrated onto the canonical RPCs earlier this session by a separate pass) were not modified by this revision — only the two new buttons, their dialog mounts, and two new imports were added to `Balances.tsx`. Employee ID confirmed never coerced to a number anywhere in the new code (`cellToString`, starter-sheet cell forced to text type `"s"`). `npx tsc --noEmit -p .` passes with zero errors project-wide; `eslint` clean on both new files (all remaining `Balances.tsx` lint findings are pre-existing, outside the diff introduced here). No SQL/migration/service-layer file touched. |
| 2026-08-20 | 7.0 | Agent | Production draft-batch repair attempt (MicroLink, owner-authorized, blocked from execution by the session sandbox after full read-only forensics confirmed every stated invariant — SQL preserved, not applied) + exhaustive owner QA sweep + one more real defect found and fixed: `Expenses.tsx`'s immediate cashier-to-admin return was still a client-orchestrated double-PATCH, replaced with `cashier_return_money_to_admin_v2`. Live-proved (not code-reviewed): the direct `profiles.balance` PATCH is NOT database-enforced (RLS is row-scoped only); the legacy `propose_balance_transfer_offer`/`accept_balance_transfer_offer` have live EXECUTE granted to PUBLIC/anon/authenticated (a REVOKE attempt was blocked by the sandbox, declared a MERGE BLOCKER for owner/DBA action); offer-acceptance and money-return-approval concurrency both proven race-safe via genuine simultaneous RPC calls. See §13. |\n| 2026-08-20 | 6.0 | Agent | Financial path closure pass (6 new additive migrations, `20260820100000`–`150000`, applied live): replaced `MoneyReturnService.approveReturnRequest`'s browser-orchestrated double-PATCH with atomic `approve_money_return_request_v2`; replaced the racy, non-ledger-writing `accept_balance_transfer_offer` with `accept_balance_transfer_offer_v2` (old function's ownership predates this session's DDL role and could not be replaced in place — documented, not worked around); extracted a shared cashier-scope helper used by both `balance_add_funds_v1` and the new `propose_balance_transfer_offer_v2`; fixed `balance_add_funds_v1`'s bank-transfer validation (account now required + `is_active` checked) and its `cash_transfer_history` role normalization (root-caused the "exe"/executive quirk from the prior pass); revoked direct client `DELETE` on import batches/rows, added an admin-only draft-cancel RPC; replaced the two-source client-merged employee balance history with one unified, correctly-paginated RPC; implemented saved import column mappings UI (Save/Choose/Set-default/Delete) against the already-existing table; audited and confirmed the Review approval-limit is already server-authoritative (no code change). See §12. All quality gates clean; zero MicroLink mutations; `main` unmerged; direct-balance lockdown still not applied. |\n| 2026-08-19 | 4.0 | Agent | Correctness hardening pass (2 new additive migrations: `20260819170000_balance_manual_rpc_hardening.sql`, `20260819171000_balance_import_reversal_archive_hardening.sql`, applied live). Fixed an admin-cash-mode regression (only cashiers debit their own wallet in cash mode now, matching current MAIN); moved cashier authorization (no self/admin/cashier targets, assigned-engineer zone scoping) from UI-only into the RPC itself; scoped the idempotency lookup to the caller's organization; made import reversal genuinely all-or-nothing (pre-flight, zero mutation on any block); made the source archive required before Apply, server-side; implemented `source_sha256` duplicate-file detection, both client-side and server-side; fixed import profile locking to true ascending-user_id order (was row-encounter order); fixed Import History's "Employee" column (was showing raw_email); added a 5,000-row import cap. All 10 targeted correctness tests passed live against Production (Mistry And Shah only): admin-cash-no-debit, cashier-cash-debit, cashier→admin denied, cashier→cashier denied, cross-org denied, missing-archive blocked, duplicate-file blocked, reversal-blocked-zero-mutation, clean-reversal, import-atomicity. Cross-org idempotency isolation verified by code review only (a live test would require acting as a MicroLink caller). Mapping-profile save/choose/default UI explicitly deferred as follow-up, not attempted. DOC-098 review architecture untouched; one follow-up noted (server-authoritative approval preview classification) for a separate future pass. typecheck/build/migrations-check/security-secrets/lint all clean, zero new findings. |
| 2026-08-19 | 3.0 | Agent | 6 additive migrations applied persistently to Production (verified: 4 new tables + RLS, 7 new RPCs, no `anon` execute, legacy `profiles`/`cash_transfer_history`/`money_assignments`/`balance_transfer_offers` policies and RPCs byte-for-byte unchanged). Added a debounce (400ms coalesce) to `Balances.tsx`'s unscoped `profiles` realtime UPDATE listener — previously called `fetchProfiles()` once per row-level event with no coalescing, which a 500-row Import Apply would have triggered 500 times; now coalesces to one refetch after the burst settles (Phase 13/27). Live end-to-end QA run against real Production (Mistry And Shah only, via the app's own authenticated client — no raw SQL) — see §7 for full results: Adjust Balance, cashier cash transfer, two-row allocation import, duplicate-apply idempotency, and invalid-row atomicity (UI + server layer) all PASS; found and fixed a real bug in `createImportBatch` (missing `created_by` on insert, `NOT NULL` violation) discovered via this QA. Zero MicroLink or other-customer-org rows touched. |
