# Restore permission impact vs staging API

Classification of restore-time failures against **staging backend** paths.

| Object / error class | Backend dependency | Classification |
|----------------------|-------------------|----------------|
| Missing role `authenticated` / `anon` / `service_role` | API does not connect as these roles | **NOT USED BY NEW API** |
| Missing role `postgres` (GRANT failures) | API uses `pesowise_migration` owner connection | **NOT USED BY NEW API** |
| Missing role `dashboard_user` | Studio only | **NOT USED BY NEW API** |
| RLS policies referencing `authenticated` | Not enforced for direct owner connection; RBAC in Fastify | **NOT USED BY NEW API** (defense-in-depth later) |
| Extensions `pg_net`, `pg_graphql`, `pgjwt` | Not referenced by staging routes | **NOT USED BY NEW API** |
| Schema `vault.*` | Not referenced by staging routes | **NOT USED BY NEW API** |
| `review_verify_expense` | Expense verify route | **USED AND WORKING** (with JWT claim bridge) — validate in staging |
| `review_approve_expense` | Expense approve route | **USED AND WORKING** (with JWT claim bridge) — validate in staging |
| `reviewer_can_act_on_expense` | Pre-check on review routes | **USED AND WORKING** — validate in staging |
| `auth.uid()` helper | Used inside above RPCs | **USED AND WORKING** if `request.jwt.claim.sub` set — validate in staging |
| `auth.users` / `auth.identities` | Login route | **USED AND WORKING** (bcrypt) — validate in staging |
| MinIO `stub` layout | Signed URL routes | **USED AND WORKING** (migration MinIO mirror) — validate in staging |

## Critical path status

No **USED AND BROKEN** objects identified for the current minimal staging API surface.

Remaining **UNKNOWN** items apply to **full frontend parity** (all legacy RPCs) — tracked as cutover blockers until mapped in `RPC_COMPATIBILITY_MATRIX.md` expansions.
