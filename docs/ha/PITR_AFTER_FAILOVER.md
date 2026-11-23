# PITR after failover / failback (PesoWise)

## Final design (2026-09-25)

| Role | Host | Postgres |
|------|------|----------|
| **Primary (writes)** | **192.168.23.46** | `supabase-db-kar0ro1k6jiyfxzzw7acnsza` |
| **Read replica (standby)** | **192.168.23.68** | `supabase-db-ypwzkftxvvbjfvsll1y3aesk` |
| **PITR archive host** | **192.168.23.68** | WAL + bases on `.68` disk |

**Important:** WAL is **not** archived on `.46`. **`pg_receivewal` runs on `.68`** and **pulls** WAL from the **`.46` primary** into `.68` storage. Point-in-time recovery uses **base backup + WAL files on `.68`**.

```text
.46 PRIMARY ──WAL stream──► .68 standby (slot pesowise_68_standby)
         └──WAL stream──► .68 pg_receivewal (slot pesowise_pitr) ──► pitr-wal/ on .68
```

## Paths on `.68`

| Item | Path |
|------|------|
| WAL archive | `…/ypwzkftxvvbjfvsll1y3aesk_supabase-db-config/_data/pitr-wal` (container: `/etc/postgresql-custom/pitr-wal`) |
| Base backups | `/var/lib/pesowise-pitr-backup/base/<timestamp>/` |
| Service | `pesowise-pitr-pg-receivewal.service` → `/usr/local/bin/pesowise-pitr-pg-receivewal.sh` |
| Health check | `scripts/ha/check-pitr-health-68-replica.sh` (run on `.68` with sudo) |

## Paths on `.46`

| Item | Path |
|------|------|
| Repl proxy (standby + PITR pull) | `pesowise-repl-proxy.service` → `192.168.23.46:5432` → DB container |
| Slots on primary | `pesowise_68_standby`, `pesowise_pitr` |

## Scripts

- `prepare-primary-46-for-68-standby.sh` — `.46` slots + `pg_hba` for `.68` / Docker bridge
- `setup-repl-proxy-46.sh` — TCP proxy for replication to primary
- `rebuild-68-standby.sh` — read replica from `.46`
- `setup-pitr-on-68-replica.sh` — install receivewal **from `.46`**
- `pitr-base-backup-on-68-from-46.sh` — base backup into `.68` base dir (`--no-slot` as `supabase_admin`)

## Recovery procedure (summary)

1. Use latest `SUCCESS` base under `/var/lib/pesowise-pitr-backup/base/` on **`.68`**.
2. Use WAL segments in `pitr-wal` on **`.68`** (same timeline as primary after failback).
3. Restore to **isolated** Postgres (see `docs/recovery/PITR_RUNBOOK.md`) — never overwrite production `.46` / `.68` PGDATA in place.

## Historical WAL on `.46`

Pre-failover archives on `.46` may remain for forensic use; **live** PITR chain for current production follows **`.46` primary → `.68` archive**.
