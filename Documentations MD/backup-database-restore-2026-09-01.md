# Backup instance — full database restore (2026-09-01)

**Doc ID:** DOC-116
**Status:** deployed — restore applied to the BACKUP instance and verified live. Production untouched.
**Last updated:** 2026-09-01
**Owner / area:** peso-bckup Supabase instance (192.168.23.46), cluster restore, storage parity

---

## 1) Summary

Reloaded the peso-bckup database (`peso-backup.vercel.app` →
`pesowise-backup-supabase.unimisk.com`, host `192.168.23.46`) from an
operator-supplied dump, `updated-peso-backup.sql` (244 MB, PostgreSQL 15.8
cluster dump). The backup instance now carries the Patidar Travels dataset
current to 2026-09-01.

**Production (`Pesowise-main`) was never contacted.** Every command in this work
targeted `192.168.23.46` and the containers `supabase-db-…` /
`supabase-edge-functions-…` on that host only.

## 2) Result

| Table | Before | After |
|---|---|---|
| `public.expenses` | 18,368 | **22,707** |
| `auth.users` | 792 | **794** |
| `public.profiles` | 486 | **488** |
| `public.attachments` | 12,830 | **14,297** |
| `storage.objects` | 16,967 | **19,953** |

Newest expense now `2026-09-01`. All 14 containers healthy afterwards;
`peso-backup.vercel.app` returns 200; PostgREST, Auth and Storage APIs all 200.

## 3) What went wrong the first time, and why

The first attempt ran `psql -U postgres` and **appeared to succeed** — exit 0
and an error count of zero. Both signals were false:

- The error count was zero because the check grepped `^ERROR`, but psql prefixes
  diagnostics with `psql:<file>:<line>: ERROR:`. Nothing ever matched. The run
  had **145 errors**.
- Exit 0 came from `psql` without `ON_ERROR_STOP`, which reports success as long
  as the file was read to the end.

The real cause: **`postgres` is not a superuser on Supabase — `supabase_admin`
is.** Every `DROP ROLE` failed ("reserved role"), and `DROP DATABASE postgres`
never happened, so the `postgres` database was not replaced at all. Only the
incidental `pesowise_report_perf_20260829` database was created.

It was caught by comparing the dump's own payload against the live table:
the dump's `postgres` section contains 22,707 `expenses` rows while the database
still reported 18,368. **Row-count parity against the source, not the exit code,
is what proves a restore.**

## 4) The restore that worked

Rather than replay the whole cluster dump, the `postgres` database section
(lines 416748–850487) was extracted and restored on its own as `supabase_admin`.
This deliberately avoided two hazards in the full cluster dump:

- it drops `_supabase` (91 MB, live analytics/Logflare) and **never recreates
  it** — a full replay would have broken the analytics container;
- it drops and recreates `template1`, which is unnecessary here.

Sequence: stop the 12 containers holding connections (db stays up) → create a
scratch maintenance database (the dump drops `postgres`, so the session cannot
be connected to it) → terminate remaining connections → restore as
`supabase_admin` → drop scratch → restart containers.

Result: 4 errors, all one benign ordering artifact
(`function graphql_public.graphql(...) does not exist` — GRANT/COMMENT emitted
before `pg_graphql` recreates the wrapper). The wrapper was recreated manually
and `graphql_public` now resolves.

## 5) Known limitation — receipt images

`storage.objects` was restored with **19,928 receipt records**, but the bucket
*bytes* were not copied (by explicit instruction — the bucket is too large).
The backup server's MinIO still holds the previous file set.

Verified directly: the oldest receipt records return **200**, the newest return
**400**. Roughly **1,608 receipt records created after the last bucket sync have
no bytes behind them** — about 8% of the bucket.

Everything else is unaffected: login, reports, RPCs, CSV export and the Remarks
column all work. Only those newer receipt images 404 in the UI. Closing the gap
requires syncing the bucket separately; nothing in the database can fix it.

