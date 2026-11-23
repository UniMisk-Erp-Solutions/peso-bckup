# Phase 5.2 — Report button + report isolation verification

**Status:** **PASS** (audit + automated tests; no connector / no Tally I/O)  
**Date:** 2026-10-06

---

## Hard invariant

**ONE `Sync to Tally` click = ONE `report_type` = ONE independently scoped `tally_sync_jobs` row.**

Cross-report accounting dedupe (same expense in CV + CA + Detailed) happens **inside mapping** only. It must **never** enqueue multiple report types from one button click.

---

## UI mapping (Admin Reports)

| Admin report tab | `report_type` | Component |
|------------------|---------------|-----------|
| Claim Verification List | `claim_verification` | `ServerReportExportPanel` in `Reports.tsx` (`TabsContent value="verification"`) |
| Claim Approval List | `claim_approval` | `ServerReportExportPanel` (`TabsContent value="approval"`) |
| Detailed Expense Report | `detailed_expense` | `ServerReportExportPanel` (`TabsContent value="detailed"`) |
| Daily Project Report | `daily_project_report` | `ServerReportExportPanel` (`TabsContent value="daily"`, **no** `reportType` prop → panel default) |

Buttons sit in the same **Report actions** card as **Generate report**:

```text
[ Generate report ] [ Sync to Tally ]
```

`enableTallySync={userRole === "admin" && !teamScoped}` — hidden for non-admin and team-scoped Reports.

---

## Filter freeze

- `syncToTally()` calls `buildTallySyncParameters()` with the **same filter props** as generation (employee, category, engineer/HO status, dates, custom fields, Detailed year/month/week).
- **Preview-only** state (`previewPage`, `columnFilters`, sort) is **not** sent to Tally sync.
- Claim Verification / Approval inherit **inherent** report semantics (no date range on tab — `dateFrom`/`dateTo` null by design).
- Detailed / Daily use existing canonical date semantics (`detailedExpenseDateRange`, daily all-time vs custom range).

---

## Pagination independence

- Browser preview uses `PREVIEW_PAGE_SIZE = 50` in `ServerReportExportPanel` only.
- Tally preparation worker pages server RPCs (`EXPENSE_PAGE` / `DETAILED_PAGE` / `DAILY_PAGE`) until `has_more` is false — **not** limited by UI page.

---

## Admin enforcement

| Layer | Mechanism |
|-------|-----------|
| Frontend | `enableTallySync` false unless `userRole === "admin" && !teamScoped` |
| Backend | `create_tally_sync_job_v1` → `tally_sync_admin_can_view_v1` or **42501** |
| Edge | `start-tally-sync` → RPC with user JWT; **403** on not permitted |

Generate Report permissions unchanged.

---

## Quiet UI after sync

Allowed: brief loading, **“Sync started.”**, generic failure if create fails.  
Not shown: job IDs, batch IDs, queued/prepared/waiting_for_connector, row counts, connector errors, sync history.

Browser does not poll Tally job status (Phase 3.6).

---

## Gates (unchanged from Phase 5.1)

| Gate | Status |
|------|--------|
| Metadata ledger serializer | IMPLEMENTED / tests PASS |
| Connector E2E delivery | **NOT VALIDATED** |
| Phase 6 TDL | **NOT STARTED** |
| Pending smoke batches (~7) | **NOT delivered** — left isolated |

---

## Tests

- `src/lib/__tests__/tallySyncReportIsolationPhase52.test.ts`
- `src/lib/__tests__/tallySyncParameters.test.ts`
- `src/lib/__tests__/tallySyncMigration.test.ts`
- `src/components/__tests__/ServerReportExportPanel.test.tsx` (Phase 5.2 block)
- `src/pages/__tests__/reportsServerSideGeneration.test.ts`

---

## Files (this phase)

Documentation only unless a future bug fix is required — implementation was already correct at audit time.
