# Team Reports — Verification List Statement Timeout Fix

**Doc ID:** DOC-048  
**Status:** complete  
**Last updated:** 2026-07-09 (Rev 6.0)  
**Owner / area:** Reports, teamReportsScope, expenses indexes, RLS

---

## 1) Summary

The Claim Verification List and Claim Approval List in Team Reports showed "No expenses found" for executives and managers with large teams. Three fixes were required, applied in sequence: (1) frontend chunked `user_id IN (...)` queries removed; (2) missing DB index `idx_expenses_org_status_created` applied; (3) **missing RLS SELECT policy** — the root cause — no policy granted executives/team-leaders/managers visibility into team member verified expenses for reporting purposes. Fix 3 (`06_rls_team_reports_policy.sql`) is the one that actually makes data visible to authenticated users.

---

## 2) User symptom

- Page: `/team-reports` → Claim Verification List tab
- Logged in as: executive with 225+ team members
- Symptom: "No expenses found" even though many verified expenses exist
- Network tab: `500 Internal Server Error`, `proxy-status: PostgREST; error=57014`
- Error JSON: `{ "code": "57014", "message": "canceling statement due to statement timeout" }`
- `x-kong-upstream-latency: 8065` — query was killed after 8+ seconds

---

## 3) Exact failing query

```sql
SELECT id, user_id, title, total_amount, status, created_at,
       trip_start, trip_end, category, purpose, destination,
       transaction_number, batch_id
FROM public.expenses
WHERE organization_id = '6709c1fe-e8c8-404d-bc68-d1edda923344'
  AND status IN ('verified', 'level_1_verified', 'level_2_verified')
ORDER BY created_at DESC;
```

---

## 4) Root cause

**Two layered problems:**

### Problem A — frontend chunked `user_id IN (...)` queries (FIXED)

`fetchTeamScopedExpenses` split 225 team member IDs into chunks of 100 and fired one query per chunk with `&user_id=in.(100 UUIDs...)` appended. Each query produced a ~4KB URL and PostgreSQL timed out trying to evaluate the 100-element IN-clause.

**Fix applied:** `src/lib/teamReportsScope.ts` — replaced the chunked loop with a single org-wide query (no `user_id` filter), then filters returned rows in memory using the pre-fetched `allowedIds` Set.

### Problem B — missing database index (APPLIED — confirmed working)

The org-wide query was still timing out because there was no index on `(organization_id, status, created_at DESC)`. Fix: `CREATE INDEX IF NOT EXISTS idx_expenses_org_status_created ON public.expenses(organization_id, status, created_at DESC)`. **Confirmed applied** — EXPLAIN ANALYZE shows `Bitmap Index Scan on idx_expenses_org_status_created`, Execution Time: **9ms**.

### Problem C — missing RLS SELECT policy (ROOT CAUSE — must be applied manually)

No RLS SELECT policy on `public.expenses` grants team leaders, executives, or managers visibility into their team members' verified expenses for reporting purposes.

**Fix needed:** Add RLS SELECT policy `"Team leaders and executives can view team member expenses"` on `public.expenses`. See `docs/sql/team-reports-timeout/06_rls_team_reports_policy.sql`.

**Why the original policy attempt (Rev 3.0) still returned 0 rows:**

The first version of the policy checked only the formal team path — it searched `teams.executive_user_id / team_leader_user_id / manager_user_id`. But this executive has NO entry in the `teams` table in any of those columns (confirmed by Step 4 returning 0 as service role, bypassing RLS).

The 225 members shown in the UI come from `list_my_teams_overview`'s **hierarchy fallback branch**, which fires when `user_has_formal_teams_with_members()` returns false. It calls `get_subordinate_user_ids()` — a recursive CTE on `profiles.reporting_engineer_id` — to find all direct and indirect reports.

**Corrected policy (Rev 4.0) — dual path:**

