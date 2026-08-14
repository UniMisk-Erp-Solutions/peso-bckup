# User Activity Insights

**Doc ID:** DOC-051
**Status:** DPDP compliance controls added — legal review required before main/production rollout. Hotfix 06 SQL ready; UI redesigned (§24); privacy notice & acknowledgement flow (§25); full DPDP compliance-control package (§26); app-facing legal pages added (§27)
**Last updated:** 2026-07-13
**Branch:** `feature/user-activity-insights`
**Owner / area:** Admin, UserManagement, AuthContext, Layout, Supabase

---

## 1) Purpose

Lets organization admins see activity insights for users inside PesoWise:

- Last session / sign-in time
- Last seen (from heartbeat)
- Visible app time today
- Expenses submitted today
- Active days in selected range
- Inactive days
- Current inactive streak
- Usage trend badge (Active / Stable / Inactive)
- Per-user 30-day activity timeline (in drawer)

---

## 2) What IS tracked

| Signal | Source |
|--------|--------|
| Session start | `start_user_activity_session` RPC called when tracker mounts |
| Visible app seconds | `document.visibilityState` — counted only while tab is in foreground |
| Heartbeat intervals | Every 60 s while tab is visible |
| Session end | `pagehide` / `beforeunload` best-effort call |
| Expenses submitted | Postgres trigger on `expenses` table — increments daily rollup |

All data is stored in two new tables (`user_activity_sessions`, `user_activity_daily_rollups`).

---

## 3) What is NOT tracked

- Keystrokes or mouse movements
- Screenshots
- Browsing outside PesoWise
- MAC address, IP address, device-level data
- Installed apps or antivirus status
- Other browser tabs or windows
- Mobile camera, microphone, or any device sensor

---

## 4) Feature flag

**Key:** `user_activity_insights`

Added to:
- `src/lib/organizationFeatureKeys.ts` — `ORGANIZATION_FEATURE_KEYS` + `MASTER_ADMIN_FEATURE_DEFINITIONS`
- `src/locales/en/master.json` — `features.userActivityInsights`
- `src/locales/hi/master.json` — Hindi translation
- `src/locales/gu/master.json` — Gujarati translation

Master admin enables this per-organization via the Master Admin Dashboard feature toggles.

When disabled:
- Tracker does nothing (feature gate check in component and in RPCs)
- Admin page shows a "not enabled" card
- UserManagement "Activity Insights" button is hidden

---

## 5) Tables

### `public.user_activity_sessions`

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | auto |
| organization_id | uuid FK → organizations | cascade delete |
| user_id | uuid FK → auth.users | cascade delete |
| started_at | timestamptz | default now() |
| ended_at | timestamptz NULL | set on session end |
| last_seen_at | timestamptz | updated on heartbeat |
| visible_seconds | integer ≥ 0 | cumulative visible time |
| heartbeat_count | integer ≥ 0 | number of heartbeats received |
| user_agent | text NULL | browser user agent |
| created_at / updated_at | timestamptz | audit |

### `public.user_activity_daily_rollups`

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | auto |
| organization_id | uuid FK | cascade delete |
| user_id | uuid FK | cascade delete |
| activity_date | date | one row per day |
| first_seen_at | timestamptz NULL | first heartbeat of the day |
| last_seen_at | timestamptz NULL | latest heartbeat of the day |
| visible_seconds | integer ≥ 0 | total visible seconds that day |
| session_count | integer ≥ 0 | number of sessions started |
| expenses_submitted_count | integer ≥ 0 | incremented by trigger |
| created_at / updated_at | timestamptz | audit |

Unique constraint: `(organization_id, user_id, activity_date)`

---

## 6) RPCs

| RPC | Caller | Description |
|-----|--------|-------------|
| `start_user_activity_session(p_user_agent)` | Tracker on mount | Inserts session row + upserts today's rollup. Returns session UUID or NULL if feature disabled. |
| `record_user_activity_heartbeat(p_session_id, p_visible_seconds)` | Tracker every 60s | Increments visible_seconds (clamped 0-120) on session + rollup. No-ops if feature off. |
| `end_user_activity_session(p_session_id)` | Tracker on unload | Sets ended_at if null. Idempotent. No-ops if unauthenticated. |
| `get_user_activity_summary(p_start_date, p_end_date)` | Admin page table | Returns one row per org member with aggregated stats. Set-based, uses rollups. Admin-only. |
| `get_user_activity_timeline(p_user_id, p_start_date, p_end_date)` | Timeline drawer | One row per date (zero-filled inactive days via generate_series). Admin-only. |
| `get_user_activity_detail(p_user_id, p_start_date, p_end_date)` | (reserved) | Returns raw session rows for a user. Admin-only. |
| `is_user_activity_insights_enabled(p_organization_id)` | Internal helper | Returns boolean. Used by all write RPCs as feature gate. |

All write RPCs are `SECURITY DEFINER` so the client cannot write directly to the tables.

---

## 7) Expense submission trigger

**Function:** `public.trg_user_activity_expense_submitted()`
**Trigger:** `trg_user_activity_expense_submitted` on `public.expenses` AFTER INSERT OR UPDATE OF status

Fires when `NEW.status = 'submitted'` AND either:
- It's a new INSERT, or
- `OLD.status IS DISTINCT FROM 'submitted'` (status transition into submitted)

Increments `expenses_submitted_count` in `user_activity_daily_rollups` for `(organization_id, user_id, activity_date)`.

**Does NOT:**
- Alter the expense row
- Change ExpenseService
- Touch any approval or review flow

---

## 8) Frontend tracker behavior

**File:** `src/components/UserActivityTracker.tsx`

**Mounted in:** `src/components/Layout.tsx` — runs for all authenticated routes, both mobile and desktop layouts.

**Activation conditions (all must be true):**
- `user` is authenticated
- `organizationId` is set
- `userRole !== "master_admin"`
- `hasOrganizationFeature("user_activity_insights") === true`

**Behavior when active:**
1. Attempt tab-leader election (see §9)
2. If leader: call `start_user_activity_session`
3. While tab is visible: accumulate visible seconds
4. Every 60 s (if visible): call `record_user_activity_heartbeat` with elapsed seconds
5. On `visibilitychange → hidden`: flush remaining seconds immediately
6. On `pagehide` / `beforeunload`: call `end_user_activity_session` (best-effort)

**RPC failures:** `console.warn` only — never throws, never breaks the app.

---

## 9) Multiple-tab protection (leader election)

**localStorage key:** `pesowise-user-activity-leader`
**Value:** `{ tabId: string, userId: string, ts: number }`
**TTL:** 90 seconds (leader must refresh on each heartbeat)

