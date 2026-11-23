# PesoWise production cutover — completed 2026-09-30

**Host:** `192.168.23.46`  
**Log:** `/tmp/pesowise-migration-backup/cutover-20260930T083626Z.log`

## Active production path

| Layer | Service | Endpoint |
|-------|---------|----------|
| Frontend | `pesowise-frontend` (nginx) | `http://192.168.23.46:4173` |
| API | `pesowise-api` | `http://192.168.23.46:8787` |
| PostgreSQL | `pesowise-postgres-migration-v2` | `127.0.0.1:15432` |
| Object storage | `pesowise-minio-migration-v2` | `127.0.0.1:19000` |

Build: `VITE_API_URL=http://192.168.23.46:8787` (no Supabase URL in production image env).

## Pre-switch

- Source backup: `/tmp/pesowise-migration-backup/pesowise-20260930T083626Z.dump`
- Compare source ↔ v2: **all YES** (no full re-restore required)

## Post-switch checks

- `POST_CUTOVER_PASS`
- `RUNTIME_PROXY_AUDIT=PASS` on `:4173` + `:8787`
- Production HTML: **no** Kong/54321/REST/Auth/Storage markers

## Old Supabase (preserved — not deleted)

`supabase-*-kar0ro1k6jiyfxzzw7acnsza` — **healthy**, all volumes intact.

| | |
|--|--|
| STACK / DB / AUTH / STORAGE / MINIO / VOLUMES | **YES** |
| DATA / OBJECTS / VOLUMES DELETED | **NO** |
| ROLLBACK COPY PRESERVED | **YES** |

## Follow-ups (non-blocking for switch)

- Register `pesowise-primary-postgres` / Coolify labels for ad-hoc containers
- Expand API + stub for any UI paths still missing server routes
- True off-host backup (`.68` unreachable); secondary copy at `pesowise-backup/migration-v2`
- Cloudflare/public URL: ensure tunnel targets `:4173` and browser can reach `:8787` (or add reverse proxy for API)

## Scripts

- `scripts/migration/production-cutover-46.sh`
- `scripts/migration/deploy-production-api-46.sh`
- `scripts/migration/verify-post-cutover-46.sh`
