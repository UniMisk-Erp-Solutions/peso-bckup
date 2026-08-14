# DOC-079 — Review Expenses V2 Architecture

**Last updated:** 2026-08-01
**Status:** in progress — **SQL contracts + client data layer implemented; flag default OFF. Not applied, not deployed.**
**Branch:** `rewrite/review-expenses-v2` (from `origin/main` @ `2f23854`)
**SQL executed:** **No.** **Production deployed:** **No.**

> **ID note:** this branch's index says `Next ID: DOC-075`, but DOC-075…078 are already
> allocated on `fix/tenant-pwa-auth-origin` and `fix/receipt-recovery-and-deletion-safety`,
> which are not yet merged. DOC-079 is used here to avoid a collision when those merge.

---

## 1. Why V1 became unstable

The current pipeline accumulated eleven overlapping mechanisms — canonical keyset
pagination, legacy offset pagination, missing-RPC detection, session capability caching,
Load All, localStorage caches, and four separate client-side enrichment passes. The
failure modes are structural, not incidental:

| Symptom | Structural cause |
|---------|------------------|
| 1,000-row truncation | PostgREST row cap on set-returning RPCs |
| ~1,512 rows instead of ~6,088 | Load All terminating on a capped page |
| Blank loading states | enrichment gating the first render |
| 57014 statement timeouts | `expense_form_field_values` scanned for the whole result set |
| Request storms | per-row/per-chunk enrichment fan-out |
| Stale caches claiming completion | localStorage `allLoaded` written before completion |
| Failures when migrations absent | silent V1 fallbacks masking a missing RPC |

The root cause common to all of them: **the client is responsible for assembling the
result set.** V2 moves that responsibility into one versioned SQL contract.

---

## 2. Target architecture

Four separated concerns:

| Concern | Contract | Cardinality |
|---------|----------|-------------|
| **A. List** | `get_review_queue_page_v2` → `jsonb` | 1 RPC per page |
| **B. Detail** | `get_review_expense_detail_v2` → `jsonb` | 1 RPC per opened row |
| **C. Actions** | existing verify/approve/reject/correct/batch mutations | unchanged |
| **D. Filter metadata** | `get_review_filter_options_v2` → `jsonb` | 1 RPC, React Query cached |

Returning a single `jsonb` document (not a row set) is deliberate: it sidesteps the
PostgREST 1,000-row cap entirely and gives one stable versioned response envelope.

**Page-first, enrich-second.** CTE order is `visible_filtered → page_ids → page_rows →
enriched_page`. Only `page_rows` (≤100 ids) may join profiles, balances, custom fields or
audit flags. Nothing expensive touches the full ~6,088-row set.

Capability gate: `review_queue_api_version()` returns `2`; the client refuses to run V2
against an un-migrated database rather than silently falling back to V1.

---

## 3. Audit — verified against the real schema

Columns below come from `src/integrations/supabase/types.ts` (generated) and the migration
history. The live database could not be queried (SSH timed out), so the SQL was written to
depend only on columns confirmed in the migration history — and specifically **never** on
`audit_logs.organization_id`, the one contradictory column.

### `expenses` (19 columns)
`admin_comment, approval_tier, assigned_engineer_id, assigned_reviewer_id, batch_id,
created_at, destination, id, organization_id, purpose, status, title, total_amount,
transaction_number, trip_end, trip_start, updated_at, user_id, category`

### `profiles` (16)
`created_at, email, id, balance, is_active, name, updated_at, user_id,
reporting_engineer_id, cashier_assigned_engineer_id, assigned_cashier_id,
cashier_assigned_location_id, organization_id, is_master_admin, employee_id,
preferred_language`

### `organization_memberships` (8)
`id, organization_id, user_id, role, is_active, is_accountant_cashier, created_at, updated_at`

### `teams` (9)
`id, organization_id, name, team_leader_user_id, executive_user_id, manager_user_id,
routing_mode, created_at, updated_at`
→ confirms the three role-aware mappings in Phase 5 all exist.

### `team_members` (4)
`team_id, user_id, organization_id, created_at`

### `audit_logs` (6, per generated types)
`action, comment, created_at, expense_id, id, user_id`

### Sources confirmed
* **Balance** → `profiles.balance` (not a separate table/view).
* **Profile/email/employee ID** → `profiles.name`, `profiles.email`, `profiles.employee_id`.
* **Resubmission / correction flags** → RPCs `get_resubmitted_expense_ids` and
  `get_reviewer_corrected_expense_ids` (`src/lib/supabaseInQuery.ts`).
