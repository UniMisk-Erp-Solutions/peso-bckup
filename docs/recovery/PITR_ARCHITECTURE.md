# PITR / WAL recovery architecture (PesoWise)

Separate from **archive/cold storage** (`archive.*` schema). See `ARCHIVE_ARCHITECTURE.md` (link only).

## Layers

```text
PRIMARY PRODUCTION (.46)
  │
  ├── continuous: pg_basebackup (timestamped)
  │
  └── continuous: WAL archive (pg_receivewal OR archive_command)
           │
           ▼
     /backup/pesowise/wal/ + /backup/pesowise/base/

Recovery (NEVER production paths):

BASE BACKUP dir + WAL dir + recovery_target_time
           │
           ▼
ISOLATED Postgres (new PGDATA, new ports)
           │
           ▼
OPTIONAL: recovery Supabase stack (localhost only)
           │
           ▼
Recovery frontend (.env.recovery.local, VITE_RECOVERY_MODE=true)
```

## Isolation requirements

| Must differ from production |
|----------------------------|
| Data directory / Docker volume |
| TCP port (e.g. 55432 not 5432) |
| Hostname / URL |
| Coolify project name |
| Credentials (`.env.recovery`, not committed) |

## What `.68` replica is NOT

- Not a WAL archive  
- Not point-in-time history after deletes on primary  
- Failover target only (future phase)

## Partial recovery (preferred for accidents)

Production stays online → restore **isolated** DB to T−ε → export rows → human review → controlled reinsert.

See `PARTIAL_RECOVERY_RUNBOOK.md`.

## Production readiness gate

Do not declare PITR production-ready until `PITR_PRODUCTION_READINESS.md` checklist passes (requires live WAL + base backup + isolated restore proof).
