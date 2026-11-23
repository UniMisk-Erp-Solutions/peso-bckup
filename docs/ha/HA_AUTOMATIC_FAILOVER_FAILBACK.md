# Automatic HA — failover, recovery, failback (Priyanshu design)

**Status:** **Design + lab simulation** on branch `priyanshu`.  
**Production today:** manual HA only (`.46` PRIMARY, `.68` STANDBY) — **unchanged by this document**.

---

## 1. Normal state

```text
VIP → .46 (Keepalived MASTER)
HAProxy on .46 + .68 → least_conn → healthy app46 / app68
DB endpoint → PostgreSQL .46 PRIMARY (writable)
.68 PostgreSQL STANDBY (pg_is_in_recovery = true)
WAL: .46 → .68 (streaming + separate PITR archive on .68)
```

| Layer | Preferred owner |
|--------|-----------------|
| Virtual IP | `.46` |
| App traffic | Both nodes via HAProxy |
| PostgreSQL writes | **`.46` only** |

---

## 2. App load balancing

- **HAProxy** on both nodes (same config), frontends bind on VIP or local + VIP.
- **Balance:** `leastconn` (or `roundrobin` if session affinity required).
- **Health check:** HTTP `GET /health` (Kong or app health path).
- **Unhealthy backend:** removed automatically; traffic flows to peer app node.

---

## 3. VIP handling (Keepalived)

- **VRRP** pair: `.46` higher priority (MASTER), `.68` BACKUP.
- On `.46` node failure (script/check failed), **VIP moves to `.68`**.
- VIP carries **user-facing entry** (or DNS points to VIP).
- Keepalived does **not** promote PostgreSQL — only network presence.

---

## 4. Database replication

- Physical streaming replication `.46` → `.68`.
- Slot on primary (e.g. `pesowise_68_standby`).
- **PITR** (`pesowise_pitr`, `pg_receivewal` on `.68`) stays **separate** — do not disable for HA work.

---

## 5. Failover (`.46` failure)

** Preconditions (automated or operator):**

1. Health checks declare `.46` app/DB path failed (not a transient blip — use `n` failures + optional witness).
2. **Fence `.46` Postgres** (stop container / STONITH / hypervisor API) — **mandatory before promotion**.
3. HA lock acquired (`ha-lock.sh` or Patroni/repmgr equivalent).
4. Standby caught up within RPO or operator accepts lag.

** Sequence:**

```text
detect .46 failure
  → VIP to .68 (Keepalived)
  → HAProxy serves app68 (and app46 down)
  → fence .46 DB (no writes)
  → promote .68 (pg_promote)
  → switch app DB endpoint to .68
  → PRIMARY=.68 STANDBY=none until .46 rejoins
```

**Expected outage window (design target):** app 1–5 min (VIP + HAProxy + promote); RPO per streaming lag (see `HA_RPO_RTO.md`).

---

## 6. Promotion

- **Manual today:** `promote-standby.sh --execute` on `.68` with `PESOWISE_HA_PROMOTE_CONFIRM=PROMOTE_STANDBY_NOW` after `check-failover-safety.sh`.
- **Future auto:** Patroni/repmgr leader election **only with fencing + witness** (see §10).

---

## 7. Recovery (`.46` returns)

**Do not** make `.46` PRIMARY immediately.

```text
.46 powered / network restored
  → verify stable (no flapping)
  → pg_basebackup OR pg_rewind + rejoin as STANDBY
  → PRIMARY remains .68
  → WAL .68 → .46 until lag = 0
```

Scripts (production-oriented, manual): `rejoin-46-from-68.sh`, `rebuild-46-standby.sh`, `wait-catchup-68.sh` (adapt direction per primary).

---

## 8. Failback (return to normal)

**Only when:**

- `.46` healthy, `.68` healthy
- Replication lag **0** (or within agreed max)
- **No split-brain** (exactly one `pg_is_in_recovery = f`)
- Controlled write quiesce or switchover window

** Sequence:**

```text
controlled switchover
  → optional brief read-only / maintenance
  → promote .46 (or pg_switchover if using repmgr/Patroni)
  → DB endpoint → .46
  → reconfigure .68 as STANDBY
  → VIP priority → .46
  → NORMAL
```

Manual today: `switch-haproxy-primary.sh` with `SWITCH_APP_TO_46`, plus failback runbook in `MANUAL_FAILOVER_RUNBOOK.md`.

---

## 9. Split-brain protection

| Control | Purpose |
|---------|---------|
| Fence old primary before promote | Old writer cannot accept commits |
| `check-failover-safety.sh` | Refuses if `.46` still writable |
| `ha-lock.sh` | One operator workflow |
| `PESOWISE_HA_FORCE_CONFIRM` | Explicit override only |
| Lab `assert_single_primary` | Simulator rejects two writables |
| **No auto-promote on 2-node without witness** | Documented limitation |

See `SPLIT_BRAIN_PREVENTION.md`.

---

## 10. Two-node quorum limitation

With **only** `.46` and `.68`, automatic promotion when `.46` is **network partitioned but still running** can cause **dual primaries** unless:

- **Fencing** reliably stops `.46` Postgres, **and/or**
- A **third witness** (etcd, small quorum node, cloud check) breaks ties.

**Do not pretend** pure two-node auto-failover is perfectly safe without fencing + witness.

---

## 11. App retry behavior

- Use **single DB URL** via VIP/DNS/pooler — not hardcoded `.46`.
- Connection pools: retry transient errors, exponential backoff.
- Idempotent API writes where possible.
- No critical session state only in one node’s memory (sticky sessions → shared store or re-login).

---

## 12. Test procedure (Priyanshu lab — safe)

**No production servers touched.**

```bash
export PESOWISE_HA_LAB=1
bash scripts/ha/lab/run-ha-lab-tests.sh
```

Optional Docker HAProxy lab:

```bash
docker compose -f tools/priyanshu-ha-lab/docker-compose.yml up -d
curl -s http://127.0.0.1:18088/   # alternates app46/app68
docker compose -f tools/priyanshu-ha-lab/docker-compose.yml down
```

Full runbook: **`PRIYANSHU_HA_LAB_RUNBOOK.md`**.

---

## 13. Rollback

- Lab: `ha-lab-state-machine.sh reset` or delete `$PESOWISE_HA_LAB_ROOT`.
- Production: **never ran auto-failover from this branch** — rollback = stay on manual runbooks.

---

## 14. Production prerequisites (before enabling auto)

- [ ] DB endpoint abstraction (VIP/DNS/PgBouncer)
- [ ] Dual-app HAProxy + health checks in prod
- [ ] Keepalived VIP tested
- [ ] Proven fencing for `.46` / `.68`
- [ ] Third witness OR accept manual promotion only
- [ ] Patroni/repmgr POC on **staging** clones
- [ ] PITR health unchanged (`check-pitr-health-68-replica.sh`)
- [ ] Rehearsal with `execute-failover-rehearsal.sh` on maintenance window

---

## Related docs

- `PRIYANSHU_HA_IMPLEMENTATION_AUDIT.md`
- `HA_MANAGER_EVALUATION.md`
- `HA_STATE_MACHINE.md`
- `MANUAL_FAILOVER_RUNBOOK.md`