* **Statuses** → `MANAGER_REVIEW_STATUSES` in `src/lib/managerReviewExpenses.ts`:
  `submitted, verified, approved, rejected, edited, under_review, level_1_verified,
  level_2_verified`.

---

## 4. Blocking discrepancies (RESOLVED — see §5a for what was implemented)

> Kept as the record of what the audit found. All three are now resolved; the
> "Decision needed" notes below are historical.

The mission's required `items[]` schema names three fields that are **not columns**. Each
needs a decision before the RPC can be written, because guessing would reproduce exactly
the class of bug this rewrite exists to remove.

### 4.1 `manager_queue_ready` — not a column
Grep across `src` and `supabase` finds it only in **client code**:
`src/lib/managerReviewExpenses.ts:376` computes it via `computeManagerQueueReady(...)` from
`src/lib/managerActionableExpenses.ts`, and `EngineerReview.tsx:262` re-derives it. No
migration defines it.

**Decision needed:** port `computeManagerQueueReady` into SQL (requires agreeing its exact
semantics, including the executive-handoff set it depends on), or drop the field from the
V2 contract and let `is_actionable` + `actionable_reason` carry it.

### 4.2 `submitted_at` — does not exist
No occurrence in the migrations or generated types. `expenses` has `created_at`,
`updated_at`, `trip_start`, `trip_end`.

**Decision needed:** which timestamp is the stable sort/snapshot key? `created_at` is the
natural candidate, but it is nullable in the generated types — a nullable sort key breaks
deterministic pagination and needs `COALESCE` plus a backing index.

### 4.3 `audit_logs.organization_id` — contradictory evidence ⚠
* generated types list **6 columns, without** `organization_id`;
* `20260731100000_reviewer_scope_indexes.sql:91` creates an index **on**
  `audit_logs (organization_id, user_id, action, expense_id)`;
* `20250303200000_allow_admin_restore_rls.sql:67` comments that audit_logs "may not have
  organization_id in all schemas".

Either the generated types are stale or that index migration has never successfully
applied. **This must be checked against Production** before any audit-flag predicate or
index is written.

---

## 5. Design decisions already settled

* **Pagination:** **keyset** (superseded the earlier snapshot+offset proposal). The cursor
  carries every ordering component for the active sort, so pages cannot drift or duplicate
  and no `OFFSET` is ever issued against mutable sort columns.
* **Ordering:** always a deterministic `id` tie-breaker — `newest` = `ts DESC, id DESC`;
  `oldest` = `ts ASC, id ASC`; `amount_high/low` = `total_amount, id`.
* **Sort input:** explicitly mapped, never interpolated — no dynamic SQL from `p_sort`.
* **Page size:** default 25, hard cap 100.
* **Count and page** share one predicate set (visibility + status + filters + snapshot).
* **Visibility ≠ actionability.** Visibility decides whether the row exists; actionability
  decides whether controls are enabled. `is_actionable` + `actionable_reason` are
  server-authoritative.
* **Custom fields:** aggregated to `jsonb` for page rows only; filtered server-side via
  indexed `EXISTS` (AND across fields, OR within a field); IDs internally, labels only in
  the display object.
* **No Load All in V2.** `Showing 1–25 of N` with Previous/Next driven by cursor history.
* **Rollout:** `VITE_REVIEW_QUEUE_V2_ENABLED`, default `false`; V1 untouched and kept for
  one release; no silent V2→V1 fallback.

---

## 5a. Blockers resolved — what changed (rev 2.0)

| # | Decision | Implementation |
|---|----------|----------------|
| A | `manager_queue_ready` **removed** from the contract | Replaced by `is_actionable` + `actionable_reason` + `actionable_stage`, computed server-side by `_review_is_actionable_v2` which ports the rules from `managerActionableExpenses.ts` (terminal → false; `level_2_verified` → true; engineer tier → actionable status; executive handoff; skipped tier; hierarchy off). A client-edge adapter `toLegacyRowShape()` maps it back for shared V1 presentational components only. |
| B | No `submitted_at` | Server returns computed `sort_at = COALESCE(updated_at, created_at, 'epoch')`. **Keyset** pagination, not offset — the cursor carries every ordering component for the active sort. |
| C | `audit_logs.organization_id` **never referenced** | Org scope inherited from the expense (`e.organization_id = p_organization_id`), audit rows joined by `al.expense_id`. New indexes use `(action, expense_id)` and `(user_id, action, expense_id)` only. |
| D | Custom fields as stable-ID records | `{source, field_id, field_key, label, value}`; filters keyed by `field_id` with AND across fields / OR within values via indexed `EXISTS`; aggregated for page rows only. |
| E | Flags from confirmed sources | `is_resubmitted` ← `audit_logs.action = 'expense_resubmitted'`; `was_reviewer_corrected` ← existence of an `expense_correction_logs` row for the expense + organization. |

