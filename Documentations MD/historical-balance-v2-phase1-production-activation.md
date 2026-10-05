# Historical Balance Anchors V2 — Phase 1 Production Activation

**Doc ID:** DOC-112
**Status:** deployed
**Last updated:** 2026-08-29
**Owner / area:** Balances, Supabase (Production, `evo3o0fdjaroxq7uohrm21cp`)

---

## 1) Summary

Found via live frontend QA: the Tally Group Summary import (and Opening
Balance / Balance Update generally) showed "Preview only — the Historical
Balance backend has not been installed yet" for the `Mistry And Shah`
organization. This was the capability probe (`balance_historical_v2_capabilities_v1`,
designed and shipped in an earlier pass — see
[historical-balance-anchors-v2.md](./historical-balance-anchors-v2.md))
correctly reporting a real, partial/drifted backend state, not a bug.
Applied the already-authored, already-reviewed **Phase 1** migration set
(exactly per `scripts/historicalBalanceV2Phase1Migrations.mjs`'s manifest)
to Production, and enabled the `historical_balance_v2` organization feature
flag for `Mistry And Shah` (it had no row at all, which defaults to
disabled). **Phase 2** (`20260824140000_revoke_legacy_transfer_offer_rpcs.sql`)
was explicitly NOT applied — its own preconditions (V2 frontend cutover,
zero runtime bare-name callers against the *deployed* build, a compatibility
window) were never independently re-verified against the current deployed
environment this session, and applying it was never part of this task.

---

## 2) Problem / requirement

The org owner needed Tally Group Summary import (and the underlying
Historical Balance Anchors V2 ledger it depends on) to actually work in
Production, not just preview/parse a file.

---

## 3) What was found (audit, before touching anything)

- `balance_historical_anchors` (0 rows), `balance_import_batches` (17 rows),
  `balance_import_rows`, `balance_import_mapping_profiles` already existed
  live — a **partial** prior application, not a clean unapplied state.
- Of the 9 functions `balance_historical_v2_capabilities_v1` checks, 3 were
  missing: `balance_validate_import_v2`, `get_my_unified_balance_history_v2`,
  `get_org_balance_ledger_v2` — explaining exactly why the probe reported
  `ready: false`.
- The 17 existing `balance_import_batches` rows broke down as: 3 `applied`
  + 1 `reversed`, both `mode='allocation'` — the **pre-existing, unrelated,
  already-safely-used** bulk allocation import feature (untouched by this
  work). The remaining 3 `historical_opening` rows were all still `draft`
  (never validated, never applied) — completely inert, zero balance impact,
  simply stuck because Validate/Apply were blocked by the incomplete
  backend.
- All 6 Phase 1 migration files were re-read and confirmed to contain
  **zero destructive statements** (no `DROP TABLE`/`DROP COLUMN`,
  no `TRUNCATE`, no `DELETE FROM`) — every DDL statement is
  `CREATE TABLE IF NOT EXISTS` or `CREATE OR REPLACE FUNCTION`, safe to
  apply regardless of the partial prior state.
- `historical-balance-anchors-v2.md`'s own §11/§12 were re-read: this
  work matches exactly "Phase B — DB compatibility: apply migrations 1-4
  (and 5, the capability probe) to Production. Do not apply 6 (1400) yet."

---

## 4) What was applied

Fresh checkpoint backup taken first:
`20260829T120615Z-pre-historical-balance-v2-phase1` (checksum verified,
`pg_restore -l` confirmed 112 table-data entries).

The 6 Phase 1 files, applied individually and sequentially (each has its
own `BEGIN`/`COMMIT`, so combining them into one outer transaction would
have been misleading, not more atomic) in the manifest's exact order:

1. `20260824100000_historical_balance_anchors_schema.sql`
2. `20260824110000_historical_balance_anchors_engine.sql`
3. `20260824120000_balance_import_v2.sql`
4. `20260824130000_historical_balance_history_v2.sql`
5. `20260826110000_balance_reverse_import_v2.sql`
6. `20260826100000_balance_historical_v2_capabilities.sql`

All 6 applied cleanly — only harmless `NOTICE: column "..." already exists,
skipping` messages, zero errors, consistent with the confirmed-idempotent,
confirmed-partial prior state.

**`20260824140000_revoke_legacy_transfer_offer_rpcs.sql` was NOT applied** —
correctly excluded per the manifest, remains a Phase 2 action gated behind
its own separate preconditions.

`organization_features` (pre-existing, generic per-org flag table used by
many features): inserted `('e0e9c7a9-555f-448a-8ba2-10fae8e0bf64', 'historical_balance_v2', true)`
for `Mistry And Shah` — it had no row at all (defaults to disabled per
`isOrganizationFeatureActive`'s `if (!ctx.featureFlags[key]) return false`).

PostgREST schema cache reloaded (`NOTIFY pgrst, 'reload schema'`).

---

## 5) Verification

- `SELECT balance_historical_v2_capabilities_v1();` → `{"ready": true, ...}`,
  all 9 checked functions present.
- Grants confirmed on all 10 relevant functions: `anon = false`,
  `authenticated = true` (matching this codebase's established pattern —
  internal `auth.uid()`/role checks inside each `SECURITY DEFINER`
  function, not blanket access).
- Spot-checked `balance_apply_import_v2`'s body: reads `auth.uid()` and a
  caller-role variable before proceeding, matching the established
  authorization pattern used throughout this codebase.
- Container health confirmed (13/13 healthy) after apply.
- No financial data was created, modified, or applied by this activation
  itself — the 6 files are schema/function definitions only. The 3
  previously-stuck `draft` `historical_opening` batches remain exactly as
  they were; an admin must still explicitly Validate and Apply them through
  the UI for anything to actually change a balance.

---

## 6) What was explicitly NOT done

- Phase 2 (`20260824140000`, the legacy transfer-offer RPC revoke) — not
  applied, not evaluated for readiness this session.
- No `balance_import_batches` row was validated, applied, or reversed.
- No employee balance was created, changed, or mutated.
- No other organization's `historical_balance_v2` flag was touched.

---

## 7) Related docs

- [historical-balance-anchors-v2.md](./historical-balance-anchors-v2.md) — full original design, Phase 1/2 manifest rationale, §11 Phase 2 preconditions.
- [tally-group-summary-balance-import.md](./tally-group-summary-balance-import.md) — the Tally parser/wizard this backend unblocks.

---

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-08-29 | 1.0 | Claude Code | Initial doc: audited a partial/drifted Historical Balance V2 backend state found via live frontend QA, applied the already-authored Phase 1 migration set (6 files, zero destructive statements, fresh backup taken first), and enabled the org feature flag for Mistry And Shah. Phase 2 explicitly not touched. |