```sql
DROP POLICY IF EXISTS "Team leaders and executives can view team member expenses"
  ON public.expenses;

CREATE POLICY "Team leaders and executives can view team member expenses"
  ON public.expenses
  FOR SELECT
  USING (
    status IN ('verified', 'level_1_verified', 'level_2_verified', 'approved')
    AND (
      -- Path 1: Formal team membership (teams + team_members)
      EXISTS (
        SELECT 1
        FROM public.team_members tm
        JOIN public.teams t
          ON t.id = tm.team_id
         AND t.organization_id = tm.organization_id
        WHERE tm.user_id = expenses.user_id
          AND tm.organization_id = expenses.organization_id
          AND (
            t.team_leader_user_id = auth.uid()
            OR t.executive_user_id = auth.uid()
            OR t.manager_user_id   = auth.uid()
          )
      )
      OR
      -- Path 2: Hierarchy fallback (reporting_engineer_id chain)
      EXISTS (
        SELECT 1
        FROM public.get_subordinate_user_ids(expenses.organization_id, auth.uid()) sub
        WHERE sub.user_id = expenses.user_id
      )
    )
  );
```

**Proof it was RLS:** SQL Editor (service_role, bypasses RLS) returned 357 rows. Authenticated user frontend got 0 rows. Classic RLS gap.

---

## 5) Why "SQL is running but UI still empty"

If the user reports the SQL was run but reports are still empty, possible causes in order of likelihood:

1. **Index still building** — `CREATE INDEX CONCURRENTLY` runs in the background and takes minutes on large tables. Check `pg_stat_progress_create_index` (file `00`).
2. **Index creation failed silently** — If the SQL Editor closed or timed out before the index built. Check `pg_indexes` (file `02`).
3. **Team scope is empty** — `list_my_teams_overview` RPC returns no teams for this user, so `teamMemberUserIds = []` and all fetched expenses are filtered out in memory (file `04`).
4. **No verified expenses in team** — The expenses exist but belong to users NOT in this executive's team (file `04`, Query 5).
5. **RLS blocking** — An RLS policy on `expenses` is blocking the authenticated user from reading verified expenses at this status (file `05`, Query 3).

---

## 6) How to check index progress

Run file `docs/sql/team-reports-timeout/00_check_index_progress_and_locks.sql` in Supabase SQL Editor.

If `pg_stat_progress_create_index` returns a row → index is still building. Wait.
If it returns no row AND `pg_indexes` does not show the index → run file `01b` to create it.

---

## 7) SQL files — run order

All files are in `docs/sql/team-reports-timeout/`.

| Step | File | Status | When to run |
|------|------|--------|-------------|
| 0 | `00_check_index_progress_and_locks.sql` | ✅ Done | Check if CREATE INDEX is still running |
| 1a | `01_create_indexes_concurrently.sql` | ❌ Failed (transaction block) | — |
| 1b | `01b_create_indexes_non_concurrent_fallback.sql` | ✅ Done | Used instead of 1a |
| 2 | `02_verify_indexes_and_query_plan.sql` | ✅ Confirmed | Index present, 9ms query |
| 3 | `03_verify_data_exists.sql` | ✅ Confirmed | 357 rows exist |
| 4 | `04_team_scope_debug.sql` | ✅ Updated | Corrected column names (executive_user_id etc.) |
| 5 | `05_postgrest_exact_query_debug.sql` | ✅ Confirmed RLS gap | No policy for executive team reporting |
| **6** | **`06_rls_team_reports_policy.sql`** | **⬅ RUN THIS NEXT** | **The actual fix — creates the missing RLS policy** |
| ⚠️ | `99_rollback_indexes_DO_NOT_RUN.sql` | — | DO NOT RUN — rollback for both indexes and policy |

---

## 8) Frontend query-shape rule

The status filter must stay **inside** the base query passed to `applyUserFilter`. Do not chain it after.

**Correct (current code in `Reports.tsx:699–706`):**
```typescript
let query = applyUserFilter(
  supabase
    .from("expenses")
    .select("id, user_id, ...")
    .eq("organization_id", organizationId)
    .in("status", statusValues),   // ← INSIDE base query
);
```

**Wrong (causes "No expenses found" even with data):**
```typescript
let query = applyUserFilter(supabase.from("expenses").select("..."));
query = query.in("status", statusValues);  // ← OUTSIDE — broken
```