All column names were verified against the migration history before writing SQL:
`expense_form_field_values.branch_field_id` (added `20260514120000`),
`expense_form_field_templates.field_key` (added `20260408090000`),
`app_role` gains `executive`/`team_leader` via `ALTER TYPE` — so roles are compared as
**text** (`m.role::text`) and a missing enum literal can never raise.

## 5b. Delivered

**Migration** `20260801130000_review_queue_v2_contracts.sql` (created, **not applied**):
`review_queue_api_version()` → 2 · `reviewer_visible_user_ids_v2()` (recursive, depth-10
guard, cycle protection, role-aware teams, active-membership intersection) ·
`get_review_queue_page_v2()` · `get_review_filter_options_v2()` ·
`get_review_expense_detail_v2()` · five actionability helpers · 18 indexes.

Every RPC is `SECURITY DEFINER`, `SET search_path = public`, checks `auth.uid()` and active
membership, revokes PUBLIC, grants only `authenticated`, and returns **one JSONB value**.
Count and page read the same `_rq_filtered` relation so they cannot drift. Enrichment
touches `_rq_page` only.

**Client** `src/features/reviewQueueV2/`: `types.ts` (contracts + six typed errors),
`api.ts` (RPC layer with runtime validation; the single Supabase cast is confined to
`callRpc`), `queryKeys.ts` (order-independent filter serialization).
`src/config/reviewQueueFeature.ts` — `VITE_REVIEW_QUEUE_V2_ENABLED`, **default false**.

**Tests** — 45, covering response parsing, malformed-payload rejection, version
enforcement, no-silent-fallback, error mapping without SQL leakage, one-RPC budget, query
keys, and 22 SQL-contract assertions (security, no `audit_logs.organization_id`, no
`OFFSET`, keyset tie-breakers, page-only enrichment, custom-filter semantics, cycle guard).

## 5c. Missing employee identity — root cause (rev 3.0)

Reported: Txn 00424/00423/00422/00421 in org `6709c1fe-e8c8-404d-bc68-d1edda923344`
showed a dash instead of the employee name and ID.

**The identity data is fully intact.** Read-only Production query:

| Txn | Employee | Employee ID | Profile | Active | Org matches |
|-----|----------|-------------|---------|--------|-------------|
| 00424 | Vijay Singh | 6767 | exists | yes | yes |
| 00423 | Dhananjay Dnyaneshwar Rodage | 6551 | exists | yes | yes |
| 00422 | Dhananjay Dnyaneshwar Rodage | 6551 | exists | yes | yes |
| 00421 | Roshan Borad | 5819 | exists | yes | yes |

All four are **cause A — the profile exists but the browser request failed.** No
deactivation, no re-import, no orphaned profile, no missing auth user, no snapshot
needed. `get_expense_submitter_profiles(p_organization_id uuid, p_user_ids uuid[])`
exists and is STABLE/SECURITY DEFINER — the RPC is not at fault either.

Note: `transaction_number` is **not unique across organizations** — `00424` exists in
three different orgs, so any diagnostic must filter by `organization_id`.

### CORS was a symptom, not the cause

Production evidence at the time of investigation:

* PostgREST is returning `{"code":"57014","message":"canceling statement due to
  statement timeout"}` on
  `GET /expense_form_field_values?select=…&expense_id=in.(…)` — the V1 bulk
  custom-field enrichment with large `IN` lists.
* Kong logged **2,476 5xx responses in 6 hours**.

Chain: V1 enriches thousands of rows in large `IN` batches → those statements hit the
timeout → PostgREST returns 500 → the error response carries no
`Access-Control-Allow-Origin` → the browser reports it as a CORS failure and
`net::ERR_FAILED`. Database saturation then causes collateral failures on other RPCs,
including `get_expense_submitter_profiles`, which is why identity fails *intermittently*
and only on some rows.

