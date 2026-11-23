# Production PITR rollback

Use if PITR must be disabled without affecting `.68` streaming or application data.

## 1. Stop WAL receiver (no WAL deletion)

```bash
sudo systemctl stop pesowise-pitr-pg-receivewal.service
sudo systemctl disable pesowise-pitr-pg-receivewal.service
sudo docker exec supabase-db-kar0ro1k6jiyfxzzw7acnsza pkill -f 'pg_receivewal.*pesowise_pitr' || true
```

WAL files under `…/pitr-wal/` **remain on disk** unless explicitly removed in a separate approved process.

## 2. Drop PITR slot (only if explicitly approved)

```sql
-- Run inside production DB container as superuser:
SELECT pg_drop_replication_slot('pesowise_pitr');
```

**Warning:** Dropping the slot allows PostgreSQL to recycle WAL not needed by other slots/replicas. Only drop after confirming no restore depends on this chain.

## 3. Revert `pg_hba` (reload only)

Remove the block marked `# PESOWISE_PITR_LOCAL`, `# PESOWISE_PITR_ADMIN`, and any mistaken lines appended only for PITR tests. Restore from backup if needed:

```bash
# Example backup location:
ls /var/lib/pesowise-pitr-backup/logs/pg_hba.backup.*
```

Edit **`/etc/postgresql/pg_hba.conf` inside the DB container** (active `hba_file`), then:

```sql
SELECT pg_reload_conf();
```

Do **not** remove `host replication replicator 192.168.23.68/32` (`.68` replica).

## 4. Revert host artifacts (optional)

- Remove `/usr/local/bin/pesowise-pitr-pg-receivewal.sh`
- Remove `/etc/systemd/system/pesowise-pitr-pg-receivewal.service`
- `systemctl daemon-reload`

## 5. Leave untouched

- Base backups under `/var/lib/pesowise-pitr-backup/base/`
- Archive/cold-storage framework
- `.68` replica configuration and slots
- Application URLs, Kong, Realtime, RLS, SQL dumps in `/home/hasto/Desktop/Hasto/pesowise-backup/`

## 6. Isolated restore test container

```bash
sudo docker rm -f pesowise-pitr-restore-test
sudo rm -rf /tmp/pesowise-prod-pitr-recovery-55433
```

## Impact

- **App:** No change if steps 1–3 done correctly.
- **`.68`:** Continues using existing replication rule for `192.168.23.68`.
- **RPO:** Reverts to non-PITR (SQL dumps / manual backups only) unless another WAL path exists.
