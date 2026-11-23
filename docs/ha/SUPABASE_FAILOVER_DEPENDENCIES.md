# Supabase failover dependencies

| SERVICE | DB CONNECTION (normal) | RESTART NEEDED? | STATEFUL? | FAILOVER ACTION |
|---------|-------------------------|-----------------|-----------|-----------------|
| Postgres `.46` | local PGDATA | — | Yes | Fence/stop before promote `.68` |
| Postgres `.68` | standby → `.46` | promote + restart if stuck | Yes | `pg_promote()` after fence |
| Kong `.46` | local primary stack | reload routes | No | Maintenance; stop write routes or whole stack |
| Kong `.68` | local + proxy write to `.46` | **yes** | No | Point write upstreams to local DB after promotion |
| PostgREST `.46` / `.68` | pooler/db container | restart | No | Restart on host that becomes primary |
| GoTrue Auth | DB via env | restart | JWT keys on `.46` | **Risk:** auth DB must match promoted primary |
| Storage API | DB + Minio | restart | Minio data on each host | Align DB + object store (same Minio or shared — audit before failover) |
| Realtime | logical replication | restart | Yes | Single primary only — avoid duplicate Realtime writers |
| Supavisor | connection pool | reload/restart | No | Update primary DSN |
| Studio | meta | optional | No | Point at new primary |
| HAProxy L7 | no direct DB | reload | No | **Repoint write backends** per `DB_ENDPOINT_SWITCH_PLAN.md` |
| Traefik | routes to HAProxy | reload | No | Usually unchanged if HAProxy on `.46` stays entry |

## Rules

- Do not start a **second writable** Realtime/Auth stack against old primary.
- Do not blindly duplicate Minio without storage parity plan.
- PITR remains on **current primary** only — see `PITR_AFTER_FAILOVER.md`.
