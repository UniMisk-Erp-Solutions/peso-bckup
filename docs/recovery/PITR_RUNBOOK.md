# PITR operator runbook

**DO NOT POINT PRODUCTION TO RECOVERY DB UNTIL INCIDENT COMMAND APPROVAL.**

## A. Verify backups

```bash
scripts/recovery/check-pitr-health.sh
scripts/recovery/validate-wal-archive.sh /backup/pesowise/wal
```

## B. Choose recovery target

Record UTC timestamp **before** incident (e.g. one second before bad DELETE).

## C. Isolated restore directory

```bash
export TARGET=/tmp/pesowise-recovery-$(date +%s)
mkdir -p "$TARGET"
```

## D. Restore to timestamp (dry-run first)

```bash
scripts/recovery/restore-pitr.sh \
  --base-backup /backup/pesowise/base/LATEST/data \
  --wal-dir /backup/pesowise/wal \
  --target-time '2026-09-25T13:20:59+00' \
  --target-dir "$TARGET"
# add --execute when approved
```

## E–G. Start isolated Postgres / optional Supabase / frontend

Use `.env.recovery.local.example`, port **55432**, `VITE_RECOVERY_MODE=true`.

## H. Partial export

See `PARTIAL_RECOVERY_RUNBOOK.md` and `export-recovered-entity.ts`.

## I. Shutdown recovery

`docker stop pitr-lab-restore`; retain `recovery_manifest.json` and logs.

## J. Evidence

Keep WAL list, base backup manifest, `recovery_manifest.json`, E2E report.
