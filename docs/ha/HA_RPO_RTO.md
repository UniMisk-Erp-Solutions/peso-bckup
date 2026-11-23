# HA RPO / RTO (measured + current blockers)

## RPO (today — not failover-ready)

| Source | Measurement |
|--------|-------------|
| Primary `pg_stat_replication` replay_lag | **~12–23 minutes** (11-min sample) |
| Standby `pg_last_xact_replay_timestamp` | **~32 hours** behind |
| Expense row delta | **1506 rows** |

**Effective RPO if promoted without repair:** **unacceptable / unbounded** — not near-zero.

After replication repair, re-measure during maintenance window.

## RTO (estimated components — not end-to-end tested)

| Phase | Estimate | Notes |
|-------|----------|--------|
| Detection | Operator-dependent | No automatic failover |
| Fencing `.46` | 5–15 min | Manual |
| Promotion `.68` | &lt; 1 min | `pg_promote` |
| HAProxy/Kong switch | 15–60 min | Manual, L7 complexity |
| App validation | 15–30 min | Read then diagnostic write |
| PITR re-establish on new primary | 1–2 h | New slot + base backup |
| Rejoin `.46` via basebackup | 1–3 h | ~900 MiB+ |

**Failover test:** **not executed** (phase 22 requires explicit approval).
