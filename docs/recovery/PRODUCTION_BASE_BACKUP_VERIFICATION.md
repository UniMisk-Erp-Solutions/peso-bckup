# Production base backup verification

**Backup:** `/var/lib/pesowise-pitr-backup/base/2026-09-25T090242Z`  
**Date (UTC):** 2026-09-25  
**Overall:** **PASS**

| Check | Result | Notes |
|-------|--------|-------|
| Directory exists | PASS | `…/data/` ~921 MiB |
| `SUCCESS` marker | PASS | Present after checksum pass |
| `metadata.json` | PASS | start/end UTC, start/end LSN, system_identifier, timeline |
| `checksums.sha256` | PASS | Generated (large tree) |
| `standby.signal` | WARN | Created by initial `pg_basebackup -R`; removed in repo script for future runs; removed before restore test |
| `primary_conninfo` in auto.conf | WARN | From first run `-R`; stripped in updated `create-base-backup.sh` |
| System identifier match | PASS | `7673759460013404199` matches production |
| Timeline | PASS | `1` |
| WAL covers backup end | PASS | WAL dir contains segments through `…BC` at backup time; slot `restart_lsn` advanced with streaming |
| Errors in backup logs | PASS | None |

## Metadata (record)

- **start:** `2026-09-25T09:02:42Z`
- **end:** `2026-09-25T09:03:11Z`
- **start_lsn:** `0/BB003FC0`
- **end_lsn:** `0/BD000000`

## Follow-up

Re-run `create-base-backup.sh` (without `-R`) on schedule; keep at least two verified chains before any retention deletion.
