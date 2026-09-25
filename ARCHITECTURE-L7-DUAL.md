# L7 dual-stack architecture (your diagram) — with Redis + PgBouncer

**Scope:** Branch **`priyanshu`** + **`tools/localhost-arch-lab`** (local PC only).  
**Does not change:** GitHub **`main`**, Vercel app, or production React routing.

Live server L7 (HAProxy + Kong) is documented separately in **`ARCHITECTURE-PRODUCTION-L7-REFERENCE.md`** and **`tools/prod-reference/`** — reference copies only, not applied from this repo by CI.

---

## Why Redis + PgBouncer were not on real servers

| Reason | Detail |
|--------|--------|
| **Your rule** | “Do not touch real app or archi” — installing Redis/PgBouncer on **`.46`/`.68`** is **production infra change** (Coolify, RAM, ports). |
| **`.68` RAM (~3.4 GB)** | Kong + replica + **Redis + PgBouncer** together is **tight**; needs sizing plan. |
| **PesoWise app code** | React app uses **Supabase JS → Kong**; it does **not** talk to Redis/PgBouncer directly today. Those sit **behind** Kong (Supavisor ≈ pooler on real stack). |
| **What we did instead** | Run **Redis + PgBouncer on your PC** in Docker to **match your diagram slots** without changing production. |

To put Redis + PgBouncer on **real `.46`/`.68`**, the **repo owner** must approve a **PesoWise-only** Coolify change (separate task).

---

## Your diagram (full stack)

```text
[ Users / Clients ]  →  localhost:5174 (peso-bckup-priyanshu)
                        │
                        ▼
         [ HAProxy / Traefik ]  →  127.0.0.1:8787/lab/l7-dual  (Node gateway)
                        │
         ┌──────────────┴──────────────┐
         ▼                             ▼
┌──────────────────┐          ┌──────────────────┐
│  SERVER 1 (.46)  │          │  SERVER 2 (.68)  │
│ • Kong (LAN)     │          │ • Kong (LAN)     │
│ • Local Redis    │          │ • Local Redis    │  ← Docker on PC :6379 / :6380
│ • PgBouncer      │          │ • PgBouncer      │  ← Docker on PC :6432 / :6433
│ • Primary DB     │◄─Async──►│ • Read Replica   │  ← real on LAN via Kong API
│   writes/auth    │   (real) │   read-heavy     │
│   + 50% reads    │          │                  │
└──────────────────┘          └──────────────────┘
```

**Real Pesowise data** still flows: **App → gateway → `.46`/`.68` Kong → Supabase** (unchanged on servers).

**Local sidecars** mirror **Redis + PgBouncer** using **sim Postgres** inside Docker (not your production database).

---

## Start full local architecture (3 steps)

**1 — Sidecars (Redis + PgBouncer × 2)** — requires [Docker Desktop](https://www.docker.com/products/docker-desktop/)

```powershell
cd "...\test project\localhost-arch-lab"
docker compose -f docker-compose.l7.yml up -d
```

| Service | Port |
|---------|------|
| Redis (.46 slot) | **6379** |
| Redis (.68 slot) | **6380** |
| PgBouncer (.46 slot) | **6432** |
| PgBouncer (.68 slot) | **6433** |

**2 — Gateway**

```powershell
& "C:\Program Files\nodejs\node.exe" server.cjs
```

Check: **http://127.0.0.1:8787/lab/stats** → `"sidecars"` should show `"up": true` for each when Docker is running.

**3 — App**

```powershell
cd "...\peso-bckup-priyanshu"
& "C:\Program Files\nodejs\npm.cmd" run dev
```

**`.env.local`:** `VITE_SUPABASE_URL=http://127.0.0.1:8787/lab/l7-dual`

---

## Production vs local

| Component | **Production (unchanged)** | **Your lab (priyanshu)** |
|-----------|----------------------------|---------------------------|
| Kong | `.46` / `.68` Coolify | Same LAN URLs via gateway |
| Redis | Not added by this project | **Local Docker** |
| PgBouncer | Supavisor in Supabase stack (existing) | **Local Docker** → sim Postgres |
| Primary / replica | Real Postgres | Real via Kong; sim Postgres for pooler demo only |

---

## Optional later (owner approval only)

- Enable **Redis** on **`.46` first**, then **`.68`** if RAM allows.  
- Tune **Supavisor** (PgBouncer-class pooler) on both stacks.  
- Wire Kong rate limits / cache to Redis.  

**None of that runs until explicitly approved — not part of this local package.**
