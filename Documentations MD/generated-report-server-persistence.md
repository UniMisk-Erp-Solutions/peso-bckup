# DOC-139 — Generated Report Server-Side Persistence

**Doc ID:** DOC-139 (formerly DOC-103) (renumbered on the 2026-10-05 upstream sync — see DOC-143; the pre-sync `peso-bckup` index gave this a different ID than upstream's independently-numbered catalog)

**Last updated:** 2026-08-21
**Status:** draft — code complete, migration NOT applied
**Branch:** local working tree (not merged, not deployed)

---

## Summary

Every generated report is now written to the database. Previously a report existed
only in the browser's React Query cache: closing the tab destroyed it, and there was
no record it had ever been produced. A new **Saved reports** panel on the Reports
page lists stored snapshots and reopens them without re-running the query.

Also fixed in the same pass: the Reports page re-ran every report on every tab
switch and every window focus.

---

## Problem / requirement

Owner requirement, verbatim: *"make sure each and every generated report stores in DB
backend and nothing stores in client/browser side"*, plus *"every time I switch tabs
so it loading reports every single time"*.

Two separate defects and one clarification:

1. **No server-side record of any generated report.** Nothing in `Reports.tsx`,
   `dailyProjectReportPaging.ts` or `buildDailyProjectExpenseReport.ts` persisted
   anything. For a finance system whose exports drive reimbursement, that is a
   missing audit trail — there was no way to answer "what did this report say on
   the day it was run?"

2. **Refetch storm on tab switch.** `App.tsx` disables focus refetching globally
   ("Don't re-hit the API just because the user switched tabs and came back").
   `Reports.tsx` overrode all three settings back to aggressive
   (`staleTime: 0`, `refetchOnMount: "always"`, `refetchOnWindowFocus: true`), so
   every switch between the four report tabs re-ran the entire pipeline — on
   Production that is ~4,141 rows paged 250 at a time, ~17 round trips per switch.

3. **Clarification on "nothing on the client".** Reports already persisted nothing
   in the browser — no `localStorage`, `sessionStorage` or IndexedDB anywhere in the
   report path (verified by grep). Rows do occupy browser *memory* while displayed,
   which is unavoidable for a rendered table. The requirement is therefore
   implemented as: **nothing persisted client-side, server holds the record of truth.**

---

## Solution

### Storage model — Option A (owner-selected): full snapshot + dedupe + retention

Two tables, deliberately split:

| Table | Grain | Weight |
|---|---|---|
| `generated_reports` | one row per **distinct report content** | heavy (`payload` jsonb) |
| `generated_report_runs` | one row per **generate click** | light |

Every generation is logged in `generated_report_runs`, so "each and every generated
report is stored" holds literally. Regenerating the same filters over unchanged data
reuses the existing snapshot (matched on `content_hash`) instead of writing a second
multi-megabyte copy, and bumps `generation_count` + renews `expires_at`.

**Why dedupe is not optional.** Production MicroLink produces ~4,141 report rows
(~2 MB as jsonb) per generation. The whole database is 151 MB with
`shared_buffers = 160 MB` on a host already using 5 GB of swap. An undeduped design
would push the working set out of cache within weeks.

### Content hashing

SHA-256 over a **canonicalised** payload (object keys sorted at every depth), so two
structurally equal payloads always hash identically — a key-order difference would
otherwise defeat dedupe and silently double storage. Falls back to a widened
composite FNV digest only where `crypto.subtle` is unavailable; that fallback is a
dedupe key, never a security boundary.

### Failure posture

`saveGeneratedReport` never throws into the render path. A storage failure logs and
returns `null`; the report the user is already looking at is not discarded and does
not appear to have failed.

### Tab-switch fix

`QUERY_DEFAULTS` in `Reports.tsx` now matches the global policy:
`staleTime: 5 min`, `refetchOnMount: false`, `refetchOnWindowFocus: false`,
`refetchOnReconnect: false`. Freshness is preserved by the existing realtime
subscription (invalidates on any `expenses` change, 1 s debounce) and each tab's
explicit Generate/refresh control. `placeholderData: keepPreviousData` is retained
so refreshes never blank the table (DOC-054's actual requirement).

---

## ⚠️ Overlap with DOC-102 — must be resolved before merge

`report_export_jobs` **already exists in the Production database**, applied from
`feature/daily-project-report-export-jobs` (DOC-102), which was never merged. Its
migration, document and frontend are absent from this tree; nothing references it.

It is a more complete design for large exports — `dedupe_key`, `storage_path` /
`filename` / `file_size_bytes` (file written to Storage rather than jsonb in
Postgres), `status` / progress, `attempt_count` / `max_attempts`, `worker_id` /
`worker_heartbeat_at`, `cancel_requested_at`, `superseded_by`, `expires_at` — but it
is **dormant**: there is no worker to claim and process jobs.

The two approaches differ in kind:

| | DOC-102 `report_export_jobs` | DOC-103 (this) |
|---|---|---|
| Model | async job → worker → **file in Storage** | synchronous → **snapshot rows in Postgres** |
| Needs a worker | **yes** (does not exist) | no |
| Works today | no | yes |
| Storage cost | MinIO (5 GB, built for blobs) | Postgres jsonb (151 MB DB) |
| Suits | large exports / downloads | audit + reopen what was viewed |

**Recommendation:** ship DOC-103 to satisfy the immediate requirement, then decide
whether to consolidate onto DOC-102's substrate once a worker exists. Do not run
both as competing report stores.

---

## Key files touched

| File | Change |
|---|---|
| `src/pages/Reports.tsx` | `QUERY_DEFAULTS` refetch policy fixed; save wired into the daily `queryFn`; `SavedReportsPanel` mounted; `lastSavedReportId` state |
| `src/lib/generatedReportStore.ts` | **new** — canonical hashing, save/list/load RPC wrappers, size formatting |
| `src/components/SavedReportsPanel.tsx` | **new** — Saved reports list with open/refresh |

---

## Database / migrations

**The owner runs SQL manually. Neither file below has been applied.**

| File | Purpose |
|---|---|
| `20260823100000_generated_report_snapshots.sql` | tables, indexes, RLS, 4 RPCs, grants |
| `supabase/rollbacks/20260823100000_generated_report_snapshots_rollback.sql` | full teardown (destructive) |

Additive only — no existing table, function, policy or index is altered. Every
`SECURITY DEFINER` function pins `search_path` (audit finding A2) and `anon` is
explicitly revoked from all four routines (audit finding A1's failure mode).

**Retention is opt-in.** `purge_expired_generated_report_snapshots_v1()` exists but
is not scheduled. To enable, run once:

```sql
SELECT cron.schedule('purge-generated-reports', '17 3 * * *',
                     $$SELECT public.purge_expired_generated_report_snapshots_v1()$$);
```

---

## Test plan

1. Apply the migration. Confirm both tables report `rowsecurity = true` and `anon`
   holds zero grants on either table or any of the four routines.
2. Generate a Daily Project Report → a row appears in `generated_reports`, a row in
   `generated_report_runs`, and the Saved reports panel lists it.
3. Click Generate again with identical filters → **no new** `generated_reports` row;
   `generation_count` increments; a **second** `generated_report_runs` row is written.
4. Change the employee filter → a new snapshot row is created.
5. Open a saved snapshot → payload returns and matches the original row count.
6. Sign in as a `cashier` (not in the permitted role list) → `save_generated_report_v1`
   raises `42501`.
7. Call any of the four RPCs with the anon key → rejected.
8. **Tab-switch regression:** open Reports, switch between all four tabs repeatedly,
   confirm via devtools Network that no report request is re-issued within the
   5-minute stale window; alt-tab away and back and confirm the same.
9. Approve an expense elsewhere → realtime invalidation still refreshes the report.

**Not yet verified:** `npm install` has never been run in this tree, so the build and
test suite could not be executed. Typecheck, lint and tests must pass before merge.

---

## Revision log

| Date | Rev | Change | By |
|---|---|---|---|
| 2026-08-21 | 1.0 | Initial. Tab-switch refetch storm fixed. Server-side snapshot persistence implemented (Option A). DOC-102 overlap discovered mid-implementation and documented; ID corrected from DOC-102 to DOC-103. Migration authored, not applied. | Agent |
