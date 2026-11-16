# L7 dual-read removal — final report

**Date:** 2026-09-25  
**Branch:** `priyanshu` (local working tree)  
**Status:** **Complete** per success criteria below

---

## A. Files deleted (repo)

- `tools/localhost-arch-lab/` (entire tree)
- `ARCHITECTURE-L7-DUAL.md`
- `ARCHITECTURE-PRODUCTION-L7-REFERENCE.md`
- `tools/prod-reference/haproxy-l7-final.cfg.example`
- `tools/prod-reference/haproxy-leastconn-real-app.cfg.example`

## B. Files edited

- `README-PRIYANSHU.md` — normal `.46` production path only
- `tools/prod-reference/README.md` — `.46`-only reference
- `.env.local.example`, `.env.local` — `https://pesowise-backup-supabase.unimisk.com`
- `docs/ha/STANDBY_READ_VALIDATION.md`, `docs/ha/DB_ENDPOINT_SWITCH_PLAN.md` — L7 removed
- **Added:** `tools/prod-reference/haproxy-pesowise-46-only.cfg.example`
- **Added:** `docs/architecture/L7_REMOVAL_AUDIT.md`

## C. Env changes

| File | Before | After |
|------|--------|--------|
| `.env.local.example` | `http://127.0.0.1:8787/lab/l7-dual` | `https://pesowise-backup-supabase.unimisk.com` |
| `.env.local` | L7 lab URL | same production URL |

Vercel / production app env: **unchanged** (already public Supabase URL).

## D. Services / processes stopped

- **Local PC:** Node listener on **port 8787** stopped (experimental gateway).
- **Production:** `haproxy-pesowise-lb` restarted with new config (not removed).

## E. Server artifacts removed / changed

| Location | Action |
|----------|--------|
| `/data/coolify/proxy/haproxy-pesowise/haproxy.cfg` | Replaced with **`.46`-only** backend (no `.68`) |
| Backup | `haproxy.cfg.bak-before-l7-removal-20260925` (prior L7 config) |
| Rollback L7 | `haproxy.cfg.bak-priyanshu-l7-haproxy-20260925-114558` still on disk |

Post-change check: `curl http://127.0.0.1:8088/auth/v1/health` → **401** (Kong on `.46` reachable).  
**PITR:** `check-pitr-health.sh` → **OVERALL: PASS** (unchanged).

## F. Routes removed

- Production HAProxy ACLs: `be_pesowise_read` → `.68` **removed**
- Local: `/lab/l7-dual`, `/lab/greatest`, `/lab/current` (repo lab deleted)

## G. `.68` references intentionally retained

- `docs/ha/*`, `scripts/ha/*` — replication, failover, lag audits
- `docs/recovery/*`, `scripts/recovery/*` — PITR, pg_hba `192.168.23.68/32` replication
- `.68` Supabase stack on server — **not modified** (Postgres replica only)

## H. Final application routing

```text
PesoWise frontend (Vercel)
    ↓
https://pesowise-backup-supabase.unimisk.com
    ↓
Traefik (.46) → HAProxy :8088 → Kong .46:54321 → PostgreSQL primary (.46)
```

No HAProxy or normal app path sends API traffic to `.68`.

## I. Git branch affected

**`priyanshu`** — deletions/edits local; **no commit/push** performed by this task unless you request it.

## J. Remaining outside repo (manual cleanup optional)

- **`test project/localhost-arch-lab/`** (sibling folder) may still exist on disk with old lab + duplicate app copy — **not deleted** automatically (outside `peso-bckup-priyanshu` repo). Remove manually if desired.
- **Kong on `.68`** may still define read routes locally; unused while HAProxy sends all traffic to `.46`.

## K. Recommended commit message

```text
Remove L7 dual-read experiment; route all Supabase traffic to .46 primary.

Delete localhost-arch-lab and L7 HAProxy examples; document .46-only proxy.
Production HAProxy on .46 updated to single-backend config.
```

## L. Rollback

**Server HAProxy (restore L7):**

```bash
sudo cp /data/coolify/proxy/haproxy-pesowise/haproxy.cfg.bak-before-l7-removal-20260925 \
        /data/coolify/proxy/haproxy-pesowise/haproxy.cfg
sudo docker restart haproxy-pesowise-lb
```

**Git:** restore deleted files from last commit before this change.

---

## Success criteria

| Criterion | Met |
|-----------|-----|
| No `/lab/l7-dual` in repo | Yes |
| No 50/50 `.46/.68` read routing in repo prod examples | Yes |
| No env → L7 lab gateway | Yes |
| Local 8787 gateway stopped | Yes |
| Production HAProxy → `.46` only | Yes |
| `.68` replica / HA / PITR untouched | Yes |
| PITR healthy | Yes |
| HA docs/scripts kept | Yes |
