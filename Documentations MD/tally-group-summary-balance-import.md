# Tally Group Summary — Direct Balance Import

**Doc ID:** DOC-105
**Status:** in progress
**Last updated:** 2026-10-01 (rev 5.0 — see revision log)
**Owner / area:** Balances / Bulk Balance Import Wizard

---

## 1) Summary

Admins can now upload a classic Tally "Group Summary" XLSX export directly into the
Bulk Balance Import wizard, instead of transcribing Tally balances into the PesoWise
starter sheet by hand. The wizard auto-detects the Particulars/Opening/Debit/Credit/
Closing Balance table (no hardcoded row/column numbers), extracts employee name +
employee ID from each Particulars cell, correctly reads Tally's Cr/Dr sign (which
lives only in the Closing Balance cell's display format, never in the raw number),
and reads the Debit column (Column C — plain positive magnitude, no Cr/Dr marking).
Both Tally import modes (Opening Balance, Balance Update) route through the
**Additive Credit V3** engine (`balance_validate_import_v3`/`balance_apply_import_v3`
— a pure delta, `new_balance = current_balance_snapshot + input_amount`, never a
target to reconcile toward): Opening Balance stages the full signed Closing Balance
as that delta (an initial credit); **Balance Update stages ONLY the Debit column**
(rev 4.0 fix — see §8/revision log; it previously, incorrectly, staged Closing
Balance for Balance Update too). Allocation import is unaffected and does not offer
a Tally source (Tally has no additive-allocation equivalent); starter-sheet imports
may still use the older `historical_opening`/`historical_update` stated-balance-target
modes, which this document's earlier revisions describe and which are unchanged.

---

## 2) Problem / requirement

The owner's real accounting source for employee closing balances is Tally, not
PesoWise. Historical/period-end imports required first exporting a Tally Group
Summary, then manually re-typing every employee's Closing Balance into the PesoWise
starter sheet — slow and error-prone, especially since Tally's Cr/Dr sign is easy to
misread manually and the "-Hold" suffix on some names offered no clear handling rule.

## 3) Solution

- **`src/lib/tallyBalanceImport.ts`** — a pure parser module (no React/Supabase
  dependency):
  - Locates the Particulars/Closing Balance table by scanning for a "Particulars"
    header cell and a header block whose combined text contains both "closing" and
    "balance" (distinguishing it from Opening Balance / Transactions Debit/Credit).
    The header/data boundary is found by scanning forward while the **Particulars
    column itself** stays blank — not by counting non-empty cells in a fixed window,
    which would swallow real data rows. This works regardless of how many extra
    header/address rows precede the table.
  - Splits each Particulars cell into employee name + employee ID via
    `/^(.*?)\s*-\s*(\d+)(?:\s*-\s*hold)?\s*$/i`, tolerating irregular whitespace
    around the hyphen. Employee ID is always a string — never passed through
    `Number()`/`parseInt`, so leading zeros survive. A trailing "-Hold" is stripped
    and recorded as `flags: ["hold"]` — a diagnostic tag only, never used to infer
    Cr/Dr or any financial semantics.
  - Reads each Closing Balance cell's **signed** value from its display format
    (`cell.w`/`cell.z`, requires `XLSX.read(..., { cellNF: true, cellText: true })`),
    never from the raw `cell.v` (always a positive magnitude regardless of Cr/Dr).
    Dr → positive PesoWise balance, Cr → negative, blank → exactly `0` (never
    skipped — a blank Closing Balance is a real historical target).
  - Extracts the report period ("1-Jul-26 to 31-Jul-26" → ISO dates) from free text
    anywhere in the header block; not hardcoded to any month.
  - Sums signed closings and compares against the sheet's own Grand Total row
    (₹0.01 tolerance for floating-point noise); returns the parsed total, the
    report's total, and the difference so a mismatch is surfaced, never hidden.
  - Any row that fails to parse (unparseable Particulars, or a Closing Balance
    that is not blank and not clearly marked Cr/Dr) is reported as a row-level
    failure with a reason — never silently dropped or guessed.
  - `resolveTallyEffectiveDate(periodEnd, usage)` implements the Case A / Case B
    choice: `usage: "opening_balance"` → `periodEnd + 1 day` (next period's opening
    position); `usage: "balance_update"` → `periodEnd` itself (the server's existing
    `day_position` logic in `balance_apply_import_v2` already places a
    `balance_update` anchor at end-of-day, so the frontend does not need to encode
    time-of-day itself).
  - A file that does not match this shape returns `{ok: false, reason}` — the
    wizard shows "This doesn't look like a supported Tally Group Summary export."
    and never falls back to a column-mapping/guessing UI.

