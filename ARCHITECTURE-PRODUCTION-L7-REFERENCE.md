# Production L7 architecture (reference — branch `priyanshu`)

Documents the **live** PesoWise Supabase path on **192.168.23.46 + 192.168.23.68**.  
**Does not change:** GitHub **`main`**, Vercel build, or React app code (still one Supabase URL).

---

## Diagram (live)

```text
Users → pesowise.unimisk.com (Vercel SPA, unchanged)
     → https://pesowise-backup-supabase.unimisk.com
     → Traefik (TLS, .46) → HAProxy :8088 (L7)
     → GET/HEAD/OPTIONS /rest|graphql → .68 Kong → replica
     → writes, /auth, /storage, /realtime, /functions → .46 Kong → primary
```

Kong on **`.68`**: `rest-v1-read` → local PostgREST (replica); `rest-v1-write` → proxy `.46:54321`.  
Kong on **`.46`**: `rest-v1-read` + `rest-v1-write` → local primary.

Example configs: **`tools/prod-reference/`**.

---

## vs first “real app” archi

| | Real app (old) | New L7 (live) |
|---|----------------|---------------|
| HAProxy | `leastconn` 50/50 | Method/path ACLs |
| REST reads | Often primary when traffic hit `.46` Kong | Steered to `.68` at HAProxy |
| App / Vercel | One URL | **Same** |

---

## 10k mixed benchmark (2025-09-25, HAProxy `:8088`, 40 workers)

| Metric | Real app (`leastconn`) | New L7 |
|--------|------------------------|--------|
| Duration | **62.5 s** | 84.2 s |
| RPS | **160** | 119 |
| **502** | **88** | **0** |
| p50 latency | 60 ms | **21 ms** |
| Peak load `.46` | 10.8 | **9.6** |
| Peak load `.68` | 8.45 | **7.9** |

**Recommendation:** Keep **L7** for production stability and read routing; `leastconn` is faster on synthetic burst but returned **502** under the same test.

Bench scripts (no secrets in repo): **`tools/localhost-arch-lab/bench_*.example`**.

---

## Local lab (unchanged scope)

PC-only gateway + optional Docker sidecars — see **`ARCHITECTURE-L7-DUAL.md`**.  
Local app uses **`http://127.0.0.1:8787/lab/l7-dual`**, not the public URL.
