# DB endpoint switch plan

## Current path (post L7 removal, 2026-09-25)

```text
Vercel app
  → https://pesowise-backup-supabase.unimisk.com
  → Traefik (.46)
  → HAProxy :8088 (all traffic → .46 Kong)
  → PostgreSQL primary (.46)
```

**`.68` is not in the HAProxy pool** for normal application traffic.

Postgres is **not** a single hostname for the app today:

- **REST reads** can hit **`.68` DB** (via local PostgREST).
- **Writes** hit **`.46` DB** via Kong on `.46`.

Internal DB connections use Docker service names / env on each host (`db`, `5432`, Supavisor pooler).

## Target (future)

One **logical write primary** endpoint for all services, e.g.:

- `pesowise-db-primary.internal:5432` (DNS or `/etc/hosts` on Coolify hosts), **or**
- HAProxy TCP/HTTP layer in front of **current primary only**, updated on failover.

## Failover switch (minimum)

| Layer | Normal | After promotion to `.68` |
|-------|--------|---------------------------|
| HAProxy L7 | Reads→`.68`, writes→`.46` | **Must repoint write backends to `.68`** |
| Kong `.46` | Primary REST/auth | Stop or read-only maintenance |
| Kong `.68` | Read replica REST | Becomes write + read |
| Supavisor / pooler | Points at local `db` | Ensure `.68` pooler is primary DSN |
| App URL | Unchanged public URL | Still Traefik→HAProxy on `.46` unless DNS moves |

## Tooling

- `scripts/ha/switch-db-primary.sh` — dry-run checklist; **not executed in production** until test window.
- Rollback: restore HAProxy backup `haproxy.cfg.bak-*` and reload `haproxy-pesowise-lb`.

## Not in scope yet

- Introducing `pesowise-db.internal` in production DNS.
- Changing Vercel env (single Supabase URL stays until deliberate cutover).
