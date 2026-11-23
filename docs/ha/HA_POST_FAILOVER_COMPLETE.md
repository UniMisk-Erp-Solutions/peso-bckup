# Post-failover HA — complete (2026-09-25)

## Operational topology

```text
App → Traefik → HAProxy (.46 host) → Kong 192.168.23.68:54321 → Postgres PRIMARY (.68, timeline 2)
PITR: slot pesowise_pitr + pg_receivewal on .68 (base 20260925T104043Z)
Standby: .46 Postgres streaming via slot pesowise_46_standby
Replication path: .46 container → 192.168.23.68:5432 (socat pesowise-repl-proxy → DB 10.0.2.16:5432)
```

## Rejoin steps executed (UTC ~11:31)

1. **`prepare-primary-for-46-standby.sh`** — `replicator` password aligned; slot `pesowise_46_standby`; `pg_hba` for `192.168.23.46/32` and **`10.0.2.1/32`** (socat/docker bridge source).
2. **`setup-repl-proxy-68.sh`** — systemd `pesowise-repl-proxy.service`; UFW allow **5432/tcp from 192.168.23.46**.
3. **`finalize-46-standby.sh`** — clean `postgresql.auto.conf`, `hot_standby = on`, `standby.signal`.
4. Validation: **`check-ha-health-standby-on-46.sh`** OVERALL **PASS**; **`check-ha-health-post-failover-68.sh`** OVERALL **PASS**; **`check-pitr-health-68.sh`** OVERALL **WARN** (WAL freshness >10 min; slot + receivewal OK).

## Diagnostics

- Migration `20260925120000_ha_failover_test_events.sql` applied on `.68`.
- Row inserted: `operation_id=rejoin-20260925`.

## Intentionally unchanged

- **Kong on `.46`** remains stopped (not in HAProxy pool).
- **Automatic failover** still disabled.
- **`.46` Kong / app failback** not executed.

## Operator maintenance

| Item | Location |
|------|----------|
| Repl proxy unit | `/etc/systemd/system/pesowise-repl-proxy.service` |
| Scripts on `.68` | `/tmp/ha/` (mirror to repo `scripts/ha/`) |
| Scripts on `.46` | `/tmp/ha/` |
| HAProxy backup | `haproxy.cfg.bak-ha-20260925T103620Z` |

If DB container IP changes after recreate, re-run **`setup-repl-proxy-68.sh`**.

## Split brain

Single writer: **`.68` only**. **`.46`** `pg_is_in_recovery()` = **t**, WAL receiver **streaming**.
