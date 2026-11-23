# Replica repair diagnosis (.46 → .68)

**Date:** 2026-09-25  
**Scope:** Read-only audit before repair (plus evidence from preserved `.68` logs)

## SYMPTOM

- `.68` `pg_stat_wal_receiver` had **no active row**; receive/replay LSN frozen (~`0/92…`).
- `pg_last_xact_replay_timestamp` **~32+ hours** behind primary.
- Row drift: `public.expenses` **22,707** (`.68`) vs **~24,213** (`.46`).
- `.46` `pg_stat_replication` sometimes showed `streaming` while `.68` receiver was dead (misleading primary-only view).

## EVIDENCE

| Check | .46 | .68 |
|-------|-----|-----|
| PostgreSQL | 15.8 (`supabase/postgres:15.8.1.085`) | Same |
| `system_identifier` | `7673759460013404199` | Match |
| Timeline | 1 | 1 |
| `pg_is_in_recovery()` | `f` | `t` |
| WAL receiver | N/A | **empty** (pre-repair) |
| `.68` logs (2026-09-24) | — | `FATAL: requested WAL segment …000092 has already been removed` (repeated) |
| Dedicated physical slot for `.68` | **Missing** before repair | `primary_slot_name` **unset** in `postgresql.auto.conf` |
| Replication slots (pre-repair) | `pesowise_pitr` + logical | — |

## ROOT CAUSE

**Primary retained insufficient WAL for the lagging standby** because there was **no dedicated physical replication slot** for `.68`. After lag accumulated, the standby requested segments already recycled on `.46`, the WAL receiver exited, and replay stalled.

**Secondary factor (repair blocker):** `replicator` password on `.46` **did not match** the value stored in preserved `.68` `primary_conninfo` (25-char preserved value rejected; auth fixed during rebuild via `ALTER USER replicator` using `supabase_admin` over the network).

## CONFIDENCE

**High** — log line matches failure mode; cluster IDs match; missing slot + missing `primary_slot_name` align with WAL removal.

## REPAIR OPTIONS

| Path | When | Choice |
|------|------|--------|
| **A — Resume streaming** | Required WAL still on primary; receiver fix only | **Rejected** — segment `…000092` already removed |
| **B — Rebuild standby** | `pg_basebackup` from `.46`, new slot, fresh PGDATA | **Selected** |

## RISK

| Risk | Mitigation |
|------|------------|
| Promoting stale `.68` | **Not performed** |
| Split brain | `.68` remains `pg_is_in_recovery()`; app still `.46`-only |
| PITR regression | Did not alter `pesowise_pitr`; slot remained active post-repair |
| Data loss on `.68` | Old PGDATA **renamed**, not deleted: `_data.preserved-20260925T095317Z` |
| Wrong replication user | Use `replicator` + `pg_hba` `192.168.23.68/32`; password re-synced on `.46` |

## Decision

**PATH B — safe rebuild of `.68`** with physical slot **`pesowise_68_standby`**, preserved PGDATA, and `scripts/ha/rebuild-68-standby.sh`.
