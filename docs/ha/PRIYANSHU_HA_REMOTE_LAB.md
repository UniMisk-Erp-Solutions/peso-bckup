# Priyanshu HA lab on real `.46` / `.68` (isolated Docker)

**Does NOT** stop or reconfigure production Supabase, Kong, Coolify HAProxy, or app URLs.

---

## Isolation rules

| Item | Production | Lab only |
|------|------------|----------|
| Container names | `supabase-db-*` | `pesowise-ha-lab-*` |
| Postgres ports | 5432 / proxy paths | **54346** (.46), **54368** (.68) |
| App HTTP | Kong `:54321` | **18046** (.46 app mock), **18088** (.68 HAProxy) |
| Volumes | Coolify volumes | `pesowise-ha-lab-*-data` |

Deploy scripts **never** run `docker stop` on production container names.

---

## Layout

```text
.46  pesowise-ha-lab-pg46     :54346  (PRIMARY)
     pesowise-ha-lab-app46    :18046

.68  pesowise-ha-lab-pg68     :54368  (STANDBY → basebackup from .46:54346)
     pesowise-ha-lab-app68    (internal)
     pesowise-ha-lab-haproxy  :18088  → .46:18046 + app68
```

---

## Deploy (from your PC)

Pack once (Git Bash):

```bash
tar -czf tools/pesowise-ha-lab-remote.tar.gz -C tools priyanshu-ha-lab
```

Copy to both servers `/tmp/pesowise-ha-lab-remote.tar.gz` and scripts from `scripts/ha/lab/deploy-lab-on-*.sh`.

**On `.46`:**

```bash
sed -i 's/\r$//' /tmp/ha/deploy-lab-on-46.sh
bash /tmp/ha/deploy-lab-on-46.sh
```

**On `.68`:**

```bash
sed -i 's/\r$//' /tmp/ha/deploy-lab-on-68.sh
bash /tmp/ha/deploy-lab-on-68.sh
```

**Verify production still up:**

```bash
docker ps --filter name=supabase-db
```

---

## E2E checks (after both lab stacks up)

**On `.68`:**

```bash
bash /tmp/ha/run-remote-lab-e2e-on-68.sh
```

**Failover drill (orchestrator — stops LAB containers only on `.46`):**

```bash
# .46
docker stop pesowise-ha-lab-app46
# .68
curl -s http://127.0.0.1:18088/    # expect app-node=68
docker stop pesowise-ha-lab-pg46   # on .46 only
# .68
docker exec pesowise-ha-lab-pg68 psql -U postgres -c "SELECT pg_promote(true);"
```

---

## Status (last deploy attempt)

- **`.46`:** Lab **running** — `pesowise-ha-lab-pg46` (healthy), `pesowise-ha-lab-app46`, production `supabase-db-kar0ro1k6jiyfxzzw7acnsza` **still healthy**.
- **`.68`:** Deploy **pending** when SSH from operator network to `.68` is available (timeouts during automated run). Re-run `deploy-lab-on-68.sh` on the server.

---

## Firewall

Allow **`.68` → `.46:54346`** (lab PG only) if standby build fails.

---

## Teardown (lab only)

```bash
cd /tmp/pesowise-ha-lab
docker compose -f docker-compose.node46.yml down -v   # on .46
docker compose -f docker-compose.node68.yml down -v   # on .68
```

Production stacks are unaffected.
