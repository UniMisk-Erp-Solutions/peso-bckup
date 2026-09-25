# Production L7 reference (PesoWise servers only)

**Branch `priyanshu` — documentation and example configs only.**

| Not in this folder | Detail |
|--------------------|--------|
| **GitHub `main`** | Unchanged by this branch’s app code |
| **Vercel app** | Still one `VITE_SUPABASE_URL`; no frontend routing changes |
| **Auto-deploy** | Nothing here is applied by CI; ops apply manually on `.46` |

Live stack (2025-09-25): **Traefik → HAProxy L7 → Kong `.46` / `.68` → primary / replica**.

Example files:

| File | Purpose |
|------|---------|
| `haproxy-l7-final.cfg.example` | L7 routing (reads → `.68`, writes/auth → `.46`) |
| `haproxy-leastconn-real-app.cfg.example` | Previous “real app” blind LB |
| `traefik-pesowise-lb.yaml.example` | Traefik upstream must use host IP (`192.168.23.46:8088`), not `127.0.0.1` inside Coolify proxy |

Server paths (hasto `.46`):

- HAProxy: `/data/coolify/proxy/haproxy-pesowise/haproxy.cfg`
- Traefik dynamic: `/data/coolify/proxy/dynamic/pesowise-supabase-load-balancer.yaml`
- Kong Pesowise: `/data/coolify/services/kar0ro1k6jiyfxzzw7acnsza/volumes/api/kong.yml`

Rollback: restore `haproxy.cfg.bak-before-46only-test` and restart `haproxy-pesowise-lb`.

See **`ARCHITECTURE-PRODUCTION-L7-REFERENCE.md`** at repo root for diagram and 10k benchmark summary.
