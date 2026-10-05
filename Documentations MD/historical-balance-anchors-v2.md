# Historical Balance Anchors V2

**Doc ID:** DOC-104
**Status:** in progress -- implemented on `feature/bulk-balance-import-ledger`, migrations written but **NOT applied to Production**
**Last updated:** 2026-08-26
**Owner / area:** Balances, Bulk Balance Import, `balance_ledger`, `expense_balance_deductions`

---

## 1) Summary

Corrects a wrong accounting model in the Bulk Balance Import wizard's Opening Balance mode and adds a proper hierarchical historical-balance-timeline system: **Opening Balance** and a new **Balance Update** mode are now historical **balance anchors** -- assertions about what an employee's balance was on a past date -- rather than direct overwrites of today's balance. The server reconstructs the balance immediately before each anchor's position on the timeline and applies only the *missing historical effect*, never `profiles.balance = stated_value`. Anchors are versioned (edit/replace creates a new revision, never mutates history in place), support explicit reversal, and cascade recalculation to every downstream anchor when an earlier one changes. **Allocation** mode is unchanged.

## 2) Problem / requirement

The owner reported the existing `historical_opening` import mode was wrong: it set `profiles.balance` directly to the imported amount, discarding whatever legitimate activity (expenses, transfers, allocations) had already happened since. The correct behavior: inserting a historical fact ("this employee had ₹2,000 on 1 July") must only apply the *missing* historical effect, and a later "Balance Update" (a reconciliation as of a later date) must only apply the *gap* between the reconstructed position and the stated value -- not the full stated value. Editing an earlier anchor must correctly recalculate every later anchor that depends on it.

## 3) Solution

### Accounting model
- **Opening Balance** (`anchor_kind='opening_balance'`, day_position=0/start-of-day): the historical baseline. `materialized_delta = stated_balance - reconstructed_position_before` (baseline before any anchor is 0).
- **Balance Update** (`anchor_kind='balance_update'`, day_position=2/end-of-day): a later reconciliation. Same formula, but the "position before" now includes every earlier anchor's *current* effect plus every ordinary ledger/expense-deduction delta in between.
- **Allocation**: unchanged -- `new_balance = current + amount`, a real additive transaction, never an anchor.
- `profiles.balance` is changed only by the **net change** in an anchor's own materialized delta (new minus old, old=0 the first time) -- never set to the stated value directly. Editing/reversing an anchor cascades the same net-change recalculation to every downstream active anchor, in ascending timeline order.
- Same-day ordering is deterministic: Opening=start of day, ordinary events=during the day (by their own timestamp), Balance Update=end of day; multiple same-day anchors of the same kind get a stable `sequence_number` (never UUID-order).

### Versioning
Every anchor is a **revision** row. Editing/replacing an anchor never mutates its financial fields -- it marks the old row `superseded` and inserts a new row in the same `revision_group_id` with `revision_number + 1`. Reversal marks the row `reversed` (never deleted) and writes a compensating ledger entry. All history is preserved and queryable.

### Conflict resolution (bulk import)
Validating a `historical_opening`/`balance_update` batch detects: an existing active Opening Balance for the employee, or an existing anchor on the same date. The admin resolves each conflict per-row: **Add as new update**, **Replace**, **Edit** (override values before replacing), or **Skip**. Apply is whole-batch atomic: any unresolved conflict blocks the entire Apply.

### Preview correctness guarantee
Rather than re-implementing the cascade arithmetic twice (a real risk of preview/apply silently disagreeing), the single-anchor preview RPC runs the **real** apply logic inside a sub-transaction it deliberately rolls back via a caught sentinel exception -- it is structurally guaranteed to match what a real apply would produce.

### A real bug caught by testing
While writing the exhaustive test suite for this engine (see `historicalBalanceReplay.test.ts`), the **supersede** path was found to double-count: a new revision's "old delta" baseline defaulted to 0 instead of the superseded row's already-applied effect, so replacing an anchor would *add* the new effect on top of the old one instead of *replacing* it. Fixed by seeding the new revision's `materialized_delta` from the superseded row's value before recomputing. Covered by a dedicated regression test.

## 4) Key files

