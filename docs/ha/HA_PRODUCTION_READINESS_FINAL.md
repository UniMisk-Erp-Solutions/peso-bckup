# PesoWise HA — production layout (final)

**Date:** 2026-09-25  
**Status:** **Normal topology restored** — primary **`.46`**, read replica **`.68`**, PITR archive on **`.68`**.

---

## Topology

| Host | Role | Service |
|------|------|---------|
| **192.168.23.46** | **Primary** (read/write Postgres + Kong in pool) | App via HAProxy → `192.168.23.46:54321` |
| **192.168.23.68** | **Read replica** (hot standby) + **PITR archive host** | Streams from `.46`; `pg_receivewal` **pulls WAL from `.46`** into `.68` disks |

```text
App → HAProxy (.46) → Kong .46:54321 → Postgres PRIMARY (.46)

.68: pg_is_in_recovery = true  (slot pesowise_68_standby)
.68: pg_receivewal → pitr-wal/  (slot pesowise_pitr on .46 primary)
```

**`system_identifier`:** `7673759460013404199` (unchanged cluster)

---

## PITR (where to recover from)

| Question | Answer |
|----------|--------|
| Where is WAL history stored? | **On `.68`** (`pitr-wal` volume + `pg_receivewal` logs) |
| Who generates WAL? | **`.46` primary** |
| Who pulls WAL for archive? | **`.68`** (`pg_receivewal -h 192.168.23.46 …`) |
| Base backups | **`/var/lib/pesowise-pitr-backup/base/` on `.68`** (e.g. `20260925T115305Z`) |
| Run health check | On **`.68`:** `sudo bash /tmp/ha/check-pitr-health-68-replica.sh` |

Full detail: **`PITR_AFTER_FAILOVER.md`**, **`docs/recovery/PITR_RUNBOOK.md`**.

---

## Work completed today (failback + PITR layout)

1. **Resolved split-brain** — fenced `.68` old primary; **`.46` sole writer**.
2. **HAProxy** — repointed to **`server app46 192.168.23.46:54321`**.
3. **`.46` repl proxy** — `pesowise-repl-proxy.service` (`192.168.23.46:5432` → DB container).
4. **`prepare-primary-46-for-68-standby.sh`** — slots `pesowise_68_standby`, `pesowise_pitr`; `pg_hba` for `.68` + bridge + `supabase_admin` (PITR base backup).
5. **`rebuild-68-standby.sh`** — `.68` **streaming standby** from `.46` (**PASS**).
6. **`setup-pitr-on-68-replica.sh`** — `pg_receivewal` on **`.68` pulling from `.46`** (slot `pesowise_pitr`).
7. **`pitr-base-backup-on-68-from-46.sh`** — base backup on **`.68`** from **`.46`**.

---

## Validation commands

**Primary + replica (on `.46`):**

```bash
docker exec supabase-db-kar0ro1k6jiyfxzzw7acnsza psql -U supabase_admin -x -c \
  "SELECT application_name, client_addr, state FROM pg_stat_replication;"
# Expect: main + pg_receivewal from .68 side (often 10.0.4.x via proxy)
```

**Standby (on `.68`):**

```bash
sudo docker exec supabase-db-ypwzkftxvvbjfvsll1y3aesk psql -U postgres -c \
  "SELECT pg_is_in_recovery(), status FROM pg_stat_wal_receiver;"
```

**PITR (on `.68`):**

```bash
sudo bash /tmp/ha/check-pitr-health-68-replica.sh
```

**PITR expense lab (validated 2026-09-28):** 500 deleted expenses on `.46` recovered on `.68` `:55432` — see `docs/recovery/PITR_EXPENSE_DEMO_REPORT.md`.

---

## Scripts (repo `scripts/ha/`)

| Script | Run on |
|--------|--------|
| `setup-repl-proxy-46.sh` | `.46` |
| `prepare-primary-46-for-68-standby.sh` | `.46` |
| `rebuild-68-standby.sh` | `.68` |
| `setup-pitr-on-68-replica.sh` | `.68` |
| `pitr-base-backup-on-68-from-46.sh` | `.68` |
| `check-pitr-health-68-replica.sh` | `.68` |
| `fence-primary-68.sh` | `.68` (failback / emergency) |
| `switch-haproxy-primary.sh` | `.46` (`SWITCH_APP_TO_46` / `SWITCH_APP_TO_68`) |

Server copies: **`/tmp/ha/`** on both hosts.

---

## Still manual

- Failover / failback promotion and fencing  
- No automatic HA  
- PITR **restore** always on **isolated** instance (never in-place overwrite)

---

## Rehearsal history

Earlier same-day rehearsal promoted `.68` and later failback restored this layout. See `HA_FAILOVER_REHEARSAL_RESULT.md` for timeline; **this file** is the **current intended production design**.
