# HA manager evaluation (Priyanshu design)

**Scope:** Choose tooling for **future** automatic PostgreSQL promotion/switchover.  
**Current production:** manual scripts only — **no change required for PITR**.

---

## Candidates

| Tool | Fits PesoWise? | Pros | Cons |
|------|----------------|------|------|
| **Manual + existing scripts** | **Today** | Already deployed; explicit operator confirm; aligns with `check-failover-safety.sh` | No automatic failover |
| **repmgr** | Moderate | Lightweight; familiar streaming replication; switchover/follow commands | **Two-node** still needs witness/fencing for safe auto-failover |
| **Patroni** | Strong for auto | DCS (etcd/consul), leader election, REST API, switchover | Extra infra; Coolify/Docker integration work; still needs **fencing** for split-brain |
| **PgBouncer + external orchestrator** | Partial | Connection pooling | Does not replace promotion logic |

---

## Recommendation (Priyanshu branch)

1. **Phase 1 (now):** Manual HA + lab simulator — prove state machine and runbooks.
2. **Phase 2 (production auto):** **Patroni** *or* **repmgr** only after:
   - Stable **DB endpoint** (VIP or DNS) apps use
   - **Fencing** of old primary (STONITH or guaranteed shutdown via hypervisor/API)
   - **Third witness** (etcd on small VM, or cloud witness) for 2-node **automatic** promotion
3. **Do not** enable automatic promotion on raw two-node without witness — see `SPLIT_BRAIN_PREVENTION.md`.

---

## Mapping to proposed architecture

| Component | repmgr | Patroni |
|-----------|--------|---------|
| VIP (Keepalived) | Orthogonal — VIP tracks **app**, not Postgres leader | Same — Patroni does not replace Keepalived |
| HAProxy app LB | Orthogonal | Orthogonal |
| Promotion | `repmgr standby promote` | REST `POST /failover` |
| Rejoin | `repmgr node rejoin` / clone | `reinit` / `pg_rewind` via operator |
| Split-brain | Requires `repmgrd` + primary visibility checks + fence | Requires DCS + `nofailover` tags + fence |

---

## PITR boundary

**Neither** repmgr nor Patroni replaces **`pg_receivewal` + base backups on `.68`**. Keep PITR scripts and slots (`pesowise_pitr`) independent of HA manager election.
