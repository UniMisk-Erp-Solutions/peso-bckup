# Dashboard Month Filter (Month-scoped KPI cards)

**Doc ID:** DOC-133
**Status:** in progress
**Last updated:** 2026-09-25 (rev 1.0)
**Owner / area:** Dashboard, dashboard stats RPC, balance history

---

## 1) Summary

A single combined **Month + Year** dropdown on the main Dashboard, above the
stat cards. **All time** (the default) is today's Dashboard exactly. Choosing a
month makes every card represent that calendar month **as one consistent
snapshot** delivered by one new server-side RPC, `get_dashboard_stats_v2`.

## 2) Problem / requirement

The Dashboard showed all-time numbers only. The owner wants the KPI cards to
represent a chosen month, without changing today's values for anyone who does
not use the feature, and without pretending point-in-time values (balances)
are interval aggregates.

## 3) Semantics (the part that is easy to get wrong)

| Card | All time | Selected month |
|---|---|---|
| Total Expenses (admin = amount, others = count — unchanged) | all | expenses with `trip_start` in the month |
| Pending Amount | `submitted`+`verified` | same statuses, expenses **dated** in the month, at their **current** status |
| Pending Approvals (count + amount, admin) | existing rule | same rule, dated in the month |
| Pending Reviews (engineer) | existing two paths | same two paths, dated in the month |
| Current Balance | live `profiles.balance` | **balance as of the month's last day**; the live balance for the **current** month (labelled "Balance as of today") |
| Total Employee/Manager/Cashier Balance | live sums | sum of every active member's **month-end** balance |

* Expense date is `expenses.trip_start` (never `created_at`/`approved_at`),
  half-open bounds `from <= trip_start < first day of next month`.
* Status is **not** reconstructed "as of month end": the system has no status
  history to do that honestly, so "Pending in August" means *amount currently
  pending among expenses dated in August* (a tooltip says so).
* Current Balance is **never** "current balance minus the month's expenses".
* A month with no expenses still shows its month-end balance.
* Future months are not offered (a future month has no month-end balance).
  "Current month" is decided in **Asia/Kolkata**, on the server and in the
  option list, so they agree at month rollover.

### Historical balance model (single source of truth)

`_dashboard_balances_as_of_v1` uses **the same event composition as
`report_detailed_expense_rows_v4`**: non-expense timeline events
(`_balance_timeline_events_v3`), every **approved, non-deleted** expense at
`-total_amount` dated `trip_start`, `report_historical_reconciliation_events`,
and the explicit `historical_opening_balance` residual (current balance − sum of
every other event, dated one day before the earliest event). Balance as of a
date = the sum of every event dated before the cutoff, which equals the
Detailed Expense final **Closing Balance** through that date. The React app
contains no balance arithmetic at all.

A member with **no known event** is unaffected by anything known, so their
balance as of any date is their current balance.

### Role classification limitation

`organization_memberships` keeps no role history, so historical role totals
classify members by their **current active role**. Nothing is fabricated.

### Existing behaviours preserved on purpose

* Non-admins see their own expenses; admins the whole organization.
* Team/hierarchy engineer path: `list_my_teams_overview` does **not** date-scope
  pending (and dates approved by `created_at`), so the new RPC takes the member
  list from it and recomputes pending by `trip_start`. Members are kept once
  **per team** so All time equals the old client sum exactly (a member on two
  teams is counted twice today — preserved, flagged).
* Old RPCs `get_dashboard_expense_summary` / `get_org_role_balance_totals` are
  untouched; the current Production frontend keeps working. If
  `get_dashboard_stats_v2` were ever unavailable, **All time** falls back to the
  legacy path; a month never does.

## 4) Solution

* **Migration** `20261003000000_dashboard_stats_month_v2.sql` (additive):
  `_dashboard_balances_as_of_v1` (service_role only) and `get_dashboard_stats_v2
  (p_organization_id, p_month_from, p_month_to_exclusive)`.
  Identity from `auth.uid()`; caller must be an **active member**; role from the
  membership; only an exact calendar month is accepted; anon has no EXECUTE.
* **Client**: `src/lib/dashboardStats.ts` (`fetchDashboardStatsV2`,
  `parseDashboardStatsV2`, `dashboardMonthRpcBounds`), `src/lib/dashboardMonthScope.ts`
  (option list, IST "current month", "31 Aug 2026"), `src/lib/dashboardStatsCache.ts`
  (key now `…-v2:user:role:org:month`; v1 entries are never read),
  `src/pages/Dashboard.tsx`.
