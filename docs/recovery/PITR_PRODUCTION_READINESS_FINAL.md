# PITR production readiness — final report

**Host:** 192.168.23.46 (PesoWise primary)  
**Report date:** 2026-09-25 (UTC)  
**Status:** **READY** (production PITR chain live; isolated restore validated)

---

## A. Production config before

| Setting | Value |
|---------|--------|
| `archive_mode` | off |
| PITR slot | none |
| `pg_receivewal` | not running |
| Base backup chain | SQL dump only (Aug 2025); no continuous WAL |

## B. Production config after

| Setting | Value |
|---------|--------|
| `archive_mode` | off (unchanged) |
| `wal_level` | logical (unchanged) |
| PITR slot | **`pesowise_pitr`** (physical) |
| WAL capture | **`pg_receivewal`** → `…/pitr-wal/` |
| Base backup | `/var/lib/pesowise-pitr-backup/base/2026-09-25T090242Z` |
| PostgreSQL restart | **None** |

## C. PITR slot

- Name: `pesowise_pitr`
- Type: physical
- Active when receiver running: **yes** (verified post-systemd)

## D. WAL receiver service

- Process: `pg_receivewal` as **postgres** user inside `supabase-db-kar0ro1k6jiyfxzzw7acnsza`
- Host systemd: **`pesowise-pitr-pg-receivewal.service`** (enabled)
- Install script: `scripts/recovery/install-pg-receivewal-service.sh`

## E. WAL destination

- Container: `/etc/postgresql-custom/pitr-wal`
- Host: `/var/lib/docker/volumes/kar0ro1k6jiyfxzzw7acnsza_supabase-db-config/_data/pitr-wal`

## F. WAL generation rate

~**195 MiB/hour** (~4.7 GiB/day) initial estimate — see `PRODUCTION_PITR_RETENTION_PLAN.md`.

## G. WAL retention estimate

~**13 days** upper bound on current free space (not a target); policy must cap via future retention script.

## H. Base backup path

`/var/lib/pesowise-pitr-backup/base/` (manifests + logs alongside).

## I. Base backup verification

**PASS** — see `PRODUCTION_BASE_BACKUP_VERIFICATION.md`.

## J. Isolated restore result

**PASS** — `pesowise-pitr-restore-test` on port **55433**; promoted; real row counts validated.

## K. Application-level validation

Read-only SQL on restored DB: organizations, expenses, EFV counts plausible; no mutating RPCs run.

## L. Partial recovery export

Sample expense JSON written to `/var/lib/pesowise-pitr-backup/manifests/partial-export-expense.json` (758 bytes). Full `export-recovered-entity.ts` can run from recovery tooling against `:55433`.

## M. Measured RPO

**~1–2 minutes** (streaming WAL) — see `PRODUCTION_RPO_RTO.md`.

## N. Measured RTO

**~2–3 minutes** for isolated DB only (same host).

## O. Monitoring status

- `scripts/recovery/check-pitr-health.sh` updated for production paths
- Host systemd restarts receiver if process missing
- Manual checks: slot active, WAL age, disk %

## P. Disk usage

`/` ~57% used, ~63 GiB free (2026-09-25).

## Q. Rollback plan

`PRODUCTION_PITR_ROLLBACK.md`

## R. Remaining risks

1. **`pg_hba` PITR lines** live in container `/etc/postgresql/pg_hba.conf` (not on config volume) — re-apply after DB container recreate from saved backup in `pitr-backup/logs/`.
2. **First base backup** used `pg_basebackup -R`; script fixed for future runs.
3. **WAL file ownership** — receiver must run as `postgres` (fixed); early root-owned segments chmod’d for restore test.
4. **WAL growth** on `/` — retention not automated.
5. **Restore test container** still runnable on 55433 — stop when drill complete.

## S. Still disabled (by design)

- Base backup **timer** (`pesowise-pitr-base-backup.timer.example`)
- `backup-retention.sh --execute`
- `archive_mode` / archive_command cold path
- Production delete / destructive tests

## T. Ready?

| Criterion | Met |
|-----------|-----|
| Slot healthy | Yes |
| WAL arriving | Yes |
| Verified base backup | Yes |
| WAL covers backup window | Yes |
| Isolated restore | Yes |
| Data validated | Yes |
| Health script | Yes |
| Partial export sample | Yes |

**Overall: READY**

`.68` replica streaming was **not** modified and remained connected throughout.
