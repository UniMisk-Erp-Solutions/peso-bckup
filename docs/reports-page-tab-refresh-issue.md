# Reports Page — Tab Switch / Screen Refresh Issue

**Document purpose:** Handoff for another developer or consultant.  
**Route affected:** `/admin/reports` (admin), `/team-reports` (team leaders)  
**Primary file:** `src/pages/Reports.tsx`  
**Last updated:** 2026-05-29  

---

## 1) What the user reported

When using the **Reports** screen:

1. User works on a report tab (filters selected, data loaded, maybe reviewing rows or drill-down).
2. User **switches away** — either:
   - another **Reports sub-tab** (Claim Verification → Daily Project Report → back), or
   - another **app page** via sidebar (Dashboard, Settings, etc.), or
   - sometimes the **browser tab**.
3. User **returns** to Reports.
4. The screen **refreshes**:
   - loading spinners appear again,
   - work in progress feels “lost” (scroll position, open side panel, mental context),
   - network requests fire again (visible in DevTools).

**Important clarification from the user:**  
The **Daily Project Report data/logic itself is OK** after recent fixes. The remaining pain is the **screen refresh behaviour** — unwanted reloads and loss of in-session UI state, not incorrect report calculations.

---

## 2) What “refresh” means technically

In this codebase, “refresh” is **not** a full browser reload (F5). It is almost always:

| Symptom | Technical cause |
|--------|------------------|
| Table goes blank / shows “Loading…” | `setLoading(true)` or `setDailyReportLoading(true)` before fetch completes |
| Filters reset to defaults | React component **unmounted** and remounted (state lives only in component) |
| Daily report overlay “Updating report…” | Daily tab `useEffect` runs again and refetches even when rows already exist |
| Open “Source expenses” sheet closes | Sheet `open` state is in `Reports.tsx`; lost on unmount |
| Many network calls in Network tab | Multiple `useEffect` hooks refetch on mount or tab change |

Console noise often seen at the same time ( **not** the root cause of Reports refresh):

- Sentry invalid DSN
- PWA manifest blob URL warnings
- WebSocket SUBSCRIBED/CLOSED for notifications
- `runtime.lastError` from browser extensions

---

## 3) Architecture (why state is fragile)

```
App.tsx
  └── lazyWithRetry(() => import("./pages/Reports"))   ← code-split chunk
        └── Reports.tsx (single large component, ~2600 lines)
              ├── React state: activeTab, filters, all report rows, daily results, sheet open, etc.
              ├── useEffect #1: team members (team reports)
              ├── useEffect #2: users + categories
              ├── useEffect #3: daily report config from Settings
              ├── useEffect #4: fetch verification | approval | detailed when activeTab matches
              ├── useEffect #5: auto-fetch daily report when activeTab === "daily"
              └── useEffect #6: detailed custom-field filter options
```

**Key design facts:**

1. **Reports is lazy-loaded.** Leaving `/admin/reports` unmounts the component → **all in-memory state is destroyed**.
2. **No persistence layer** for Reports UI (no `sessionStorage`, no URL query params for tab/filters, no React Query cache for report rows).
3. **Sub-tabs** (Verification / Approval / Detailed / Daily) are Radix `Tabs` inside one component. Parent state survives sub-tab switches, but **effects still re-run** when `activeTab` changes.
4. **Global `loading` flag** is shared across Verification, Approval, and Detailed tabs — one fetch sets loading for the whole page feel.

---

## 4) Root causes (ranked)

### A) Auto-fetch on every sub-tab activation (in-app tab switch)

**Location:** `Reports.tsx` ~lines 415–442

```tsx
useEffect(() => {
  if (canViewReports && teamScopeReady) {
    if (activeTab === "verification") void fetchVerificationExpenses();
    else if (activeTab === "approval") void fetchApprovalExpenses();
    else if (activeTab === "detailed") { ... }
  }
}, [..., activeTab, ...]);
```

**Behaviour:** Every time the user selects Verification (or Approval / Detailed), this effect runs and calls the fetch function, which does `setLoading(true)`. The table shows a loading row even if data was loaded seconds ago on the same filters.

**User impact:** Switching Reports sub-tabs feels like a refresh.

---

### B) Daily tab auto-refetch when re-selected

**Location:** `Reports.tsx` ~lines 444–509

```tsx
useEffect(() => {
  if (activeTab !== "daily" || !dailyConfigReady || ...) return;
  setDailyReportLoading(true);
  void fetchDailyProjectExpenseReportRows({ ... });
}, [activeTab, dailyDateFrom, dailyDateTo, ...]);
```

