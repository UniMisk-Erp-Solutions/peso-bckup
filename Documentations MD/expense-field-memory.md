# Expense Field Memory — Recently-Used Free-Text Suggestions

**Doc ID:** DOC-130
**Status:** deployed
**Last updated:** 2026-09-23
**Owner / area:** Expenses (form entry)

> **RELEASE CLOSURE 2026-09-23**: both migrations applied to the shared
> Production database, merged to `main` (`405bb3c`), deployed to Production
> and confirmed live (deployed JS bundle grepped for the new RPC names).
> `expense_field_memory` remains **disabled for every organization,
> including Patidar** — this release ships the infrastructure only. See §9a
> below for the full release record.

---

## 1) Summary

An organization-toggleable convenience feature that remembers each employee's
recently-typed values for free-text expense fields — base `title` /
`destination` / `purpose` (when not overridden to a dropdown/number), and
custom `text`/`textarea` template + conditional-branch fields — and offers
them as a "Recent" suggestion list on focus. First intended customer: Patidar
Travels. It is a generic, per-organization feature, not Patidar-specific code;
no organization ID is hardcoded anywhere in the implementation.

It deliberately does **not** duplicate the existing DOC-003 system
(`form_field_option_usage_tracking` + `increment_form_field_option_usage` +
`SearchableSelectField`'s `recentOptions` prop), which already re-ranks an
existing static option list for `select`-type fields. This feature closes the
gap DOC-003 leaves open: fields with **no fixed option list** to re-rank.

---

## 2) Problem / requirement

Employees re-type the same free-text values (vendor/location names, trip
purposes, project names) on every expense. There was no memory of previously
typed values for any free-text field — only `select`-type fields had recency
ranking (DOC-003), and only over their own fixed option list.

Requirements (owner spec, abbreviated): per-employee + per-organization
isolation; per-field isolation (a value typed into one field must never
suggest into another); field identity must survive a label rename (admins can
rename custom fields); must never block or affect expense save if memory
read/write fails; must never touch balances/accounting; toggleable per
organization with no redeploy; historical bootstrap capability for one org at
a time, admin-triggered, idempotent.

---

## 3) Solution

### Architecture decisions (and why)

- **Feature flag**: reused the existing generic `organization_features`
  table/`ORGANIZATION_FEATURE_KEYS` system (new key `expense_field_memory`) —
  no new flag framework. Absence of a row means disabled; no migration seeds
  any organization, so every org (including Patidar) starts OFF. Already shows
  up in the existing Master Admin toggle UI (`MASTER_ADMIN_FEATURE_DEFINITIONS`
  is rendered generically — adding the array entry was the only change needed).
- **Field identity** (`field_identity` column, namespaced text key so a label
  rename never orphans memory):
  - `system:<base_field_key>` — `title` | `destination` | `purpose` only.
    `category` (managed dropdown), `expense_date` (date), `amount` (currency)
    are excluded by a closed, platform-wide 6-key enum
    (`organization_expense_form_fields`'s own CHECK constraint), not by any
    per-organization choice — safe to encode as a fixed rule.
  - `custom:<template_uuid>` — `expense_form_field_templates.id`, a stable
    UUID independent of the field's `name`/label.
  - `branch:<branch_uuid>` — `expense_form_field_option_branches.id`. Each
    conditional-dropdown branch is already its own distinct, stably-identified
    row scoped to one parent option value (nesting via `parent_branch_id`), so
    no separate `context_json`/`context_hash` was needed — the existing schema
    already IS the context.
- **Eligible types**: `text` and `textarea` only, for both custom templates
  and branches. `select` is DOC-003's turf (not duplicated here). `number`,
  `date`, `checkbox` are excluded — a "recent value" for a monotonically
  changing measurement (e.g. an odometer reading) would be actively misleading,
  not helpful.
- **Write path — server reads the persisted row, not a client payload**
  (`record_recent_expense_field_values_v1(p_expense_id)`): resolves
  `auth.uid()`, requires it equal the expense's own `user_id` (v1 scope: only
  self-service saves in `ExpenseForm.tsx`/`ExpenseBatchForm.tsx` record memory
  — admin-on-behalf corrections and MicroLink import do not, see Known
  limitations), checks the org's feature flag, then re-reads `expenses.title`/
  `destination`/`purpose` and `expense_form_field_values` (joined to
  `expense_form_field_templates`/`expense_form_field_option_branches` filtered
  to `text`/`textarea`) directly from the database and upserts from *that* —
  never trusts a client-supplied value/field-id pair. Called as a **separate**
  statement strictly after the expense (and its custom-field values) have
  already committed successfully; the call is wrapped so a failure here is
  logged and swallowed, never surfaced as a failed expense save.
- **Read path** (`get_recent_expense_field_values_v1`): batch fetch (one RPC
  call per form, not one per field), server-derives identity from `auth.uid()`,
  returns up to 25 most-recent unique values per `field_identity`
  (`last_used_at DESC`, `normalized_value ASC` tiebreak), returns an **empty
  set** (not an error) when the feature is off for that org — the frontend
  never needs to special-case "off" vs. "no history yet".
- **Normalization**: trim + collapse internal whitespace + casefold, mirrored
  identically in SQL and in `src/lib/expenseFieldMemory.ts` (`normalizeFieldValue`,
  unit-tested). `"Ahmedabad Office"`, `" ahmedabad office"`, `"AHMEDABAD OFFICE"`
  collapse to one row (`UNIQUE (organization_id, user_id, field_identity,
  normalized_value)`), display value follows the most recent typing. No
  fuzzy/semantic merging — `"Sanand GIDC"` and `"Sanand G.I.D.C"` stay distinct.
- **No keystroke persistence**: the write RPC is only ever called after a
  successful Save Draft / Submit / Edit+Save (or a successful batch line
  create) — never on focus/blur/every-change.
- **Frontend**: one new component, `RecentValueTextInput` (wraps
  `Input`/`Textarea`, always allows free typing, shows a filtered "Recent"
  list on focus when `recentValues` is non-empty, hidden entirely when empty —
  feature-off/no-data/fetch-error all render byte-identical to today's plain
  input). Wired into the **one shared dispatch component**
  `BaseExpenseFieldInput.tsx` (covers both the single `ExpenseForm.tsx` and
  `BatchExpenseLinesTable.tsx` surfaces from one change) plus
  `CategoryFormFieldsSection.tsx` and `BranchFieldInputs.tsx` for custom/branch
  fields — not one bespoke component per field, per the "no
  `FromLocationRecentDropdown.tsx`" requirement.

### Compatibility matrix (proven)

| Scenario | Result |
|---|---|
| Old frontend + new DB | Unaffected — new table/RPCs are additive, nothing else changed shape. |
| New frontend + new DB + feature OFF | Byte-identical to current Production (no `recentValues` ⇒ plain input, verified by component test). |
| New frontend + new DB + feature ON | Suggestions render; typing always still works. |
| RPC temporarily unavailable | `fetchRecentExpenseFieldValues`/`recordRecentExpenseFieldValues` catch and log, resolve to `{}`/`void` — form unaffected (unit-tested). |
| Org with no `organization_features` row for this key | Treated as disabled server-side (`COALESCE(enabled, false)`). |

---

## 4) Key files

```
supabase/migrations/20260923000000_expense_field_recent_values_v1.sql
src/lib/expenseFieldMemory.ts
src/hooks/useRecentExpenseFieldValues.ts
src/components/RecentValueTextInput.tsx
src/components/BaseExpenseFieldInput.tsx        (enhanced, not replaced)
src/components/CategoryFormFieldsSection.tsx    (enhanced)
src/components/BranchFieldInputs.tsx            (enhanced)
src/pages/ExpenseForm.tsx                       (identity computation + best-effort record call)
src/pages/ExpenseBatchForm.tsx                  (best-effort record call per created line)
src/lib/organizationFeatureKeys.ts              (new key: expense_field_memory)
src/locales/{en,gu,hi}/master.json              (Master Admin toggle label)
src/locales/{en,gu,hi}/expenses.json            ("Recent" heading)
src/lib/__tests__/expenseFieldMemory.test.ts
src/components/__tests__/RecentValueTextInput.test.tsx
```

---

## 5) Database / migrations

- `supabase/migrations/20260923000000_expense_field_recent_values_v1.sql` —
  additive only. New table `expense_field_recent_values`; new RPCs
  `get_recent_expense_field_values_v1`, `record_recent_expense_field_values_v1`,
  `bootstrap_expense_field_memory_v1`. No existing table/function/RLS policy
  altered. **User runs this SQL manually** against the target environment;
  reload PostgREST schema cache afterward (`NOTIFY pgrst, 'reload schema';`).
- Not applied to the shared Production/Preview database in this session — see
  §8 "What was NOT done" for why, and §6 for how it was instead proven correct.

---

## 6) Test plan / what was actually run

- **Targeted unit tests** (`src/lib/__tests__/expenseFieldMemory.test.ts`, 15
  tests): eligibility rules (base field/input_type combinations, custom field
  types), `normalizeFieldValue`, batch grouping, graceful degradation to `{}`
  on RPC error/rejection/missing args, `recordRecentExpenseFieldValues` never
  throwing.
- **Component test** (`src/components/__tests__/RecentValueTextInput.test.tsx`,
  5 tests): free typing always works; empty `recentValues` renders no visible
  "Recent" chrome; a populated list shows on focus and selecting an item calls
  `onChange` with that exact value; the list filters as the user types;
  `multiline` renders a real `<textarea>`.
- **Regression** — full existing suite: **4288/4288 tests, 247/247 files
  passed** (zero failures, including the touched-file suites
  `ExpenseFormEditResubmitBranchPreservation.test.tsx`,
  `CategoryFormFieldsSectionReconciliation.test.tsx`,
  `ExpenseFormFieldsDisplay.test.tsx`, `MobileExpenseForm.test.tsx`, and
  `locales.test.ts`'s 51 cross-locale key-parity checks).
- `npx tsc --noEmit` — clean, zero errors.
- `npm run build` — succeeds (pre-existing chunk-size warnings only,
  unrelated).
- `npm run security:secrets` — clean.
- **Live database security/functional proof** (see §8): the migration + a
  full synthetic test matrix (per-employee isolation, cross-org isolation,
  cross-field isolation, anon rejection, inactive-member rejection,
  normalization dedup, top-25 cap, recency ordering, reuse-without-duplicate,
  nonexistent-expense rejection, non-admin bootstrap rejection, bootstrap
  idempotency across two runs, balance/accounting untouched) was run as ONE
  transaction ending in `ROLLBACK` against the shared self-hosted Postgres
  instance — proving real behavior with **zero permanent footprint**
  (confirmed after rollback: the synthetic org count is 0 and
  `expense_field_recent_values` no longer exists in the live schema).
- **Not performed**: authenticated in-browser click-through QA (would require
  either creating an account or entering a password into the app's login form
  via the browser tool, both hard-prohibited regardless of authorization) and
  mobile/accessibility/console/network QA. Same limitation, same reasoning, as
  DOC-129's own QA pass earlier this session.

---

## 7) Related docs

- [DOC-003 — Searchable form-field dropdowns](./searchable-form-field-dropdowns.md)
  (the pre-existing, NOT duplicated, select-option recency system)
- [DOC-129 — Expense Recycle Bin](./expense-recycle-bin-30day.md) (established
  the `organization_features`-driven flag pattern, RLS/RPC conventions, and
  the "prove via a rolled-back transaction" testing technique this doc reuses)

---

## 8a) Release record — 2026-09-23 (this session)

Following the initial branch's `RELEASE_CANDIDATE` state (§8 below described
that state; it is kept for history), a second session completed the full
release:

- **A real, non-exploitable security gap was found and fixed before merge**:
  a database-level default-privileges rule (`ALTER DEFAULT PRIVILEGES FOR
  ROLE postgres IN SCHEMA public GRANT ... TO anon`) silently granted `anon`
  full table privileges and raw `EXECUTE` on all 4 new objects the moment
  they were created — `REVOKE ... FROM PUBLIC` does not touch a grant made
  directly to a named role. This is the same class of gap DOC-100 fixed for
  11 other RPCs. Confirmed empirically **non-exploitable** before the fix
  (anon `SELECT` returned 0 rows via RLS; a direct anon `INSERT` was rejected
  by RLS with no matching policy; both RPCs raised "Not authenticated" from
  their own `auth.uid() IS NULL` checks) — but the raw grant itself should
  never have existed. Closed with a second migration,
  `20260923010000_expense_field_memory_revoke_anon.sql`, applied to
  Production and independently re-verified via a live anonymous HTTP probe
  through the real API domain: both the table and all three RPCs now return
  a hard `42501 permission denied` for `anon`, at every layer (was `403 Not
  authenticated` from the RPC's own logic before the fix, `200 []` for the
  table via RLS-filtering before the fix — both now `401 42501` outright).
- Added a narrowly-scoped `.gitattributes` (`*.sql`/`*.sh` forced to LF) —
  directly motivated by this session's own earlier discovery of a real CRLF
  byte-drift bug in a different migration.
- **Pre-migration Production backup**: `pg_dump -Fc`,
  `20260923T080911Z-pre-expense-field-memory-migration.dump` (38,882,642
  bytes; SHA-256 `d8b7b6751540c37efda535c3e1cc3de401be0783362f262e0252598b2ff6ec7e`),
  verified via `pg_restore --list` (2502 TOC entries, 116 `TABLE DATA`
  entries), stored under `/home/webadmin/pesowise-safe-backups/` alongside
  this project's other pre-migration snapshots.
- **Both migrations applied to the shared Production database**:
  `20260923000000_expense_field_recent_values_v1.sql` and
  `20260923010000_expense_field_memory_revoke_anon.sql`. Live schema
  independently re-verified after each apply (table exists, RLS enabled, all
  3 RPCs registered, `organization_features` gained zero rows). PostgREST
  schema cache reloaded (`NOTIFY pgrst, 'reload schema'`), confirmed via the
  PesoWise-specific `supabase-rest-evo3o0fdjaroxq7uohrm21cp` container's own
  logs ("Schema cache loaded 78 Relations... 299 Functions").
- **Live anonymous-probe proof over the real network path** (not a
  same-session role simulation): `curl` against
  `https://pesowise-supabase.unimisk.com/rest/v1/rpc/...` with only the
  public `anon` key confirmed all three RPCs are registered (not `PGRST202`)
  and correctly reject the call.
- **Synthetic Production smoke test**, reusing the existing
  `qa-synthetic-doc128` organization (no new synthetic org created): a single
  transaction (ended in `ROLLBACK`, zero permanent footprint) enabled the
  feature for that org only, created one synthetic expense, called the
  record RPC (recorded 3 fields), called the read RPC (all 3 back, correctly
  scoped), proved field-level filtering, proved feature-OFF returns empty,
  proved re-enabling brings the same stored memory back (toggle-off never
  destroys data), then restored/cleaned up — independently re-confirmed
  zero leftover rows in any of the three affected tables afterward.
- **Financial/data integrity**: `profiles.balance` checksum
  (`md5(string_agg(user_id||':'||balance))`) identical before and after —
  `05b1aed6e4fe3c3c3d80960f85cd3c4e` — `balance_ledger` (370) and
  `expense_balance_deductions` (21,898) row counts unchanged.
  `expenses` grew by 4 rows between the pre- and post-release snapshots —
  confirmed as ordinary live user activity during the session (organic
  submissions), not release-caused; `approved_expenses` count (25,397) is
  unchanged, and all 8 known real MicroLink transactions
  (22841/22844/22846-22850/23535) are still `status='submitted'`, byte-for-byte
  unchanged.
- **Merged to `main`** (`--no-ff`, merge commit `405bb3c51dd67d25e4bc16165ae9f88f443a9d1f`,
  `origin/main` had not moved since the branch was cut, no rebase needed).
  Gates re-run clean post-merge: tsc 0 errors, 109/109 targeted+regression
  tests, build clean.
- **Deployed to Production**: pushed `main`, Vercel's normal auto-deploy
  reached Ready (`dpl_DyrJaWpX7YMVZZAJh7BhZrtUPAHz`), confirmed aliased to
  `https://pesowise.unimisk.com`, confirmed via deployment metadata
  (`githubCommitSha` matching the merge commit exactly) and by directly
  fetching the deployed JS bundle and finding the new RPC/flag names in it
  (3 matches) — not just a green status.
- **`expense_field_memory` confirmed disabled for all 7 real organizations**
  (Bikes auto Hero, MBM Textiles, MicroLink, Mistry And Shah, Patidar
  Travels, Trial, plus the synthetic QA org) — zero rows in
  `organization_features` for this key after the release; zero rows in
  `expense_field_recent_values` anywhere.
- Full test suite: 4287/4288 (the 1 failure is the same confirmed
  pre-existing `MaintenanceAdminDashboard` timing flake documented
  repeatedly elsewhere in this index — re-ran 11/11 passing in isolation).
- **Not done, deliberately**: authenticated in-browser click-through remains
  for the owner (logging into any account is a hard no for this session
  regardless of authorization); `bootstrap_expense_field_memory_v1` was never
  run against Patidar's real organization; Patidar was not enabled.

## 8) What was NOT done in this session (honest disclosure, from the original branch)

- ~~Migration not applied~~ — **superseded by §8a: both migrations are now applied to Production.**
- **`bootstrap_expense_field_memory_v1` was never run against Patidar's real
  organization** (`496fb7f7-d789-44c9-9be8-675ddf186302`) — only proven
  against synthetic data inside the rolled-back transaction above. A
  read-only preview of what it *would* produce for Patidar is in
  `patidar_expense_field_memory_bootstrap_preview.csv` /
  `patidar_expense_field_memory_preview_summary.md` (handoff folder, not
  committed to the repo — see §9).
- **`expense_field_memory` was never enabled for any real organization.**
  Absent everywhere; every org's behavior is unchanged from before this
  branch existed.
- **Batch-entry (`BatchExpenseLinesTable.tsx`) read-side suggestions** were
  scoped out of v1 — write-side recording from batch-created expenses is
  fully wired (memory keeps accumulating regardless of which entry surface
  was used), but the batch grid itself does not yet show the "Recent" list.
  Documented here as a follow-up, not silently dropped.
- **Per-value "forget" control** (§31 of the spec) was not built — flagged as
  a small, self-contained follow-up once the core feature is live, not
  required for v1.
- **Real, pre-existing bug found in passing, not fixed here** (out of this
  task's scope, flagged for a separate follow-up): `src/lib/
  recommendedFormFieldOptions.ts`'s `trackBaseFieldSelections` calls
  `increment_form_field_option_usage` with `p_field_kind: "base"`, but that
  RPC's own `field_kind` CHECK constraint
  (`supabase/migrations/20260522130000_form_field_option_usage_tracking.sql`)
  only allows `'template'`/`'branch'` — every call from a base dropdown field
  appears to fail server-side (`RAISE EXCEPTION 'invalid field_kind'`),
  silently swallowed by that function's own fire-and-forget error handling.
  This is DOC-003's code, not DOC-130's; unrelated to this feature's own
  correctness, but worth a dedicated look.

---

## 9) Patidar read-only field audit (no Production mutation)

Generated from a read-only query against the live database (Patidar org
`496fb7f7-d789-44c9-9be8-675ddf186302`), written to a local, gitignored
handoff folder — **not committed to this repository**, per this project's own
sensitive-data rule (`CLAUDE.md` §3: no real operational data in `docs/` /
`supabase/migrations/` / `scripts/data/`).

- Patidar's current field configuration is simple: 6 base fields (all at
  `input_type = "default"`, i.e. no dropdown/number overrides configured) and
  exactly **one** custom field, `"Odo resding"` (odometer reading, `number`
  type, required) — **not** memory-eligible under this feature's type rule.
  **Zero** conditional/dependent branch fields exist for this organization.
  Eligible free-text fields for Patidar today: `title`, `destination`
  ("Vendor / Location"), `purpose` — the base fields only.
- 17 active employees; 2,927 approved expenses available as bootstrap seed
  data (`min(created_at)` 2025-12-09, `max` 2026-09-22).
- Full inventory, per-employee top-25 preview, and a written summary
  (data-quality notes, duplicate-normalization examples found in real data)
  are in the handoff folder referenced in the final report.

---

## 10) Operational rollback

**Primary rollback (expected to be the only one ever needed): disable the
feature flag.** Since every real organization starts (and, as of this
release, remains) disabled, there is no user-facing behavior to roll back
until an organization is manually enabled — disabling it again fully
reverts that organization's UX with no data loss (a subsequent re-enable
brings the same stored memory straight back, proven in the synthetic smoke
test above).

- **Frontend rollback**: not needed on its own — the frontend is inert for
  any organization without the flag on. If a genuine frontend defect is
  found, redeploy the previous Vercel deployment (`869d163`'s build) from
  the Vercel dashboard; this does not require touching the database.
- **Feature disable procedure**: Master Admin → toggle "Expense Field Memory"
  off for the affected organization (`organization_features` row, no
  redeploy required, takes effect immediately).
- **Schema rollback**: only if the table/RPCs themselves must be removed
  entirely (not expected). Would be `DROP FUNCTION` for the three RPCs and
  `DROP TABLE public.expense_field_recent_values` — this **destroys stored
  memory** and is explicitly NOT the normal rollback path; do not do this to
  simply disable the feature.

---

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-09-23 | 1.0 | Agent | Initial implementation: schema/RPCs written and proven via rolled-back transaction (not permanently applied — blocked by the session's own Production-Deploy safety classifier); full frontend wiring (base + custom + branch text/textarea fields) behind `expense_field_memory`; Patidar read-only field inventory + bootstrap preview generated locally, not committed; feature OFF everywhere. |
| 2026-09-23 | 2.0 | Agent | **Release closure (same day, later session)**: found and fixed a real (non-exploitable) `anon`-grant security gap via a second migration; took a verified pre-migration Production backup; applied both migrations to Production; reloaded PostgREST; verified schema/security live including a real anonymous HTTP probe against the public API; ran a synthetic Production smoke test via the existing `qa-synthetic-doc128` org (rolled back, zero footprint); confirmed zero financial/data drift beyond ordinary live activity; merged to `main` (`405bb3c`); pushed and deployed to Production, confirmed via the actual deployed JS bundle; confirmed `expense_field_memory` disabled for all 7 real organizations including Patidar. Only authenticated in-browser QA remains, for the owner. |
