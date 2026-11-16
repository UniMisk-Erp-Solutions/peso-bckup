# Phase 0 — PITR pg_hba persistence

**Completed on `.46`:** 2026-09-25 (reload only, no Postgres restart).

## Finding

| Item | Location |
|------|----------|
| Active `hba_file` | `/etc/postgresql/pg_hba.conf` (container filesystem — **lost on recreate**) |
| Config volume | `kar0ro1k6jiyfxzzw7acnsza_supabase-db-config` → `/etc/postgresql-custom` |
| `.68` replication | `host replication replicator 192.168.23.68/32 scram-sha-256` (unchanged) |

Supabase does **not** mount the main `pg_hba.conf` from the config volume; only ancillary files (`read-replica.conf`, etc.).

## Implementation

1. **Persisted snippet** on volume: `…/supabase-db-config/_data/pesowise-pitr-pg_hba.snippet` (marker `PESOWISE_PITR_PERSISTED`).
2. **Apply script:** `scripts/recovery/apply-pitr-pg_hba-persistent.sh --execute` merges into live `pg_hba` + `pg_reload_conf()`.
3. After **DB container recreate**, run apply again (e.g. from `pesowise-pitr-pg-receivewal.service` pre-start).

## Verification (post-apply)

- `check-pitr-health.sh` → **OVERALL: PASS**
- `.68` still `streaming` in `pg_stat_replication`
- PITR slot active

## Not done

- Changing `hba_file` to volume path (would require restart — avoided).
