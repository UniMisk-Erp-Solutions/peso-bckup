# Production proxy reference (PesoWise — `.46` primary only)

**Branch `priyanshu` — example configs for ops; not applied by CI.**

| Item | Detail |
|------|--------|
| **Public URL** | `https://pesowise-backup-supabase.unimisk.com` |
| **Path** | Traefik (TLS, `.46`) → HAProxy `:8088` → Kong `.46` → PostgreSQL primary |
| **`.68`** | PostgreSQL replica / HA target only — **not** in HAProxy pool |
| **Vercel** | Unchanged `VITE_SUPABASE_URL` pointing at public Supabase URL |

| File | Purpose |
|------|---------|
| `haproxy-pesowise-46-only.cfg.example` | All Supabase API traffic → `192.168.23.46:54321` |
| `traefik-pesowise-lb.yaml.example` | Traefik upstream `http://192.168.23.46:8088` (not `127.0.0.1` inside Coolify proxy) |

Server paths on `.46` (hasto):

- HAProxy: `/data/coolify/proxy/haproxy-pesowise/haproxy.cfg`
- Traefik dynamic: `/data/coolify/proxy/dynamic/pesowise-supabase-load-balancer.yaml`

Rollback HAProxy: restore `haproxy.cfg.bak-priyanshu-l7-haproxy-*` or prior backup, then restart `haproxy-pesowise-lb`.

Removed (L7 experiment): `haproxy-l7-final.cfg.example`, `haproxy-leastconn-real-app.cfg.example`, `tools/localhost-arch-lab/`.
