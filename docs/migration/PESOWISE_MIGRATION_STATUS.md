# PesoWise Supabase → PostgreSQL + API migration

**Status:** `PARTIAL` — pre-cutover gates documented in [`GATE_STATUS_PRE_CUTOVER.md`](GATE_STATUS_PRE_CUTOVER.md). **No production cutover.**

**Scope:** PesoWise only (`kar0ro1k6jiyfxzzw7acnsza` on `192.168.23.46`). Unrelated Coolify projects not touched.

---

## 1. Phase 0 — Repository (local)

| Field | Value |
|--------|--------|
| Repository | `peso-bckup-priyanshu` (remote: `UniMisk-Erp-Solutions/peso-bckup`) |
| Branch | `priyanshu` |
| Commit | `2cc2e0b801c732b3b08af8c114356b3679260e88` |
| Working tree | Dirty (HA/recovery/migration docs and scripts untracked; no push per user rule) |

### Frontend env names (values not recorded)

| Variable | Purpose |
|----------|---------|
| `VITE_SUPABASE_URL` | Supabase/Kong gateway URL |
| `VITE_SUPABASE_ANON_KEY` / `VITE_SUPABASE_PUBLISHABLE_KEY` | JWT anon key |
| `VITE_RECOVERY_MODE` | Optional recovery lab |
| `VITE_MAINTENANCE_*` | Separate maintenance Supabase client |
| `VITE_PUBLIC_SITE_URL`, analytics/social | Marketing |

**Target (post-cutover only):** `VITE_API_URL` — **not set in production yet.**

---

## 2. Phase 1 — Application Supabase dependency summary

**Central client:** `src/integrations/supabase/client.ts` — `@supabase/supabase-js`, localStorage sessions, auto refresh.

**~100+ TS/TSX files** import the Supabase client or call through services.

### Feature usage (proven)

| Feature | Primary locations | Replacement |
|---------|-------------------|-------------|
| **Auth** | `AuthContext.tsx`, `Auth.tsx`, `authSession.ts` | `POST /api/auth/*`, HttpOnly sessions |
| **PostgREST `.from()`** | Services, pages, libs (wide) | Domain REST on backend |
| **`.rpc()`** | Expense workflow, reports, form builder, teams, tenant, activity | Backend transactions + explicit routes |
| **Storage** | `FileUpload.tsx`, `attachmentPreview.ts`, receipt libs | Signed URL API |
| **Realtime** | `useNotificationManager`, `useUnreadNotifications`, `realtimeFilters.ts` | SSE `/api/events` |
| **Edge functions** | `invokeAdminEdgeFunction.ts`, ContactPage | Backend routes |
| **RLS / auth.uid()** | DB migrations (`supabase/migrations/`) | Server RBAC (+ optional PG RLS without Supabase JWT) |

### RPC examples (non-exhaustive; grep `supabase.rpc` in `src/`)

Financial / review: `review_verify_expense`, `review_approve_expense_*`, `review_reject_expense`, `apply_expense_correction`, `admin_submit_expense_for_employee_v1`, …

Reporting: `get_daily_project_report_page_v1`, `create_*_export_job_v1`, `save_generated_report_v1`, …

Tenant/auth helpers: `get_organization_by_subdomain`, `get_employee_auth_email`, `email_can_sign_in_on_tenant`, …

### Partial dependency table (expand during Phase 9)

| FILE | SUPABASE FEATURE | TABLE/SERVICE | OPERATION | SECURITY | REPLACEMENT |
|------|------------------|---------------|-----------|----------|-------------|
| `AuthContext.tsx` | auth + rpc | org features | read session, org | RLS via JWT | API auth + me |
| `ExpenseService.ts` | from + rpc | expenses, workflows | CRUD + approve | RLS + RPC | API + transactions |
| `MoneyReturnService.ts` | from | money_return_requests | CRUD | RLS | API |
| `NotificationService.ts` | from + channel | notifications | read/update | RLS | API + SSE |
| `FileUpload.tsx` | storage | buckets | upload | storage policies | signed URLs |
| `attachmentPreview.ts` | storage + from | attachments | preview URL | policies | signed download |
| `api/` (Vercel) | server Supabase | maintenance | admin | service role | extend or merge into Fastify |