```
supabase/migrations/20260824100000_historical_balance_anchors_schema.sql
supabase/migrations/20260824110000_historical_balance_anchors_engine.sql
supabase/migrations/20260824120000_balance_import_v2.sql
supabase/migrations/20260824130000_historical_balance_history_v2.sql
supabase/migrations/20260824140000_revoke_legacy_transfer_offer_rpcs.sql
src/lib/historicalBalanceReplay.ts
src/lib/__tests__/historicalBalanceReplay.test.ts
src/lib/balanceImportStarterSheet.ts (amountHeaderForMode extended to 3 modes)
src/services/BalanceLedgerService.ts (anchor types, previewHistoricalAnchor,
  applyHistoricalAnchor, reverseHistoricalAnchor, getBalanceHistoricalAnchors,
  validateImportBatchV2, applyImportBatchV2, get*HistoryV2)
src/services/BalanceImportService.ts (ImportRowDetail conflict/anchor fields)
src/components/balances/ImportBalancesDialog.tsx (3 modes, conflict UI, richer preview,
  Historical Balance availability gate)
src/pages/Balances.tsx (Bulk Add switched to V2 -- byte-identical allocation arithmetic)
supabase/migrations/20260826100000_balance_historical_v2_capabilities.sql (capability probe)
src/lib/balanceHistoricalV2Capability.ts (fail-closed capability client + hook)
src/lib/organizationFeatureKeys.ts (historical_balance_v2 flag)
src/lib/orgFeatureGates.ts (hasHistoricalBalanceV2)
scripts/verify_historical_balance_v2_rollout.sql (read-only pre-flight check)
scripts/verify_historical_balance_v2_install.sql (read-only post-install check)
scripts/check_legacy_transfer_rpc_retirement.mjs (migration 1400 readiness gate)
src/lib/__tests__/legacyTransferOfferRpcRetirement.test.ts
src/lib/__tests__/balanceHistoricalV2Capability.test.ts
src/components/balances/__tests__/ImportBalancesDialogHistoricalGate.test.tsx
```

## 5) Database / migrations

Seven new additive migrations, **NOT applied to Production** in this session. User runs SQL manually; `NOTIFY pgrst, 'reload schema'` is included at the end of each.

> **DO NOT apply these in filename/timestamp order, and DO NOT use a generic
> "apply all pending migrations" command for this release.** The filenames
> sort as `...100000` / `...110000` / `...120000` / `...130000` /
> **`...140000`** / `...26100000` / `...26110000` -- i.e. the revoke
> migration (`20260824140000_revoke_legacy_transfer_offer_rpcs.sql`) sorts
> BEFORE both the capability probe (`20260826100000_...`) and the atomic
> import-reversal engine (`20260826110000_...`), even though it must be
> applied LAST, and only after a separate frontend deployment in between. A
> tool that blindly applies "everything pending, in order" would revoke the
> legacy transfer RPCs before the capability probe or the reversal engine
> even exist, and before any V2 frontend has been deployed to depend on
> them. See `scripts/historicalBalanceV2Phase1Migrations.mjs` for the
> explicit, generic-apply-proof Phase 1 file list, and §11/§12 below for the
> full phased rollout this is part of.

The correct DEPLOYMENT order (not filename order):

**Phase 1 -- apply together, all five pre-existing + the new reversal engine + capability probe:**
1. `20260824100000_historical_balance_anchors_schema.sql` -- `balance_historical_anchors` table; widens `balance_ledger`'s `entry_type`/`source_type` CHECK constraints; widens `balance_import_batches.mode` and `balance_import_rows.validation_status`; adds conflict/resolution/anchor columns to `balance_import_rows`.
2. `20260824110000_historical_balance_anchors_engine.sql` -- the replay engine (`_balance_historical_position_before_v1`, `_balance_materialize_anchor_v1`, `_balance_cascade_downstream_anchors_v1`) and public RPCs (`balance_preview_historical_anchor_v1`, `balance_apply_historical_anchor_v1`, `balance_reverse_historical_anchor_v1`, `get_balance_historical_anchors_v1`).
3. `20260824120000_balance_import_v2.sql` -- `balance_validate_import_v2`, `balance_apply_import_v2`.
4. `20260824130000_historical_balance_history_v2.sql` -- `get_my_unified_balance_history_v2`, `get_org_balance_ledger_v2` (anchor-aware history reads).
5. `20260826110000_balance_reverse_import_v2.sql` -- **new (2026-08-26)**, `balance_reverse_import_v2`: mode-aware, all-or-nothing import reversal. Allocation delegates to the existing `balance_reverse_import_v1` engine unchanged; historical_opening/balance_update reverse each row's anchor through `balance_reverse_historical_anchor_v1` (never duplicated arithmetic), blocking the whole batch if any anchor was later edited/replaced or already reversed. See §13.
6. `20260826100000_balance_historical_v2_capabilities.sql` -- `balance_historical_v2_capabilities_v1()`, a DOC-080-pattern read-only capability probe (`{contract, version, ready, functions}`) the frontend uses to fail closed when this environment doesn't have 1-5 installed yet (now also checks `balance_reverse_import_v2`). See §8.

