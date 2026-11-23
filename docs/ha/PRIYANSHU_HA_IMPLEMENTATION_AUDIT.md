# Priyanshu branch — HA implementation audit

**Date:** 2026-09-29  
**Branch:** `priyanshu`  
**Production:** **not modified** by this audit (repo-only).

---

## CURRENT PRIYANSHU HA IMPLEMENTATION

| Area | Status |
|------|--------|
| Target topology | Documented as **manual** HA: `.46` PRIMARY, `.68` STANDBY + PITR on `.68` |
| Automatic VIP + dual-app + auto DB promotion | **Not implemented on real servers** — design target for future |
| Local L7 lab | **Removed** (`tools/localhost-arch-lab/` deleted on branch) |
| New Priyanshu HA lab | **`tools/priyanshu-ha-lab/`** + **`scripts/ha/lab/`** (this work) |

---

## EXISTING FILES (reused)

### `scripts/ha/` (production-oriented, manual execute)

| Script | Role |
|--------|------|
| `check-failover-safety.sh` | Refuses promotion unless fenced + lag + HA lock |
| `promote-standby.sh` | `pg_promote` on `.68` (dry-run default) |
| `ha-lock.sh` | Operator lock under `/var/lib/pesowise-ha/` |
| `fence-primary-46.sh` / `fence-primary-68.sh` | Fencing helpers |
| `switch-haproxy-primary.sh` | Repoint HAProxy Kong backend (`.46` ↔ `.68`) |
| `switch-db-primary.sh` | DB endpoint switch plan |
| `rejoin-46-from-68.sh` / `rejoin-old-primary.sh` | Rejoin after promotion |
| `rebuild-68-standby.sh` / `rebuild-46-standby.sh` | Standby rebuild |
| `prepare-primary-46-for-68-standby.sh` | Slots + `pg_hba` on primary |
| `setup-repl-proxy-46.sh` | Repl proxy on `.46` |
| `check-ha-health.sh` | Health probes |
| `execute-failover-rehearsal.sh` / `manual-failover-rehearsal.sh` | Rehearsal wrappers |
| `wait-catchup-68.sh` | Lag wait before failback |

### `docs/ha/`

| Doc | Role |
|-----|------|
| `HA_STATE_MACHINE.md` | Manual state transitions |
| `SPLIT_BRAIN_PREVENTION.md` | Fencing, lock, no auto-promote |
| `HA_PRODUCTION_READINESS_FINAL.md` | Current **real** layout (reference only) |
| `MANUAL_FAILOVER_RUNBOOK.md` | Operator runbook |
| `DB_ENDPOINT_SWITCH_PLAN.md` | App DB target switching |

### `scripts/recovery/` / `docs/recovery/`

PITR WAL/base/restore — **unchanged by HA lab work** (separate concern).

---

## EXISTING SIMULATORS

| Simulator | Notes |
|-----------|--------|
| `scripts/recovery/run-e2e-pitr-test.sh` | Docker PITR only — **not** HA failover |
| Former `tools/localhost-arch-lab/` | **Removed** — do not revive for production paths |
| **`tools/priyanshu-ha-lab/`** | **New** — VIP/HAProxy/DB role simulation (local) |
| **`scripts/ha/lab/ha-lab-state-machine.sh`** | **New** — full lifecycle + split-brain guards |

---

## EXISTING REPLICATION LOGIC

- Streaming standby `.46` → `.68` documented and scripted for **real hosts** (rebuild/rejoin).
- Lab uses **logical replication roles** in simulator (`primary_writable` flags), not live `192.168.23.x` SSH.

---

## EXISTING HAProxy LOGIC

- `switch-haproxy-primary.sh` — single-backend cutover on **real** `.46` HAProxy path.
- `tools/prod-reference/haproxy-pesowise-46-only.cfg.example` — `.46`-only reference.
- Lab: **`tools/priyanshu-ha-lab/haproxy/haproxy.cfg.example`** — dual backend `leastconn` + HTTP checks.

---

## EXISTING HEALTH CHECKS

- `check-ha-health.sh`, `check-failover-safety.sh`, PITR health scripts on `.68`.
- Lab: mock app `/health` + HAProxy `option httpchk`.

---

## MISSING PIECES (addressed on `priyanshu`)

| Gap | Addition |
|-----|----------|
| Keepalived + VIP failover design | `HA_AUTOMATIC_FAILOVER_FAILBACK.md` |
| Dual-app HAProxy `least_conn` | Lab HAProxy example + simulator |
| Automatic HA manager choice | `HA_MANAGER_EVALUATION.md` |
| Safe local lifecycle tests (12 scenarios) | `scripts/ha/lab/run-ha-lab-tests.sh` |
| Priyanshu runbook | `PRIYANSHU_HA_LAB_RUNBOOK.md` |
| Two-node quorum/fencing honesty | Documented in failback doc + tests |

---

## Production touch policy

All scripts under `scripts/ha/lab/` and `tools/priyanshu-ha-lab/` **refuse** to run when `PESOWISE_HA_LAB=1` is unset against production IPs (guard in state machine).

Real `.46` / `.68` scripts remain **manual, dry-run by default** — unchanged behavior.
