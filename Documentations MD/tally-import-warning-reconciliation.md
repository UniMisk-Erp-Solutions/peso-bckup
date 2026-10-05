# Tally Import — Warning Model & Reconciliation Redesign

**Doc ID:** DOC-113
**Status:** in progress
**Last updated:** 2026-09-01
**Owner / area:** Balances, Historical Balance Anchors V2, Supabase (Production, `evo3o0fdjaroxq7uohrm21cp`)

---

## 1) Summary

The Tally Group Summary import wizard treated every employee-identity problem
(unknown Employee ID, name mismatch, unparseable Particulars) as a fatal,
blocking error, and its reconciliation total silently excluded any row whose
identity could not be parsed — even though the row's financial amount was
perfectly readable. Against the owner's real `service july.xlsx` file, one
row ("Kairavi Bhatt - Trainee", no numeric Employee ID) carried a real
₹15,903.00 Cr balance that vanished from the parsed total, producing the
observed mismatch (Parsed total ₹3,493.00 vs Grand Total -₹12,410.00,
difference ₹15,903.00) and blocking Continue entirely. Separately, the
"Preview only — Historical Balance backend has not been installed yet"
banner was investigated: the schema is fully installed and `ready: true`
server-wide, but the `historical_balance_v2` organization feature flag was
never enabled for `MicroLink` (the file's actual organization) — a
found-but-not-fixed product decision, plus a real, independently-confirmed
frontend capability-cache bug that could cause the same symptom to persist
after the backend *does* become ready.

---

## 2) Problem / requirement

1. Identity problems (unknown employee, name mismatch, unparseable
   Particulars) must become non-blocking warnings, not fatal errors.
2. The reconciliation total must never depend on whether a row's identity
   resolved — only on whether its financial amount could be read.
3. Only importable rows (matched + name-mismatch) may ever be staged;
   unknown/unidentified rows must never reach `balance_import_rows`.
4. The ₹15,903 discrepancy needed an exact, proven root cause — not a guess.
5. The Historical Balance V2 "Preview only" banner needed investigation
   against live Production state, not an assumption.

---

## 3) Root cause (proven against the real file)

`parseTallyGroupSummaryWorkbook` treated identity parsing and amount parsing
as one combined step: if `parseTallyParticulars` failed, the row was pushed
into a generic `failures` list and its amount was **never added** to
`parsedClosingTotal` — conflating "can we read this row's identity" with
"does this row's amount count toward the sheet total."

Cell-level forensics on the real `service july.xlsx` (never committed;
read-only, local-only inspection) confirmed:
- Row 49, "Kairavi Bhatt - Trainee": Closing Balance cell `v=15903`,
  `w="15903.00 Cr"` — a real, fully-readable Cr balance, but
  `parseTallyParticulars` fails (no numeric ID after a hyphen).
- 65 real data rows total: 15 Cr / 11 Dr / 38 blank-Zero + this one
  unidentifiable row — exactly matching the owner's reported 64 (identified)
  + the one failure.
- Grand Total cell: `-12,410.00` (all 65 rows, including Kairavi Bhatt's).
- Old buggy total (64 identified rows only) = `-12,410.00 - (-15,903.00) =
  +3,493.00` — exactly the reported "Parsed total ₹3,493.00", and the
  difference is exactly ₹15,903.00.

Employee ID 4114 ("Sharanabasappa") has a blank Closing Balance cell — one
of the 38 legitimate zero-balance rows (Tally's own convention for a
zero account), not a parsing defect. Employee ID 3673's Tally Particulars
("Shailesh Barot Late. Punjiram") differs from PesoWise's recorded name
("Shaileshkumar Barot") for the same Employee ID — a name mismatch, already
correctly non-blocking even before this fix, just not labeled as a warning.

A live SQL cross-check (read-only, Production) confirmed this file belongs
to **MicroLink**, not the org it was first tested against: 61 of 64
identified Employee IDs resolve to real MicroLink profiles (30 exact name
matches, 31 name mismatches — mostly a Tally "Surname First" vs PesoWise
"First Last" convention difference), 3 unknown (including 4114).

---

## 4) Solution

### Parser (`src/lib/tallyBalanceImport.ts`)

Identity and amount are now parsed **independently** per row:

- `rows: TallyBalanceRow[]` — identity AND amount both readable.
- `unidentifiedRows: TallyUnidentifiedRow[]` (new) — amount readable, no
  extractable Employee ID. Its amount **still counts** toward
  `sheetFinancialTotal`; the row can never be staged.
- `amountFailures: TallyAmountFailure[]` (new) — the Closing Balance cell
  itself is unreadable, regardless of identity. **Never** counted in any
  total (never silently coerced to ₹0); this is the one case that can leave
  a genuine, unexplained sheet-level gap.
- `sheetFinancialTotal` (renamed from `parsedClosingTotal`) = SUM of `rows` +
  `unidentifiedRows` — deliberately identity-independent.
- `reportGrandTotal` / `sheetReconciliationDifference` (renamed from
  `reportClosingTotal` / `reconciliationDifference`).
- `reconciles()` now fails whenever `amountFailures.length > 0`, in addition
  to the existing Grand-Total-presence and tolerance checks.

New pure helper `computeTallyReconciliation(result, employeesById)` resolves
every identified row against known PesoWise employees (Employee ID is
always authoritative; no fuzzy/name-based matching) and returns the
importable/skipped split: `importableRows`, `unknownEmployeeRows`,
`matchedCount`, `nameMismatchCount`, `unknownEmployeeCount`,
`identityFailureCount`, `amountFailureCount`, `importableTotal`,
`skippedKnownTotal`, and `importSumMatchesSheetTotal` (proof that
importable + skipped-known accounts for the entire sheet total).

### UI (`src/components/balances/ImportBalancesDialog.tsx`)

- Reconciliation panel now shows Tally Grand Total, all-rows total,
  Importable, and Skipped separately, with "N rows will be skipped. The
  complete Tally report still reconciles." — never "FAILED" merely because
  rows are skipped.
- Amber `WARNING — WILL IMPORT` (name mismatch) and `WARNING — WILL SKIP`
  (unknown employee) badges replace the old destructive/fatal red styling.
  A distinct amber block lists unidentifiable rows ("This row could not be
  matched to an employee and will be skipped.").
- A genuine amount-read failure still renders as a red, fatal block —
  identity problems never do.
- Continue is enabled once the sheet reconciles and at least one importable
  row exists; unknown employees, name mismatches, and identity failures
  never block it.
- `handleContinueToPreviewTally` stages **only** `importableRows` — unknown
  employees and unidentified rows never reach `insertImportRows` /
  `balance_import_rows`. No placeholder ID, no name-based fallback, no
  employee is ever created.

### Frontend capability cache (`src/lib/balanceHistoricalV2Capability.ts`)

Caching is now asymmetric: a definitive `ready: true` is cached for the
tab's lifetime (unchanged); a `ready: false` (for any reason — RPC error,
malformed response, or a real "not ready") is cached for only 60 seconds
(`NEGATIVE_CACHE_TTL_MS`), so a tab that probed before the backend became
ready self-heals shortly afterward without a manual reload, while still
avoiding a request storm within the window.

---

## 5) Historical Balance V2 backend — investigation result

Live, read-only Production inspection confirmed:
- `balance_historical_v2_capabilities_v1()` returns `ready: true` with all 9
  functions present — the schema is fully installed, server-wide.
- `MicroLink` (`6709c1fe-e8c8-404d-bc68-d1edda923344`) has **zero rows** in
  `organization_features` for `historical_balance_v2` — the flag defaults to
  disabled. This, not a stuck cache, is the actual reason this org's banner
  shows "Preview only".
- No schema/migration change was needed or applied. The org-level flag was
  deliberately **not** enabled here — granting a specific customer access to
  a capability is a product decision, not a backend-readiness fix, and was
  outside this task's scope.

---

## 6) Key files

```
src/lib/tallyBalanceImport.ts
src/lib/__tests__/tallyBalanceImport.test.ts
src/lib/balanceHistoricalV2Capability.ts
src/lib/__tests__/balanceHistoricalV2Capability.test.ts
src/components/balances/ImportBalancesDialog.tsx
src/components/balances/__tests__/ImportBalancesDialogTally.test.tsx
```

No database migrations — this is a frontend-only fix. No Production data
was modified; all SQL run against Production for this task was read-only.

---

## 7) Test plan

- [x] 64 new/updated unit tests in `tallyBalanceImport.test.ts`, including an
      exact reproduction of the ₹15,903 production scenario and a Phase-16
      regression fixture matching the observed 64-row/15-Cr/11-Dr/38-Zero shape.
- [x] 15 component-level tests in `ImportBalancesDialogTally.test.tsx`
      covering warning badges, Continue gating, and staged-row content.
- [x] 4 capability-cache tests including TTL-based self-healing under fake timers.
- [x] The real `service july.xlsx` run through the fixed parser via
      `vite-node` (never committed): `sheetFinancialTotal` now matches
      `reportGrandTotal` exactly (difference ₹0.00).
- [x] `tsc --noEmit`, `npm run build`, `git diff --check`,
      `migrations:check`, `security:secrets` all clean; full suite passes
      (one unrelated, pre-existing flaky test file passes on isolated rerun).
- [ ] Live browser QA against the real file: not completed — no login
      credentials were available for MicroLink (the file's actual
      organization) in this session, and credentials must never be
      guessed/fabricated. Automated coverage above substitutes for this.

---

## 8) Related docs

- [historical-balance-anchors-v2.md](./historical-balance-anchors-v2.md)
- [historical-balance-v2-phase1-production-activation.md](./historical-balance-v2-phase1-production-activation.md)
- [tally-group-summary-balance-import.md](./tally-group-summary-balance-import.md)

---

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-09-01 | 1.0 | Claude Code | Initial doc: root-caused the ₹15,903 mismatch exactly against the real file, redesigned the parser/reconciliation model to separate identity from financial parsing, replaced fatal identity errors with warnings, fixed a real frontend capability-cache bug, and found (but did not fix) MicroLink's disabled `historical_balance_v2` feature flag as the actual cause of its "Preview only" banner. |
