# Localhost architecture lab (branch `priyanshu`)

**L7 dual-stack** replaces the old **greatest** lab mode. Does **not** change production.

| URL prefix | Behaviour |
|------------|-----------|
| `/lab/l7-dual/` | Target arch: 50% REST reads `.46` / 50% `.68`; writes/auth→`.46` |
| `/lab/greatest/` | Alias of `l7-dual` |
| `/lab/current/` | Blind leastconn (prod-like) |

App copy: `../peso-bckup-priyanshu` with `.env.local` → `http://127.0.0.1:8787/lab/l7-dual`

See **ARCHITECTURE-L7-DUAL.md**.
