-- ============================================================
-- FILE: 00_check_index_progress_and_locks.sql
-- PURPOSE: Check whether CREATE INDEX is still running, and
--          whether any locks are blocking queries on expenses.
-- SAFE: Read-only. No data changes.
-- RUN THIS FIRST if the user says "SQL is still running" or
--   the index creation seems to have stalled.
-- ============================================================


-- ──────────────────────────────────────────────────────────
-- QUERY 1: Is CREATE INDEX still in progress?
-- ──────────────────────────────────────────────────────────
-- If this returns rows → index creation is actively running.
--   blocks_done / blocks_total shows % progress.
--   phase values: "initializing", "waiting for writers before build",
--                 "building index", "waiting for writers before validation",
--                 "index validation: scanning index", "finished"
-- If this returns NO rows → either:
--   (a) index creation already finished (check file 02 to confirm)
--   (b) index creation was never started
--   (c) index creation was cancelled/errored

SELECT
  pid,
  datname,
  relid::regclass                    AS table_name,
  index_relid::regclass              AS index_name,
  phase,
  lockers_total,
  lockers_done,
  current_locker_pid,
  blocks_total,
  blocks_done,
  CASE WHEN blocks_total > 0
    THEN ROUND(100.0 * blocks_done / blocks_total, 1)
    ELSE NULL
  END                                AS blocks_pct_done,
  tuples_total,
  tuples_done,
  partitions_total,
  partitions_done
FROM pg_stat_progress_create_index;


-- ──────────────────────────────────────────────────────────
-- QUERY 2: Is there any CREATE INDEX query running right now?
-- ──────────────────────────────────────────────────────────
-- If this returns rows, the index build is still in progress.
-- running_for shows how long it has been running.
-- If it has been running for >5 minutes with no pg_stat_progress_create_index
-- row, something may be stuck.

SELECT
  pid,
  state,
  wait_event_type,
  wait_event,
  now() - query_start              AS running_for,
  left(query, 500)                 AS query_preview
FROM pg_stat_activity
WHERE
  query ILIKE '%CREATE INDEX%'
  OR query ILIKE '%idx_expenses_org_status_created%'
  OR query ILIKE '%public.expenses%'
ORDER BY query_start NULLS LAST;


-- ──────────────────────────────────────────────────────────
-- QUERY 3: Any locks on the expenses table?
-- ──────────────────────────────────────────────────────────
-- If index creation is blocking queries (or vice versa),
-- this shows what holds the lock and what is waiting.
-- granted = false means the process is waiting for the lock.
-- Look for long-running queries with granted = false.

SELECT
  l.pid,
  a.state,
  a.wait_event_type,
  a.wait_event,
  l.locktype,
  l.mode,
  l.granted,
  now() - a.query_start            AS running_for,
  left(a.query, 400)               AS query_preview
FROM pg_locks l
JOIN pg_stat_activity a ON a.pid = l.pid
WHERE l.relation = 'public.expenses'::regclass
ORDER BY l.granted, a.query_start;


-- ──────────────────────────────────────────────────────────
-- HOW TO INTERPRET RESULTS
-- ──────────────────────────────────────────────────────────
--
-- Scenario A — pg_stat_progress_create_index has a row:
--   Index is still being built. Wait for it to finish.
--   Check blocks_pct_done to estimate remaining time.
--
-- Scenario B — pg_stat_activity has a row with state = 'active':
--   Index build is running. Wait.
--
-- Scenario C — pg_stat_activity has a row with wait_event_type = 'Lock':
--   Another query is blocking the index build.
--   The blocking query will be visible in QUERY 3.
--   You may need to cancel the blocking query or wait for it.
--
-- Scenario D — all queries return empty:
--   Index creation has finished (or failed silently).
--   Run file 02_verify_indexes_and_query_plan.sql to confirm.
--
-- Scenario E — all queries return empty AND file 02 shows index missing:
--   Index creation was never started, or it errored.
--   Run file 01_create_indexes_concurrently.sql (or 01b fallback).
