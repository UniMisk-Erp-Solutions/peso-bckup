# PesoWise — branch `priyanshu` (local lab + production L7 **reference**)

This folder is a **full copy** of the app for local testing. **GitHub `main`, Vercel, and production React code paths are unchanged** (still one public Supabase URL in prod).

## Architecture docs

| Doc | Purpose |
|-----|---------|
| **`ARCHITECTURE-L7-DUAL.md`** | Local PC lab (`8787`, optional Redis/PgBouncer Docker) |
| **`ARCHITECTURE-PRODUCTION-L7-REFERENCE.md`** | Live **L7 HAProxy** on `.46`/`.68` (reference only) |
| **`tools/prod-reference/`** | Example HAProxy / Traefik configs (not auto-deployed) |

## Architecture

```text
Browser (:5174)
  → http://127.0.0.1:8787/lab/l7-dual
  → writes / auth / storage / realtime → .46 Kong → primary
  → REST reads ~50% .46 (primary) / ~50% .68 (replica)
```

(Replaces the old **greatest** all-reads-to-.68 lab model.)

## Run (two terminals)

**Terminal 1 — gateway**

```bash
cd tools/localhost-arch-lab
# or: cd ../localhost-arch-lab  (sibling folder on your PC)
node server.cjs
```

**Terminal 2 — app**

```bash
npm install
npm run dev
```

Open **http://localhost:5174**

Config: **`.env.local`** → `VITE_SUPABASE_URL=http://127.0.0.1:8787/lab/l7-dual`

## Git (this branch vs `main`)

**Only** these paths differ from **`main`** — same app code as production:

- `ARCHITECTURE-PRODUCTION-L7-REFERENCE.md`
- `ARCHITECTURE-L7-DUAL.md`
- `README-PRIYANSHU.md`
- `.env.local.example` (local lab URL only)
- `tools/prod-reference/` (example HAProxy / Traefik)
- `tools/localhost-arch-lab/` (gateway + optional Docker sidecars + bench examples)

No duplicate app copy, no `vite.config` changes, no SQL/script churn on this branch.
