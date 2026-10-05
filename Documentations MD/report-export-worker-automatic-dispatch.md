# Report Export Worker — Automatic Dispatch

**Doc ID:** DOC-111
**Status:** deployed
**Last updated:** 2026-08-29
**Owner / area:** Reports, Supabase Edge Functions, Production infrastructure (`evo3o0fdjaroxq7uohrm21cp`)

---

## 1) Summary

Closes the last gap in server-side report generation: `run-report-export-job`
was deployed and fully working (DOC-110), but jobs required a manual SSH/curl
invocation to actually run. The dispatch mechanism the frontend already
expected turned out to already exist and be correctly wired
(`triggerExportWorker()` in `src/lib/reportExportJobs.ts`, called from
`ServerReportExportPanel.tsx` immediately after every enqueue) — it just had
no backstop for the case its own code comment already anticipated: a failed
nudge leaves a job `queued` with nothing to pick it up. A small host-level
cron backstop closes that gap, and a second, unrelated but directly relevant
gap was found and closed in the same pass: `recover_stale_report_export_jobs_v1`
existed in the schema since DOC-106 but was never called from anywhere, so a
job whose worker died mid-run would have stayed `running` forever.

---

## 2) Problem / requirement

Normal users must never need SSH or a manual `curl` to make a generated
report actually run. The existing architecture already handles the common
case (see §3) but had two silent failure modes with no automatic recovery:
a failed dispatch nudge, and a worker that dies mid-processing without
reaching `complete`/`fail`.

---

## 3) Solution