A tab claims leadership if:
- No leader record exists, OR
- The leader record is for a different user, OR
- The leader record timestamp is older than 90 s (stale leader)

Only the leader tab sends heartbeats → prevents time double-counting from multiple tabs.

On signOut: `AuthContext.signOut()` removes the key via `localStorage.removeItem("pesowise-user-activity-leader")`.

---

## 10) Admin UI

**Page:** `src/pages/UserActivityInsights.tsx`
**Route:** `/admin/user-activity`
**Access:** `allowedRoles={["admin"]}` (ProtectedRoute)

### Controls
- Date range selector: Last 7 / 30 / 90 days
- Active/Inactive filter: All / Active+Stable / Inactive only
- Search: name, email, employee ID

### Summary cards (top of page)
1. Active users today
2. Inactive users today
3. Total visible app time today
4. Expenses submitted today

### Table columns
- User (name + email)
- Role
- Employee ID
- Last seen
- Today active time
- Today expenses
- Active / total days
- Inactive streak
- Trend badge

### Trend badge logic
| Badge | Condition |
|-------|-----------|
| Active (green) | last_seen within 1 day |
| Stable (yellow) | last_seen within 7 days |
| Inactive (grey) | no activity in 7+ days |

### Per-user timeline drawer
Clicking any table row opens a dialog with the 30-day activity timeline:
- Bar chart (proportional width)
- Active / inactive day colours
- Visible time, session count, expenses submitted per day
- First seen / last seen per day

Uses `get_user_activity_timeline` RPC — NOT raw session queries.

### Privacy copy (always visible on page)
> "Activity time is approximate and based on visible PesoWise app sessions.
> It does not track keystrokes, screenshots, or browsing outside PesoWise."

---

## 11) UserManagement link

**File:** `src/pages/UserManagement.tsx`

Adds an "Activity Insights" button in the user list card header.

**Shown only when:**
- `userRole === "admin"` AND
- `hasOrganizationFeature("user_activity_insights") === true`

Click navigates to `/admin/user-activity`.

Does not add any new queries or state to UserManagement.

---

## 12) Feature-flag safety guarantee (Phase 2 hardening)

All four layers that could write or expose activity data are gated behind `is_user_activity_insights_enabled()`:

| Layer | Gate |
|-------|------|
| **Frontend tracker** | `shouldRun` guard — component exits immediately if `featureEnabled` is false; no RPCs called |
| **Expense trigger** (`trg_user_activity_expense_submitted`) | First line checks `is_user_activity_insights_enabled(NEW.organization_id)` and returns early if off |
| **`end_user_activity_session` RPC** | Resolves org_id from the session row, then checks helper before updating |
| **RLS SELECT policies** | All 4 policies call `is_user_activity_insights_enabled(organization_id)` — rows are invisible when feature is off |

Additional hardening details:
- `is_user_activity_insights_enabled()` is defined **before** the RLS policies in the migration (correct run order).
- The tracker's React cleanup path has a null guard — `end_user_activity_session` is only called when `sessionIdRef.current` is non-null (i.e., only when `start_user_activity_session` returned a valid UUID).
- The admin `useQuery` for the summary has `enabled: featureEnabled` — no fetch is attempted when the feature is off.
- Toggling the feature flag off immediately revokes read access (RLS) and stops new writes (tracker + trigger gates) without any data loss.

---

## 13) RLS

Both tables have RLS enabled. All SELECT policies include `is_user_activity_insights_enabled(organization_id)` (see §12):

| Table | Policy | Rule |
|-------|--------|------|
| user_activity_sessions | Org admins can read | feature enabled AND `organization_id IN (admin's org)` |
| user_activity_sessions | Users can read own | feature enabled AND `user_id = auth.uid()` |
| user_activity_daily_rollups | Org admins can read | same |
| user_activity_daily_rollups | Users can read own | same |

No INSERT/UPDATE/DELETE policies for the client — all writes go through SECURITY DEFINER RPCs or the trigger.

---

## 14) Manual SQL run order

**Migration file:** `supabase/migrations/290713_0900_user_activity_insights.sql`

**SQL was created but NOT run. Apply manually:**

```
1. Open Supabase SQL Editor for the target project.
2. Paste the full contents of: supabase/migrations/290713_0900_user_activity_insights.sql
3. Run the script.
4. Verify: check that both tables exist, indexes are created, and RPCs are callable.
5. In Master Admin → enable "User Activity Insights" for one test organization.
6. Log in as an employee in that org and keep the app visible for 2 minutes.
7. As admin, open /admin/users → click "Activity Insights" → verify data appears.
```

---

## 15) Staging rollout runbook

> **Staging only. Do not apply to production until staging passes.**

### Pre-requisites
- Feature branch `feature/user-activity-insights` deployed to staging frontend.
- Staging Supabase project open in SQL Editor (not production).

### Step-by-step

1. **Deploy frontend.** Confirm feature branch is deployed to the staging frontend environment.

2. **Open Supabase staging project only.** Do NOT use the production project.

