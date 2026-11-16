# Production PITR failure safety (monitoring expectations)

Non-destructive checks only — do not stop production Postgres for drills unless using an isolated restore host.

| Condition | Expected detection | Response |
|-----------|-------------------|----------|
| `pg_receivewal` stopped | `check-pitr-health.sh` FAIL; systemd `Restart=on-failure` | `systemctl start pesowise-pitr-pg-receivewal.service` |
| Slot inactive | Health script WARN/FAIL on `pg_replication_slots.active` | Start receiver; verify `pg_hba` + credentials |
| Disk almost full | `df` in health script; WARN >75% | Expand disk or prune per retention policy (dry-run first) |
| WAL path not writable | Receiver log errors; FAIL on WAL dir | Fix ownership (`postgres:postgres` on `pitr-wal`) |
| Base backup too old | Health script base age | Run `create-base-backup.sh --execute` |
| WAL gap / zero-byte segment | `validate-wal-archive.sh` FAIL | Investigate receiver downtime; do not delete WAL |
| Checksum failure | Manual verify on `checksums.sha256` | New backup; keep failed set for forensics |
| Receiver restart after DB container restart | systemd oneshot re-exec wrapper | Confirm slot still exists |

Simulations performed safely: receiver stop/start, permission fix on WAL, isolated restore failure modes (wrong WAL mount, `-R` standby artifacts) — production primary remained available; `.68` streaming observed throughout enablement.
