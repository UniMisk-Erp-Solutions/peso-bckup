# Controlled failover rehearsal plan (do not execute without approval)

| Time | Step | Rollback point |
|------|------|----------------|
| T0 | Announce maintenance | Cancel |
| T1 | App maintenance / read-only | Restore app |
| T2 | Record `.46` `pg_current_wal_lsn()` | — |
| T3 | Wait until `.68` replay ≥ target LSN | **Abort if lag** |
| T4 | Fence `.46` (stop DB container) | Start `.46` if abort before promote |
| T5 | Verify `.46` not writable | — |
| T6 | `promote-standby.sh --execute` | **No auto rollback** — treat as failover |
| T7 | Validate `.68` `pg_is_in_recovery = f` | — |
| T8 | `switch-db-primary.sh` + HAProxy manual | Revert HAProxy backup |
| T9 | Start services on `.68` | — |
| T10 | App + `ha_diag` write test | — |
| T11 | End maintenance | — |

**Prerequisite:** Clear all items in `HA_CURRENT_STATE_AUDIT.md` BLOCKED section.

**Not scheduled** as of 2026-09-25.