**-- FRONTEND V2 CUTOVER HAPPENS HERE, then a compatibility window, THEN --**

**Phase 2 -- apply alone, only after every §11 precondition is independently confirmed:**
7. `20260824140000_revoke_legacy_transfer_offer_rpcs.sql` -- **security hardening**, revokes `anon`/`authenticated` EXECUTE on the legacy (pre-v2) `propose_balance_transfer_offer`/`accept_balance_transfer_offer`, confirmed unledgered and confirmed unused by any current frontend code. **This file's filename timestamp is deliberately misleading about its deployment position -- gated behind additional preconditions, see §11.**

All have matching rollback files in `supabase/rollbacks/`. `20260819163000_balance_import_apply_rpc.sql`/`20260819174000_balance_import_apply_hardening_v2.sql` (v1 apply/validate) are **untouched** and remain live for backward compatibility.

### 5a) Two real defects found and fixed during a release-prep static review (2026-08-26)

A fresh, skeptical static review of migrations 1-4 (still unapplied anywhere -- this session's own SQL was never executed against a database) found and fixed, in place, before any environment could have run the buggy versions:

1. **`20260824100000_historical_balance_anchors_schema.sql` -- `balance_ledger_source_type_check` regression.** This file `DROP CONSTRAINT`s and re-`ADD`s `balance_ledger_source_type_check` as what its own comment calls "a superset of values" of the original 20260819160000 list. It was not: an earlier migration on this same branch, `20260820130000_money_return_approve_v2.sql`, had already widened this exact constraint to add `'money_return'` (used by the live `approve_money_return_request_v2` RPC). The new list in 20260824100000 omitted it. Applied in order, this would have silently un-widened the constraint -- either failing the migration itself outright (if any `money_return` row already existed) or succeeding silently and then breaking the very next `approve_money_return_request_v2` call with a raw CHECK-violation error. Fixed by adding `'money_return'` back to both the migration's new list and its rollback's restore-list (which had the identical omission, and was also corrected to restore to the *20260820130000* state, not the older pre-money-return state).
2. **`20260824120000_balance_import_v2.sql` -- unvalidated resolution action.** `balance_apply_import_v2`'s per-row dispatch was `IF v_action IN ('replace','edit') THEN ...supersede... ELSE ...create...`, with no check that `v_action` (taken directly from caller-supplied JSONB) is actually one of the five values `balance_import_rows.resolution_action`'s own CHECK constraint allows. An unrecognized/misspelled action string would fall into the `ELSE` branch and be treated as `'create'`. Because the row's own `resolution_action` column is later set to that same value, an invalid string would actually surface as a late, confusing `balance_import_rows_resolution_action_check` violation *after* the anchor mutation had already run inside the same function call -- Postgres function-level atomicity would still roll the whole thing back, so this was a fail-safe-but-confusing bug, not a data-corruption one. Fixed with an explicit `RAISE EXCEPTION` guard immediately after the skip-check in both loops of the function, before any mutation or identity-lock work runs.

Also added (not a defect, a review-flagged low-priority improvement): `balance_historical_anchors_sequence_lookup_idx` -- `_balance_next_anchor_sequence_v1`'s `(organization_id, user_id, effective_date, anchor_kind)` lookup has no `status` filter, so it couldn't use the existing partial `..._timeline_idx` (`WHERE status='active'`). Low urgency at expected per-employee anchor volumes, but free to add while the migration is still unapplied.

## 6) Test plan

- [x] `src/lib/__tests__/historicalBalanceReplay.test.ts` -- 12 tests: the owner's required example (-₹1,000 + ₹2,000 opening → ₹1,000), the hierarchical Balance Update example, the hard-gate earlier-edit-cascades-downstream test, the reversal test, same-day ordering, genesis baseline, allocation regression, rounding, and the supersede double-count regression.
- [x] `src/lib/__tests__/balanceImportStarterSheet.test.ts` -- extended with a `balance_update` canonical-header case.
- [ ] Server SQL/RPC contract: **written but not executed against any database in this session** (no local Docker/Supabase stack available -- confirmed no `docker`, `supabase` CLI present but cannot start without Docker; no VPN/Production access, per this task's explicit constraint). Recommend applying to a disposable branch/backup and running `scripts/verify_historical_balance_v2_rollout.sql` before, and `scripts/verify_historical_balance_v2_install.sql` after, applying migrations 1-5.
- [ ] Live browser QA of the conflict-resolution UI, edit/replace/reverse flows: not performed (no running preview environment in this session).
- [x] `src/lib/__tests__/legacyTransferOfferRpcRetirement.test.ts` -- 5 tests: zero bare-name references, `_v2` cutover confirmed actually happened (not just "absent"), matcher self-check against its own v1-is-a-prefix-of-v2 edge case.
- [x] `src/lib/__tests__/balanceHistoricalV2Capability.test.ts` -- 8 tests: ready=true when all present, fails closed on RPC error/network throw/contract mismatch/server-reported false, probes the RPC exactly once across concurrent+repeated calls (no request storm), never calls any RPC besides the capability probe itself (no mutation fallback).
- [x] `src/components/balances/__tests__/ImportBalancesDialogHistoricalGate.test.tsx` -- 4 tests: flag OFF hides all 3 historical affordances with no banner; flag ON + backend missing hides them WITH the banner (including while the check is still loading, never optimistic); flag ON + backend ready offers everything.

## 7) Related docs / verification queries for the reviewer

- [balance-system-and-import-audit.md](./balance-system-and-import-audit.md) (DOC-103) -- the original balance/import architecture this extends.
- Recommended pre-Production verification (read-only until the owner authorizes apply):
  ```sql
  -- After applying to a disposable branch: reproduce the required example.
  select public.balance_apply_historical_anchor_v1(
    '<org>', '<user with balance -1000>', 'opening_balance', '2026-07-01', 2000, 'create'
  );
  -- Expect profiles.balance to become 1000, not 2000.
  ```

## 8) Feature flags & backend capability gate (2026-08-26)

**Core rule: feature flags control UI availability, never accounting version.** There is no "flag OFF -> v1 RPC, flag ON -> v2 RPC" switch anywhere in this system, and there must never be one -- a flag is not allowed to bring a legacy financial RPC back into reachability.

Two independent, ANDed conditions gate Opening Balance / Balance Update / Tally import / anchor edit-replace-reverse in the import wizard:

1. **`historical_balance_v2`** -- a new per-organization flag (`organization_features.feature_key`, see `src/lib/organizationFeatureKeys.ts`), master-admin toggled, default OFF. Purely a UI-availability switch.
2. **`balance_historical_v2_capabilities_v1()`** -- the DOC-080-pattern backend capability probe (migration 6, §5). Reports `ready=true` only when every one of the 8 V2 RPCs this feature depends on (`balance_validate_import_v2`, `balance_apply_import_v2`, `balance_preview_historical_anchor_v1`, `balance_apply_historical_anchor_v1`, `balance_reverse_historical_anchor_v1`, `get_balance_historical_anchors_v1`, `get_my_unified_balance_history_v2`, `get_org_balance_ledger_v2`) is actually installed. `src/lib/balanceHistoricalV2Capability.ts` calls it, fails closed to `ready=false` on ANY error (RPC missing/PGRST202, network failure, contract mismatch), and caches the result at module scope for the tab's lifetime (this is a schema-wide fact, not a per-request one -- re-probing on every render would be exactly the kind of request storm this idiom exists to prevent).

`historicalAvailable = historicalFlagOn && capability.ready`. `ImportBalancesDialog.tsx`'s Step 1 renders Opening Balance / Balance Update / the Tally file-source choice **only** when `historicalAvailable` is true; otherwise only Allocation is offered. If the flag is ON but the capability check confirms the backend is missing, an inline banner explains why ("Historical balance import ... requires the latest PesoWise backend update.") instead of a raw 404. **There is no v1 fallback for any of these modes** -- unavailable means hidden/blocked, never "silently use the old RPC."

This is the same idiom already used for Review Queue V2 (`debug_review_queue_capabilities_v1`) and Manager Override (`review_manager_override_capabilities_v1`) -- see those for precedent if this needs to be extended further.

**Transfer Offers already followed this pattern before this pass**: the existing `transfer_recipient_acceptance` organization flag gates the Transfer Offers page/dashboard widget/prompt gate; no separate backend-capability probe exists for it because `propose_balance_transfer_offer_v2`/`accept_balance_transfer_offer_v2` have been live in `BalanceTransferOfferService.ts` unconditionally since DOC-103 rev 6.0 (2026-08-20) -- there is no environment where the flag can be ON without the v2 RPCs existing, since they shipped together in an already-applied migration. No change was needed there.

## 9) Financial RPC matrix

| Action | RPC called | Notes |
|---|---|---|
| Transfer Propose | `propose_balance_transfer_offer_v2` | Exclusively. Zero runtime callers of the bare `propose_balance_transfer_offer` anywhere in `src/` (verified by exact quoted-string scan, not substring match -- see §11). |
| Transfer Accept | `accept_balance_transfer_offer_v2` | Exclusively, same verification. |
| Transfer Reject | `reject_balance_transfer_offer` (no `_v2`) | Audited: only `UPDATE balance_transfer_offers SET status='rejected', ...` on a row still `status='pending'`. Never touches `profiles.balance`, `balance_ledger`, or any other financial table. **Correctly has no `_v2` variant** -- it's a state transition, not a money movement, so it needs none. |
| Transfer Cancel | `cancel_balance_transfer_offer` (no `_v2`) | Same audit result as Reject -- pending-only state transition, no financial mutation. No `_v2` variant needed. |
| Opening Balance | `balance_apply_import_v2` / `balance_apply_historical_anchor_v1` only | Gated on `historicalAvailable` (§8). No v1 fallback under any condition. |
| Balance Update | `balance_apply_import_v2` / `balance_apply_historical_anchor_v1` only | Same as above. |
| Allocation | `balance_apply_import_v2` (always, when reachable at all) | See §10 for why no v1 compatibility fallback was implemented for this mode either, despite being technically permitted. |

## 10) Allocation V1 compatibility -- decision: no fallback implemented

The release-prep brief for this pass explicitly *permitted* (did not require) a temporary Allocation-only fallback to the v1 import RPC (`balance_apply_import_v1`) when the v2 backend capability is missing, conditioned on v1 Allocation's ledger/audit guarantees being proven equivalent and "tests prov[ing] this explicitly."

**Investigated:** `balance_apply_import_v1`'s latest definition (`20260819174000_balance_import_apply_hardening_v2.sql`) does write `balance_ledger` evidence for the `allocation` mode (`entry_type` tagged `'allocation'`), so it is not obviously deficient the way the legacy transfer-offer v1 RPCs were (those wrote zero ledger evidence, which is why they're being revoked in §5/migration 6).

**Decision: do not implement the fallback in this pass.** Building an actual runtime branch that calls a different RPC when a capability check fails, and shipping it having never executed against any real database (no local Postgres/Supabase was available this session -- see §6 test plan), is itself exactly the kind of unproven financial code path this whole release-prep pass exists to eliminate. Allocation therefore fails closed identically to Opening Balance/Balance Update when `historicalAvailable` is false -- in practice this is moot today anyway, since `historicalAvailable` gates only the mode *selector*, and Allocation is offered independently of that gate (§8); Allocation was never blocked by the historical capability check to begin with, because it doesn't depend on any of the 8 v2-only RPCs the probe checks. The permitted-but-not-required fallback is deferred to a future pass where a disposable database is available to prove it end-to-end per the brief's own "tests prove this explicitly" condition.

## 11) Migration 1400 release gate & rollback design

`20260824140000_revoke_legacy_transfer_offer_rpcs.sql` remains in the repository (not deleted) but must **not** be applied until every one of the following is independently confirmed on the *target* environment, not just this branch's source:

1. Production frontend has deployed the V2 transfer-offer service code (`BalanceTransferOfferService.ts` calling `_v2` exclusively).
2. The feature-flag ON path has been tested against V2 in that environment.
3. The feature-flag OFF path has been tested (Transfer Offers hidden, no propose/accept RPC reachable).
4. No runtime application code contains a bare (non-`_v2`) call to `propose_balance_transfer_offer`/`accept_balance_transfer_offer`. Automated, not manual: run `node scripts/check_legacy_transfer_rpc_retirement.mjs` (exit 0 + `READY_TO_REVOKE=true`) or the equivalent vitest guard `src/lib/__tests__/legacyTransferOfferRpcRetirement.test.ts`. As of this pass: **0 bare-name references, 2 `_v2` call sites confirmed** (`BalanceTransferOfferService.ts:63,91`) -- both scripts report `READY_TO_REVOKE=true` against this branch's own source, but that only proves the *branch*, not whatever is actually *deployed*; re-run against the deployed bundle/build output before trusting it for a live cutover.
5. Built Production assets have been searched for the bare V1 RPC strings (not just source -- a stale cached bundle or an old mobile client build could still reference them).
6. No supported rollback frontend version still depends on V1.
7. V2 ledger evidence is confirmed present for transfers made since the V2 cutover.

**Rollback window design:** frontend V2 cutover and the migration-1400 revoke are deliberately **not coupled into one irreversible moment**. Recommended sequence: deploy V2 frontend -> QA -> a short compatibility window where V1 still exists but is unused -> only then apply 1400. Before 1400 is applied, rolling the frontend back to a pre-V2 build is always safe (V1 still exists and is still granted). **After** 1400 is applied, any rollback frontend must itself speak V2 -- a pre-cutover build rolled back after 1400 would get `permission denied` on the now-revoked V1 RPCs.

**Decision: 1400 stays in `supabase/migrations/` where it is -- not relocated out of the automatic migration stream.** Its filename timestamp sorts before the capability probe's, which is a genuine, confirmed hazard for any tool that applies migrations in filename order (see §5's warning and `scripts/historicalBalanceV2Phase1Migrations.mjs`'s own header comment). Relocating it (e.g. to a non-`migrations/` holding area, re-timestamped only at final cutover) was considered, since every record in this repository's own audit trail says it has never been applied to any environment. But "never applied according to this repo's tracked history" is not the same as "conclusively proven unapplied everywhere" -- this session has no VPN/Production access to independently verify that against the actual target environment, and moving a migration file is itself a structural change with its own risk (breaking `npm run migrations:check`'s assumptions, confusing a future rollback script, changing what "pending" means for anyone else's tooling) for a benefit that the explicit Phase 1 manifest + this warning already deliver more safely. The conservative choice -- leave the file exactly where it is, make Phase 1 an explicit, tested, non-ambiguous list, and state loudly not to use a generic apply-all -- was made instead. **Do not use a generic "apply all pending migrations" command for this release; use `scripts/historicalBalanceV2Phase1Migrations.mjs`'s list for Phase 1, and apply 1400 alone, manually, only after every precondition above is confirmed.**

## 12) Release phases

- **Phase A -- repo (this pass):** V2 frontend code, `historical_balance_v2` feature flag + capability gate, release-safety tests, zero runtime V1 transfer-offer callers confirmed. Migrations 1-4 statically reviewed, two real defects found and fixed, still unapplied anywhere.
- **Phase B -- DB compatibility:** apply migrations 1-4 (and 5, the capability probe) to Production. Do **not** apply 6 (1400) yet. Old `main` frontend continues to work unmodified throughout (v1 import/history/transfer RPCs are all still present and granted).
- **Phase C -- frontend:** deploy this branch's frontend. Test flag OFF (silent, unchanged behavior) and flag ON with the backend now present (full Historical Balance feature set) in the deployed environment.
- **Phase D -- retire legacy:** re-run the migration-1400 readiness scan against what's actually deployed (§11, item 4-5). Apply migration 6 (1400) only once every precondition holds.
- **Phase E:** full financial smoke test (transfer propose/accept/reject/cancel, opening balance, balance update, allocation, Tally import) against the live environment.

---

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-08-24 | 1.0 | Claude Sonnet 5 | Initial implementation: schema, replay engine, import V2, history V2, legacy-RPC hardening migration (all unapplied), frontend wizard rewrite, 33 new/updated focused tests. Found and fixed a real supersede double-counting bug via the test suite before any SQL touched a database.
| 2026-08-26 | 2.0 | Claude Sonnet 5 | Release-prep pass (repo-only, no VPN/Production access): new `historical_balance_v2` feature flag + DOC-080-pattern backend capability probe (migration 6, `balance_historical_v2_capabilities_v1`) gate Opening Balance/Balance Update/Tally import in `ImportBalancesDialog.tsx`, fail-closed, zero v1 fallback (§8). Financial RPC matrix audited: Transfer Propose/Accept confirmed V2-exclusive with zero runtime bare-name callers (new release-safety test + standalone script, §9/§11); Reject/Cancel confirmed non-financial (pending-only state transitions) and correctly left without `_v2` variants. Allocation V1 compatibility fallback deliberately NOT implemented -- documented decision, §10. Two real defects found via a fresh static review of migrations 1-4 (never applied anywhere) and fixed in place: `balance_ledger_source_type_check` was regressing an already-applied constraint widening (dropped `'money_return'`), and `balance_apply_import_v2` silently defaulted an unrecognized resolution action to `'create'` instead of raising -- see §5a. Migration 1400 release gate and rollback-window design documented (§11); two new read-only SQL verification scripts added (pre-flight + post-install, §5/§25). 17 new tests across 3 files. Cherry-picked the independent Form Template pending-option-save fix (`675d673`) onto this branch, unrelated to financial semantics. Branch backed up to `backup/bulk-balance-import-ledger-pre-release-prep-20260826` before this pass. Still `feature/bulk-balance-import-ledger` only, not merged, no migration applied to Production; no local Postgres/Supabase available this session (no Docker) so the SQL itself remains statically-reviewed-only.
| 2026-08-26 | 3.0 | Claude Sonnet 5 | Visibility + reversal pass, prompted by the owner reporting Tally import was not visible in the Vercel Preview. Root cause: `historicalAvailable = historicalFlagOn && historicalCapability.ready` was a single boolean gating both UI visibility and mutation eligibility, so the entire File Source selector (Tally included) and the Opening Balance/Balance Update radios disappeared whenever the backend migrations weren't installed yet or the flag was off. Split into `historicalFlagOn` / `historicalBackendReady` / `historicalMutationReady`; visibility is now unconditional and mutation-readiness is checked at exactly one choke point (`stageAndValidate`) immediately before any database-writing RPC, with a "Preview only" banner explaining why Continue is disabled. Added `initialSource` prop to `ImportBalancesDialog` and a direct "Import from Tally" button on `Balances.tsx`. New migration `20260826110000_balance_reverse_import_v2.sql`: mode-aware, all-or-nothing atomic import reversal -- Allocation delegates unchanged to `balance_reverse_import_v1`; historical_opening/balance_update reverse each row's anchor through `balance_reverse_historical_anchor_v1` (arithmetic never duplicated), guarded by a zero-mutation pre-flight that blocks the WHOLE batch if any anchor was later manually superseded or already reversed. Fixed a real mode-mislabeling bug in `ImportHistoryDialog.tsx` (`balance_update`/unrecognized modes were shown as "Allocation"). Phase 1 migration manifest grew from 5 to 6 files (reversal engine inserted before the capability probe -- see §5). Re-verified the owner's real Tally file against the fully-hardened parser with identical results, confirming no regression. A real-employee-data security finding in a sibling test file (`tallyBalanceImport.test.ts`) was found, disclosed to the owner, and remediated (working tree fixed; with explicit owner authorization, the two exposed commits were rewritten via a branch-scoped `git filter-branch` and force-pushed) -- see `Documentations MD/index.md`'s revision log for full detail; not otherwise related to this doc's accounting model.