- **`src/components/balances/ImportBalancesDialog.tsx`** — wizard integration:
  - Step 1 ("type") gained a **File source** selector: "PesoWise starter sheet" vs
    "Tally Group Summary export". Selecting Tally restricts the amount-application
    choice to Opening Balance / Balance Update (Allocation is hidden — Tally has no
    additive-allocation concept) and skips the starter-sheet download step entirely.
  - The upload step branches per source. The Tally branch reads the file with
    `cellNF: true, cellText: true`, runs `parseTallyGroupSummaryWorkbook`, and
    renders `TallyPreviewPanel`: report period, employee/Cr/Dr/zero counts, the
    resolved effective date, a reconciliation PASS/FAIL banner (parsed vs report
    Grand Total, with the difference), any row-level parse failures, and a
    per-employee table (Employee / Employee ID / Tally Closing / PesoWise Signed
    Balance / Status). Status is **Matched** (employee ID found, name agrees),
    **Name differs** (ID found, name differs — a warning, not a block; PesoWise's
    stored name is shown for comparison), or **Unknown Employee** (ID not found —
    not blocked here; the existing V2 validator/conflict UI already has an
    "unknown" status with a Skip action). Employee identity is resolved by
    **Employee ID**, never by name.
  - Continue is disabled while there are unparsed rows or the file fails to
    reconcile against its own Grand Total — an admin cannot proceed past either
    condition and cannot silently apply a mismatched total.
  - **Current, correct behavior (rev 4.0 — see §8 below for the full history
    of how this section drifted and was corrected):** on Continue, parsed
    Tally rows are converted to the same source-agnostic `StagedImportRow[]`
    a starter-sheet upload produces (`rawEmployeeId`, `rawEmail: null`, the
    resolved `effectiveDate`, and a `note` recording the source period + Hold
    flag if present) — but `inputAmount` is **NOT** always the signed
    Closing Balance:
    - **Opening Balance** (`mode: "opening_credit"`) → `inputAmount = row.signedClosingBalance`
      (unchanged since rev 1.0 — an opening credit genuinely is the full
      starting balance).
    - **Balance Update** (`mode: "balance_credit"`) → `inputAmount = row.tallyDebitAmount`
      (Column C, "how much NEW money was added this period" — rev 4.0 fix;
      **not** Closing Balance, **not** Closing-minus-Opening, **not**
      Debit-minus-Credit). Continue is blocked with a clear message if any
      importable row's Debit cell could not be read.
    - Both Tally modes (`opening_credit` / `balance_credit`) are **Additive
      Credit V3** modes (`isAdditiveV3Mode`, `20260901121500_additive_credit_v3_import.sql`),
      not the Historical Balance Anchor V2 `stated_balance`-target engine this
      section originally described: `balance_validate_import_v3` /
      `balance_apply_import_v3` treat `input_amount` purely as a **delta**
      (`new_balance = current_balance_snapshot + input_amount`), never a
      target to reconcile toward. For Balance Update this means, in full:
      `new PesoWise balance = current PesoWise balance + Tally Debit` — e.g.
      Opening ₹10,000 / Debit ₹5,000 / Credit ₹3,000 / Closing ₹12,000 on a
      current PesoWise balance of ₹20,000 → **₹25,000** (adds exactly the
      ₹5,000 Debit), never ₹32,000 (Closing added), never ₹37,000 (Closing
      replacing), never ₹32,000-via-Debit-minus-Credit math. The legacy
      `validateImportBatchV2`/`applyImportBatchV2`/stated-balance-target path
      this section used to describe still exists and still serves the
      starter-sheet's own `historical_opening`/`historical_update` modes
      (pre-dating the V3 additive modes) and `allocation` imports — it is
      simply not what either Tally mode routes through.
    - Archive/upload mechanics are unchanged for both modes: `createImportBatch`
      → archive the **original** uploaded Tally `.xlsx` (SHA256
      duplicate-protected, same as any other source) → `insertImportRows` →
      mode-appropriate validate RPC → conflict-resolution UI where
      applicable → mode-appropriate apply RPC.
  - `handleContinueToPreview` (starter-sheet path) and
    `handleContinueToPreviewTally` both delegate to a shared
    `stageAndValidate(stagedRows)` so the archive/insert/validate/conflict-fetch
    logic exists in exactly one place for both sources.

