# Standby read validation (.68)

**Date:** 2026-09-25  
**Mode:** Read-only SQL on standby while `pg_is_in_recovery = t`  
**Production writes on `.46`:** unchanged.

## Result: **FAIL (stale standby)**

| Check | Primary `.46` | Standby `.68` | Match |
|-------|-------------|---------------|-------|
| `public.expenses` count | 24213 | 22707 | **NO** (−1506) |
| `pg_last_xact_replay_timestamp` | live | ~2026-09-24 | **NO** |
| `pg_stat_wal_receiver` | N/A | **empty** | **NO** |

## Historical note (2026-09-25)

Production **L7 HAProxy read→`.68`** was removed. All Supabase API traffic goes to **`.46` Kong** again. Stale-read risk from routing reads to a lagging replica is eliminated at the proxy layer; fix **`.68` replication lag** separately for HA failover readiness.

## Read path checks (when standby is healthy)

When replication is repaired, re-run on `.68`:

- `organizations`, `profiles`, `expenses`, `expense_form_field_values`
- report/balance tables (read-only `SELECT`)
- `auth` schema presence
- Storage metadata tables

Do **not** run INSERT/UPDATE/DELETE on standby while in recovery.

## BLOCKED

Standby read validation **cannot PASS** until replication lag is fixed.  
Do not use `.68` as authoritative read source until counts and replay timestamp match primary.