**Classification: 2 (upstream failure whose error response lacks CORS headers), with an
element of 4 (timeout read as CORS).** Adding origins to an allowlist would not have
fixed it. The fix is to stop issuing the query that times out — which is exactly what
V2's page-only enrichment does.

## 5d. V2 runtime defect found and fixed

`get_review_queue_page_v2` was declared `STABLE` while executing `CREATE TEMP TABLE`.
PostgreSQL refuses DDL in a non-volatile function, so **the function could never have
run** — the regex tests passed regardless, exactly as warned. It is now a single
CTE-only statement (7 `MATERIALIZED` CTEs: `visible → filtered → actionable → eligible
→ page_rows → page_identity/page_custom_fields → items`), preserving page-first
enrichment, keyset pagination and the shared filtered relation for count and page.

Submitter identity is now resolved **inside** the page RPC for page users only, with an
`identity_source` of `current_profile` / `inactive_profile` / `unresolved`. An inactive
employee keeps their identity rather than blanking the row. The browser therefore never
calls `get_expense_submitter_profiles` for the V2 list.

## 5e. Ordering / cursor correctness fixes (rev 4.0)

Three defects were found by review and fixed. The first two produced **wrong data**,
not merely slow data.

| # | Defect | Effect | Fix |
|---|--------|--------|-----|
| 1 | Items were aggregated with a fixed `ORDER BY pr.sort_at DESC, pr.id DESC` regardless of `p_sort` | `oldest`, `amount_high` and `amount_low` returned a correctly *paged* but incorrectly *ordered* JSON array | items now aggregate `ORDER BY pr.rn` |
| 2 | The cursor came from a `last_row` CTE using an approximate **inverse** ordering | the cursor could disagree with the last item actually returned → skipped or repeated rows across pages | cursor is now the row with the highest `rn` |
| 3 | SQL emitted `identity_source` but the TypeScript contract dropped it | identity provenance was silently discarded, so a fabricated or unresolved identity was indistinguishable from a confirmed one | added to `ReviewQueueItemV2` + validated in the parser |

The root of 1 and 2 was having **three** independent order definitions (page selection,
item aggregation, cursor derivation). There is now **one**: a `row_number() OVER (…)`
computed inside `page_rows` using the same `ORDER BY` that selects the page. Items
aggregate by `rn`; the cursor is `ORDER BY rn DESC LIMIT 1`. They cannot drift.

`identity_source` accepts only `current_profile | inactive_profile | expense_snapshot |
auth_user | deterministic_reimport | unresolved`; anything unrecognised degrades to
`unresolved` rather than being dropped.

## 5f. BLOCKED — no database available

The following could **not** be done and no result is claimed for them:

* the employee-6174 diagnostic (auth user id, the 23 expenses, executive-visible and
  executive-actionable counts, per-expense exclusion reasons, the `6174` vs `06174`
  search-collision proof);
* re-verification of whether `20260801130000` has been applied anywhere;
* any real SQL runtime test, timing, payload size or query plan.

Reason: the only reachable database is Production, and during this task the server
became unreachable entirely (port 22 timed out repeatedly; it had responded ~30 minutes
earlier). Repository policy forbids applying migrations to Production, and there is no
local Supabase or dedicated Preview database.

**The V2 page RPC has still never executed against a live PostgreSQL.** The previous
revision passed every static test while being fundamentally unrunnable, so "untested
against real SQL" must be treated as unknown, not as likely-correct.

## 6. What is NOT built yet

Still outstanding, and required before Preview can be exercised:

* **Presentational components** — `ReviewQueuePage/Table/Filters/Pagination/DetailDialog`,
  the React Query hooks, and the V1/V2 route switch. The data layer is complete and tested;
  the UI is not written, so nothing renders V2 yet.
* **Large-data fixture** (226 users / 6,088 expenses) and the performance measurements —
  these need a Preview database; no timing claim is made here.
* **Repair of the older migrations** that assume `audit_logs.organization_id`
  (`20260731100000_reviewer_scope_indexes.sql:91`, `290706_0900_manager_rpc_performance_fix.sql:33`).
  V2 does not depend on them, but a fresh-database migration run may still fail.
* Regenerating `src/integrations/supabase/types.ts` from an authoritative database, as a
  separate commit.

---

## 7. To unblock

