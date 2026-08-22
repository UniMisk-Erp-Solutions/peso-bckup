# Server-side report generation (all four Reports tabs)

**Doc ID:** DOC-104 / DOC-105
**Status:** deployed (backup instance) — not yet applied to Production
**Last updated:** 2026-08-22
**Owner / area:** Reports, Supabase Edge Functions, Storage

---

## 1) Summary

All four Reports tabs now generate their file **on the server**. Clicking
Generate enqueues a job; a Deno edge worker builds the whole CSV, writes it to
the private `generated-reports` bucket, and the UI shows a **Download CSV**
button. The browser never assembles a report, never holds one in memory, and
never serialises a file — the download streams from Storage to disk via a
short-lived signed URL.

- **DOC-104** — the Daily Project Report worker (the piece DOC-102 never shipped).
- **DOC-105** — Claim Verification, Claim Approval and Detailed Expense.

---

## 2) Problem / requirement

Every report was built client-side. The tab pulled every matching row, kept the
whole result in memory to render a preview table, then serialised the file in
the browser. Two consequences:

1. **Load.** On the live dataset that is 4,290 rows (Daily) and 10,457 rows
   (Approval / Detailed) pulled into a tab that only needed to produce a file.
2. **Silent truncation.** The list endpoints capped at 1,000 rows, so
   Claim Approval and Detailed Expense had been exporting ~10% of the data with
   no error shown. Daily showed 434 of 4,290 for the same class of reason.

DOC-102 had already built the entire job schema — `report_export_jobs`, the
create/claim/heartbeat/complete/fail/recover/cancel lifecycle, and the
`generated-reports` bucket — but no worker was ever written, so every enqueued
job sat at `queued` and the feature stayed dormant.

---

## 3) Solution

### Worker

`supabase/functions/run-report-export-job/` claims a job, pages the rows
server-side, builds the CSV, uploads it, and completes the job. It reads data
without a user session through the seam DOC-102 left: the caller-facing RPCs are
thin `auth.uid()` wrappers around row producers granted to `service_role` alone.
Authorization happens once, when a permitted user creates the job.

Guarantees carried over from the proven browser coordinator rather than
reinvented:

| Guarantee | Why |
|---|---|
| Completeness invariant | refuses to write a file if assembled rows ≠ `total_count` |
| Snapshot pinning | a long export cannot mix pre- and post-write states |
| `schema_version` check | fails on an unknown contract instead of guessing |
| Output parity | direct ports of `finalizeDailyReportGroups`, the balance walks, custom-key ordering and INR/date formatting |
| UTF-8 BOM | Excel renders Hindi/Gujarati names instead of mojibake |
| RFC 4180 escaping | a comma or newline in a project name cannot shift columns |
| Heartbeats + soft deadline | a timed-out job stays re-claimable, not stuck |

### Column parity

Server files reproduce the client's columns exactly. Where the client used a
translated header, the **English** string is used deliberately: an export is
data, and a file whose columns move with a UI language setting cannot be diffed
or scripted against.

Balance columns are ports of the two distinct walks:

- **Verification** — claims not yet deducted, so the walk starts at
  `balance + total` and steps **down**.
- **Approval** — already reflected in the balance, so the walk runs **backward**
  from it.
- **Detailed (one employee)** — allocations as credits and expenses as debits,
  merged, date-ordered, walked backward from the present wallet balance. With
  *All employees* there is no single wallet, so it degrades to a flat list —
  the same split the UI makes via `showDetailedBalanceColumns`.

### Frontend

`ServerReportExportPanel` handles all four: Generate → progress → Download.
The four browser-paging queries are disabled (`enabled: false && …`) so opening
a tab does no work. The query definitions remain so their code paths and tests
stay intact.

Behaviour worth knowing:
- the worker nudge is best-effort — a failed invoke leaves the job `queued` and
  claimable, so a lost nudge is not a lost report;
- a completed job is restored on mount, so a reload does not regenerate
  something already sitting in Storage;
- the enqueue RPCs dedupe an identical request that is still queued/running;
- polling gives up after 10 minutes with an honest message; the server job
  continues regardless.

---

## 4) Key files touched

| File | Role |
|---|---|
| `supabase/functions/run-report-export-job/index.ts` | worker: claim → page → build → upload → complete |
| `supabase/functions/run-report-export-job/expenseReports.ts` | CSV builders + balance walks for the three expense reports |
| `src/lib/reportExportJobs.ts` | enqueue / trigger / poll / signed download |
| `src/components/ServerReportExportPanel.tsx` | Generate → progress → Download UI |
| `src/pages/Reports.tsx` | panels replace the client-side buttons; four queries disabled |

---

## 5) Database / migrations

`20260822120000_server_side_expense_reports.sql` — **user runs SQL manually.**

- widens `report_export_jobs_report_type_check` to the three new types;
- `report_expense_rows_v1` — keyset-paged expense rows with submitter, batch and
  resolved custom fields (`service_role` only);
- `report_expense_allocations_v1` — cash transfers for the Detailed ledger;
- `_report_expense_custom_fields_v1` / `_report_humanize_field_key_v1` — label
  resolution matching the client;
- `create_expense_report_export_job_v1` — caller-facing enqueue, refuses anyone
  who may not view reports.

Keyset pagination, not `OFFSET` — these reports are exactly where the silent
1,000-row cap bit, and a cursor cannot silently truncate.

> **After applying, reload PostgREST's schema cache** (`NOTIFY pgrst, 'reload
> schema'` or restart the rest container). Without it the worker fails with
> *"Could not find the function … in the schema cache"*.

Prerequisite already applied on the backup instance: DOC-103's
`20260821_generated_reports.sql`.

---

## 6) Test plan

Verified end-to-end on the backup instance against the live dataset:

| Report | Rows | Pages | Bytes | CSV records |
|---|---|---|---|---|
| Daily Project | 4,290 | 18 | 555,721 | 4,291 = 1 + 4,290 ✅ |
| Claim Verification | 625 | 3 | 218,062 | 626 = 1 + 625 ✅ |
| Claim Approval | 10,457 | 42 | 3,537,254 | 10,458 = 1 + 10,457 ✅ |
| Detailed Expense | 10,457 | 42 | 2,207,778 | 10,458 = 1 + 10,457 ✅ |

Record counts were verified **quote-aware** — `wc -l` over-counts because
correctly-quoted fields contain newlines, which is itself evidence the RFC 4180
escaping works.

Pagination proved complete and non-duplicating by draining the full set:
**21 pages, 10,457 collected, 10,457 distinct**, matching `total_count` exactly.

Also verified: `deno check` exit 0; `npm run build` exit 0 with all markers
present in the emitted bundle; the failure path returns a job to `queued` at
attempt 1/3 rather than losing it.

**Manual check after deploying to Production:** open each tab, click Generate,
confirm the row count matches the database and the downloaded CSV opens in Excel
with correct column headers and readable names.

---

## 7) Known gaps

- **Not applied to Production.** Backup instance only.
- **xlsx/pdf/json exports were dropped** from these tabs; the server path emits
  CSV. The `format` column already allows `xlsx` if that is wanted later.
- **The preview tables are gone** from all four tabs — deliberate, since
  rendering them is exactly the browser work being removed.
- `src/integrations/supabase/types.ts` is stale and predates these objects; both
  new libs reach them through one narrow, commented cast. Regenerating it is a
  separate change.

---

## Revision log

| Date | Change | By |
|---|---|---|
| 2026-08-22 | DOC-104 worker + DOC-105 three expense reports; migration applied and proven on the backup instance; all 14 edge functions deployed to Coolify | Claude |
