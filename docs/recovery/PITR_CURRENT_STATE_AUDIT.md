# PITR current state audit (read-only — PesoWise primary `.46`)

**Date:** 2026-09-25  
**Scope:** Pesowise Supabase DB container `supabase-db-kar0ro1k6jiyfxzzw7acnsza` on `192.168.23.46`  
**No configuration changes were made during this audit.**

---

## Executive summary

| Question | Answer |
|----------|--------|
| Can we PITR to an arbitrary timestamp **today** on production? | **NO — not proven; likely NOT possible** with current settings |
| Is `.68` a substitute for WAL archive? | **NO** (streaming replica; not a retained WAL library) |
| What exists today? | **Logical replication** (Realtime), **physical streaming to `.68`**, **Aug-2025 SQL + storage tarball** (point-in-time snapshot, not continuous WAL) |

---

## Configuration matrix

| CONFIG | CURRENT VALUE | EXPECTED / SAFE FOR PITR | STATUS | RISK | ACTION NEEDED |
|--------|---------------|---------------------------|--------|------|---------------|
| PostgreSQL version | **15.8** | 15.x lab matches major | OK | Low | Match major in recovery env |
| `wal_level` | **logical** | `replica` or `logical` (base backup OK) | WARN | Medium | Accept for base backup; document logical slots |
| `archive_mode` | **off** | **on** (or external `pg_receivewal` + slot) | **FAIL** | **Critical** | Enable archiving **only with approved change window** |
| `archive_command` | (inactive) | `cp`/rsync or `pg_receivewal` destination | **FAIL** | Critical | Design + implement Phase 4–5 |
| `max_wal_senders` | 10 | ≥2 | OK | Low | — |
| `max_replication_slots` | 5 | ≥2 physical + logical headroom | WARN | Medium | Add **physical PITR slot** without dropping Realtime slots |
| `wal_keep_size` | 0 | >0 or slot WAL keep | WARN | Medium | WAL can be recycled |
| `max_slot_wal_keep_size` | **4GB** | Sized to RPO target | WARN | Unknown | Measure WAL/day; may be insufficient |
| `checkpoint_timeout` | 5min | default OK | OK | Low | — |
| `data_directory` | `/var/lib/postgresql/data` | isolated recovery path | OK | Low | Never restore into this path |

---

## Replication slots (observed)

| slot_name | type | active | Notes |
|-----------|------|--------|-------|
| `supabase_realtime_messages_replication_slot_` | logical | yes | Realtime — **do not drop** |
| `cainophile_r7vdip3a` | logical | yes | Realtime — **do not drop** |
| **`hasto_pitr_pesowise` (expected)** | physical | — | **NOT PRESENT** |

---

## Streaming replication (not PITR archive)

- **Client:** `192.168.23.68` — Pesowise **hot standby** (`.68` replica).
- **Purpose:** read replica / failover prep — **not** retained WAL for point-in-time restore.
- **Replica lag:** flush/replay lag observed ~**2h** in one snapshot — investigate separately; **not** RPO for external PITR.

---

## WAL receiver / `pg_receivewal`

| Check | Result |
|-------|--------|
| `pg_receivewal` process on host | **Not found** |
| Dedicated WAL archive container | **Not found** |
| WAL archive directory on `/backup` | **No `/backup` mount** in `df` |

---

## Base backups (observed)

| Location | Content | PITR-capable? |
|----------|---------|---------------|
| `/home/hasto/Desktop/Hasto/pesowise-backup/` | `Pesowise-main_2026-08-12_0035_db.sql.gz` (~416 MB) + storage tar | **NO** — logical dump at **one instant**; no WAL chain |
| Coolify `/data/coolify/backups` | Empty (only `.` / `..`) | N/A |

---

## Retention (estimated)

| Item | Estimate |
|------|----------|
| Continuous WAL retention for PITR | **~0** (archive off, no receivewal) |
| Restorable window | **Last logical dump date only** (Aug 2025) unless other copies exist |
| Row counts | **UNKNOWN** (not queried on production) |

---

## Storage

| Filesystem | Size | Used | Avail |
|------------|------|------|-------|
| `/` (`/dev/sda5`) | 150G | 80G (56%) | 64G |

WAL archive size: **N/A**. Daily WAL growth: **UNKNOWN** — run `check-pitr-health.sh` after archiving enabled.

---

## Archive / cold-storage (separate layer)

See `ARCHIVE_ARCHITECTURE.md` — **not** a substitute for PITR.

---

## Blockers before production PITR proof

1. **`archive_mode=off`** — no WAL segment library for target-time recovery.  
2. **No physical PITR replication slot** / no `pg_receivewal`.  
3. **No recent `pg_basebackup` chain** with manifests/checksums in standard path.  
4. **Do not run 500+500 delete test on production.**

**Next safe step:** Deploy tooling in repo → run **isolated Docker lab E2E** → then approved production **read-only** base backup + WAL receiver setup → restore **historical** timestamp to recovery host (no production writes).
