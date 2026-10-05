# PesoWise — branch `priyanshu`

Ops-focused work on this branch: **PITR/recovery**, **manual HA** docs/scripts, and production proxy reference under `tools/prod-reference/`.

## Production (normal path)

```text
App (Vercel) → https://pesowise-backup-supabase.unimisk.com
            → Traefik → HAProxy :8088 → Kong on .46 → PostgreSQL primary (.46)
```

**`.68`** is a PostgreSQL replica for HA/failover planning — not an application read target.

## Local development

Copy `.env.local.example` → `.env.local` and set:

- `VITE_SUPABASE_URL=https://pesowise-backup-supabase.unimisk.com` (or your documented self-hosted URL from root `.env.example`)

Do **not** use the removed localhost L7 lab gateway (`8787`, `/lab/l7-dual`).

### HA lab (local, safe)

```powershell
powershell -ExecutionPolicy Bypass -File scripts/ha/lab/run-priyanshu-ha-e2e.ps1
```

Or double-click / cmd:

```bat
scripts\ha\lab\run-priyanshu-ha-e2e.bat
```

Or:

```bash
node scripts/ha/lab/ha-e2e.mjs
```

See `docs/ha/PRIYANSHU_HA_E2E_SYSTEM.md` (full end-to-end) and `docs/ha/HA_AUTOMATIC_FAILOVER_FAILBACK.md`.

## Key folders

| Path | Purpose |
|------|---------|
| `docs/recovery/` | PITR runbooks and audits |
| `docs/ha/` | Manual failover (not automatic) |
| `docs/architecture/` | Architecture change notes (e.g. L7 removal) |
| `scripts/recovery/` | PITR scripts |
| `scripts/ha/` | Manual HA scripts |
| `scripts/ha/lab/` | **Local HA simulator + tests (safe)** |
| `tools/priyanshu-ha-lab/` | Optional Docker HAProxy dual-app lab |
| `tools/prod-reference/` | HAProxy/Traefik **examples** for `.46` |
| `docs/migration/` | Supabase → Postgres/MinIO migration (Coolify, cutover, pgAdmin) |
| `scripts/migration/` | Runnable `.46` migration scripts (no `tmp-*`) |
| `backend/` | Fastify migration API (when using `VITE_API_URL`) |

## Removed

The **L7 dual-read experiment** (local `localhost-arch-lab`, production HAProxy read→`.68`) has been removed from this repo. See `docs/architecture/L7_REMOVAL_FINAL.md`.