**Schema source of truth:** `supabase/migrations/` (300+ files). **Do not guess** policy text — export from production in a later read-only pass.

---

## 3. Phase 2 — Production infrastructure (PesoWise only, `.46`)

**Coolify Supabase service ID:** `kar0ro1k6jiyfxzzw7acnsza`

| Container | Image | Status (audit time) |
|-----------|--------|---------------------|
| `supabase-db-kar0ro1k6jiyfxzzw7acnsza` | `supabase/postgres:15.8.1.085` | healthy |
| `supabase-auth-kar0ro1k6jiyfxzzw7acnsza` | `gotrue:v2.186.0` | healthy |
| `supabase-rest-kar0ro1k6jiyfxzzw7acnsza` | `postgrest:v14.6` | up |
| `supabase-storage-kar0ro1k6jiyfxzzw7acnsza` | `storage-api:v1.44.2` | healthy |
| `supabase-minio-kar0ro1k6jiyfxzzw7acnsza` | Coolify MinIO | healthy |
| `realtime-dev-kar0ro1k6jiyfxzzw7acnsza` | `realtime:v2.76.5` | healthy |
| `supabase-kong-kar0ro1k6jiyfxzzw7acnsza` | `kong:3.9.1` | healthy |
| `supabase-edge-functions-*` | edge-runtime | healthy |
| `supabase-supavisor-*`, studio, meta, analytics, vector, imgproxy | various | healthy |

**PesoWise app (non-Supabase):**

| Container | Role |
|-----------|------|
| `pesowise-frontend` | React static/nginx |
| `haproxy-pesowise-lb` | L7 load balancer |

**Isolated HA lab (PesoWise-named, not production DB):** `pesowise-ha-lab-pg46`, `pesowise-ha-lab-app46` — exited; did not stop Supabase.

**PostgreSQL version:** 15.8

**Domains (from repo example, not verified on server):** `pesowise-backup-supabase.unimisk.com` — production routing via Kong/HAProxy: **UNKNOWN** detail until read-only Coolify env inspection scoped to PesoWise.

---

## 4. Phase 3 — Backup and recovery (Gate B)

| Item | Value |
|------|--------|
| Timestamp (UTC) | `20260930T062343Z` |
| Location on `.46` | `/tmp/pesowise-migration-backup/` |
| Custom dump | `pesowise-20260930T062343Z.dump` (~26.8 MiB) |
| Schema-only | `pesowise-20260930T062343Z.schema.sql` (~1.6 MiB) |
| `pg_restore --list` | **2499** entries |
| SHA-256 dump | `b80d00f852d7676c99926a8f3e91f61eb14c8c1e982dc39ea97d80f020476464` |
| SHA-256 schema | `54aa522e9299bfdaad43ed49bd61d7c7b9c923aeed4a78670df3f8f5ac092465` |
| Tooling | `pg_dump` / `pg_restore` via `supabase-db-kar0ro1k6jiyfxzzw7acnsza` |

**Gate B:** **PASS** (native dump + restore list + checksums).

**Still required before cutover:** off-host copy of dump + storage object backup with byte verification (Phase 11/22).

---

## 5. Phase 4 — Data inventory (source, read-only)

| Entity | Count / metric |
|--------|----------------|
| `auth.users` | 794 |
| `auth.identities` | 726 |
| `public.profiles` | 488 |
| `public.user_roles` | 489 |
| `public.expenses` | 25,213 |
| Sum `expenses.total_amount` | 20,989,240.59 |
| Sum approved/paid (status filter) | 12,734,575.88 |
| `public.attachments` | 14,297 |
| `public.notifications` | 84,829 |
| `public.audit_logs` | 84,514 |
| `money_assignments` | 4 |
| `money_return_requests` | 7 |
| `balance_transfer_offers` | 100 |
| `storage.objects` | 19,959 (~7.3 GB metadata sum) |
| Buckets | `receipts` (public), `expense-attachments` (public), `organization-logos`, `generated-reports`, `balance-import-archive`, `bills` |
| Public tables with RLS | 66 |

