# Historical Balance Anchors V2

**Doc ID:** DOC-112
**Status:** in progress -- implemented on `feature/bulk-balance-import-ledger`, migrations written but **NOT applied to Production**
**Last updated:** 2026-08-24
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
supabase/migrations/20260824100500_historical_balance_anchors_schema.sql
supabase/migrations/20260824110000_historical_balance_anchors_engine.sql
supabase/migrations/20260824120000_balance_import_v2.sql
supabase/migrations/20260824130000_historical_balance_history_v2.sql
supabase/migrations/20260824140500_revoke_legacy_transfer_offer_rpcs.sql
src/lib/historicalBalanceReplay.ts
src/lib/__tests__/historicalBalanceReplay.test.ts
src/lib/balanceImportStarterSheet.ts (amountHeaderForMode extended to 3 modes)
src/services/BalanceLedgerService.ts (anchor types, previewHistoricalAnchor,
  applyHistoricalAnchor, reverseHistoricalAnchor, getBalanceHistoricalAnchors,
  validateImportBatchV2, applyImportBatchV2, get*HistoryV2)
src/services/BalanceImportService.ts (ImportRowDetail conflict/anchor fields)
src/components/balances/ImportBalancesDialog.tsx (3 modes, conflict UI, richer preview)
src/pages/Balances.tsx (Bulk Add switched to V2 -- byte-identical allocation arithmetic)
```

## 5) Database / migrations

Five new additive migrations, **NOT applied to Production** in this session. User runs SQL manually; `NOTIFY pgrst, 'reload schema'` is included at the end of each. Apply in filename order (each depends on the previous):

1. `20260824100500_historical_balance_anchors_schema.sql` -- `balance_historical_anchors` table; widens `balance_ledger`'s `entry_type`/`source_type` CHECK constraints; widens `balance_import_batches.mode` and `balance_import_rows.validation_status`; adds conflict/resolution/anchor columns to `balance_import_rows`.
2. `20260824110000_historical_balance_anchors_engine.sql` -- the replay engine (`_balance_historical_position_before_v1`, `_balance_materialize_anchor_v1`, `_balance_cascade_downstream_anchors_v1`) and public RPCs (`balance_preview_historical_anchor_v1`, `balance_apply_historical_anchor_v1`, `balance_reverse_historical_anchor_v1`, `get_balance_historical_anchors_v1`).
3. `20260824120000_balance_import_v2.sql` -- `balance_validate_import_v2`, `balance_apply_import_v2`.
4. `20260824130000_historical_balance_history_v2.sql` -- `get_my_unified_balance_history_v2`, `get_org_balance_ledger_v2` (anchor-aware history reads).
5. `20260824140500_revoke_legacy_transfer_offer_rpcs.sql` -- **security hardening**, revokes `anon`/`authenticated` EXECUTE on the legacy (pre-v2) `propose_balance_transfer_offer`/`accept_balance_transfer_offer`, confirmed unledgered and confirmed unused by any current frontend code.

All have matching rollback files in `supabase/rollbacks/`. `20260819163000_balance_import_apply_rpc.sql`/`20260819174000_balance_import_apply_hardening_v2.sql` (v1 apply/validate) are **untouched** and remain live for backward compatibility.

## 6) Test plan

- [x] `src/lib/__tests__/historicalBalanceReplay.test.ts` -- 12 tests: the owner's required example (-₹1,000 + ₹2,000 opening → ₹1,000), the hierarchical Balance Update example, the hard-gate earlier-edit-cascades-downstream test, the reversal test, same-day ordering, genesis baseline, allocation regression, rounding, and the supersede double-count regression.
- [x] `src/lib/__tests__/balanceImportStarterSheet.test.ts` -- extended with a `balance_update` canonical-header case.
- [ ] Server SQL/RPC contract: **written but not executed against any database in this session** (no sandboxed Postgres available; read-only Production access only, per this task's explicit constraint). Recommend applying to a disposable branch/backup and running the SQL verification queries in section 7 below before Production.
- [ ] Live browser QA of the conflict-resolution UI, edit/replace/reverse flows: not performed (no running preview environment in this session).

## 7) Related docs / verification queries for the reviewer

- [balance-system-and-import-audit.md](./balance-system-and-import-audit.md) (DOC-111) -- the original balance/import architecture this extends.
- Recommended pre-Production verification (read-only until the owner authorizes apply):
  ```sql
  -- After applying to a disposable branch: reproduce the required example.
  select public.balance_apply_historical_anchor_v1(
    '<org>', '<user with balance -1000>', 'opening_balance', '2026-07-01', 2000, 'create'
  );
  -- Expect profiles.balance to become 1000, not 2000.
  ```

---

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-08-24 | 1.0 | Claude Sonnet 5 | Initial implementation: schema, replay engine, import V2, history V2, legacy-RPC hardening migration (all unapplied), frontend wizard rewrite, 33 new/updated focused tests. Found and fixed a real supersede double-counting bug via the test suite before any SQL touched a database.
| 2026-08-26 | 1.1 | Claude Opus 5 | Imported into the `peso-bckup` repository from `Mithil1105/peso-patidar` branch `feature/bulk-balance-import-ledger`. Renumbered DOC-104 → DOC-112 (DOC-104 was already allocated here to server-side report generation). Both of this layer's migrations were renamed to clear version-prefix collisions with this repository's own admin-submit migrations: `20260824100000` → `20260824100500` and `20260824140000` → `20260824140500`; all references in §4/§5 updated. `20260824140500_revoke_legacy_transfer_offer_rpcs.sql` gained an import note recording that it must be applied **last, after the frontend deploy** — its "no frontend calls the bare names" safety argument holds for the new bundle but not for the one currently serving peso-backup.vercel.app, which does call them. Section 6's two unchecked boxes still stand: this engine's SQL has still never been executed against a database and still has no live browser QA. |