**Primary dispatch (already existed, unmodified):** `generate()` in
`ServerReportExportPanel.tsx` calls `enqueue*ReportExport()`, then
immediately calls `triggerExportWorker()`, which does
`supabase.functions.invoke("run-report-export-job", { body: {} })` using the
requesting user's own authenticated session (never a service_role key in the
browser). The Edge Function accepts either the service_role key or any valid
user JWT (`index.ts`'s own auth check). The UI then polls the job row
(`fetchExportJob`) to observe `queued → running → completed`, so the browser
never waits synchronously for the whole report.

**Backstop dispatch (new):** a host-level cron job on the Production host
(`webadmin`'s own crontab, `*/2 * * * *`) runs
`/home/webadmin/report-worker-dispatch.sh`, which calls the same Edge
Function using the service_role key read fresh from the edge-functions
container's own environment at invocation time (no secret duplicated or
stored anywhere new). This exists **only** to catch the case
`triggerExportWorker()`'s own comment already documents: "if this fails the
job stays queued and any later invocation... still picks it up" — the cron
tick is that later invocation, so a job is never permanently stuck without
developer intervention, even in the worst case (tab closed immediately after
enqueue, network failure on the nudge, etc.).

**Stale-job recovery (new — wired up, not invented):**
`recover_stale_report_export_jobs_v1(p_stale_after interval DEFAULT 5
minutes)` already existed (`20260827150000_report_export_jobs.sql`) and was
already correct — requeue if attempts remain, `failed` with `worker_lost`
once exhausted — but was never called. `run-report-export-job/index.ts` now
calls it (best-effort, never blocks the request's own claim attempt) at the
start of every invocation, so both the frontend's nudge and the cron
backstop also sweep stale jobs on the same cadence, with no separate
schedule needed.

**Why not `pg_cron`:** `pg_cron`'s background launcher process is running
(it's in `shared_preload_libraries`), but the extension itself is not
installed (`CREATE EXTENSION`) in the `postgres` database, and installing it
purely for this would be a larger, more consequential change than a host
crontab entry for a stack that already uses host-level cron for its own
backup script (`/etc/cron.d/supabase-backup`). No new Postgres extension,
secret storage, or database object was needed.

---

## 4) Key files

```
supabase/functions/run-report-export-job/index.ts   (+ recover_stale_report_export_jobs_v1 call)
/home/webadmin/report-worker-dispatch.sh             (Production host only, not in this repo)
webadmin's crontab on 192.168.0.18                   (*/2 * * * *, not in this repo)
```

`src/lib/reportExportJobs.ts` and `src/components/ServerReportExportPanel.tsx`
were read and confirmed already correct — **not modified**.

---

## 5) Database / migrations

No new migration. `recover_stale_report_export_jobs_v1` already existed and
was already correctly granted (`service_role` only, confirmed
`anon`/`authenticated` both denied) — this task only added a caller.

---

## 6) Authentication / security model

- The cron backstop authenticates as `service_role`, exactly as a
  server-side scheduler should — the key is read fresh from the
  edge-functions container's own environment at each invocation, never
  written to a new file, the crontab entry, or any log.
- No new grants were added to any RPC. `claim/heartbeat/complete/fail/recover_stale_report_export_job_v1`
  all remain `service_role`-only (verified via `has_function_privilege`).
- No webhook or publicly reachable endpoint was created — the cron script
  reaches the Edge Function over the Docker network internal to the
  `evo3o0fdjaroxq7uohrm21cp` stack only (`--network container:supabase-edge-functions-evo3o0fdjaroxq7uohrm21cp`),
  the same path a `docker exec`-based operator call would use; it is not
  reachable from outside the host.
- Cross-org isolation is unchanged: the worker still processes one job at a
  time, scoped to that job's own `organization_id`; the claim RPC's
  per-organization concurrency cap (`p_max_per_org`) prevents one tenant
  from starving another regardless of which caller (frontend nudge or cron)
  triggered the invocation.

---

## 7) Concurrency behavior

`claim_report_export_job_v1` uses `FOR UPDATE SKIP LOCKED` with a
per-organization running-job cap — this was already correct and is
unchanged. Verified: two real concurrent-style invocations (the frontend
pattern and the cron backstop can both fire around the same moment) claim
different jobs or one gets `{"claimed": false}`; never the same job twice.
Confirmed live by draining 4 real jobs (one per organization/report-type)
through the cron backstop alone, each completing with a distinct
`worker_id` and no duplicate `storage_path`.

---

## 8) Retry / failure behavior

- A worker that calls `fail_report_export_job_v1` with `p_retryable=true`
  (the worker's default on a caught exception) requeues the job if
  `attempt_count < max_attempts` (3), otherwise marks it `failed` with a
  sanitized message.
- A worker that dies without calling `fail`/`complete` at all (crash,
  platform kill, network partition) leaves the job `running` with a stale
  `worker_heartbeat_at`; `recover_stale_report_export_jobs_v1` (now called
  on every invocation) requeues it if attempts remain, or marks it `failed`
  with `error_code = 'worker_lost'` once exhausted.
- Both paths verified via a `BEGIN ... ROLLBACK`-wrapped synthetic test
  (never touching real data): a simulated 10-minutes-stale `running` job
  with 1 of 3 attempts used was correctly requeued; the same job with all 3
  attempts used was correctly marked `failed` / `worker_lost`.

---

## 9) Idle / load behavior

Measured on Production:
- Idle (queue empty): edge-functions container ≈0.01% CPU; a cron tick's
  own claim-and-return-false round trip completes in well under a second.
- No cron tick runs while a previous one is still in flight (`flock` guard
  in the dispatch script) — this bounds worst-case invocation overlap, on
  top of the database's own claim-level safety.
- Cadence is 2 minutes, matched to being a backstop (not the primary path)
  — not a high-frequency poll. This is materially lower overhead than
  running a scheduler on the order of seconds.

---

## 10) Operational troubleshooting

- Dispatch log: `/home/webadmin/report-worker-dispatch.log` on the
  Production host (`192.168.0.18`) — one line per cron tick, timestamped,
  with the Edge Function's raw JSON response.
- A job stuck `queued` for more than ~2 minutes with no `worker_id` set
  indicates either the cron job stopped running (`crontab -l` as
  `webadmin`) or the Edge Function itself is failing to boot (check
  `docker logs supabase-edge-functions-evo3o0fdjaroxq7uohrm21cp`).
- A job stuck `running` for more than 5 minutes with a stale
  `worker_heartbeat_at` should self-recover on the next invocation (frontend
  nudge or cron tick) via `recover_stale_report_export_jobs_v1`; if it does
  not, verify that RPC is still `service_role`-granted and that the worker's
  best-effort call to it isn't itself throwing before reaching the claim
  step (check the Edge Function logs for the specific job's timeframe).

---

## 11) How to disable

Remove the crontab entry only — this does not touch the primary (frontend
nudge) dispatch path or the stale-job recovery call, which are both in
application/worker code, not the schedule:

```bash
crontab -l | grep -v report-worker-dispatch.sh | crontab -
```

To fully revert the stale-job-recovery wiring, remove the
`recover_stale_report_export_jobs_v1` call block from
`supabase/functions/run-report-export-job/index.ts` and redeploy — the RPC
itself is unaffected either way (SQL was not changed).

---

## 12) Test plan

- [x] Traced the intended architecture before implementing anything —
      confirmed `triggerExportWorker()` already existed, was already wired
      to every enqueue call site, and already used the correct
      (user-session, not service_role) authentication model.
- [x] 4 real jobs (all four report types) enqueued via SQL only — **no
      manual worker invocation of any kind** — drained automatically by the
      cron backstop alone, one per 2-minute tick, each with a distinct
      `worker_id`. Claim Approval and Detailed Expense both 12,601 rows
      (>1,000).
- [x] Storage objects, correct row counts, and job history confirmed for
      all 4 automatically-processed jobs.
- [x] Idle CPU measured (~0.01% on the edge-functions container).
- [x] Stale-job recovery (both requeue and exhausted-attempts→failed paths)
      verified via a `BEGIN...ROLLBACK`-wrapped synthetic test; zero rows
      persisted afterward.
- [x] Security: no service_role secret in frontend code (unchanged, already
      correct); no new grants; RPCs remain `service_role`-only; no new
      publicly reachable endpoint.
- [x] `tsc --noEmit` clean.

---

## 13) Related docs

- [daily-report-batch-ambiguity-redesign.md](./daily-report-batch-ambiguity-redesign.md) (DOC-110) — the report core this worker calls.
- [server-side-report-generation.md](./server-side-report-generation.md) (DOC-106) — original worker/job-queue design, including `recover_stale_report_export_jobs_v1`'s original definition.
- [PENDING_MIGRATIONS_PREET_INTEGRATION.md](./PENDING_MIGRATIONS_PREET_INTEGRATION.md) — activation register.

---

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-08-29 | 1.0 | Claude Code | Initial doc: traced and confirmed the existing frontend-nudge dispatch architecture, added a host-cron backstop for the nudge-failure case, and wired up the pre-existing but never-called stale-job recovery RPC. |
