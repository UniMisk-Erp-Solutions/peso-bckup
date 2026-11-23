# L7 dual-read removal audit

**Date:** 2026-09-25  
**Scope:** PesoWise repo + production HAProxy on `.46`  
**Action:** Remove experimental L7 / dual-read routing; route all app traffic to `.46`.

| PATH | REFERENCE | PURPOSE | SAFE TO DELETE? | ACTION |
|------|-----------|---------|-----------------|--------|
| `tools/localhost-arch-lab/` | `/lab/l7-dual`, `8787`, `server.cjs` | Local PC L7/greatest/leastconn lab | **Yes** | Delete entire directory |
| `ARCHITECTURE-L7-DUAL.md` | Local L7 diagram | Lab docs | **Yes** | Delete |
| `ARCHITECTURE-PRODUCTION-L7-REFERENCE.md` | Live L7 HAProxy doc | Production L7 reference | **Yes** | Delete |
| `README-PRIYANSHU.md` | L7 lab instructions | Branch readme | **No** | Rewrite (remove L7) |
| `.env.local.example` | `8787/lab/l7-dual` | Dev env template | **No** | Point to normal Supabase URL |
| `.env.local` (local) | `8787/lab/l7-dual` | Developer machine | **No** | Replace with production backup URL |
| `tools/prod-reference/haproxy-l7-final.cfg.example` | REST read → `.68` | L7 production example | **Yes** | Delete |
| `tools/prod-reference/haproxy-leastconn-real-app.cfg.example` | 50/50 `.46`/`.68` | Prior LB experiment | **Yes** | Delete |
| `tools/prod-reference/README.md` | L7 live stack | Ops notes | **No** | Rewrite for `.46`-only |
| `tools/prod-reference/traefik-pesowise-lb.yaml.example` | Traefik → `:8088` | Production Traefik | **Yes** | **Keep** (no `.68` in file) |
| `docs/ha/*` | Mentions L7 as current | HA / failover | **No** | Minor wording updates only |
| `scripts/ha/*`, `docs/recovery/*` | `.68` replication/PITR | HA/PITR | **No** | **Keep** |
| `/data/coolify/proxy/haproxy-pesowise/haproxy.cfg` (`.46`) | `be_pesowise_read` → `.68` | **Live L7 production** | **No** | Replace with `.46`-only config + reload |
| `haproxy.cfg.bak-*` on server | Backups | Rollback | **Yes** | **Keep** backups; add new `.46`-only backup |
| Kong `kong.yml` (`.46`/`.68`) | `rest-v1-read` | API gateway | **No** | Not changed (HAProxy is app entry); `.68` Kong unused when HAProxy is `.46`-only |
| Vercel production app | `pesowise-backup-supabase.unimisk.com` | Normal prod | **No** | Unchanged |
| Git branch `priyanshu` | L7 commit history | Version control | **No** | Forward delete only; no history rewrite |

## Normal production endpoint (from existing config)

- **Public Supabase URL:** `https://pesowise-backup-supabase.unimisk.com` (Traefik → HAProxy `:8088` on `.46` → Kong `.46`)
- **Local dev:** use same URL or self-hosted URL from `.env.example` comments — **not** `8787/lab/*`

## Invalid vs valid `.68` references after removal

| Valid | Invalid |
|-------|---------|
| Postgres replication, HA scripts/docs | REST GET via HAProxy to `.68` |
| Failover planning | PostgREST read pool to `.68` for normal app |
| PITR / audits | `/lab/l7-dual`, `/lab/greatest` |