## 4) Key files

```
src/lib/tallyBalanceImport.ts
src/lib/__tests__/tallyBalanceImport.test.ts
src/components/balances/ImportBalancesDialog.tsx
src/components/balances/__tests__/ImportBalancesDialogTally.test.tsx
```

## 3a) Final hardening pass (2026-08-26) — fail-closed gaps closed

A follow-up audit against the shipped code (not a redesign) found and closed
five remaining fail-closed gaps, all in `tallyBalanceImport.ts` /
`ImportBalancesDialog.tsx`:

1. **Grand Total is now REQUIRED, not merely checked when present.**
   `reconciles()` previously returned `true` when the Grand Total row was
   missing or unparseable (`reportClosingTotal === null`) -- a Tally-shaped
   file with no Grand Total could reach Continue unreconciled. It now
   returns `false` in that case, and the UI banner explains why ("The Tally
   Group Summary must include a valid Grand Total Closing Balance so
   PesoWise can reconcile the import before applying it.") instead of the
   old, softer "no Grand Total row was found to check against."
2. **A non-numeric, non-blank Closing Balance cell can no longer become
   ₹0.** `parseTallySignedBalance` used `Math.abs(Number(cell.v)) || 0`,
   which silently turns `Number("ABC")` (`NaN`) into `0` via `|| 0`. It now
   explicitly checks `Number.isFinite` first and reports a row-level parse
   failure (never a fabricated zero) for a genuinely non-numeric value like
   `"ABC"`, `"N/A"`, or a bare `"-"`.
3. **A file with zero successfully parsed employee rows is now rejected at
   the parser level** (`{ok: false, reason: "No employee rows could be
   parsed..."}`), not left for the wizard to notice on its own.
4. **The client-side 5,000-row guard now applies to Tally too**, before any
   batch is created or file uploaded -- previously only the starter-sheet
   path had this early check; Tally relied solely on the server's later
   guard.
5. **Tally mode fail-closed at the handler level, not just the UI.**
   `tallyUsageForMode` used to default anything that wasn't
   `"balance_update"` to `"opening_balance"` -- including a hypothetical
   `"allocation"` state. It now returns `null` for anything other than the
   two valid modes, and `handleContinueToPreviewTally` independently checks
   `historicalAvailable`, `importSource === "tally"`, and a non-null usage
   before staging anything -- a hidden radio button is presentation, not
   financial authority.

Also: the Tally employee-preview lookup now filters `is_active = true`
(matching the starter-sheet path's existing convention) so an inactive
employee shows "Unknown Employee" in the preview instead of falsely
appearing "Matched" and then flipping to unknown at server validation.

## 3b) CRITICAL FIX (2026-08-26) — Tally was disappearing whenever the backend was missing

**The bug:** the "type" step's File source selector (PesoWise starter sheet vs
Tally) and the Opening Balance/Balance Update radios were all wrapped in
`{historicalAvailable && (...)}`, where `historicalAvailable = historicalFlagOn
&& historicalCapability.ready`. On any environment where the Historical
Balance V2 migrations haven't been applied yet -- which is every environment
today, including the Preview deployment -- `balance_historical_v2_capabilities_v1`
404s, `historicalCapability.ready` is `false`, and the entire Tally import
FORMAT vanished from the screen. A `useEffect` made this worse by silently
resetting `mode`/`importSource` back to Allocation/starter-sheet the instant
that happened, even if the admin had already selected Tally.

**Why this was wrong:** Tally is a file *format*, not a financial capability.
An admin must always be able to select it, upload a file, and see a full
local preview (period, employee count, Cr/Dr/zero counts, Hold flags, Grand
Total, reconciliation, employee matching) regardless of whether the
accounting engine backing Opening Balance/Balance Update has been deployed
yet. Only the actual database-writing step should depend on that.

**The fix:** replaced the single `historicalAvailable` gate with three
independent concepts:
- `historicalFlagOn` -- the org admin enabled the feature in Master Admin.
- `historicalBackendReady` -- `balance_historical_v2_capabilities_v1` reports ready.
- `historicalMutationReady = historicalFlagOn && historicalBackendReady` --
  required before `stageAndValidate` (and therefore `createImportBatch`/
  `insertImportRows`/`validateImportBatchV2`/`applyImportBatchV2`) is ever
  called for a historical mode, checked in ONE shared choke point regardless
  of source.

**Visibility rules (never gated on backend readiness):**
- The Tally source, and Opening Balance/Balance Update whenever Tally is
  selected, are **always** offered -- flag on or off, backend ready or not.
- Opening Balance/Balance Update for the **starter-sheet** source are offered
  when `historicalFlagOn` alone (unaffected by backend readiness -- selecting
  and previewing don't touch the database either way).
- Allocation remains always available, unaffected by any of this.
- The `useEffect` that silently reset mode/source on backend-missing is
  **removed entirely**. The only automatic correction left is: switching the
  source to Tally while mode is Allocation sets mode to Opening Balance
  (Tally has no Allocation meaning) -- never a backend-driven reset.

**When the backend isn't ready**, Continue is disabled and a "Preview only"
banner explains why, instead of a raw 404 or the option disappearing:
> "Preview only -- the Historical Balance backend has not been installed yet.
> You can inspect this Tally file, but Validation and Apply will unlock after
> the PesoWise V2 database update."

**Direct entry point:** `ImportBalancesDialog` gained an `initialSource?:
"template" | "tally"` prop. The Balances page now shows two buttons side by
side -- "Import Balances" (unchanged) and a new "Import from Tally" -- both
opening the exact same dialog component/parser/services, never a second
implementation. Because the dialog's step/mode/source state only initializes
once per mount, `Balances.tsx` remounts it fresh (`key={importDialogInitialSource}`)
whenever the entry point changes, so reopening via a different button always
lands on the correct starting step.

## 3c) Atomic import reversal V2 (2026-08-26)

`ImportHistoryDialog`'s "Reverse Import" previously called
`reverseImportBatch` (`balance_reverse_import_v1`) for every mode, including
historical_opening/balance_update -- but v1 only understands a flat
compensating-ledger-entry model, which is structurally wrong for a batch that
created HISTORICAL ANCHORS (whose net effect on today's balance depends on
cascading recalculation, never a flat "-delta"). It now calls
`reverseImportBatchV2` (`balance_reverse_import_v2`) exclusively:
- **Allocation** batches delegate to the existing v1 engine unchanged
  (byte-identical accounting -- never duplicated).
- **historical_opening/balance_update** batches reverse each row's
  `resulting_anchor_id` through the canonical `balance_reverse_historical_anchor_v1`
  engine (never duplicated arithmetic), after verifying every anchor still
  belongs to this batch and is still `status='active'`. A later manual
  edit/replace (status='superseded') or an already-reversed anchor
  (status='reversed') blocks the **whole batch** reversal with zero mutation
  -- never a partial one, and never silently unwinding an intentional later
  correction. A batch with zero anchor evidence RAISEs rather than being
  marked reversed with nothing actually undone.

Also fixed in `ImportHistoryDialog.tsx`: `modeLabel(mode)` used to render
*anything* that wasn't `historical_opening` as `"Allocation"` -- including
`balance_update`, and any future/unrecognized mode. It now maps all three
known modes correctly and shows an unrecognized mode's raw value rather than
mislabeling it. The "Reverse Import" button is now shown only for
`status === "applied"` **and** a recognized mode.

## 5) Database / migrations

One new migration, part of the Historical Balance Anchor V2 Phase 1 set (see
[`historical-balance-anchors-v2.md`](./historical-balance-anchors-v2.md) and
`scripts/historicalBalanceV2Phase1Migrations.mjs`):
- `20260826110000_balance_reverse_import_v2.sql` -- `balance_reverse_import_v2`.

The capability probe (`20260826100000_balance_historical_v2_capabilities.sql`)
was updated (still unapplied anywhere, so edited in place rather than
patched) to also check for `balance_reverse_import_v2`'s existence.
Everything else in this feature reuses the existing Historical Balance
Anchors V2 schema/engine and import-batch tables unchanged.

## 6) Test plan

- [x] `src/lib/__tests__/tallyBalanceImport.test.ts` (24 tests, pure unit tests, no
      React/Supabase): Cr → negative, Dr → positive, blank → zero (never
      null/skipped), sign is never inferred from the raw positive number alone;
      Particulars parsing across "Name-1234"/"Name - 1234"/"Name  -  1234" spacing
      variants, "-Hold" suffix stripped + flagged, employee ID kept as a string
      (leading zeros survive); period parsing for two different months (not
      hardcoded to July); effective-date resolution for both Case A
      (`opening_balance` → `periodEnd + 1`, including a month-rollover case) and
      Case B (`balance_update` → `periodEnd` itself); a full 6-row sample
      reproducing every task-specified example with exact Grand Total
      reconciliation; Grand Total itself excluded from the employee rows; a
      reconciliation mismatch is flagged, not hidden; a mismatch within the ₹0.01
      tolerance is not falsely flagged; the table is located correctly even when
      pushed down by extra header/address rows AND with a realistic split header
      ("Closing" / "Balance" on two stacked rows) — no hardcoded row/column
      numbers in either case; an unsupported file shape (arbitrary `Name | Amount`
      columns) is rejected with a clear reason, not guessed; an unparseable
      Particulars cell is reported as a row-level failure, not silently dropped.
- [x] `npx tsc --noEmit -p tsconfig.app.json` — zero errors in any file touched by
      this change (baseline pre-existing-error count unchanged at 615).
- [x] `npm run build` — clean.
- [x] `npm run migrations:check` — clean (no new migrations added by this change).
- [x] `npm run security:secrets` — clean.
- [x] `npx vitest run` (full suite) — zero new failures vs. this branch's own
      established baseline; see the release-prep revision log entries for exact
      counts as of each pass.
- [x] `src/components/balances/__tests__/ImportBalancesDialogTally.test.tsx`
      (2026-08-26, 11 tests) — a REAL in-memory XLSX File built with SheetJS
      driven through the actual React wizard (not just the pure parser): file
      select → parse → preview → Continue → staging, for both Opening Balance
      (effective date = periodEnd+1) and Balance Update (effective date =
      periodEnd); asserts the exact `StagedImportRow` values reaching
      `insertImportRows`; confirms Tally never offers Allocation; confirms
      Continue is blocked by a missing Grand Total, a reconciliation mismatch,
      a row parse failure, an unsupported workbook, and a >5,000-row file
      (staging never starts in that last case); confirms Unknown Employee and
      Name-differs preview states, with Employee ID (never the Tally name)
      staged as identity; confirms only `validateImportBatchV2` is called,
      never `applyImportBatchV2` before an explicit Apply and never the v1
      import RPCs (dead code, zero callers, confirmed separately).
- [x] **Real Tally file QA (2026-08-26) — READ-ONLY, parser only, never
      committed.** The owner's actual Tally Group Summary export was located
      and read in this session (`~/Downloads/Pm july.xlsx` — accessible this
      session; an earlier session hit a since-resolved environment limitation
      trying to read a similarly-named file from a different path). Parsed via
      `parseTallyGroupSummaryWorkbook` through `vite-node` (never modified,
      never copied into the repository, never logged beyond aggregate counts):
      **204 employees, 94 Cr, 60 Dr, 50 zero, 1 Hold-flagged, 0 parse
      failures, signed total −1,439,220, Grand Total −1,439,220, difference 0,
      `reconciles() === true`** — an exact match against every number
      predicted before this file was ever accessible, with zero discrepancies.
      This is real-data structural/reconciliation proof, not a live-browser
      Apply proof — see the item below for what remains.
- [ ] Manual QA against the real Tally Group Summary export **through the live
      React wizard in a browser, backed by a real database** (parse → preview
      → reconciliation → conflict resolution → Apply) — deliberately NOT
      performed. Doing so would require either a live Supabase connection
      (creating a real import batch + inserting real rows is a real database
      mutation, out of scope for this session's no-live-mutation constraint)
      or extensive mocking that would not actually exercise a live backend.
      The parser-level proof above is real; the end-to-end live-browser proof
      still requires a session with an authorized, disposable database.

## 7) Related docs

- [`historical-balance-anchors-v2.md`](./historical-balance-anchors-v2.md) — the
  accounting engine this feature's output feeds into unchanged.

### Known limitations (disclosed, not silently omitted)

- Verification is primarily by synthetic fixtures reproducing every structural
  example given in the task (spacing variants, Hold suffix, Cr/Dr/blank, split
  header, pushed-down table, Grand Total reconciliation, unsupported-file
  rejection), plus a component-level integration test driving the real React
  wizard against a real in-memory XLSX file. No real employee data is
  committed anywhere in this repository at any point.
- The owner's real Tally export WAS successfully read and parsed read-only in
  the 2026-08-26 pass (see the test plan entry above) — this is genuine
  real-data proof of the parser and its reconciliation logic, not a synthetic
  substitute. **What remains unperformed is a live-browser Apply pass against
  a real, disposable database** — the parser/reconciliation correctness is
  proven; the end-to-end database write path for a Tally-sourced batch has
  only been proven for the starter-sheet-equivalent staged rows via unit and
  component tests, not via a live backend. Status stays "in progress" until
  that live pass happens.

---

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-08-25 | 1.0 | Claude Code | Initial doc — pure parser (`tallyBalanceImport.ts`, 24 tests) + wizard integration (`ImportBalancesDialog.tsx`: file-source selector, Tally upload/preview panel, shared `stageAndValidate` staging path). Feeds Historical Balance Anchor V2 unchanged. `feature/bulk-balance-import-ledger` only, not merged, no migrations added. |
| 2026-08-26 | 2.0 | Claude Code | Final hardening pass: 5 fail-closed gaps closed (Grand Total now required not optional; a non-numeric closing cell can no longer become ₹0; zero-employee-row files rejected at the parser level; the 5,000-row guard now applies to Tally uploads too, before any batch/upload; Tally mode fails closed at the handler level, never silently defaulting Allocation to Opening Balance) plus an active-employee filter added to the Tally preview lookup. New `ImportBalancesDialogTally.test.tsx` (11 tests) drives the real wizard against a real in-memory XLSX file end to end. The owner's real Tally export was located and parsed READ-ONLY this session (never committed, never logged beyond aggregates): 204 employees / 94 Cr / 60 Dr / 50 zero / 0 failures / signed total −1,439,220, exact match against every previously-predicted number, reconciles() true. Live-browser Apply QA against a real database still not performed (correctly out of scope for a no-live-mutation session) — status stays "in progress". |
| 2026-08-26 | 3.0 | Claude Code | Visibility fix, prompted by the owner reporting Tally import was not visible in the Vercel Preview. Tally is a file FORMAT and must never disappear because the Historical Balance backend (a separate concern) isn't installed yet — `ImportBalancesDialog.tsx`'s File Source selector was previously wrapped entirely behind `historicalAvailable` (flag AND backend-ready), hiding Tally along with Opening Balance/Balance Update. Now always rendered; a "Preview only" banner explains when Validation/Apply are still locked behind the backend install (see `historical-balance-anchors-v2.md` §8/rev 3.0 for the shared `historicalMutationReady` mechanism). Added a direct "Import from Tally" button on `Balances.tsx` via a new `initialSource` prop, landing straight on the upload step. Re-parsed the owner's real Tally file fresh against the current (post-visibility-fix, post-reversal-engine) parser: identical results to rev 2.0 (204 employees / 94 Cr / 60 Dr / 50 zero / 1 Hold / 0 failures / signed total −1,439,220 / reconciles true) — confirms nothing in this pass touched parsing behavior. A real-employee-data exposure was found in this doc's own test fixtures (`tallyBalanceImport.test.ts`'s `SAMPLE_ROWS`, already pushed in two prior commits) matching illustrative real-file examples the owner had shared; disclosed immediately, the working tree was fixed (synthetic "Test Employee Alpha"–"Zeta" placeholders), and — with the owner's explicit authorization — the two exposed commits were rewritten via a branch-scoped `git filter-branch` and force-pushed to `origin/feature/bulk-balance-import-ledger`. Three backup branches on origin still carry the real names in their own history, left untouched pending a separate owner decision. Live-browser Apply QA against a real database still not performed — status stays "in progress". |
| 2026-10-01 | 5.0 | Claude Code | **Financial hotfix re-audit — legacy V2 vs additive V3 root cause, fail-closed routing guarantee, server-response sanity check.** The owner reported a validation case equivalent to Current=₹7,000/Debit=₹0 displaying as **−₹7,000**. Root cause CONFIRMED (not guessed) from the live, self-hosted Production database: the legacy `balance_validate_import_v2` function (still live, used only for `mode IN ('historical_opening','balance_update')` batches) computes `v_new := v_current + (input_amount - historical_position_before)`, and `ImportBalancesDialog.tsx`'s preview table separately renders `adjustment = input_amount - historical_position_before` whenever `anchorKindForMode(mode)` is non-null (i.e. only for the two legacy modes) — when a prior `historical_opening` anchor already established a nonzero `historical_position_before` equal to the current balance, a Debit=0 row's displayed adjustment is exactly `0 - current = -current`. This is NOT reachable from today's UI for a NEW Tally import: every `setMode()` call site and every `RadioGroupItem value=` in the file was enumerated exhaustively, and the mode selector only ever offers `opening_credit` / `balance_credit` / `allocation` — there is no live path to create a new batch with `historical_opening`/`balance_update`. A real, un-applied `balance_update`-mode batch was found on Production (org "Mistry And Shah", batch created 2026-08-29, `status='validated'`, never applied) proving the legacy engine genuinely produced this exact shape historically, pre-dating this branch's mode-selector restriction — left untouched (read-only forensics only, per policy). Added defense-in-depth anyway: (1) an explicit fail-closed assertion in `stageAndValidate` (`ImportBalancesDialog.tsx`) that throws an internal-contract error before `createImportBatch` if a Tally batch's derived usage (`tallyUsageForMode`) ever disagrees with its underlying `mode` (balance_update usage must have `mode="balance_credit"`, opening_balance usage must have `mode="opening_credit"`) — this cannot fire via today's UI, but guards against a future regression reopening the legacy path; (2) a client-side server-response sanity check in `handleApply` that verifies every `valid` additive-V3 row satisfies `calculated_new_balance == current_balance_snapshot + input_amount` (0.01 tolerance) before allowing Apply, blocking with "Balance validation returned an inconsistent result. Nothing has been applied." otherwise — proven with a new test that reproduces the exact Current=7000/Debit=0/calculated=-7000 shape and asserts `applyImportBatchV3` is never called. Also live-re-verified (via `pg_get_functiondef` over SSH, not migration text) `balance_validate_import_v3`, `balance_apply_import_v3`, `_balance_apply_credit_core_v3` (its own comment: *"THE ENTIRE FORMULA. No target. No reconstruction. No adjustment math."* — `v_balance_after := v_balance_before + p_amount`), and `balance_reverse_import_v3`: all four confirmed additive, confirmed `input_amount=0` rows classify `no_op` and are excluded from the Apply loop (`WHERE validation_status = 'valid'`), confirmed reversal is per-ledger-entry (`balance_reverse_credit_v3`), not target-based. 1 new test added (17 total in `ImportBalancesDialogTally.test.tsx`, all passing); `tsc -p tsconfig.app.json --noEmit` shows zero new errors from these changes. Branch `hotfix/date-lock-and-tally-debit`, PR #7, not yet merged. |
| 2026-10-01 | 4.0 | Claude Code | **Balance Update hotfix**: confirmed and fixed a real bug where a Balance Update import added the row's full **Closing Balance** to the PesoWise balance, instead of only the period's **Debit** (new money added) -- found by auditing `ImportBalancesDialog.tsx`'s staging step (`inputAmount: row.signedClosingBalance`, used for BOTH `opening_credit` and `balance_credit` modes) against `balance_apply_import_v3`'s own doc comment, which already correctly treats `input_amount` as an additive delta (`current_balance_snapshot + input_amount`) -- the math was always right, the wrong NUMBER was being fed into it. Parser (`tallyBalanceImport.ts`) now also locates and parses the Debit column (`locateTallyTable`'s new required `debitColumn`, `parseTallyDebitCell`, new `TallyBalanceRow.tallyDebitAmount` field: 0 for blank/zero, NaN for a negative or unparseable cell, never silently 0). `ImportBalancesDialog.tsx` now stages `row.tallyDebitAmount` (not `signedClosingBalance`) specifically for `usage === "balance_update"`, blocking Continue with a clear message if any importable row's Debit is unreadable; **Opening Balance (`opening_credit`) is completely unchanged** -- still stages the full Closing Balance, exactly as before. Preview table gains Debit / Current PesoWise Balance / New PesoWise Balance columns for Balance Update imports. 12 new unit tests (76 total, all passing) including the task's own worked example (Debit 5,000, Closing 12,000 -> adds exactly 5,000) and a dedicated proof that a large Closing Balance (50,000) with the same Debit (5,000) still adds only 5,000. Verified read-only against the owner's real file `fms aug GrpSum 28-09-2026.xlsx` (never committed): confirmed columns A=Particulars/B=Opening/C=Debit/D=Credit/E=Closing exactly as specified, 33 employee rows, 0 unreadable Debit cells, sheet reconciles (signed total −140,510 matches Grand Total exactly) -- and the real, dramatic scale of the bug: the OLD code would have added a net **−₹140,510** across this one file's rows, where the CORRECT total is **+₹34,772** (sum of real Debit amounts only). Branch `hotfix/date-lock-and-tally-debit`, not yet merged to `main`. |