**Behaviour:** Leaving Daily (e.g. to Verification) and coming back sets `activeTab === "daily"` again → effect runs → **15s+ field-value queries can run again** even when `dailyReportResults` already has data.

**Mitigation already added (partial):** Rows stay visible under a semi-transparent “Updating report…” overlay instead of wiping the table. **Refetch on tab return is still intentional in current code.**

---

### C) Full remount when navigating away from Reports (sidebar)

**Location:** `src/App.tsx`

```tsx
const Reports = lazyWithRetry(() => import("./pages/Reports"));

<Route path="/admin/reports" element={
  <ProtectedRoute>
    <Layout>
      <LazyPage><Reports /></LazyPage>
    </Layout>
  </ProtectedRoute>
} />
```

**Behaviour:** Click Dashboard → Reports unmounts. Click Reports again → new mount, default `activeTab` (`verification`), empty arrays, all effects run from scratch.

**User impact:** This is the strongest “everything I was doing is gone” scenario.

---

### D) Previously fixed: Daily report infinite refetch loop (separate bug)

**Was:** `useEffect` depended on `dailyReportConfig` state that the fetch path updated → loop → repeated ~15s `expense_form_field_values` calls and UI glitching.

**Fix applied:**

- Store config in `dailyReportConfigRef` (ref, not effect dependency).
- Separate `dailyReportLoading` from global `loading`.
- Debounce 300ms + `dailyFetchSeqRef` to ignore stale responses.
- Removed daily logic from the main tab-fetch effect.

**Status:** Fixed for the loop/glitch. Does **not** remove refetch-on-tab-return (B).

---

### E) Previously fixed: `useAuth must be used within an AuthProvider` crash

**Was:** After hot reload or lazy chunk load, Reports could read a different `AuthContext` instance than `AuthProvider` → ErrorBoundary → page looks “broken/refreshed”.

**Fix applied:** Stable context in `src/contexts/auth-context.ts`; `useAuth` imported from there in Reports and hooks.

**Status:** Fixed for dev/HMR. Production navigation should not hit this unless duplicate React bundles exist.

---

## 5) What was changed in recent work (summary for consultant)

| Area | Change | Files |
|------|--------|-------|
| Daily report loop / glitch | Ref-based config, debounced fetch, separate loading state, overlay UX | `Reports.tsx`, `buildDailyProjectExpenseReport.ts` |
| Daily report grouping | Group by employee + day + project ID; review highlighting | `buildDailyProjectExpenseReport.ts`, `Reports.tsx` |
| Source expense drill-down | Click row → sheet lists underlying approved expenses | `DailyReportSourceExpensesSheet.tsx`, `buildDailyProjectExpenseReport.ts` |
| Field value fetch | Org-scoped query + branch field mapping support | `buildDailyProjectExpenseReport.ts`, `DailyExpenseReportMappingSection.tsx` |
| i18n missing keys | `daily.generating`, `columns.projectId`, etc. | `src/locales/*/reports.json` |
| Expense detail 406 | Profile fetch via RPC instead of direct `profiles.single()` | `ExpenseDetail.tsx` |
| Auth context stability | Split `auth-context.ts` | `src/contexts/auth-context.ts`, `AuthContext.tsx` |

**Not changed (still causes refresh feel):**

- Auto-fetch on `activeTab` change for Verification / Approval / Detailed.
- Auto-fetch when returning to Daily tab.
- No session persistence when leaving `/admin/reports`.
- No “fetch only on Submit/Generate button” mode for non-daily tabs (Verification/Approval still auto-fetch on tab select).

---

## 6) How to reproduce

### Reproduce A — sub-tab refresh (in Reports)

1. Log in as admin → `/admin/reports`.
2. Open **Daily Project Report**, wait for rows.
3. Switch to **Claim Verification List**.
4. Switch back to **Daily Project Report**.

**Expected today:** Network calls for daily report again; “Updating report…” overlay; possible 15s wait on slow `expense_form_field_values`.

### Reproduce B — full state loss (sidebar)

1. `/admin/reports` → Daily tab → set filters, open source-expense sheet on a row.
2. Sidebar → **Dashboard**.
3. Sidebar → **Reports**.

**Expected today:** Back on Verification tab (default); filters reset; sheet closed; all fetches from zero.

### Reproduce C — Verification tab loading flash

1. `/admin/reports` → Verification → wait for table.
2. Switch to Approval, then back to Verification.

