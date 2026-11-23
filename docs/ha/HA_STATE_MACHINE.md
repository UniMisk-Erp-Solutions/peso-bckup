# HA state machine (manual)

```text
NORMAL
  .46 PRIMARY (writable)
  .68 STANDBY (recovery, hot_standby reads)
  PITR WAL on .46

FAILOVER_PENDING
  .46 fenced or unreachable (operator verified)
  .68 still standby, catch-up in progress

PROMOTED
  .68 PRIMARY (writable)
  .46 fenced / stopped

REJOINING
  .68 PRIMARY
  .46 rebuilding (pg_basebackup or rare pg_rewind) → standby

REVERSED (stable after failback)
  .46 PRIMARY
  .68 STANDBY

OPTIONAL_FAILBACK (controlled switchover)
  maintenance → catch-up → fence .68 → promote .46 → rejoin .68
```

## Transitions (operator-only)

| From | Event | To | Guard |
|------|--------|-----|--------|
| NORMAL | `.46` failure + fence | FAILOVER_PENDING | Fencing proof |
| FAILOVER_PENDING | lag OK + promote | PROMOTED | `check-failover-safety.sh`, HA lock |
| PROMOTED | rejoin `.46` | REJOINING | New primary stable |
| REJOINING | `.46` streaming | REVERSED or NORMAL topology | Slot/WAL plan |
| PROMOTED | failback window | OPTIONAL_FAILBACK | Same guards as promotion |

No automatic transitions.