Expense status breakdown: approved 17752, submitted 3198, level_2_verified 2591, level_1_verified 950, draft 573, rejected 144, verified 5.

### Phase 21 preview (source vs `pesowise-postgres-migration-v2`)

| Entity | Source | Target | Match |
|--------|--------|--------|-------|
| auth.users | 794 | 794 | YES |
| profiles | 488 | 488 | YES |
| expenses | 25,213 | 25,213 | YES |
| attachments | 14,297 | 14,297 | YES |
| notifications | 84,829 | 84,829 | YES |
| audit_logs | 84,514 | 84,514 | YES |
| sum(total_amount) | 20,989,240.59 | 20,989,240.59 | YES |

---

## 6. Phase 5 — New PostgreSQL service

**Planned name:** `pesowise-postgres-migration-v2`  
**Compose:** `tools/pesowise-migration/docker-compose.postgres-v2.yml`  
**Host bind:** `127.0.0.1:15432` → container 5432  
**Volume:** `pesowise_postgres_migration_v2_data`  
**Credentials:** `/tmp/pesowise-migration-v2/.env` on `.46` (not in git)

**Deploy state:** **RUNNING** on `.46` — `pesowise-postgres-migration-v2`, `127.0.0.1:15432`, volume `pesowise_postgres_migration_v2_data`. Credentials in `/tmp/pesowise-migration-v2/.env` (host only, not in git).

**Phase 15 restore:** `pg_restore` from `pesowise-20260930T062343Z.dump` completed with **1100 non-fatal errors** (missing Supabase roles `anon`/`authenticated`/`service_role`, vault grants). **`public.expenses` count = 25,213** matches source. Full entity compare: run `scripts/migration/compare-source-target-46.sh`.

**PITR on target:** not configured yet (required before cutover).

---

## 7. Safety gates (current)

| Gate | Status |
|------|--------|
| A — PesoWise source identified | **PASS** |
| B — Verified backup | **PASS** |
| C — Scope boundary | **PASS** (so far) |
| D — No unrelated overwrite | **PASS** (v2 isolated) |
| E–K — UUID/files/auth/totals/previews/rollback | **PARTIAL** — DB totals/counts match on v2 clone; storage copy, auth login, RBAC, previews, rollback drill **not done** — **cutover blocked** |

---

## 8. Rollback (pre-cutover)

1. Keep `VITE_SUPABASE_*` on `pesowise-frontend`.  
2. No changes to `kar0ro1k6jiyfxzzw7acnsza` containers.  
3. Migration v2 is disposable; drop only `pesowise-postgres-migration-v2` + volume if abandoning lab.

---

## 9. Next work (ordered)

1. ~~Start `pesowise-postgres-migration-v2`; `pg_restore` dump; compare counts (Phase 15/21).~~ **Done (partial grants errors; verify all entities).**
2. Dedicated MinIO bucket copy for migration (Phase 11).  
3. **In progress:** `backend/` Fastify scaffold (`GET /health`, `/ready`) — implement auth + domain routes (Phases 6–8).  
4. Map RPC → transactions (Phase 9–10).  
5. Staging env + validation (Phases 19–23).  
6. Cutover only after gates E–K (Phases 24–26).

---

## 10. Unchanged / untouched

- Full Supabase stack `kar0ro1k6jiyfxzzw7acnsza` — **running, not stopped**  
- Production `pesowise-frontend` env — **not modified**  
- Unrelated Coolify projects — **not inspected or modified**  
- No `DELETE`/`DROP`/`TRUNCATE` on production DB  

---

*Scripts:* `scripts/migration/pesowise-pg-dump-46.sh`, `pesowise-readonly-inventory-46.sh`, `pesowise-data-inventory-46.sh`, `remote-up-postgres-v2-46.sh`, `restore-dump-to-v2-46.sh`