1. Decide `manager_queue_ready`: port to SQL, or replace with `is_actionable` + reason.
2. Decide the stable sort timestamp (and whether it needs `COALESCE` + a NOT NULL backfill).
3. Confirm on Production, read-only:
   ```sql
   SELECT column_name FROM information_schema.columns
   WHERE table_schema='public' AND table_name='audit_logs';

   SELECT indexname FROM pg_indexes
   WHERE schemaname='public' AND tablename IN ('expenses','audit_logs','expense_form_field_values');
   ```
4. Confirm the real shape of `expense_form_field_values` / `_templates` /
   `_option_branches` (absent from the generated types).
5. Confirm the exact `action` strings behind the two flag RPCs.

With those five answers the RPC, indexes, client feature and tests can be written against
facts rather than assumptions.

---

## 8. Baseline recorded (this branch, at `2f23854`)

| Check | Result |
|-------|--------|
| `git diff --check` | clean |
| `npx tsc --noEmit` | pass |
| `npm run typecheck:api` | pass |
| `npm test -- --run` | **1626 passed / 92 files** |
| `npm run migrations:check` | pass |
| `npx tsx scripts/i18n-check-keys.ts` | **fails — 186 missing keys (pre-existing)** |
| `npm run lint` | **458 problems (pre-existing)** |

---

## Revision log

| Date | Rev | Author | Notes |
|------|-----|--------|-------|
| 2026-08-01 | 4.0 | Agent | Fixed three defects in the V2 page RPC. (1) Items were aggregated in a fixed `sort_at DESC, id DESC` order regardless of `p_sort`, so oldest/amount sorts returned mis-ordered JSON. (2) The cursor was derived from an approximate inverse ordering that could disagree with the last returned item, risking skipped/repeated rows. Both are resolved by a single `row_number()` inside `page_rows`, reused for item aggregation and cursor derivation. (3) `identity_source` was emitted by SQL but dropped by the client contract; it is now typed, validated, and degrades unknown values to `unresolved`. 4 new tests (54 in the V2 suite, 1794 total). **Employee-6174 diagnostic, migration-state re-check and all SQL runtime testing remain BLOCKED — the server became unreachable and no Preview database exists.** |
| 2026-08-01 | 3.0 | Agent | Investigated the blank employee identity for Txn 00424/00423/00422/00421. **All four profiles exist, are active and are correctly org-scoped** — cause A (browser request failed), not missing data; no snapshot or re-import mapping is required. Proved CORS is a *symptom*: PostgREST is returning 57014 statement timeouts on V1's bulk `expense_form_field_values` IN-list queries and Kong logged 2,476 5xx in 6h; those error responses carry no CORS header, so the browser reports ERR_FAILED. Fixed a fatal V2 runtime defect — the page RPC was STABLE yet executed CREATE TEMP TABLE, so it could never have run; rewritten CTE-only with 7 MATERIALIZED CTEs and server-side identity resolution (`identity_source`). 5 new tests (50 in the V2 suite, 1676 total). **No Production SQL executed, nothing deployed, V2 flag still false.** |
| 2026-08-01 | 2.0 | Agent | Blockers A–E resolved and implemented. `manager_queue_ready` removed from the contract in favour of server-computed `is_actionable`/`actionable_reason`/`actionable_stage`; `submitted_at` replaced by computed `sort_at`; offset replaced by keyset pagination; `audit_logs.organization_id` dependency eliminated (scope inherited from the expense); custom fields modelled as stable-ID records with AND/OR filter semantics; flags sourced from `expense_resubmitted` and `expense_correction_logs`. Added migration `20260801130000_review_queue_v2_contracts.sql` (5 RPCs + 5 helpers + 18 indexes, **not applied**), `src/features/reviewQueueV2/` data layer with runtime validation, and `VITE_REVIEW_QUEUE_V2_ENABLED` defaulting off. 45 tests added (1671 total). UI components, large-data fixture and performance measurement still outstanding. No SQL executed, nothing deployed, V1 untouched. |
| 2026-08-01 | 1.0 | Agent | Initial — V1 failure analysis; four-contract V2 architecture (list/detail/actions/filter-metadata) with single-`jsonb` responses to bypass the PostgREST row cap; page-first CTE ordering; snapshot+offset pagination with deterministic tie-breakers; settled decisions on sort mapping, page caps, visibility vs actionability, custom-field filtering and rollout. Schema audited from generated types + migrations. **Three required response fields found not to exist** (`manager_queue_ready` is client-computed, `submitted_at` absent, `audit_logs.organization_id` contradictory) — SQL deliberately not written pending §7. No code changed, no SQL executed. |
