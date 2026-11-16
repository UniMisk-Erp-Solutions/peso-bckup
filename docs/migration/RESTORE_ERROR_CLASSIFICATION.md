# PesoWise pg_restore error classification

After restoring the verified dump into disposable database `pesowise_restore_audit` on `pesowise-postgres-migration-v2`:

| Metric | Value |
|--------|--------|
| Total `pg_restore` errors | **542** |
| Warnings | 1 |
| Primary v2 DB (`pesowise`) data match | **Full integrity PASS** (0 public table mismatches) |

## Error classes

| ID | Class | Approx. count | Safe to ignore for API migration? | Notes |
|----|--------|---------------|-----------------------------------|--------|
| **1** | Missing role `postgres` | 381 | Yes | Grants only |
| **2** | Missing role `authenticated` | 94 | Yes | RLS policies not applied; backend enforces RBAC |
| **3** | Missing role `dashboard_user` | 34 | Yes | Supabase Studio role |
| **4** | Missing role `service_role` / `anon` | 14 | Yes | JWT roles |
| **5** | Missing extensions (`pg_net`, `pg_graphql`, `pgjwt`, `supabase_vault`) | 21 | Mostly yes | Edge/graphql/net not in target stack |
| **6** | Missing `vault.*` | 3 | Yes | Supabase vault |
| **7** | Missing schema `net` | 1 | Yes | pg_net |
| **8** | Other function/extension comments | remainder | Case-by-case | No public data impact observed |

**Not errors:** Table data for `public.*`, `auth.*`, and `storage.*` restored successfully on v2.

## Artifacts on `.46`

- `/tmp/pesowise-migration-backup/restore-errors-classify.log`
- `/tmp/pesowise-migration-backup/restore-error-classification.txt`

## Gate impact

- **Gate E (UUID/data):** PASS  
- **Gate F (files):** PASS via MinIO `stub` mirror (`mc diff` 0)  
- Cutover still blocked on auth/preview/staging validation (G, I, J)

See also: [`GATE_STATUS_PRE_CUTOVER.md`](GATE_STATUS_PRE_CUTOVER.md)