## 6) Remarks column (DOC-115) after the restore

Preserved, and the underlying duplication is gone:

- `report_daily_project_rows_v1` retains **both** halves of the DOC-115 fix —
  `f.purpose` carried through the `enriched` CTE, and `'purpose'` emitted in
  `source_expenses`.
- `get_daily_project_report_page_v1` is now a **thin wrapper delegating to
  `report_daily_project_rows_v1`**, not a second implementation. The
  hand-maintained parity hazard recorded in DOC-115 §4 no longer applies to this
  pair — there is one implementation.
- The `run-report-export-job` worker still carries `row["Remarks"]` after the
  container restart (deployed by `docker cp`, which survives `docker start`).

A live RPC call returns populated `purpose` values on restored rows.

## 7) Rollback

A pre-restore snapshot was taken and is **deliberately retained** on the server:

```
/tmp/pre_restore_postgres.dump    22.6 MB  (custom format, postgres db)
/tmp/pre_globals.sql               5.1 KB  (cluster roles)
```

Plus the checksummed local backup from earlier the same day under
`.local-sensitive-data/db-backups/2026-09-01/`.

## 8) Git safety

`updated-peso-backup.sql` was found **untracked and not ignored in the repository
root** — a 244 MB dump of real employee and expense data one `git add -A` away
from being committed. It is now ignored (`/*.sql`, `updated-peso-backup.sql`,
`*-peso-backup.sql`). `git check-ignore` confirms; `security:secrets` is clean.
No dump file is committed by this change.

## 9) Leftover

`pesowise_report_perf_20260829` (209 MB) was created from the dump during the
first attempt. It is a perf-test database, not application data, and is safe to
drop if the space is wanted. Left in place rather than removed unasked.

## 10) Post-restore repair (same day) — "nothing showing on the frontend"

Reported symptom: the app loaded but displayed no data. Two separate causes,
one environmental and one real.

### 10a. The server was down

At the time of the report the backup host was unreachable: `ping 192.168.23.46`
returned *Destination host unreachable* from the gateway, SSH was refused, and
Cloudflare returned **530** (origin unreachable) for
`pesowise-backup-supabase.unimisk.com`. `peso-backup.vercel.app` still returned
200 because the frontend is static on Vercel — so the page rendered while every
query failed. That is exactly the "loads but empty" symptom. The host later came
back and all 14 containers returned healthy on their own; the restored data was
intact (794 users / 22,707 expenses / 488 profiles).

### 10b. Real defects found and fixed

**No planner statistics.** A freshly restored database has none until `ANALYZE`
runs — **115 of 115 public tables had zero statistics**, so the planner used
default estimates. `VACUUM ANALYZE` was run across the database. (This alone did
not fix the anon 3s timeout below, but it is required hygiene and was missing.)

**Schema/code version mismatch — the significant finding.** The dump came from a
*newer* codebase than the frontend deployed at `peso-backup.vercel.app` (which
builds from this repository). Comparing the pre-restore backup against the
restored database: **7 functions lost, 5 new**.

| Lost in restore | Status |
|---|---|
| `admin_submit_expense_for_employee_v1` | superseded by `_v2` upstream |
| `admin_bulk_submit_expenses_v1` | superseded by `_v2` upstream |
| `get_daily_report_project_name_ambiguity_v1` | superseded by `_batch_v2` upstream |
| `save_generated_report_v1` | **no replacement — feature removed upstream** |
| `list_generated_reports_v1` | **no replacement** |
| `get_generated_report_v1` | **no replacement** |
| `purge_expired_generated_report_snapshots_v1` | **no replacement** |

Six of the seven are called by code in `src/`, and none of the new `v2` names
appear anywhere in this repository — confirming the database moved forward and
the deployed frontend did not. The `generated_reports` **table itself was gone**,
so those functions could not simply be recreated.

Repaired without guessing at upstream semantics:

