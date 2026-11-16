# Split-brain prevention

## Scenarios

| Scenario | Risk | Protection |
|----------|------|------------|
| `.46` network partition but still writable | Dual primary | **Fence `.46`** before `pg_promote` on `.68` |
| Promote `.68` while app still writes `.46` | Divergent timelines | Maintenance mode + HAProxy write path |
| `.46` restarts after `.68` promoted | Old primary accepts writes | Keep `.46` stopped until rejoin as standby |
| Two operators run failover | Double promotion | `ha-lock.sh` on `/var/lib/pesowise-ha/` |
| Automatic promotion | Uncontrolled | **Not implemented** (phase 21) |

## Mandatory controls

1. **`check-failover-safety.sh`** → default **REFUSE**.
2. **`--force`** requires `PESOWISE_HA_FORCE_CONFIRM=I_ACCEPT_SPLIT_BRAIN_RISK`.
3. **Single writable marker:** only one host with `pg_is_in_recovery = f`.
4. **Stable DB endpoint** (future): switch one logical target, not app hardcode to `.46`.
5. **Promotion confirm:** `PESOWISE_HA_PROMOTE_CONFIRM=PROMOTE_STANDBY_NOW`.
6. **Old primary startup:** after failover, `.46` must start only as standby (no promote) until failback plan.

## Operator confirmation points

- Fence verified (yes/no)
- Lag within RPO (yes/no)
- HA lock held (yes/no)
- Explicit promote confirm env set (yes/no)
