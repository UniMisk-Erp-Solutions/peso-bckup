# Manual failover runbook (PesoWise) — proven commands

**Manual only.** No automatic promotion. **Never promote while `.46` Postgres is writable.**

## Preconditions

- `docs/ha/PRE_FAILOVER_STABILITY_REPORT.md` — 60 min monitor PASS  
- `check-pitr-health.sh` → **OVERALL: PASS** on current primary  
- `check-ha-health.sh` → **OVERALL: PASS**  
- `RUN_LOCALLY=standby check-failover-safety.sh` → **PROMOTION ALLOWED**  
- HA lock: `ha-lock.sh acquire --operator NAME --reason controlled_manual_failover_rehearsal`

## A. Prechecks

**On `.46`:**

```bash
/home/hasto/peso-bckup-priyanshu/scripts/recovery/check-pitr-health.sh
/home/hasto/peso-bckup-priyanshu/scripts/ha/check-ha-health.sh
scripts/ha/cleanup-stale-walsender-46.sh          # dry-run
scripts/ha/cleanup-stale-walsender-46.sh --execute  # if zombie walsender
```

**On `.68`:**

```bash
SUDO_PASSWORD=*** scripts/ha/verify-replication-68.sh
SUDO_PASSWORD=*** INTERVAL_SEC=180 DURATION_MIN=60 scripts/ha/pre-failover-stability-monitor.sh
```

## B. Lag / catch-up

```sql
-- .46
SELECT pg_current_wal_lsn();
SELECT pid, application_name, state, replay_lag, sent_lsn, replay_lsn
FROM pg_stat_replication WHERE client_addr = '192.168.23.68';
```

```sql
-- .68
SELECT pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn(), now() - pg_last_xact_replay_timestamp();
SELECT * FROM pg_stat_wal_receiver;
```

Record `FINAL_PRIMARY_LSN`; wait until `.68` replay LSN ≥ that value.

## C. Freeze writes

Maintenance at app/proxy layer (Vercel policy / HAProxy maintenance). **Do not stop Postgres yet.**

## D. Fence `.46`

```bash
PESOWISE_FENCE_CONFIRM=FENCE_46_NOW scripts/ha/fence-primary-46.sh --execute
```

Verify from `.68`: connection to `192.168.23.46:5432` fails.  
Set `PESOWISE_PRIMARY_FENCED=1` for safety script if primary TCP still pings.

## E. Promote `.68`

```bash
RUN_LOCALLY=standby PESOWISE_HA_PROMOTE_CONFIRM=PROMOTE_STANDBY_NOW \
  scripts/ha/promote-standby.sh --execute
```

Validate: `SELECT pg_is_in_recovery();` → `f` on `.68`.

## F. Diagnostic writes (not financial)

Apply `supabase/migrations/20260925120000_ha_failover_test_events.sql`, then:

```sql
INSERT INTO ha_diag.failover_test_events (operation_id, note) VALUES ('rehearsal', 'insert');
UPDATE ha_diag.failover_test_events SET note = 'updated' WHERE operation_id = 'rehearsal';
DELETE FROM ha_diag.failover_test_events WHERE operation_id = 'rehearsal';
```

## G. Switch application path

HAProxy on `.46` (Traefik still points to `:8088`):

```bash
PESOWISE_SWITCH_CONFIRM=SWITCH_APP_TO_68 scripts/ha/switch-haproxy-primary.sh --execute
```

Backup created as `haproxy.cfg.bak-ha-*`. Reload `haproxy-pesowise-lb`.

Ensure `.68` Supabase services (Kong, PostgREST, Auth, Storage, Realtime) use **local** primary DB — restart if env still pointed at `.46`.

Checklist: `scripts/ha/switch-db-primary.sh` (precheck + service list).

## H. PITR on new primary (`.68`)

```bash
PESOWISE_PITR_TRANSFER_CONFIRM=PITR_TRANSFER_NOW \
  PESOWISE_DB_CONTAINER=supabase-db-ypwzkftxvvbjfvsll1y3aesk \
  scripts/ha/transfer-pitr-primary.sh --execute
```

Do **not** drop `.46` `pesowise_pitr` until `.68` chain passes `check-pitr-health.sh`.

## I. New base backup

```bash
SOURCE_HOST=127.0.0.1 PESOWISE_DB_CONTAINER=supabase-db-ypwzkftxvvbjfvsll1y3aesk \
  scripts/recovery/create-base-backup.sh --execute
```

## J. Rejoin `.46` (basebackup — pg_rewind unsafe)

```bash
SUDO_PASSWORD=*** scripts/ha/rebuild-46-standby.sh
```

Create slot **`pesowise_46_standby`** on `.68` if not created by script.

## K. Verify reversed topology

```bash
# .68
scripts/ha/check-ha-health.sh
# .46
HA_ROLE=standby STANDBY_DB_CONTAINER=supabase-db-kar0ro1k6jiyfxzzw7acnsza scripts/ha/check-ha-health.sh
```

## L. Post-failover observation

60 min: `scripts/ha/pre-failover-stability-monitor.sh` with `PRIMARY_HOST=192.168.23.68` (adapt verify script).

## Failback (plan only — separate approval)

1. Maintenance → catch-up → fence `.68` → promote `.46` → switch HAProxy back → PITR on `.46` → `rebuild-68-standby.sh` → validate.

## Rollback decision points

| When | Action |
|------|--------|
| Lag high before fence | **STOP**, fix replication |
| Fence not proven | **STOP**, do not promote |
| After promotion, app switch fails | Do not start `.46` as primary without fencing `.68` |
| PITR FAIL on new primary | **STOP** declaring HA READY |

## References

- `HA_FAILOVER_EXECUTION_CHECKLIST.md`
- `DB_ENDPOINT_SWITCH_PLAN.md`
- `PITR_AFTER_FAILOVER.md`
- `SPLIT_BRAIN_PREVENTION.md`
