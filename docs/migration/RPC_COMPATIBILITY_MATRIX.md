# RPC compatibility matrix (staging backend)

| RPC | Purpose | Current caller | Uses auth.uid()/JWT context | SECURITY DEFINER | Supabase role | Supabase extension | Works on plain Postgres v2 | Target action |
|-----|---------|----------------|-----------------------------|------------------|---------------|-------------------|---------------------------|---------------|
| `review_verify_expense(uuid, text)` | Engineer/manager verify step | `backend/src/routes/expenses.ts` | Yes (`auth.uid()` inside function) | Yes | GRANT to `authenticated` (not restored) | No | **Yes** with `set_config('request.jwt.claim.sub', …)` | **KEEP** |
| `review_approve_expense(uuid, text)` | Approve expense / balance effects | `backend/src/routes/expenses.ts` | Yes | Yes | GRANT to `authenticated` (not restored) | No | **Yes** with JWT claim bridge | **KEEP** |
| `reviewer_can_act_on_expense(uuid)` | Authorization gate before review RPCs | `backend/src/routes/expenses.ts` | Yes | Yes | GRANT to `authenticated` (not restored) | No | **Yes** with JWT claim bridge | **KEEP** |

## Notes

- Staging API does **not** call PostgREST; it invokes the above functions over a direct PostgreSQL connection as `pesowise_migration`.
- Missing roles `authenticated` / `anon` affect **RLS policy creation** during restore, not `SECURITY DEFINER` execution when connected as table owner.
- `auth.uid()` on v2 must resolve via Supabase-compatible `request.jwt.claim.sub` session setting (verified during staging auth tests).

## Frontend (not yet migrated to API)

All other `supabase.rpc(...)` usages in `src/` remain on production Supabase until cutover. They are **out of scope** for staging API validation except as documented compatibility debt.
