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

---

## Revision log

| Date | Notes |
|---|---|
| 2026-09-01 | Restore performed and verified. Documents the false-success first attempt (wrong grep pattern, missing `ON_ERROR_STOP`, `postgres` not being a superuser), the row-count parity check that caught it, the targeted section restore as `supabase_admin` that avoided dropping the live `_supabase` analytics database, the `graphql_public` repair, the 1,608 receipt records with no bytes behind them, DOC-115 survival plus the wrapper consolidation, retained rollback artifacts, and the gitignore fix for a 244 MB dump sitting committable in the repo root. |
