# Pre-cutover gates (A–P)

**Overall:** `PARTIAL`  
**Decision:** **NOT READY FOR FINAL CUTOVER** (implementation advanced; validation gaps remain)  
**Cutover:** **NOT performed.** Production unchanged. **Supabase preserved.**  
**Final cutover attempt (2026-09-30):** **BLOCKED** — see `FINAL_CUTOVER_REPORT.md` (Gate **O** + J/L/M/N/P not PASS).

See: `SOURCE_DATA_PRESERVATION.md`, `COOLIFY_PESOWISE_ARCHITECTURE.md`

| Gate | Status | Evidence / reason |
|------|--------|-------------------|
| A | **PASS** | Supabase stack healthy |
| B | **PASS** | Native backups |
| C | **PASS** | Scope enforced |
| D | **PASS** | Isolated v2 resources |
| E | **PASS** | Prior 0 public mismatches |
| F | **PASS** | MinIO mirror mc diff 0 |
| G | **PASS** | Auth matrix; inactive user check added in API |
| H | **PASS** | Baseline financial totals |
| I | **PASS** | RBAC matrix |
| J | **PARTIAL** | API download chain PASS; React UI preview matrix not completed; `e1a68041` **SOURCE_ALREADY_MISSING** |
| K | **PASS** | Rollback path |
| L | **PARTIAL** | Full React on `:5175` deployed; per-role UI walkthrough not completed |
| M | **PARTIAL** | HTML bundle + API proxy audit clean; **browser DevTools runtime** audit not completed (agent browser cannot reach `.46`) |
| N | **PARTIAL** | PITR script fixed; WAL archive file permissions block recovery (`Permission denied` on `/wal_archive/*`) |
| O | **BLOCKED** | No authorized off-host destination for migration v2 |
| P | **PARTIAL** | Submit smoke only; approve/reject/concurrency races not proven |

## Architecture status (Coolify project `pesowise`)

| Component | Present | Notes |
|-----------|---------|-------|
| Existing Supabase | **YES** | `coolify_project=pesowise`, service `kar0ro1k6jiyfxzzw7acnsza` |
| New PostgreSQL | **YES** (Docker) | `pesowise-postgres-migration-v2`, volume `pesowise_postgres_migration_v2_data` — **not yet Coolify-managed service** |
| Staging API | **YES** | `:18787` |
| Migration MinIO | **YES** (unhealthy healthcheck) | `:19000` |
| React staging | **YES** | `:5175` |
| Prod frontend | **YES** | Still `VITE_SUPABASE_*` |

## Remaining work before **READY FOR FINAL CUTOVER**

1. Register **pesowise-primary-postgres** (or rename) in Coolify **pesowise** project using existing volume/data (operator/UI).
2. Complete backend API surface for all UI domains (users, balances, money return, categories, reports).
3. Finish migration shim / service layer so **every** active React path avoids production Supabase at **runtime**.
4. Gate **L** — manual or Playwright role UI validation on `:5175`.
5. Gate **M** — browser network capture from client on LAN (0 prod Supabase requests).
6. Gate **N** — fix WAL archive permissions + prove marker A/B.
7. Gate **P** — full financial lifecycle + concurrency suite.
8. Gate **O** — user-authorized off-host backup target OR accept BLOCKED at cutover planning.

## Production safety

`verify-production-unchanged-46.sh` → **PRODUCTION_CHECK_PASS**
