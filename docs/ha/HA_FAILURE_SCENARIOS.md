# HA failure scenarios (manual response)

| # | Scenario | Detect | Safe action | Promote? | RPO | Rejoin | Rollback |
|---|----------|--------|-------------|----------|-----|--------|----------|
| 1 | `.46` PG container crash | Health checks fail | Restart container on `.46` | No | 0 if quick | N/A | N/A |
| 2 | `.46` OS crash | Ping/SSH fail | Fence; promote if prolonged | Maybe | lag-based | basebackup `.46` | Restore `.46` from backup |
| 3 | `.46` hardware dead | Total loss | Promote `.68` after fence proof | Yes | lag | Rebuild `.46` | PITR + base backups |
| 4 | `.46` network only | Split-brain risk | **Do not promote** until fenced | Only if fenced | — | — | Fix network |
| 5 | `.68` replication broken | `pg_stat_wal_receiver` empty | **Fix standby** (current state) | **No** | — | N/A | Repair streaming |
| 6 | `.68` lag too high | `check-failover-safety` | Wait / fix | No | high | — | — |
| 7 | Both reachable | HA health | Identify single primary | No dual write | — | — | — |
| 8 | Both unreachable | External monitoring | Escalate | No | — | — | — |
| 9 | Promote OK, app switch fails | User reports | Keep `.68` primary; fix HAProxy | — | — | — | Do not start `.46` primary |
| 10 | PITR still on `.46` after promote | Health script | Stand up PITR on `.68` | — | WAL gap | See PITR doc | — |
| 11 | `.46` returns unexpectedly | Split-brain | **Stop** `.46` Postgres | — | — | rejoin as standby | — |
| 12 | `pg_rewind` failure | Rejoin script | Use **pg_basebackup** path | — | — | basebackup | — |

## Current priority

**Scenario 5** matches production audit — address before any failover rehearsal.
