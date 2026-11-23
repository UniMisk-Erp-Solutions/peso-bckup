# Priyanshu HA — end-to-end local system

Single entry point for **all** HA validation on branch `priyanshu`. **Does not** connect to `192.168.23.46` / `.68`.

---

## One command

**Windows (double-click or terminal):**

```bat
scripts\ha\lab\run-priyanshu-ha-e2e.bat
```

```powershell
powershell -ExecutionPolicy Bypass -File scripts/ha/lab/run-priyanshu-ha-e2e.ps1
```

```bash
npm run test:ha-e2e
```

**Git Bash (alternative):**

```bash
bash scripts/ha/lab/run-priyanshu-ha-e2e.sh
```

---

## Layers

| Layer | What it proves | Requires |
|-------|----------------|----------|
| **1 — State machine** | VIP/app/DB lifecycle, fence, promote, failback, split-brain block | Bash only |
| **2 — Docker lab** | HAProxy `leastconn`, app backend drain, PG `.46→.68` replication + `pg_promote` | Docker Desktop |

Reports: `tools/priyanshu-ha-lab/reports/`

---

## Stack (Docker)

| Service | Port | Role |
|---------|------|------|
| `haproxy` | **18088** | App load balancer |
| `vip-mock` | **18080** | Keepalived placeholder |
| `pg46` | **54346** | PostgreSQL PRIMARY |
| `pg68` | **54368** | PostgreSQL STANDBY → promoted in test |

```bash
docker compose -f tools/priyanshu-ha-lab/docker-compose.yml up -d
docker compose -f tools/priyanshu-ha-lab/docker-compose.yml down -v
```

---

## Production boundary

| Allowed locally | Never from this repo without explicit approval |
|-----------------|--------------------------------------------------|
| Simulator + Docker lab | `promote-standby.sh --execute` on real `.68` |
| Read production docs | Change Coolify / HAProxy / DNS on prod |
| `npm run test:ha-e2e` | Push to remote (unless you ask later) |

PITR scripts under `scripts/recovery/` are **unchanged** by the HA lab.

---

## Related docs

- `HA_AUTOMATIC_FAILOVER_FAILBACK.md` — target architecture
- `PRIYANSHU_HA_LAB_RUNBOOK.md` — step-by-step
- `PRIYANSHU_HA_IMPLEMENTATION_AUDIT.md` — what existed vs added
