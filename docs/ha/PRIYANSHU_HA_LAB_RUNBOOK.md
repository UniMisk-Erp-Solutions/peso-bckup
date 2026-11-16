# Priyanshu HA lab — safe test runbook

**Branch:** `priyanshu` only.  
**Never** run these steps against `192.168.23.46` / `.68` production services.

---

## Prerequisites

- Git branch: `priyanshu`
- Bash (Git Bash or WSL on Windows)
- Optional: Docker Desktop for HAProxy mini-lab

---

## A. State-machine lifecycle (required)

```bash
cd peso-bckup-priyanshu
export PESOWISE_HA_LAB=1
bash scripts/ha/lab/run-ha-lab-tests.sh
```

**Expect:** `ALL_LAB_TESTS_PASS`

**Manual exploration:**

```bash
export PESOWISE_HA_LAB_ROOT=/tmp/my-ha-lab
bash scripts/ha/lab/ha-lab-state-machine.sh reset
bash scripts/ha/lab/ha-lab-state-machine.sh status
bash scripts/ha/lab/ha-lab-state-machine.sh fence-46
bash scripts/ha/lab/ha-lab-state-machine.sh promote-68
bash scripts/ha/lab/ha-lab-state-machine.sh status
```

---

## B. Docker HAProxy lab (optional)

```bash
docker compose -f tools/priyanshu-ha-lab/docker-compose.yml up -d
curl -s http://127.0.0.1:18088/
curl -s http://127.0.0.1:18088/health
# Stop app46 to simulate backend failure:
docker compose -f tools/priyanshu-ha-lab/docker-compose.yml stop app46
sleep 5
curl -s http://127.0.0.1:18088/   # should show app-node=68
docker compose -f tools/priyanshu-ha-lab/docker-compose.yml down
```

This validates **load balancing + health checks only** — not PostgreSQL.

---

## C. Scenarios mapped to simulator

| # | Scenario | Simulator command |
|---|----------|-------------------|
| 1 | App `.46` down | `simulate-app46-down` |
| 2 | HAProxy backend fail | `simulate-haproxy-backend-fail` |
| 3 | VIP owner fail | `simulate-vip-owner-down` + `simulate-keepalived-failover-to-68` |
| 4 | PG primary fail | `fence-46` (after health proves need) |
| 5 | Standby promotion | `promote-68` |
| 6 | App reconnect | `app-reconnect-68` |
| 7 | `.46` returns | `simulate-46-return` |
| 8 | `.46` rejoin standby | `rejoin-46-as-standby` |
| 9 | Catch-up | `catchup-complete` |
| 10 | Failback | `failback-promote-46` |
| 11 | `.68` standby again | `rejoin-68-as-standby` |
| 12 | Split-brain block | `attempt-unsafe-dual-write` → blocked |

---

## D. What this lab does NOT do

- Does not SSH to production
- Does not run `promote-standby.sh --execute` on real `.68`
- Does not change PITR/WAL/base backups
- Does not modify Coolify, HAProxy on `.46`, or DNS

---

## E. Relating lab to production scripts

Production manual scripts live in `scripts/ha/` (dry-run by default).  
Use lab to train operators on **order of operations**; use production runbooks only in approved maintenance with fencing proof.

---

## F. Cleanup

```bash
rm -rf "${PESOWISE_HA_LAB_ROOT:-/tmp/pesowise-ha-lab-test-*}"
docker compose -f tools/priyanshu-ha-lab/docker-compose.yml down -v 2>/dev/null || true
```
