# Production PITR enablement audit (192.168.23.46)

Read-only discovery completed **2026-09-25** (UTC). No PostgreSQL restart was required.

| ITEM | CURRENT VALUE | TARGET VALUE | CHANGE REQUIRED? | RISK | RESTART REQUIRED? | NOTES |
|------|---------------|--------------|------------------|------|-------------------|-------|
| PostgreSQL version | 15.8 (`supabase/postgres:15.8.1.085`) | Match client 15.x for backup/receive | No (client 18 works; prefer 15) | Low | No | Host has `postgresql-client` 18.6 installed |
| Container | `supabase-db-kar0ro1k6jiyfxzzw7acnsza` | Same | No | — | No | Coolify service `kar0ro1k6jiyfxzzw7acnsza` |
| `data_directory` | `/var/lib/postgresql/data` | Unchanged | No | — | No | Docker volume `kar0ro1k6jiyfxzzw7acnsza_supabase-db-data` |
| `wal_level` | `logical` | `logical` or `replica` | No | — | No | Physical slot + `pg_receivewal` OK at `logical` |
| `archive_mode` | `off` | `off` (streaming PITR) | No | — | No | Do not enable unless policy changes |
| `archive_command` | disabled | N/A | No | — | No | |
| `max_wal_senders` | 10 | ≥ 3 (`.68` + Realtime + PITR) | No | Low | No | Headroom OK |
| `max_replication_slots` | 5 | ≥ 3 | No | Low | No | 2 logical (Realtime) + 1 physical PITR |
| `wal_keep_size` | 0 | 0 (slot retention) | No | — | No | |
| `max_slot_wal_keep_size` | 4096 MB | ≥ 4096 MB | No | Medium | No | Per-slot WAL cap |
| `checkpoint_timeout` | 300 s | 300 s | No | — | No | |
| `hba_file` | `/etc/postgresql/pg_hba.conf` | + PITR replication rules | **Yes** | Medium | **Reload only** | Not on config volume; backup copy under `/var/lib/pesowise-pitr-backup/logs/` |
| Timeline / system ID | timeline 1 / `7673759460013404199` | Record in backups | Yes (metadata) | Low | No | Stored in first base backup `metadata.json` |
| `.68` streaming | `supabase_admin` @ `192.168.23.68` | Unchanged | **No** | — | No | Not modified |
| PITR slot | **`pesowise_pitr`** (physical) | Dedicated PITR slot | **Yes** | Low | No | Created via `pg_create_physical_replication_slot` |
| `pg_receivewal` on host | Not in PATH initially | Running in DB container | **Yes** | Low | No | Uses Unix socket + `supabase_admin` |
| WAL destination | `/etc/postgresql-custom/pitr-wal` (volume-backed) | Dedicated WAL path | **Yes** | Low | No | Host path: `/var/lib/docker/volumes/kar0ro1k6jiyfxzzw7acnsza_supabase-db-config/_data/pitr-wal` |
| Base backup root | `/var/lib/pesowise-pitr-backup/base/` | Timestamped dirs | **Yes** | Low | No | First backup `2026-09-25T090242Z` (~921 MiB) |
| Filesystem `/` | ext4 ~63 GiB free (57% used) | Monitor WAL growth | Monitor | Medium | No | No separate `/backup` mount |
| Replication role | `supabase_admin` (repl privilege) | Least privilege repl user | No new role | Low | No | `.68` already uses same role |
| `archive_mode` restart | Not needed | — | No | — | **No restart** | Status: **enabled without restart** |

## Layout (effective)

```
/var/lib/pesowise-pitr-backup/
  base/           # pg_basebackup output (timestamped)
  manifests/      # partial export samples
  logs/           # pg_hba backup snapshots
  .pgpass         # host client auth (mode 600, not in git)

Docker volume …/supabase-db-config/_data/
  pitr-wal/       # continuous WAL via pg_receivewal
  pitr-logs/      # receivewal log
```

## Changes applied (summary)

1. Physical slot `pesowise_pitr`.
2. `pg_hba` append (reload): `local`/`host` replication for `supabase_admin` (127.0.0.1, 10.0.4.1) and earlier `replicator` lines — see rollback doc for exact removal.
3. `pg_receivewal` streaming to `pitr-wal` (postgres OS user).
4. `systemd` unit `pesowise-pitr-pg-receivewal.service` on host.
5. First verified base backup + isolated restore test on port **55433** (read-only validation).

## Not changed

- `.68` replica configuration, archive/cold-storage framework, RLS, app, Kong, Realtime, Auth, Storage, frontend.