3. **Run migration.**
   Open Supabase SQL Editor → paste the full contents of:
   ```
   supabase/migrations/290713_0900_user_activity_insights.sql
   ```
   Run the script. It is safe to run multiple times (idempotent — `CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, etc.).

4. **Verify tables exist.**
   Run `docs/sql/user-activity-insights/00_verify_installation.sql` → confirm:
   - `public.user_activity_sessions` exists
   - `public.user_activity_daily_rollups` exists

5. **Verify RPCs exist.**
   Same file — confirm all 7 functions are listed:
   - `start_user_activity_session`
   - `record_user_activity_heartbeat`
   - `end_user_activity_session`
   - `get_user_activity_summary`
   - `get_user_activity_timeline`
   - `get_user_activity_detail`
   - `is_user_activity_insights_enabled`

6. **Verify trigger exists.**
   Same file — confirm `trg_user_activity_expense_submitted` is listed with 2 rows (INSERT + UPDATE).

7. **Keep feature DISABLED first.**
   Do not enable the feature yet.

8. **Verify feature-disabled state.**
   Run `docs/sql/user-activity-insights/01_verify_feature_disabled_no_data_access.sql` while feature is off:
   - Login as admin → confirm "Activity Insights" button is NOT visible in `/admin/users`
   - Confirm `is_user_activity_insights_enabled(org_id)` returns `false`
   - Submit a test expense → confirm `expenses_submitted_count` did NOT increment in rollups

9. **Enable `user_activity_insights` for ONE test organization only.**
   Go to Master Admin dashboard → Feature Toggles → enable for the test org only.
   Do NOT enable for all orgs at this stage.

10. **Login as employee from that org.**
    Keep the app visible for at least 2 minutes (two heartbeat cycles).

11. **Verify data in admin view.**
    Login as admin from the same org → open `/admin/user-activity`:
    - Summary table shows the employee with `last_seen` updated
    - Today active time > 0
    - Click the employee row → timeline drawer opens

12. **Run enabled-state SQL checks.**
    Run `docs/sql/user-activity-insights/02_verify_feature_enabled_rollups.sql`:
    - Confirm rollup rows exist for today
    - Confirm `visible_seconds` > 0
    - Submit an expense → re-run → confirm `expenses_submitted_count` incremented

13. **Disable flag again and verify stop.**
    Turn OFF feature for the test org from Master Admin.
    - Tracker should stop sending heartbeats (no new `updated_at` advances in rollups)
    - Admin page shows "not enabled" card

14. **Multi-tab check.**
    Re-enable for the test org. Open two browser tabs as the same employee.
    Keep both visible for 2 minutes.
    Confirm `visible_seconds` did NOT double (leader election working).

15. **Cross-org isolation check.**
    Login as admin from a DIFFERENT org (feature disabled for them).
    Confirm they cannot see the test org's activity data.

16. **Do not enable for all orgs** until step 13–15 pass.

---

## 16) QA testing checklist

After SQL is applied in staging:

- [ ] Master admin enables `user_activity_insights` for test org
- [ ] Admin sees "Activity Insights" button in UserManagement
- [ ] Admin navigates to `/admin/user-activity`
- [ ] Page loads with summary cards and table
- [ ] Employee logs in — last seen updates within ~60 s
- [ ] Today active time increases each minute tab is visible
- [ ] Open two tabs as same employee — time is NOT doubled (leader election)
- [ ] Employee submits an expense — `today_expenses_submitted` increments
- [ ] Admin clicks a user row — 30-day timeline drawer opens
- [ ] Inactive days in timeline are shown as greyed-out zero rows
- [ ] Disable feature flag for org — tracker sends no more heartbeats
- [ ] Admin page shows "not enabled" card when feature is disabled
- [ ] Different org admin cannot see the first org's activity data
- [ ] Sign out → `pesowise-user-activity-leader` localStorage key is cleared

---

## 17) Rollback notes

To roll back:
1. Drop the trigger: `DROP TRIGGER IF EXISTS trg_user_activity_expense_submitted ON public.expenses;`
2. Drop the RPCs: `DROP FUNCTION IF EXISTS public.start_user_activity_session(text);` etc.
3. Drop helper: `DROP FUNCTION IF EXISTS public.is_user_activity_insights_enabled(uuid);`
4. Drop tables: `DROP TABLE IF EXISTS public.user_activity_sessions; DROP TABLE IF EXISTS public.user_activity_daily_rollups;`
5. Disable the feature flag via Master Admin (prevents tracker from calling non-existent RPCs).
6. Feature flag key `user_activity_insights` can remain in `organizationFeatureKeys.ts` — it will simply never match any enabled row.

Frontend code can remain in place. If the tables/RPCs don't exist, the tracker RPCs will fail silently (`console.warn`), and the admin page will show an error card.

---

## 18) Pre-staging approval checklist

Complete every item before enabling the feature in production.

**Infrastructure**
- [ ] Branch `feature/user-activity-insights` deployed to **staging frontend only** (not production)
- [ ] SQL migration run in **staging Supabase project only** (not production)
- [ ] `00_verify_installation.sql` confirms 2 tables, 5 indexes, 7 functions, 1 trigger, RLS enabled, 4 policies

**Feature-disabled verification (run BEFORE enabling flag)**
- [ ] `01_verify_feature_disabled_no_data_access.sql` shows no rollup writes after expense submission
- [ ] `/admin/users` does not show the Activity Insights button
- [ ] `/admin/user-activity` shows "not enabled" card

**Single-org enable test**
- [ ] Feature enabled for **one test organization only** via Master Admin
- [ ] Employee keeps app visible 2–3 minutes → `visible_seconds` > 0 in rollups
- [ ] Admin sees employee row in `/admin/user-activity` with correct `last_seen`
- [ ] Timeline drawer opens and shows data
- [ ] Employee submits one expense → `expenses_submitted_count` increments
- [ ] `02_verify_feature_enabled_rollups.sql` confirms all rollup fields

**Multi-tab isolation test**
- [ ] Two tabs opened as the same employee for 2 minutes
- [ ] `visible_seconds` does NOT approximately double (leader election working)

**Cross-org isolation test**
- [ ] Admin from a different org (feature disabled) cannot see test org's activity data
- [ ] `is_user_activity_insights_enabled()` returns false for non-enabled orgs

**Disable / re-enable test**
- [ ] Feature disabled → tracker stops sending heartbeats within 60s
- [ ] RLS immediately blocks reads of existing rows
- [ ] Re-enable → data reappears without loss

**Sign-out test**
- [ ] Sign out → `pesowise-user-activity-leader` localStorage key is cleared

**Do NOT proceed to production until ALL items above are checked.**

---

## 20) Production SQL decision gate

> **Preferred path:** test on a staging Supabase project first (see §15).
> **Fallback path (this section):** production SQL with feature disabled and single-org rollout,
> used only when no staging Supabase is available.

### DO NOT run the production migration unless ALL of the following are true

| # | Condition | Check |
|---|-----------|-------|
| 1 | Feature branch `feature/user-activity-insights` is deployed (or scheduled) to the production frontend | [ ] |
| 2 | A full database backup/snapshot exists and has been verified restorable | [ ] |
| 3 | `docs/sql/user-activity-insights/99_production_preflight_DO_NOT_RUN_MIGRATION_YET.sql` returns a clean result (all 10 checks pass) | [ ] |
| 4 | Zero organizations have `feature_key = 'user_activity_insights'` AND `enabled = true` (preflight check 6 returns 0 rows) | [ ] |
| 5 | You are running during a low-traffic window (overnight or weekend — preflight check 8 informs timing) | [ ] |
| 6 | You will keep the feature flag **disabled** immediately after the migration runs | [ ] |
| 7 | You will run `docs/sql/user-activity-insights/00_verify_installation.sql` immediately after the migration | [ ] |
| 8 | You will enable the feature for **ONE internal/test organization only** first | [ ] |
| 9 | The rollback SQL file `docs/sql/user-activity-insights/99_rollback_user_activity_insights_DO_NOT_RUN.sql` is open and ready in a second browser tab (but will NOT be run unless explicitly required) | [ ] |
| 10 | You accept that the migration adds a trigger to the `expenses` table — this trigger no-ops (returns `NEW` immediately) for all orgs while the feature is disabled | [ ] |

### Production-only rollout sequence (when no staging is available)

```
1. Run 99_production_preflight_DO_NOT_RUN_MIGRATION_YET.sql → confirm all PASS
2. During low-traffic window: run supabase/migrations/290713_0900_user_activity_insights.sql
3. Immediately run 00_verify_installation.sql → confirm 2 tables, 5 indexes, 7 functions, trigger, RLS, 4 policies
4. Keep feature flag DISABLED — do not enable yet
5. Run 01_verify_feature_disabled_no_data_access.sql → confirm feature is off and no writes happen
6. Enable feature for ONE internal test org only via Master Admin
7. Keep app visible 2 minutes as an employee in that org → check rollup rows
8. Run 02_verify_feature_enabled_rollups.sql → confirm visible_seconds > 0, rollup rows exist
9. Submit a test expense → re-run 02 → confirm expenses_submitted_count incremented
10. Disable flag for the test org
11. Verify RLS blocks reads when disabled (re-run 01 checks conceptually: query rollup table via SQL)
12. Do NOT enable for all orgs until satisfied with single-org test
```

### Trigger impact note

The trigger `trg_user_activity_expense_submitted` fires on every `INSERT` or `status UPDATE` on the `public.expenses` table for **all orgs**. Its first line calls `is_user_activity_insights_enabled(NEW.organization_id)` — when the feature is disabled (which it will be for all orgs initially), it returns `NEW` immediately with no further work. The added latency per expense update is one indexed lookup on `organization_features` — negligible (sub-millisecond).

### Rollback

If anything goes wrong after the migration:
1. Disable the feature flag for all orgs via Master Admin (tracker stops calling RPCs)
2. Run `docs/sql/user-activity-insights/99_rollback_user_activity_insights_DO_NOT_RUN.sql` only after explicit approval
3. All collected activity data will be permanently deleted by the rollback script

---

## 21) Production hotfix — app_role enum cast

### Symptom

After applying the migration and enabling the feature for one org, the preview/prod console showed:

```
invalid input value for enum app_role: "master_admin"
```

This error occurred when calling:
- `start_user_activity_session`
- `get_user_activity_summary`

### Root cause

Both RPCs compared `organization_memberships.role` (which is typed as the `app_role` enum) directly against the string literal `'master_admin'`. PostgreSQL cannot implicitly cast a string literal to an enum value that is not defined in that enum, so it throws a 400 before any RPC logic executes.

Fix: cast the enum column to text before comparing — `role::text <> 'master_admin'` — since PostgreSQL can always cast any enum to its text representation.

### File to run

```
docs/sql/user-activity-insights/03_hotfix_app_role_enum_casts.sql
```

Only contains `CREATE OR REPLACE FUNCTION`. No tables, triggers, policies, or expense logic changed.

### Run order

1. Run `docs/sql/user-activity-insights/03_hotfix_app_role_enum_casts.sql` in the Supabase SQL Editor (production)
2. Hard refresh the preview/prod app
3. Login as employee — confirm `start_user_activity_session` no longer returns 400
4. Login as admin — confirm `get_user_activity_summary` no longer returns 400
5. Confirm activity data appears in `/admin/user-activity`

### Source migration also fixed

`supabase/migrations/290713_0900_user_activity_insights.sql` has been updated with the same `::text` casts so future fresh installs do not hit this error.

---

## 22) Production hotfix 04 — get_user_activity_summary user_id ambiguity

### Symptom

After applying Hotfix 03, `start_user_activity_session` returns 200 ✓ but `get_user_activity_summary` still returns 400 with:

```json
{
  "code": "42702",
  "message": "column reference \"user_id\" is ambiguous",
  "details": "It could refer to either a PL/pgSQL variable or a table column."
}
```

### Root cause

`get_user_activity_summary` is declared as `RETURNS TABLE(user_id uuid, name text, email text, employee_id text, role text, last_seen_at timestamptz, first_seen_in_range timestamptz, today_visible_seconds integer, today_expenses_submitted integer, ...)`.

In PL/pgSQL, every column listed in `RETURNS TABLE` is implicitly declared as an output variable in the function scope. This means all of `user_id`, `name`, `email`, `employee_id`, `role`, `last_seen_at`, `first_seen_in_range`, `today_visible_seconds`, `today_expenses_submitted` etc. are live PL/pgSQL variables throughout the function body.

When CTE output columns have the same names (e.g. `r.user_id AS user_id`, `om.role AS role`), PostgreSQL (error 42702) cannot resolve whether the reference is to the CTE column or the PL/pgSQL output variable of the same name — even when the reference is qualifier-prefixed in the final SELECT.

### Fix

Rename every CTE output column to a unique alias that does not match any `RETURNS TABLE` output variable:

| Context | Old name | New unique alias |
|---------|----------|-----------------|
| Admin lookup | `om_c` alias | `om_admin` alias |
| members CTE | `user_id` | `member_user_id` |
| members CTE | `name` | `member_name` |
| members CTE | `email` | `member_email` |
| members CTE | `employee_id` | `member_employee_id` |
| members CTE | `role` | `member_role` |
| range_rollups CTE | `user_id` | `rollup_user_id` |
| range_rollups CTE | `activity_date` | `rollup_activity_date` |
| range_rollups CTE | `visible_seconds` | `rollup_visible_seconds` |
| range_rollups CTE | `expenses_submitted_count` | `rollup_expenses_submitted_count` |
| range_rollups CTE | `first_seen_at` | `rollup_first_seen_at` |
| range_rollups CTE | `last_seen_at` | `rollup_last_seen_at` |
| agg CTE | `user_id` | `agg_user_id` |
| agg CTE | `last_seen_at` | `agg_last_seen_at` |
| agg CTE | `first_seen_in_range` | `agg_first_seen_in_range` |
| agg CTE | `total_visible_seconds` | `agg_total_visible_seconds` |
| agg CTE | `total_expenses_submitted` | `agg_total_expenses_submitted` |
| agg CTE | `active_days` | `agg_active_days` |
| agg CTE | `last_active_at` | `agg_last_active_at` |
| today_agg CTE | `user_id` | `today_user_id` |
| today_agg CTE | `visible_seconds` | `today_visible_seconds_value` |
| today_agg CTE | `expenses_submitted_count` | `today_expenses_submitted_value` |

The final SELECT maps these unique aliases back to the declared `RETURNS TABLE` column order with explicit `AS` aliases so PostgREST binds the result correctly.

### Files created / changed

| File | Change |
|------|--------|
| `docs/sql/user-activity-insights/04_hotfix_summary_user_id_ambiguity.sql` | New — full `CREATE OR REPLACE FUNCTION` with renamed CTE columns |
| `docs/sql/user-activity-insights/05_verify_summary_rpc_after_hotfix.sql` | New — read-only verification queries (4 checks) |
| `supabase/migrations/290713_0900_user_activity_insights.sql` | D11 function replaced with Hotfix 04 version; D12/D13 admin check gets `role::text` cast |

### Run order

1. Run `docs/sql/user-activity-insights/04_hotfix_summary_user_id_ambiguity.sql` in the Supabase SQL Editor
2. Hard refresh the app
3. Open `/admin/user-activity` → confirm `get_user_activity_summary` returns 200
4. Optionally run `docs/sql/user-activity-insights/05_verify_summary_rpc_after_hotfix.sql` to verify

### Verification

After running, confirm the function was applied:

```sql
SELECT pg_get_functiondef(oid)
FROM   pg_proc
WHERE  proname = 'get_user_activity_summary'
  AND  pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public');
```

Expected: output contains `member_user_id`, `agg_user_id`, `today_user_id`.  
Expected: output does NOT contain `GROUP BY r.user_id` or unqualified `WHERE user_id =`.

### Safety

- Only `CREATE OR REPLACE FUNCTION` — no DROP, no tables, no triggers, no RLS
- No changes to expenses, expense submission logic, or any other RPC
- Hotfix 03 enum casts (`role::text`) are preserved and extended
- Idempotent — safe to run multiple times

---

## 23) Production hotfix 05 — rewrite summary RPC as SQL-language function

### Symptom

`get_user_activity_summary` still returns 400 after Hotfix 04 (CTE column renaming). Employee tracking continues to work: `start_user_activity_session` = 200, `record_user_activity_heartbeat` = 204.

### Root cause

Hotfix 04 renamed all CTE output columns to unique prefixes (`member_`, `rollup_`, `agg_`, `today_*_value`) to avoid PL/pgSQL RETURNS TABLE output-variable ambiguity. This approach is correct in theory, but some PostgreSQL planner paths still raise SQLSTATE 42702 for `LANGUAGE plpgsql` `RETURNS TABLE` functions when any CTE or subquery column name matches an output variable name — even after renaming. The class of bug is inherent to `LANGUAGE plpgsql` + `RETURNS TABLE`.

### Fix

Rewrite `get_user_activity_summary` as `LANGUAGE sql`. Pure SQL functions do not have PL/pgSQL variable scoping. `RETURNS TABLE` column names in a `LANGUAGE sql` function are only used by the caller to bind the result — they do not exist as variables inside the function body. SQLSTATE 42702 from output-variable collision is therefore impossible.

**Behaviour change (safe):** The SQL version returns an **empty set** instead of raising exceptions when the caller is unauthenticated, not an admin, or the feature is disabled. The frontend handles `data ?? []` and shows an empty state.

### Files created / changed

| File | Change |
|------|--------|
| `docs/sql/user-activity-insights/06_hotfix_summary_sql_language_function.sql` | New — `LANGUAGE sql` rewrite of `get_user_activity_summary` |
| `docs/sql/user-activity-insights/07_verify_summary_sql_language_hotfix.sql` | New — read-only verification (4 checks, language + definition + data) |
| `supabase/migrations/290713_0900_user_activity_insights.sql` | D11 replaced with `LANGUAGE sql` version |

### Run order

1. Run `docs/sql/user-activity-insights/06_hotfix_summary_sql_language_function.sql` in the Supabase SQL Editor
2. Hard refresh `/admin/user-activity` (Ctrl+Shift+R)
3. Confirm `get_user_activity_summary` returns 200 in Network tab
4. Confirm the activity table renders member rows
5. Optionally run `docs/sql/user-activity-insights/07_verify_summary_sql_language_hotfix.sql` — Check 1 must show `language = sql`

### Verification (Check 1)

```sql
SELECT p.proname, l.lanname AS language, p.prosecdef AS security_definer
FROM   pg_proc p JOIN pg_language l ON l.oid = p.prolang
WHERE  p.proname = 'get_user_activity_summary'
  AND  p.pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public');
```

Expected: `language = sql`, `security_definer = true`.

### Safety

- Only `CREATE OR REPLACE FUNCTION` — no DROP, no tables, no triggers, no RLS
- No changes to expenses, expense submission logic, or any other RPC
- Hotfix 03 enum casts (`role::text`) preserved
- Idempotent — safe to run multiple times

---

## 24) UI revision — admin daily activity log

**Motivation:** The original drawer showed a narrow bar-and-text list. Admins needed to see clear, structured day-by-day logs with all time fields visible at a glance.

**Changes (UI only — no SQL, no tracking scope change):**

- `src/pages/UserActivityInsights.tsx` fully redesigned.

### New helper functions added

| Function | Purpose |
|---|---|
| `formatClockTime(ts)` | Format timestamp as `HH:MM AM/PM` |
| `formatDateOnly(dateStr)` | Short date label, avoids UTC shift via `T00:00:00` suffix |
| `formatLongDate(dateStr)` | Full label e.g. `Sun, 13 Jul 2026`, safe for date-only strings |
| `getMaxVisibleSeconds(timeline)` | Dynamic scale for progress bar (floor: 1 hour) |

### Redesigned `TimelineDrawer`

- Size: `max-w-4xl`, `max-h-[90vh]`, flex column with scrollable body
- Header shows: user name, date range, privacy note with `Eye` icon
- **5 mini summary cards**: Active days · Inactive days · Total app time · Expenses submitted · Last used
- **Desktop**: proper `<table>` with columns: Date · Status · First used · Last used · App time · Sessions · Expenses
  - Active rows: white background with green-50 hover + green Active pill
  - Inactive rows: gray-50 background + gray Inactive pill
  - Progress bar is secondary (under App time column), scaled to `getMaxVisibleSeconds()`
  - Expenses column always shown, even when 0
  - First used / Last used always shown, `—` when null
- **Mobile**: card-per-day layout, no horizontal overflow
- Empty state: "No activity data for this range."

### Main page improvements

- Table column labels: `Last seen` → `Last used`, `Today time` → `Today app time`, `Today exp.` → `Today expenses`
- Card description row now includes: "Click any user to view day-by-day activity logs."
- Error state now shows a two-line helpful message instead of a bare red string

### Data source

All data comes from existing `get_user_activity_timeline` RPC fields:
`activity_date`, `first_seen_at`, `last_seen_at`, `visible_seconds`, `session_count`, `expenses_submitted_count`, `is_active`

No new SQL. No new RPC. No SQL schema change. No tracking change.

### Session detail expansion

**Skipped.** The daily log table already provides the detail admins need. Adding per-session expansion would require a second RPC call per row click with non-trivial state management; deferred to a future iteration if requested.

---

## 25) Privacy notice & acknowledgement flow

**Motivation:** Before merging to main, users must be informed that their activity is tracked and consent before the tracker starts. This satisfies internal legal/compliance requirements.

### SQL artifacts (run in order — NOT yet applied)

| File | Purpose |
|------|---------|
| `docs/sql/user-activity-insights/08_user_activity_notice_acknowledgement.sql` | Creates `user_activity_notice_acknowledgements` table, RLS policies, `has_acknowledged_user_activity_notice` RPC, `acknowledge_user_activity_notice` RPC |
| `docs/sql/user-activity-insights/09_verify_user_activity_notice_acknowledgement.sql` | 7-check read-only verification (table exists, RLS on, policies, both RPCs, ack count, SECURITY DEFINER, unique constraint) |

### New table: `user_activity_notice_acknowledgements`

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | `gen_random_uuid()` |
| `organization_id` | uuid FK → organizations | CASCADE DELETE |
| `user_id` | uuid FK → auth.users | CASCADE DELETE |
| `notice_version` | text | Default `'user_activity_notice_v1'` |
| `acknowledged_at` | timestamptz | Updated on re-acknowledgement |
| `created_at` | timestamptz | Immutable |

Unique constraint on `(organization_id, user_id, notice_version)`. RLS: users read own rows; org admins read all org rows.

### New RPCs

| RPC | Returns | Behaviour |
|-----|---------|-----------|
| `has_acknowledged_user_activity_notice(p_notice_version)` | `boolean` | Returns `true` if user has acknowledged, or if feature is off for their org. Returns `false` if not yet acknowledged. Unauthenticated → `false`. |
| `acknowledge_user_activity_notice(p_notice_version)` | `void` | Upserts row for the user's org. No-op if org has feature disabled or user is unauthenticated. |

Both are `SECURITY DEFINER SET search_path = public`. Notice version constant: `"user_activity_notice_v1"`.

### New component: `UserActivityNoticeGate` (`src/components/UserActivityNoticeGate.tsx`)

Replaces the bare `<UserActivityTracker />` in the app shell (`src/components/Layout.tsx`).

Flow:
1. If feature is off OR user is master_admin → render `<UserActivityTracker noticeAcknowledged={true} />` directly (no modal).
2. While checking acknowledgement (React Query, 5-min staleTime) → render nothing (tracker stays idle).
3. If not acknowledged → render `<UserActivityTracker noticeAcknowledged={false} />` PLUS a non-dismissible `<Dialog open>` modal showing the privacy notice.
4. On "I understand" button click → call `acknowledge_user_activity_notice` RPC → invalidate query → render `<UserActivityTracker noticeAcknowledged={true} />`.

The modal cannot be closed without acknowledging. Error state shown if RPC fails.

### Modified: `UserActivityTracker` (`src/components/UserActivityTracker.tsx`)

Added `noticeAcknowledged?: boolean` prop (default `false`). Added to `shouldRun`:

```ts
const shouldRun =
  !!userId &&
  !!organizationId &&
  userRole !== "master_admin" &&
  featureEnabled &&
  noticeAcknowledged;   // ← NEW
```

Tracker stays completely idle until the gate passes `true`.

### Modified: `Layout.tsx`

- Import changed: `UserActivityTracker` → `UserActivityNoticeGate`
- Both render sites (mobile + desktop branches) changed: `<UserActivityTracker />` → `<UserActivityNoticeGate />`

### Modified: `MasterAdminDashboard.tsx`

When a master-admin enables `user_activity_insights` for an org, a confirmation dialog appears before the save. Dialog requires:
- Checkbox: "I confirm that this organization has informed its users that their activity will be tracked within PesoWise."
- Enable button disabled until checkbox is checked.
- Cancel button clears pending state without saving.

This gate is only shown when ENABLING (not disabling) `user_activity_insights`.

### Modified: `UserActivityInsights.tsx` (admin page)

Added a two-column privacy info card between the page header and the user table:
- **Left column — "What this tracks":** Visible PesoWise app time · Last used time · Session count · Expenses submitted per day
- **Right column — "What this does NOT track":** Keystrokes · Screenshots · Websites or other apps · Location / camera / microphone

Styled as `bg-blue-50` rounded card with `ShieldCheck` (green) and `XCircle` (red) icons.

### Tests

| Test | File | Change |
|------|------|--------|
| `does not call start_user_activity_session when noticeAcknowledged is false (default)` | `userActivityTracker.test.tsx` | NEW — verifies tracker is fully idle when prop is false |
| `calls start_user_activity_session when feature is enabled, user is set, and noticeAcknowledged is true` | `userActivityTracker.test.tsx` | RENAMED from original "calls start_user_activity_session when feature is enabled and user is set" — now passes `noticeAcknowledged={true}` |
| `clears the leader key on unmount even when start_user_activity_session returns null` | `userActivityTracker.test.tsx` | UPDATED — now passes `noticeAcknowledged={true}` |

736/736 tests pass.

---

## 26) DPDP compliance-control package

> **Compliance wording:** DPDP compliance controls implemented — legal review required before representing this as compliant.

This section documents the full compliance-control layer added in v2.3. It does not constitute legal advice and does not guarantee DPDP compliance. The enabling organisation is responsible for legal review, policy adoption, and user communication.

### A. In-app notice (updated)

`src/components/UserActivityNoticeGate.tsx` updated to add:
- Retention note: "Activity data is kept according to your organization's configured retention policy."
- Access/rights note: "For access, correction, or deletion requests, contact your organization admin or support according to your organization's policy."

### B. Admin enablement disclaimer (strengthened)

`src/pages/MasterAdminDashboard.tsx` confirmation dialog updated:
- Added: "This is not a hidden monitoring feature. Users will be shown an in-app notice before tracking starts."
- Added: "Your organization remains responsible for HR/legal policy, lawful basis, retention period, and grievance/contact process."
- Expanded checkbox text: covers lawful/internal approval + retention policy + grievance/contact process.
- Added non-blocking audit RPC call (`record_user_activity_feature_audit`) on enable.
- Added non-blocking audit RPC call on disable.

### C. Admin activity page privacy card (expanded)

`src/pages/UserActivityInsights.tsx` privacy card now includes:
- Admin responsibility note
- Retention note
- Access/correction/deletion contact note

### D. SQL files

| File | Purpose | Destructive? |
|------|---------|-------------|
| `08_user_activity_notice_acknowledgement.sql` | Acknowledgement table + policies + RPCs | No (CREATE IF NOT EXISTS); policies now idempotent |
| `10_retention_cleanup_activity_data_DO_NOT_RUN_AUTOMATICALLY.sql` | Retention cleanup (180-day default) | DELETE sections commented out |
| `11_export_user_activity_data_for_request.sql` | Access/export request — read-only | No |
| `12_erasure_user_activity_data_DO_NOT_RUN_AUTOMATICALLY.sql` | Erasure/deletion for one user | DELETE sections commented out |
| `13_user_activity_feature_audit_log.sql` | Audit table + RPC for enable/disable events | No (CREATE IF NOT EXISTS) |
| `14_harden_notice_ack_policy_idempotency.sql` | Idempotent re-creation of ACK policies | No (DROP IF EXISTS + CREATE) |

### E. Supporting documents

| Document | Purpose |
|----------|---------|
| [`user-activity-insights-privacy-notice.md`](./user-activity-insights-privacy-notice.md) | Client-facing privacy notice template |
| [`user-activity-insights-data-inventory.md`](./user-activity-insights-data-inventory.md) | Data inventory / record of processing |
| [`user-activity-insights-dpia.md`](./user-activity-insights-dpia.md) | DPIA / privacy impact assessment |
| [`user-activity-insights-breach-runbook.md`](./user-activity-insights-breach-runbook.md) | Breach response runbook |

### F. What still cannot be claimed

> Do not represent this as legally DPDP compliant until:
> - Reviewed by qualified legal counsel
> - Adopted into the enabling organisation's HR/internal policy
> - Lawful basis confirmed
> - Privacy notice delivered to users before activation
> - Retention period operationalised (cleanup schedule in place)
> - Grievance/contact email operational

### G. Pre-main / pre-production checklist

- [ ] Legal counsel reviewed this feature
- [ ] Privacy notice template reviewed and adopted by client org
- [ ] Lawful basis for processing confirmed
- [ ] Grievance/contact email decided and operational
- [ ] Retention period decided (default: 180 days)
- [ ] Breach notification process and owner named
- [ ] SQL files 08, 09, 13, 14 applied in Supabase
- [ ] One-org pilot tested before full rollout
- [ ] Client onboarding documentation updated

---

## 19) Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-07-13 | 1.0 | Agent | Initial — feature flag, SQL migration (not run), tracker, admin page, UserManagement link. 728/728 tests pass. TypeScript clean. Build clean. Branch: `feature/user-activity-insights`. |
| 2026-07-13 | 1.1 | Agent | Phase 2 hardening — added feature-flag gates to expense trigger, `end_user_activity_session`, and all 4 RLS SELECT policies; fixed D7/D6 migration run order; added null guard in tracker cleanup; updated §12 and §13. 728/728 tests pass. TypeScript clean. |
| 2026-07-13 | 1.2 | Agent | Phase 3 staging prep — added §15 staging rollout runbook; created `docs/sql/user-activity-insights/` verification SQL files (00, 01, 02). All validation passes. |
| 2026-07-13 | 1.3 | Agent | Phase 4 hardening — mountedRef reset on effect restart; follower-tab takeover polling (FOLLOWER_CHECK_MS=30s); stopAsLeader clears sessionIdRef/refs on leadership loss; fixed misleading sendBeacon comment; corrected SQL migration header wording (apply before enabling flag, staging only). |
| 2026-07-13 | 1.4 | Agent | Phase 5 polish — leader key always cleared on cleanup even when start returned null; userId extracted as stable primitive, added to effect dep array [shouldRun, userId] so tracker restarts on user change; 7 tracker unit tests added (735/735 pass). |
| 2026-07-13 | 1.5 | Agent | Phase 6 staging prep — final safety review (all 17 points pass); updated status to staging-ready; added §18 pre-staging approval checklist; validation: git diff clean, TypeScript clean, 735/735 tests pass, build clean. SQL still not applied. Feature not enabled for any org. |
| 2026-07-13 | 1.6 | Agent | Production preflight package — no staging Supabase available; added §20 production SQL decision gate (10-point go/no-go checklist + production-only rollout sequence + trigger impact note + rollback guidance); created `docs/sql/user-activity-insights/99_production_preflight_DO_NOT_RUN_MIGRATION_YET.sql` (read-only, 10 checks) and `99_rollback_user_activity_insights_DO_NOT_RUN.sql` (destructive, explicit-approval-only). SQL risk review: no DROP TABLE, no DELETE, no UPDATE on existing business tables; only risk is CREATE POLICY not being idempotent (preflight check 5 detects this). Status updated to production-preflight-ready. |
| 2026-07-13 | 1.7 | Agent | Phase 7 hotfix — production test found `invalid input value for enum app_role: "master_admin"` in `start_user_activity_session` and `get_user_activity_summary`. Root cause: bare string comparison against `app_role` enum. Fix: `role::text <> 'master_admin'` + `om.role::text AS role` in SELECT. Created `docs/sql/user-activity-insights/03_hotfix_app_role_enum_casts.sql` (CREATE OR REPLACE FUNCTION only — no tables/triggers/RLS/expense logic changed). Source migration updated with same casts. Added §21 production hotfix section. 735/735 tests pass. TypeScript clean. Build clean. |
| 2026-07-13 | 1.8 | Agent | Hotfix 04 — comprehensive CTE column renaming to fix SQLSTATE 42702. Root cause: RETURNS TABLE(user_id, name, email, role, last_seen_at, ...) declares all those names as PL/pgSQL output variables, creating ambiguity with CTE column names of the same names throughout the function body. Fix: renamed ALL CTE output columns to unique prefixes (member_, rollup_, agg_, today_*_value); final SELECT maps them back with explicit AS aliases. Created `04_hotfix_summary_user_id_ambiguity.sql` + `05_verify_summary_rpc_after_hotfix.sql`. Source migration D11 fully replaced; D12/D13 get role::text cast. Added §22. |
| 2026-07-13 | 1.9 | Agent | Hotfix 05 — rewrite get_user_activity_summary as LANGUAGE sql. Hotfix 04 CTE renaming was insufficient; PL/pgSQL RETURNS TABLE output-variable scoping still triggered 42702. Fix: rewrite as pure SQL function — no PL/pgSQL variable scope, class of bug eliminated entirely. Returns empty set instead of exception for unauthenticated/non-admin/feature-off callers (frontend handles data??[] safely). Created `06_hotfix_summary_sql_language_function.sql` + `07_verify_summary_sql_language_hotfix.sql`. Source migration D11 replaced with LANGUAGE sql version. Added §23. 735/735 tests pass. TypeScript clean. Build clean. |
| 2026-07-13 | 2.0 | Agent | Hotfix 06 — fix `profiles.full_name` → `profiles.name` in all activity SQL files. Running Hotfix 05 SQL surfaced error 42703 (`column p_member.full_name does not exist`): profiles table uses `name`, not `full_name`. Fixed in `06_hotfix_summary_sql_language_function.sql`, source migration D11, and all historical hotfix/verify files (`03`, `04` ×2, `05`, `07`). No functional change — column name correction only. |
| 2026-07-13 | 2.1 | Agent | UI redesign — admin daily activity log drawer. Previous drawer showed narrow bar list; replaced with `max-w-4xl` dialog with 5 summary cards + full desktop table (Date, Status, First used, Last used, App time, Sessions, Expenses) + mobile card layout. Added `formatClockTime`, `formatDateOnly`, `formatLongDate`, `getMaxVisibleSeconds` helpers. Main page: column labels improved, error state improved, drawer hint added. No SQL change. 735/735 tests pass. TypeScript clean. Build clean. See §24. |
| 2026-07-13 | 2.2 | Agent | Privacy notice & acknowledgement flow — legal gate before tracking starts. New `UserActivityNoticeGate` component wraps `UserActivityTracker` in the app shell; blocks tracker until user acknowledges a non-dismissible Dialog modal. `noticeAcknowledged` prop added to tracker (defaults false). Admin dashboard shows confirmation dialog with checkbox before enabling the feature. Admin user-activity page gains privacy info card (what IS tracked / what is NOT tracked). SQL: `user_activity_notice_acknowledgements` table + `has_acknowledged_user_activity_notice` + `acknowledge_user_activity_notice` RPCs (SECURITY DEFINER, RLS). Verification: `09_verify_user_activity_notice_acknowledgement.sql`. Tests: 736/736 pass (1 updated, 2 new). TypeScript clean. Build clean. See §25. |
| 2026-07-13 | 2.3 | Agent | DPDP compliance-control package. In-app notice updated with retention note + access/correction/deletion contact copy. Admin enablement dialog strengthened: "not a hidden monitoring feature" statement, responsible-organisation language, expanded checkbox covering lawful basis + retention + grievance. Audit log call added (non-blocking, requires SQL 13). Admin activity page privacy card expanded with admin responsibility + retention + access request note. SQL: retention cleanup (10), access export (11), erasure (12), audit log table+RPC (13), acknowledgement policy hardening (14), file 08 made idempotent. Docs: privacy notice template, data inventory, DPIA, breach runbook created. TypeScript clean. 736/736 tests pass. Build clean. See §26. |
| 2026-07-13 | 2.4 | Agent | App-facing legal pages (§27). 3 new public pages: `DataProcessingPolicy` (`/legal/data-processing`), `UserActivityInsightsNotice` (`/legal/activity-insights`), `DataRightsAndGrievance` (`/legal/data-rights`). All use MarketingShell+FullBleedBand pattern. Routes added to App.tsx (public, under TenantHostRedirect). PrivacyPage + TermsPage: LAST_UPDATED bumped to 2026-07-13, Activity Insights section added to each. MarketingFooter LEGAL_LINKS extended with all 3 new pages. Auth.tsx: Privacy Policy / Terms / Data Rights footer link strip added below the login Card. UserActivityNoticeGate: Activity Insights Notice + Privacy Policy links added in acknowledgement disclaimer. MasterAdminDashboard enablement dialog: Activity Insights Notice + Data Processing Policy links added. UserActivityInsights admin page privacy card: Data Rights & Grievance + Activity Insights Notice links added. `Link` import added to MasterAdminDashboard and UserActivityInsights. Deleted obsolete `docs/sql/user-activity-insights/04_hotfix_user_id_ambiguous.sql` (superseded by `04_hotfix_summary_user_id_ambiguity.sql`). TypeScript clean. Build clean. DO NOT push — awaiting user approval. |
---

## §27) App-facing legal pages (v2.4)

**Branch:** `feature/user-activity-insights`
**Status:** Committed, not pushed. Legal review required before production rollout.

### New pages created

| Route | Component | File |
|-------|-----------|------|
| `/legal/data-processing` | `DataProcessingPolicy` | `src/pages/legal/DataProcessingPolicy.tsx` |
| `/legal/activity-insights` | `UserActivityInsightsNotice` | `src/pages/legal/UserActivityInsightsNotice.tsx` |
| `/legal/data-rights` | `DataRightsAndGrievance` | `src/pages/legal/DataRightsAndGrievance.tsx` |

All three use the `MarketingShell` + `FullBleedBand` pattern from existing legal pages. All include template disclaimers noting they must be reviewed by legal counsel before production use.

### Updated pages

- **`PrivacyPage`** (`/privacy`) — `LAST_UPDATED` bumped to 2026-07-13; Activity Insights section added before "Changes": what IS tracked, what is NOT tracked, links to `/legal/activity-insights` and `/legal/data-rights`.
- **`TermsPage`** (`/toc`) — `LAST_UPDATED` bumped; Activity Insights clause added before "Changes": organisation responsibility, in-app notice requirement, scope of tracking, retention responsibility, compliance wording.

### Routes (App.tsx)

Three new routes added under `TenantHostRedirect` (public, no auth guard):

```tsx
<Route path="/legal/data-processing" element={<DataProcessingPolicy />} />
<Route path="/legal/activity-insights" element={<UserActivityInsightsNotice />} />
<Route path="/legal/data-rights" element={<DataRightsAndGrievance />} />
```

Imports added at top of App.tsx (direct import, not lazy — same pattern as existing legal pages).

### Links added

| Location | Links added |
|----------|-------------|
| `MarketingFooter.tsx` LEGAL_LINKS | Activity Insights Notice, Data Processing Policy, Data Rights & Grievance |
| Auth page (`Auth.tsx`) below Card | Privacy Policy · Terms · Data Rights |
| `UserActivityNoticeGate` acknowledgement disclaimer | Activity Insights Notice, Privacy Policy |
| `MasterAdminDashboard` enablement dialog | Activity Insights Notice, Data Processing Policy |
| `UserActivityInsights` privacy card | Data Rights & Grievance, Activity Insights Notice |

### Deleted file

`docs/sql/user-activity-insights/04_hotfix_user_id_ambiguous.sql` — obsolete earlier draft, superseded by `04_hotfix_summary_user_id_ambiguity.sql` (the complete version). Deleted.

### Important wording

All new pages include: **"DPDP compliance controls are implemented; legal review is required before representing this as compliant."**

They do NOT say "fully DPDP compliant."

### Validation

- TypeScript: `npx tsc --noEmit` — clean
- Do NOT push — awaiting user approval