* **UX**: cards keep their values (dimmed, "Updating…") while a new month loads
  and swap atomically; "Showing August 2026" strip; card descriptions
  ("Balance as of 31 Aug 2026", "Pending in August 2026", "… · as of 31 Aug 2026").
* **Races / scope**: `runMonthFetch` (generation token + AbortController, same
  guard as My Expenses); `fetchStats` reads the month from a ref so realtime and
  notification refreshes preserve it; month resets to All time on user, role or
  organization change; the month is not persisted across sessions.

## 5) Key files touched

`supabase/migrations/20261003000000_dashboard_stats_month_v2.sql`,
`src/pages/Dashboard.tsx`, `src/lib/dashboardStats.ts`,
`src/lib/dashboardMonthScope.ts`, `src/lib/dashboardStatsCache.ts`,
`src/locales/{en,hi,gu}/dashboard.json`,
`src/lib/__tests__/dashboardMonthFilter.test.ts`.

## 6) Database / migrations

`20261003000000_dashboard_stats_month_v2.sql` — **applied to Production
2026-09-25** (owner-authorized for Preview QA; additive, backward compatible)
after a fresh full backup
`20260925T080705Z-pre-dashboard-stats-v2.dump` (43,321,798 bytes, SHA-256
`04c0e6a68d1b0111f1dac6954caebb852320c7976a2eb53dd2b8bbb788fea2b6`, 2,583
`pg_restore --list` entries). Financial fingerprint (approved/rejected expense
hash, balances checksum, ledger hash, deductions count) identical before and
after. Read-only: no accounting data is written.

## 7) Verification (Production data, rolled-back transactions, then applied)

* **All-time parity** vs the old RPCs / live balance / old engineer paths:
  15 users (admin/employee/engineer/cashier across MicroLink, Patidar,
  Mistry And Shah, Trial) × every card — **0 differences**.
* **Month parity** vs direct SQL (trip_start bounds, role scope, `deleted_at IS
  NULL`) for 8 months (Aug/Sep/Jul 2026, Dec→Jan 2025/26, Feb 2026, leap Feb
  2024, Jun, Mar 2026) × 15 users — total, count, pending amount, pending
  approvals count+amount: **0 differences** (578 checks total, 0 failed).
* **Historical balance** vs the Detailed Expense V4 final Closing Balance
  through month end (paged to the last row): **exact for every tested user and
  month** (105 comparisons + live-balance checks for unfinished months).
* **Role totals** vs the sum of per-member V4 balances: Patidar (Aug, May),
  Mistry And Shah (Aug), MicroLink (Aug) — **exact**.
* **Authorization**: anon `insufficient_privilege`; no JWT `28000`; cross-org
  and inactive member `42501`; non-calendar-month and half-supplied bounds
  `22023`.
* **Performance (MicroLink, ~23.8k expenses)**: All time 17–29 ms; live month
  12–13 ms; a finished month (admin, month-end balances for 443 members)
  170–270 ms; employee month 30 ms; response ≈ 0.5 KB. Zero expense rows reach
  the browser.

## 8) Test plan

`npx vitest run src/pages/__tests__/DashboardMonthFilter.test.tsx` (8 real-Dashboard behavioural tests: default All time + no bounds, option list, August bounds + month-end balance instead of the live one, current month = live, restore All time, stale August vs September, org switch resets, failed month load restores the previous period) and `src/lib/__tests__/dashboardMonthFilter.test.ts` (40 tests: month
bounds incl. Dec→Jan and leap Feb, option list, IST rollover, cache identity
isolation for month/org/user/role and v1 entries, stale-August-vs-September
guard, migration security/semantic contract, page contract). Full suite 262 files / 4,561 tests green. Manual retest steps
are in the release notes for this pass.

## 9) Known limitations

* Historical role totals use current roles (no role history exists).
* Status is current, not as-of-month-end.
* MicroLink month-end balances follow the V4 model, whose opening residual is
  derived from live balances; they are exactly consistent with Detailed Expense,
  which is the requirement, not an independent ledger audit.
* The team-path pending double-counts a member who is on two teams (matches the
  old Dashboard).
* The Old Money dashboard theme has no month selector (it only shows balance).

---

## Revision log

| Date | Rev | By | Change |
|---|---|---|---|
| 2026-09-25 | 1.0 | Agent | Initial: `get_dashboard_stats_v2`, Dashboard Month selector, month-aware cache, race guard, parity proofs, applied to Production for Preview QA. |