---

## 9) Reports.tsx deployed-code check

These values were confirmed correct in the current uncommitted `src/pages/Reports.tsx`:

| Check | Value | Status |
|-------|-------|--------|
| `engineerStatus` default | `"all"` (line 329) | ✅ Correct |
| `clearFilters()` reset | `setEngineerStatus("all")` (line 1485) | ✅ Correct |
| `fetchVerificationExpenses` status filter | `.in("status", statusValues)` inside base (line 706) | ✅ Correct |
| Dropdown options | All verified / Verified / Level 1 Verified / Level 2 Verified | ✅ Correct |

**No code changes to `Reports.tsx` are needed.**

---

## 10) What to paste back if reports are still empty

If the UI still shows "No expenses found" after running the index SQL, paste back:

1. Output of `00` Query 1 — is CREATE INDEX still running?
2. Output of `02` Part 1 — does `idx_expenses_org_status_created` appear?
3. Output of `02` Part 2 — what does EXPLAIN ANALYZE say?
4. Output of `03` Query 1 — how many verified expenses per status?
5. Output of `04` Query 2 — which teams is this user an exec/leader/manager of?
6. Browser network tab for the failing request: URL, status code, response body

---

## 11) Key files

```
src/lib/teamReportsScope.ts                                   — Problem A fix (done)
supabase/migrations/290707_0900_expenses_missing_indexes.sql  — Problem B source SQL (not applied yet)
docs/sql/team-reports-timeout/                                — Manual SQL debug + fix files
```

---

## 12) Database / migrations

The index SQL is in `supabase/migrations/290707_0900_expenses_missing_indexes.sql`.

**Do NOT run `supabase db push`** — this file uses the short-timestamp format (`290707_...`) which the Supabase CLI silently ignores. The SQL must be run manually in Supabase SQL Editor.

Use the files in `docs/sql/team-reports-timeout/` instead of the raw migration file — they include safety comments, run order guidance, and the CONCURRENTLY option.

---

## 13) Remaining follow-up

**Pagination (future):** The query currently fetches ALL verified expenses with no LIMIT. If the org grows to 5,000+ verified expenses, the browser payload becomes large. Recommended future work: add server-side pagination (page size 100) with a default date-range filter. Not blocking.

---

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-07-09 | 1.0 | Agent | Initial — replace chunked IN queries with org-wide fetch + in-memory filter |
| 2026-07-09 | 2.0 | Agent | Major update — Problem B (missing DB index) documented; SQL debug files created in docs/sql/team-reports-timeout/; Reports.tsx confirmed correct (no code changes needed); full diagnosis tree added |
| 2026-07-09 | 3.0 | Agent | Root cause confirmed as Problem C — missing RLS SELECT policy. Index confirmed working (9ms, Bitmap Index Scan). 357 rows in DB but 0 rows returned to authenticated user. New policy file 06_rls_team_reports_policy.sql created. teams table column names corrected (executive_user_id, team_leader_user_id). |
| 2026-07-09 | 4.0 | Agent | Policy corrected to use dual-path lookup: formal team path (teams table) OR hierarchy fallback (get_subordinate_user_ids via reporting_engineer_id chain). The executive is not in the teams table — all 225 members come from the hierarchy RPC branch. Step 4 broken into 4A (formal), 4B (hierarchy), 4C (subordinate count). |
| 2026-07-09 | 5.0 | Agent | Root cause of remaining 500: RLS USING clause with recursive CTE called per-row still times out. RLS cannot efficiently evaluate hierarchy checks at this scale. Fix: created get_team_expenses_for_members SECURITY DEFINER RPC (file 07). Frontend teamReportsScope.ts now calls this RPC when teamScoped (bypasses RLS entirely). All three Reports.tsx callers updated with rpcOptions. |
| 2026-07-09 | 6.0 | Agent | Added Employee ID to all three report tables (UI) and all export formats (xlsx/csv/pdf/json). Fixed ExpenseWithUser interface, mapExpensesWithUsersAndBatch to forward employee_id from profiles, and all export col maps/headers/row builders. Status: complete. |