1. Re-applied this repository's own migration
   `20260823100000_generated_report_snapshots.sql` (idempotent), recreating
   `generated_reports` and `generated_report_runs` with their indexes, RLS
   policies and all four functions.
2. Restored `admin_submit_expense_for_employee_v1`,
   `admin_bulk_submit_expenses_v1` and
   `get_daily_report_project_name_ambiguity_v1` **verbatim** from the pre-restore
   backup. They coexist with the newer `v2` functions; nothing was replaced.
3. Recreated the `graphql_public.graphql` wrapper (the 4 restore errors in §4).

All 7 functions and both tables are present again, verified through the live
API as a real authenticated admin: `list_generated_reports_v1` → 200,
`get_daily_report_project_name_ambiguity_v1` → 200, `get_backend_health` → 200,
`admin_bulk_submit_expenses_v1` → its own validation error (i.e. it executes),
and `admin_submit_expense_for_employee_v1` present in PostgREST's live schema.
Expenses / profiles / organizations return 200 in 0.5–0.9 s for admins of all
five organizations.

### 10c. Verification-method notes

Two 404s and three "NOT exposed" results during this work were **test artifacts,
not defects**, and are recorded so they are not re-investigated:

- PostgREST matches RPCs *by signature*. Calling a function that takes arguments
  with `{}` returns `404 PGRST202`, which reads identically to "function
  missing". `list_my_teams_overview`, `list_manager_pending_expenses` and
  `get_cashier_for_engineer` all require arguments and were present throughout.
- The OpenAPI spec is generated **per role**. Fetched with the anon key it omits
  functions granted only to `authenticated`/`service_role` — which is why three
  working functions appeared "NOT exposed" while one of them had just returned
  a real 200.

### 10d. Still outstanding

- **Anon queries on `expenses` return 500 / 57014** (3 s `statement_timeout` for
  `anon`). Harmless in practice — a logged-out browser never queries expenses,
  and authenticated reads are 0.5–0.9 s — but the RLS policy set on `expenses`
  (20 policies, all `roles=public`, so they evaluate for `anon` too) is slow
  enough to exceed 3 s. Worth a policy review, not fixed here.
- **1,608 receipt images still 404** (§5) — unchanged, needs a bucket sync.
- The frontend remains one codebase version behind the database. The `v1`
  functions restored above are a compatibility bridge, not a substitute for
  eventually moving the frontend onto the `v2` API.

---

## Revision log

| Date | Notes |
|---|---|
| 2026-09-01 | Restore performed and verified. Documents the false-success first attempt (wrong grep pattern, missing `ON_ERROR_STOP`, `postgres` not being a superuser), the row-count parity check that caught it, the targeted section restore as `supabase_admin` that avoided dropping the live `_supabase` analytics database, the `graphql_public` repair, the 1,608 receipt records with no bytes behind them, DOC-115 survival plus the wrapper consolidation, retained rollback artifacts, and the gitignore fix for a 244 MB dump sitting committable in the repo root. |
| 2026-09-01 (post-restore repair) | Frontend showed no data. Root cause was twofold: the backup host was unreachable at the time (gateway said destination host unreachable, Cloudflare 530; the static Vercel page still returned 200, which is why it looked like an app bug), and separately the restore had left real defects. Fixed: ran VACUUM ANALYZE (115 of 115 tables had zero planner statistics after the restore), recreated the graphql_public wrapper, and repaired a genuine schema/code version mismatch — the dump came from a newer codebase, dropping 7 functions and the generated_reports table that the deployed frontend still calls. Recreated the tables and 4 functions from this repo's own idempotent migration 20260823100000, and restored 3 admin/ambiguity v1 functions verbatim from the pre-restore backup, alongside the newer v2 ones. All verified live per-organization. Also recorded two verification traps that produced false 'missing function' readings: PostgREST matches RPCs by signature (a no-arg call to an arg-taking function returns 404 PGRST202), and its OpenAPI spec is per-role (anon-key fetches omit authenticated-only functions). |