**Expected today:** `fetchVerificationExpenses()` runs again; `loading === true`; table shows loading state.

---

## 7) Recommended fixes (for next developer)

Priority order:

### 1) Cache per tab + fetch only when inputs change (high impact)

Introduce a **filter fingerprint** per tab, e.g.:

```ts
const verificationFetchKey = JSON.stringify({ activeTab, selectedEmployee, selectedCategory, teamMemberUserIds });
const lastFetchedKeyRef = useRef<string | null>(null);

useEffect(() => {
  if (activeTab !== "verification") return;
  if (lastFetchedKeyRef.current === verificationFetchKey) return; // skip refetch
  lastFetchedKeyRef.current = verificationFetchKey;
  void fetchVerificationExpenses();
}, [verificationFetchKey]);
```

Apply same pattern to Approval, Detailed, and Daily (daily already has seq/debounce; add **skip if key unchanged**).

### 2) Do not set loading when cached data exists (UX)

```ts
const hasCachedRows = verificationExpenses.length > 0;
if (!hasCachedRows) setLoading(true);
// else: optional small inline “Refreshing…” badge, no table wipe
```

### 3) Persist UI across route leave (medium impact)

Options (pick one):

- **`sessionStorage`:** `activeTab`, filter values, timestamp; restore on mount.
- **URL search params:** `/admin/reports?tab=daily&employee=all&...` (shareable, survives remount).
- **React Query:** `useQuery` with `staleTime: 5 * 60 * 1000` for each report type (aligns with global QueryClient staleTime).

### 4) Split `Reports.tsx` (maintainability)

Single 2600-line file makes effect interactions hard to reason about. Split:

- `VerificationReportTab.tsx`
- `ApprovalReportTab.tsx`
- `DetailedReportTab.tsx`
- `DailyProjectReportTab.tsx`
- Shared hooks: `useReportFilters`, `useDailyReport`

Each tab owns its fetch/cache logic.

### 5) Optional: fetch only on explicit button (product decision)

Verification/Approval currently auto-load on tab select. User may prefer **only** “Submit” / “Generate report” triggering fetch (Daily already has Generate button but also auto-fetch on tab open).

---

## 8) Network profile (why it feels slow)

Daily report path (when fetch runs):

1. `expenses` — approved rows (~2–3s)
2. `get_expense_submitter_profiles` RPC
3. `expense_form_field_values` — **often 14–15s per batch** (large org)
4. `organization_settings` — daily mapping config

Repeating (3) on every tab return is the main performance pain, even when data is unchanged.

---

## 9) Files to read first

| File | Why |
|------|-----|
| `src/pages/Reports.tsx` | All tab state, all `useEffect` fetch triggers |
| `src/lib/buildDailyProjectExpenseReport.ts` | Daily row build + source expense list |
| `src/components/DailyReportSourceExpensesSheet.tsx` | Drill-down UI (lost on remount) |
| `src/App.tsx` | Lazy route → remount behaviour |
| `src/contexts/auth-context.ts` | Auth stability for lazy routes |
| `src/lib/lazyWithRetry.ts` | Chunk reload on stale deploy |

---

## 10) Acceptance criteria (suggested)

A fix should satisfy:

1. Switching between Reports **sub-tabs** does **not** refetch if filters unchanged and data younger than N minutes.
2. Navigating Dashboard → Reports restores **last sub-tab and filters** (session or URL).
3. Returning to Daily with cached data shows **no full-screen loading**; optional subtle refresh indicator only.
4. Open drill-down sheet state may still reset on full remount unless persisted (nice-to-have).
5. Explicit **Generate / Submit** always forces a fresh fetch.

---

## 11) Related docs

- `docs/manager-workflow-issue-report.md` — different workflow/manager list issues
- `docs/pesowise-issues-and-fixes-handoff.md` — broader handoff index (if present)

---

## 12) Quick reference — effect dependency map

| Effect | Triggers refetch when… |
|--------|-------------------------|
| Team members | `teamScoped`, `organizationId`, `canViewTeamReports` |
| Users/categories | `teamMemberUserIds`, `teamScopeReady`, … |
| Daily config | `dailyProjectReportEnabled`, org change |
| Verification/Approval/Detailed | **`activeTab` changes**, filter changes |
| Daily report data | **`activeTab === 'daily'`**, date/employee filters, team scope |
| Detailed custom fields | `activeTab === 'detailed'`, period filters |

**The single dependency most responsible for “tab switch refresh” is `activeTab` in effects #4 and #5.**
