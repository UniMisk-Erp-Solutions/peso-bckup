# PesoWise — Capacity, Scalability & Reliability Guide

**Purpose:** Document whether the app can sustain ~400 concurrent users on the current Coolify hardware, which code paths create load or unreliable UI, and what to change to improve capacity and stability.

**Last updated:** May 29, 2026  
**Related docs:** [`pesowise-issues-and-fixes-handoff.md`](./pesowise-issues-and-fixes-handoff.md)

---

## Table of contents

1. [Executive summary](#1-executive-summary)
2. [Current architecture](#2-current-architecture)
3. [Hardware assessment](#3-hardware-assessment)
4. [What “400 concurrent users” means](#4-what-400-concurrent-users-means)
5. [Capacity tiers (realistic expectations)](#5-capacity-tiers-realistic-expectations)
6. [Code-level load multipliers](#6-code-level-load-multipliers)
7. [Frontend reliability issues (expenses “missing” or reverting)](#7-frontend-reliability-issues-expenses-missing-or-reverting)
8. [Database and infrastructure caveats](#8-database-and-infrastructure-caveats)
9. [Recommendations (prioritized)](#9-recommendations-prioritized)
10. [Load testing plan](#10-load-testing-plan)
11. [Monitoring checklist (Coolify / Postgres)](#11-monitoring-checklist-coolify--postgres)
12. [File reference index](#12-file-reference-index)

---

## 1. Executive summary

| Question | Short answer |
|----------|--------------|
| Can **Vercel** handle 400 concurrent users? | **Yes** — static SPA + edge; not your bottleneck. |
| Can **one Coolify Supabase stack** on **4-core Xeon + 128 GB RAM** handle 400 concurrent? | **Maybe** for light employee usage; **risky** for heavy admin/manager load across large orgs without tuning. |
| What limits you first? | **Postgres CPU + connections**, **Realtime WebSockets**, **8s statement timeout**, **disk I/O** (if not SSD). |
| Is the GPU relevant? | **No** — GT 710 is unused by this stack. |
| Is RAM the bottleneck? | **Unlikely** — 128 GB is ample for Postgres buffer cache. **CPU and I/O** matter more. |

**Bottom line:** The app can serve hundreds of users in principle, but the **self-hosted Supabase layer** and **frontend patterns** (many Realtime channels, duplicate polling, burst REST on page load, client-side list races) must be addressed before treating 400 concurrent as production-safe.

---

## 2. Current architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Users (browsers)                                                │
└────────────┬───────────────────────────────┬────────────────────┘
             │ HTTPS                          │ WSS (Realtime)
             ▼                                ▼
┌────────────────────────┐      ┌─────────────────────────────────┐
│  Vercel                │      │  Coolify (your Xeon server)      │
│  • React SPA (dist/)   │      │  • Kong / nginx (API gateway)    │
│  • vercel.json CSP     │      │  • PostgREST (REST)              │
│  • api/manifest.ts     │      │  • GoTrue (Auth)                 │
│  • api/contact.ts      │      │  • Realtime (WebSockets)         │
└────────────────────────┘      │  • PostgreSQL                    │
                                │  • Storage (receipts)            │
                                │  • Edge Functions (Deno)         │
                                └─────────────────────────────────┘
```

**Scaling implication:** Adding users increases load on **Coolify only** (REST, Auth, Realtime, Storage, SQL). Vercel scales independently.

**Future option:** Move the SPA to Coolify (Docker + nginx) and reverse-proxy `/rest/v1` on the same domain — reduces CORS/proxy URL issues but **shares the same 4 CPU cores** with Supabase unless you split services across machines.

---

## 3. Hardware assessment

### Your Coolify host (as described)

| Component | Spec | Role in Pesowise |
|-----------|------|------------------|
| CPU | Intel Xeon, **4 cores**, 3.3 GHz base | Postgres, Kong, PostgREST, Realtime, Storage API, Edge Functions — **all compete here** |
| RAM | **128 GB** DDR3 @ 1333 MHz | Excellent for Postgres `shared_buffers` and OS page cache |
| GPU | GT 710 | **Not used** |
| Disk | *Not specified* | **Critical** — SSD/NVMe strongly recommended |

### Strengths

- **128 GB RAM:** Postgres can keep hot tables (expenses, profiles, notifications, audit_logs) largely in memory after warm-up.
- **4 cores @ 3.3 GHz:** Adequate for tens to low hundreds of active API requests per second **if** queries are indexed and short.

### Weaknesses

- **Single-node Supabase:** No horizontal scale; one Postgres instance is the ceiling.
- **DDR3 1333:** Higher latency than DDR4/DDR5; usually offset by huge RAM for read-heavy workloads.
- **4 cores for entire stack:** Under spike (Monday morning login), CPU saturation causes slow queries → `statement_timeout` → empty UI.
- **HDD (if applicable):** Would dominate latency for receipt previews and sequential scans.

---

## 4. What “400 concurrent users” means

**Concurrent** = ~400 browsers with the app open at the same time. Not 400 requests per second.

### Typical load model

| Activity | Approx. backend load per user |
|----------|-------------------------------|
| Idle on Dashboard | 3–6 WebSocket channels + 1 REST poll/min (notifications) |
| Navigate / refresh page | **20–50 REST/RPC calls** in 2–5 seconds (auth context, stats, lists, enrichment) |
| Submit expense + upload receipt | Auth + insert + storage upload + audit + notifications |
| Admin opens panel (large org) | Heavy: org expenses, profiles, custom fields, audit chunks |

### Peak planning example

- 400 concurrent × 10% actively clicking in the same minute ≈ **40 users** in a burst.
- 40 × 30 API calls ≈ **1,200 requests in ~30s** ≈ **40 RPS** average, higher in spikes.

That is **achievable** on tuned Postgres + SSD. It is **not achievable** if many queries still full-scan `expenses` or hit 8s timeouts.

### Realtime connection math

Each active user may hold **3–6** Supabase Realtime channels (see [§6](#6-code-level-load-multipliers)):

```
400 users × 4 channels (avg) ≈ 1,600 WebSocket connections
```

Self-hosted Realtime must handle connection count, memory per connection, and broadcast fan-out on `postgres_changes`. Reconnect storms (already seen in logs as `CHANNEL_ERROR` / `CLOSED` / `SUBSCRIBED` churn) worsen with scale.

---

## 5. Capacity tiers (realistic expectations)

| Scenario | Verdict on your hardware (SSD assumed) |
|----------|----------------------------------------|
| 50–100 concurrent, mixed roles, SQL migrations applied | **Comfortable** |
| 200 concurrent, mostly employees (own expenses only) | **OK** with monitoring |
| 400 concurrent, light usage (read-heavy, spread over day) | **Plausible** after tuning |
| 400 concurrent, many admins + MicroLink-scale orgs | **High risk** on 4 cores |
| 400 users opening Dashboard in same 5-minute window | **Likely pain** without pooler + RPCs + fewer sockets |

Treat **100–150 concurrent** as a safe target until load-tested. Use **400** as a goal after fixes in [§9](#9-recommendations-prioritized).

---

## 6. Code-level load multipliers

These patterns increase **per-user** backend load and worsen under concurrency.

### 6.1 Multiple Realtime channels per session

| Channel topic (examples) | File |
|--------------------------|------|
| `auth-balance-{userId}` | `src/contexts/AuthContext.tsx` |
| `notification-popups-{userId}-{orgId}` | `src/hooks/useNotificationManager.ts` |
| `unread-notifications-count-{userId}` | `src/hooks/useUnreadNotifications.ts` |
| Dashboard notifications | `src/pages/Dashboard.tsx` |
| `cashier-return-requests-{userId}` | `src/pages/Dashboard.tsx` |
| `engineer-expenses-{userId}` | `src/pages/EngineerReview.tsx` |
| `balances-cashier-{userId}` | `src/pages/Balances.tsx` |
| Transfer offer channels (×2) | `src/hooks/usePendingTransferOfferCount.ts`, `src/components/DashboardPendingTransferOffers.tsx`, `src/pages/TransferOffers.tsx` |
| `notifications-{userId}` | `src/pages/Notifications.tsx` |

**Impact:** 400 users can mean **1,500–2,500+** simultaneous WebSocket connections to Realtime.

**Suggestion:** Single `NotificationProvider` (Phase 3 in performance plan) — one subscription for notifications + unread count; remove duplicate Dashboard/Layout subscriptions.

---

### 6.2 Polling in addition to Realtime

**`useNotificationManager.ts`** — polls every **60 seconds** even when Realtime is subscribed:

```typescript
// src/hooks/useNotificationManager.ts (simplified)
const pollInterval = setInterval(async () => {
  await supabase.from("notifications").select("id")
    .eq("user_id", user.id)
    .eq("organization_id", organizationId)
    .eq("read", false)
    .limit(1);
}, 60000);
```

**`Dashboard.tsx`** — similar 60s poll calling `fetchNotifications()`.

**Impact at 400 users:** ~**400 extra REST requests/minute** (~7 RPS) baseline, plus Realtime.

**Suggestion:** Poll only when Realtime status is `CHANNEL_ERROR` / `TIMED_OUT`; use exponential backoff; or poll every 5 minutes as fallback.

---

### 6.3 Burst REST on page load

On login / navigation, the app fires many parallel calls:

- `AuthContext`: profile, role, org, features, balance, Realtime
- `Dashboard`: stats RPC, notifications, transfer offers, role-specific widgets
- `AdminPanel` / `Expenses`: expense lists + profile enrichment + audit/custom-field chunks

**Impact:** Login spikes correlate with **connection pool exhaustion** and Kong latency.

**Suggestions:**

- React Query `staleTime` (partially done in `App.tsx`) — extend to dashboard stats, org settings.
- Defer non-critical enrichment until after first paint (AdminPanel already does two-phase `setExpenses`; keep that pattern).
- Server-side RPCs for aggregates (`get_dashboard_expense_summary`) — **must exist on Coolify**.

---

### 6.4 Dashboard stats and statement timeout

**`src/lib/dashboardStats.ts`:**

```typescript
// If RPC missing or errors for org admin → returns zeros (no fallback scan)
if (opts.organizationId) {
  return emptyExpenseSummary();
}
// User-scoped fallback only
const { data } = await supabase.from("expenses")
  .select("status, total_amount, assigned_engineer_id")
  .eq("user_id", opts.userId);
```

**Postgres roles (from backup):** `authenticated` role often has **`statement_timeout = 8s`**.

**Impact:** Under load, slow queries fail with `57014`; UI shows **₹0 / empty stats** while DB still has data — looks like “app broken” not “server busy”.

**Suggestions:**

- Ensure RPC + indexes on Coolify (migrations `20260529130000`–`20260529160000`).
- Show “stats unavailable, retrying” instead of zeros when RPC fails.
- `dashboardStatsCache.ts` — good for UX; document that cached numbers can diverge from live lists.

---

### 6.5 Large-org URL limits (proxy / “fake CORS”)

Chunked queries in `src/lib/supabaseInQuery.ts` and `fetchOrgMembershipRolesMap` in `src/lib/orgUsers.ts` address oversized GET URLs.

**Impact at scale:** More users × more large-org admins = more requests near proxy URL limits if any code path still uses giant `.in("user_id", [...])`.

**Suggestion:** Grep for remaining unchunked `.in("user_id"` in hot paths; same-domain API proxy (Phase 5) for long term.

---

### 6.6 Edge Functions on same CPU

Functions under `supabase/functions/` (admin-create-user, bulk import, compress-upload, etc.) run on the **same Coolify host**.

**Impact:** Bulk user CSV import during business hours competes with dashboard queries.

**Suggestion:** Rate-limit bulk admin operations; run heavy imports off-peak; consider queue/worker for imports.

---

### 6.7 Storage / receipts

Thousands of receipt files (~490 MB+ in backups) served via Supabase Storage API.

**Impact:** 400 users previewing PDFs/images → **disk read + egress** on the same server.

**Suggestion:** CDN in front of storage public URLs; image thumbnails; lazy-load attachments in lists.

---

## 7. Frontend reliability issues (expenses “missing” or reverting)

These cause **incorrect UI** even when the DB is correct — and get worse under load (slow responses → races).

### 7.1 Race conditions — overlapping fetches

**Pattern:** `setExpenses(baseList)` then async enrichment calls `setExpenses(enriched)` with **no request ID or abort**.

| File | Behavior |
|------|----------|
| `src/pages/Expenses.tsx` | `fetchExpenses` — base list then `enrichExpenseList` |
| `src/pages/AdminPanel.tsx` | `fetchExpenses` — lines ~696 and ~732 |
| `src/pages/EngineerReview.tsx` | Realtime triggers overlapping `fetchAssignedExpenses()` |

**Symptom:** List flickers, rows disappear, **older fetch overwrites newer** (“revert”).

**Suggestion:**

```typescript
// Pattern to adopt (conceptual)
let fetchSeq = 0;
const seq = ++fetchSeq;
const data = await load();
if (seq !== fetchSeq) return; // stale
setExpenses(data);
```

Or use React Query with `queryKey` + automatic deduplication.

---

### 7.2 Hard cap — only 150 expenses loaded initially

| File | Constant |
|------|----------|
| `src/pages/Expenses.tsx` | `EXPENSE_INITIAL_FETCH_LIMIT = 150` |
| `src/pages/AdminPanel.tsx` | Same + `EXPENSES_PER_PAGE = 15` |

**Symptom:** DB count grows; UI shows subset unless user clicks **Load all expenses**.

**Suggestion:** Raise initial limit for small orgs; virtualized table for large lists; cursor-based pagination server-side.

---

### 7.3 Client-side filters hiding rows

| Filter | Location |
|--------|----------|
| Status whitelist in SQL | `AdminPanel.tsx` — `.in("status", [...])` excludes other statuses |
| Search / status / custom fields | `filterAndSortExpenses`, `filteredExpenses`, `applyFilters` |
| Manager queue filter | `src/lib/managerReviewExpenses.ts` — `isRowInManagerReviewQueue` |
| `showOnlyActionable` | `EngineerReview.tsx` |

**Symptom:** Data fetched (or in DB) but **filtered out** in browser.

---

### 7.4 Fetch errors keep stale state

**`Expenses.tsx`:** on error, toast only if `expenses.length === 0`; otherwise **previous list remains**.

**Symptom:** Mismatch between `totalExpenseCount` and visible rows after failed refresh.

---

## 8. Database and infrastructure caveats

| Item | Detail |
|------|--------|
| `max_connections` | Default Postgres ~100–200; each REST request may hold a connection; pooler (Supavisor/PgBouncer) **required** at scale |
| `statement_timeout` | ~8s for `authenticated` — org-wide scans fail |
| RLS | Every query runs policy checks — CPU cost scales with row counts |
| Migration drift | Missing RPCs → 404 / empty fallbacks |
| Single Postgres | No read replica → all read/write on one instance |
| Realtime | Broadcasts WAL changes — CPU + memory per subscriber |
| Kong URL limits | Long `in.(uuid,...)` query strings → 414 / fake CORS |

### SQL migrations to have applied before scale testing

1. `20260529130000_resubmitted_expense_ids_rpc.sql`
2. `20260529140000_dashboard_expense_summary_rpc.sql`
3. `20260529150000_dashboard_expense_indexes.sql`
4. `20260529160000_large_org_perf_indexes.sql`
5. Manager workflow RPCs if using hierarchy (`20260528183500_manager_visibility_stable_rpc.sql`, etc.)

---

## 9. Recommendations (prioritized)

### P0 — Do before claiming 400 users

| # | Action | Effort | Impact |
|---|--------|--------|--------|
| 1 | Apply all performance SQL migrations on Coolify + reload PostgREST schema | Low (manual SQL) | High — fixes timeouts, dashboard zeros |
| 2 | Confirm **SSD** for Postgres + storage volumes | Infra | High |
| 3 | Verify **connection pooler** is enabled and app uses pooler port where appropriate | Low | High — prevents connection exhaustion |
| 4 | Fix fetch **race conditions** in `Expenses.tsx`, `AdminPanel.tsx`, `EngineerReview.tsx` | Medium | High — stops “reverting” lists |
| 5 | Monitor Postgres: connections, slow queries, CPU | Ongoing | Essential |

### P1 — Reduce per-user load (2–4 weeks)

| # | Action | Effort | Impact |
|---|--------|--------|--------|
| 6 | **Single notification Realtime provider** — remove duplicate channels in Dashboard, `useUnreadNotifications`, `useNotificationManager` | Medium | High — fewer WebSockets |
| 7 | **Conditional polling** — only when Realtime unhealthy | Low | Medium |
| 8 | Extend **React Query** to dashboard stats, org roles (partially done), expense lists | Medium | Medium — fewer duplicate fetches |
| 9 | Server-side **pagination** for admin expense list (cursor on `updated_at`) | Medium | High for large orgs |
| 10 | Remaining **chunked `.in()`** audits in `CashTransferHistory`, `UserManagement` drawer, etc. | Low–Medium | Medium |

### P2 — Architecture (1–3 months)

| # | Action | Effort | Impact |
|---|--------|--------|--------|
| 11 | **Dockerize frontend** on Coolify + nginx | Medium | Same-origin proxy possible |
| 12 | **Same-domain reverse proxy** to PostgREST (`/api/rest/...`) — Phase 5 | Medium | Eliminates proxy URL/CORS class of bugs |
| 13 | **CDN** for storage assets | Medium | Offloads receipt traffic from origin |
| 14 | **Read replica** or second Coolify node for Postgres reads | High | True read scale |
| 15 | **Rate limiting** at Kong for anon/auth abuse | Medium | Stability |

### P3 — Operational excellence

| # | Action |
|---|--------|
| 16 | Load test with k6/Locust (see [§10](#10-load-testing-plan)) |
| 17 | Alert on Postgres connections > 80%, CPU > 85%, p95 REST latency |
| 18 | Run heavy bulk imports off-peak |
| 19 | Document runbook for `statement timeout` / Realtime restart |

---

## 10. Load testing plan

### Goals

- Validate **p95 REST latency** &lt; 500ms for common endpoints at target concurrency.
- Validate **zero** `57014` timeouts on dashboard RPC during test.
- Measure **Realtime connection count** and stability (no mass `CHANNEL_ERROR`).

### Suggested k6 scenarios

1. **Login + dashboard** — 50 VUs ramp to 200 over 5 min; each iteration: auth token → `get_dashboard_expense_summary` → notifications select.
2. **Employee expenses** — 100 VUs fetch own expenses (`user_id=eq.{id}`) paginated.
3. **Admin panel** — 20 VUs org-scoped expense list (150 row limit).
4. **Soak** — 100 VUs for 30 min idle + 60s notification poll.

### Success criteria

| Metric | Target |
|--------|--------|
| HTTP 5xx rate | &lt; 0.1% |
| `get_dashboard_expense_summary` p95 | &lt; 2s |
| Postgres active connections | &lt; 80% of `max_connections` |
| Realtime stable subscriptions | &gt; 95% SUBSCRIBED after 5 min |

### Tools

- [k6](https://k6.io/) with Supabase anon key + test user JWTs
- Postgres: `pg_stat_statements` extension for slow query log
- Coolify / host: `htop`, `iostat`, container stats

---

## 11. Monitoring checklist (Coolify / Postgres)

Run periodically and under load:

```sql
-- Active connections
SELECT count(*) AS connections, state
FROM pg_stat_activity
GROUP BY state;

-- Max connections setting
SHOW max_connections;

-- Slow / frequent queries (requires pg_stat_statements)
SELECT calls, mean_exec_time, query
FROM pg_stat_statements
ORDER BY mean_exec_time DESC
LIMIT 20;

-- Table sizes (growth)
SELECT relname, pg_size_pretty(pg_total_relation_size(relid))
FROM pg_catalog.pg_statio_user_tables
ORDER BY pg_total_relation_size(relid) DESC
LIMIT 15;

-- RPCs exist
SELECT proname FROM pg_proc
WHERE proname IN (
  'get_dashboard_expense_summary',
  'get_org_role_balance_totals',
  'get_resubmitted_expense_ids'
);
```

**Host metrics to watch:**

- CPU % per container (especially `db`, `kong`, `realtime`)
- Disk read/write latency
- Memory — Postgres should use a large fraction of RAM over time (healthy caching)

---

## 12. File reference index

| Topic | Files |
|-------|-------|
| Realtime / balance | `src/contexts/AuthContext.tsx` |
| Notifications + poll | `src/hooks/useNotificationManager.ts`, `src/hooks/useUnreadNotifications.ts` |
| Dashboard load | `src/pages/Dashboard.tsx`, `src/lib/dashboardStats.ts`, `src/lib/dashboardStatsCache.ts` |
| My expenses | `src/pages/Expenses.tsx` |
| Admin expenses | `src/pages/AdminPanel.tsx` |
| Manager review | `src/pages/EngineerReview.tsx`, `src/lib/managerReviewExpenses.ts`, `src/lib/managerActionableExpenses.ts` |
| Chunked queries | `src/lib/supabaseInQuery.ts`, `src/lib/orgUsers.ts` |
| Custom field filters | `src/hooks/useExpenseCustomFieldFilters.ts`, `src/lib/expenseCustomFieldFilters.ts` |
| React Query defaults | `src/App.tsx`, `src/hooks/useOrgMembershipRoles.ts` |
| SQL performance | `supabase/migrations/20260529130000_*.sql` … `20260529160000_*.sql` |
| Issue handoff | `docs/pesowise-issues-and-fixes-handoff.md` |

---

## Summary decision matrix

| If your goal is… | Focus on… |
|------------------|-----------|
| Support **400 concurrent employees** submitting/viewing own expenses | P0 SQL + pooler + SSD; P1 reduce Realtime duplication |
| Support **many large-org admins** simultaneously | P0 + server-side pagination + same-domain proxy; consider more CPU |
| Fix **“expenses disappear / revert”** | §7 race fixes + filters audit — not more RAM |
| Fix **dashboard shows zero** | Deploy `get_dashboard_expense_summary` + indexes on Coolify |
| Prepare for **growth beyond 400** | P2 read replica or second DB node; CDN for storage |

---

*This document is planning guidance, not a guarantee of capacity. Validate with load tests on your exact Coolify configuration and disk subsystem.*
