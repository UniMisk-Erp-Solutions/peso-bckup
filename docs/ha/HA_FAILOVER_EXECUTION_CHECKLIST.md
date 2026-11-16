# Manual HA failover — execution checklist (.46 SSH required)

**Status:** Rehearsal **not executed** past pre-checks — awaiting **`hasto@192.168.23.46` SSH** (password `qwertyui` rejected from automation host).

**Safe state:** `.46` PRIMARY · `.68` STANDBY streaming · app on `.46` only.

---

## Completed from automation (.68)

1. Stale walsender on `.46` terminated (`cleanup-stale-walsender-46.sh --execute`).
2. HA scripts uploaded to `.68` `/tmp/ha/`.
3. **60-minute** stability monitor started (`pre-failover-stability-monitor.sh`).

---

## Operator sequence (after `.46` login works)

Set on jump host:

```bash
export SSH_46=hasto@192.168.23.46 SSH_46_PASS='***'
export SSH_68=mithil@192.168.23.68 SSH_68_PASS='***'
export SUDO_PASSWORD='***'
```

### 1 — Precheck (.46)

```bash
/home/hasto/peso-bckup-priyanshu/scripts/recovery/check-pitr-health.sh
/home/hasto/peso-bckup-priyanshu/scripts/ha/check-ha-health.sh
```

### 2 — Wait for stability TSV (`.68`)

```bash
tail -f /tmp/pre-failover-stability.log
# Require full 60 min file /tmp/pre-failover-stability.tsv
```

### 3 — Lock + safety (`.68`)

```bash
sudo /tmp/ha/ha-lock.sh acquire --operator YOU --reason controlled_manual_failover_rehearsal
RUN_LOCALLY=standby /tmp/ha/check-failover-safety.sh
```

### 4 — Maintenance / freeze writes

App/proxy maintenance per org policy (minimum impact). Record `MAINTENANCE_START`.

### 5 — Final catch-up

On `.46`: `SELECT pg_current_wal_lsn();` → `FINAL_PRIMARY_LSN`  
On `.68`: wait until `pg_last_wal_replay_lsn() >= FINAL_PRIMARY_LSN`.

### 6 — Fence `.46`

```bash
PESOWISE_FENCE_CONFIRM=FENCE_46_NOW /tmp/ha/fence-primary-46.sh --execute
# From .68: psql to .46:5432 must fail
export PESOWISE_PRIMARY_FENCED=1
```

### 7 — Promote `.68`

```bash
PESOWISE_HA_PROMOTE_CONFIRM=PROMOTE_STANDBY_NOW RUN_LOCALLY=standby /tmp/ha/promote-standby.sh --execute
```

### 8 — Diagnostic writes (`.68`)

Apply migration `20260925120000_ha_failover_test_events.sql`, then INSERT/UPDATE/DELETE on `ha_diag.failover_test_events` only.

### 9 — Switch app path (`.46` host — HAProxy still runs there)

```bash
PESOWISE_SWITCH_CONFIRM=SWITCH_APP_TO_68 /tmp/ha/switch-haproxy-primary.sh --execute
```

Restart `.68` Kong/PostgREST/Auth/Storage as needed so services use local primary DB.

### 10 — PITR on new primary (`.68`)

```bash
PESOWISE_PITR_TRANSFER_CONFIRM=PITR_TRANSFER_NOW /tmp/ha/transfer-pitr-primary.sh --execute
# Requires install-pg-receivewal-service.sh + create-base-backup.sh on .68
```

### 11 — Rejoin `.46` (basebackup path)

```bash
SUDO_PASSWORD=*** /tmp/ha/rebuild-46-standby.sh
# Slot pesowise_46_standby on .68
```

### 12 — Verify reversed topology

```bash
HA_ROLE=standby /tmp/ha/check-ha-health.sh   # on .46 after rejoin
/tmp/ha/check-ha-health.sh                   # on .68 as primary
/tmp/ha/verify-replication-68.sh             # adjust PRIMARY_HOST if needed
```

### 13 — End maintenance · observe 60 min · record RPO/RTO

See `POST_FAILOVER_STABILITY_REPORT.md`, `HA_RPO_RTO_FINAL.md`, `SPLIT_BRAIN_VALIDATION_FINAL.md`.

---

## Rollback (before app switch)

Restore `.46` postgres container if fenced but not promoted; release HA lock.

## Rollback (after promotion, before app switch)

Keep `.68` primary; do **not** start `.46` postgres until fenced again.

**Failback:** documented in `MANUAL_FAILOVER_RUNBOOK.md` — not auto-executed.
