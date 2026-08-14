# Employee Balance History (feature-gated)

**Doc ID:** DOC-087  
**Status:** in progress — migration APPLIED 2026-08-08; code on `dev` only, not merged to `main`, feature flag still off, browser verification outstanding  
**Last updated:** 2026-08-08 (rev 1.2)  
**Owner / area:** Transfers / Balances, Supabase RPC, Employee navigation  

---

## 1) Summary

Phase 1 of employee financial transparency. Employees whose organization has the
new `employee_transfer_history` feature enabled get a dedicated **Balance History**
page at `/balance-history` showing the balance credits recorded to their PesoWise
account: amount, effective transfer date, payment method and who credited it.

Everything is served by a purpose-built, employee-safe `SECURITY DEFINER` RPC.
The existing admin/cashier `/cash-transfer-history` surface is untouched, and the
`cash_transfer_history` RLS policies were **not** widened.

The feature defaults **OFF**. An organization with no `organization_features` row
for this key gets nothing: no nav entry, no dashboard link, and an RPC that
refuses.

---

## 2) Problem / requirement

Employees could see a Current Balance number and nothing behind it. When money
was credited — by an admin, a cashier, or through an accepted transfer offer —
there was no way for the employee to confirm the amount or the date. Every query
went to a manager.

The blocker was structural, not cosmetic: employees have **no SELECT path** on
`cash_transfer_history` at all. Its policies admit admins (org-wide), cashiers
(rows they sent or received), and accountant cashiers (org-wide, read-only). So
the feature needed a new, deliberately narrow server-side read path.

---

## 3) Solution

### Why a separate surface rather than opening the existing page

`/cash-transfer-history` is an admin/cashier financial-operations screen. It
loads `select("*")` — every column — with no pagination, and for admins it is
org-wide. Widening its roles or `useCashierCapabilities().canViewTransferHistory`
would have handed employees other people's transfers, transferrer/recipient
organizational detail, source bank metadata, masked source account numbers, and
free-text `notes` that historically carry internal audit text.

Instead: a separate employee read model, with its own RPC, its own route, and its
own response contract. The admin/cashier page is byte-for-byte unchanged.

### Two independent gates

| Layer | Mechanism | Effect when the flag is off |
|---|---|---|
| Client | `hasOrganizationFeature(ORGANIZATION_FEATURE_KEYS.employee_transfer_history)` | No sidebar item, no More-sheet item, no dashboard link; the page redirects to `/dashboard` and the React Query hook stays `enabled: false`, so **no RPC is issued** |
| Server | `public.org_feature_enabled(p_organization_id, 'employee_transfer_history')` inside the RPC | `RAISE EXCEPTION 'feature_disabled'` |

Typing the URL by hand or calling the RPC directly from the console therefore
does not bypass the flag. The client gate is a UX affordance; the server gate is
the security boundary.

---

## 4) Key files

```
supabase/migrations/20260808120000_employee_balance_transfer_history_rpc.sql
src/pages/EmployeeBalanceHistory.tsx
src/hooks/useEmployeeBalanceHistory.ts
src/lib/organizationFeatureKeys.ts
src/integrations/supabase/types.ts
src/App.tsx
src/components/AppSidebar.tsx
src/components/mobile/MobileMoreSheet.tsx
src/components/mobile/MobileBottomNav.tsx
src/components/dashboard/OldMoneyDashboard.tsx
src/pages/Dashboard.tsx
src/locales/{en,hi,gu}/{transfers,nav,master}.json
```

Tests:

```
src/lib/__tests__/employeeBalanceHistoryRpc.test.ts
src/lib/__tests__/balanceHistoryFeatureAndI18n.test.ts
src/pages/__tests__/EmployeeBalanceHistory.test.tsx
src/pages/__tests__/DashboardBalanceHistoryEntry.test.tsx
src/components/__tests__/balanceHistoryNavigation.test.tsx
src/components/__tests__/balanceHistoryRouteAccess.test.tsx
```

---

## 5) Database / migrations

**Migration:** `20260808120000_employee_balance_transfer_history_rpc.sql`

> **APPLIED 2026-08-08.** The owner ran this manually against the self-hosted
> instance. Verified afterwards: `pg_proc` reports `get_my_balance_transfer_history`
> with `pronargs = 3` (the expected `uuid, integer, integer` signature), and
> `has_function_privilege` confirms `authenticated` can execute while `anon`
> cannot. The PostgREST schema cache was reloaded.
>
> The function existing is **not** the same as the feature being verified — see
> §12 for what remains unproven.

Contents — function definition, grants and comments only:

* `CREATE OR REPLACE FUNCTION public.get_my_balance_transfer_history(...)`
* `REVOKE ALL ... FROM PUBLIC`, `REVOKE ALL ... FROM anon`, `GRANT EXECUTE ... TO authenticated`
* `COMMENT ON FUNCTION ...`

It contains **no** `INSERT` / `UPDATE` / `DELETE` / `ALTER TABLE` / `CREATE POLICY`
/ `DROP POLICY`. No balances are touched, no rows are backfilled, no RLS changes.
A test asserts each of those absences.

### Index decision — no new index

The table already carries, from `20250129000000_create_cash_transfer_history.sql`:

```
idx_cash_transfer_history_recipient (recipient_id, transferred_at DESC)
```

The query filters `organization_id = p_organization_id AND recipient_id = v_uid`
and orders by `transferred_at DESC, id DESC`. `recipient_id` is the highly
selective term — one user's own credits — and the existing index already supplies
the `transferred_at DESC` ordering, so the planner reads an already-sorted prefix
and applies `organization_id` as a cheap residual filter over the few matching
rows. A `(organization_id, recipient_id, transferred_at DESC, id)` composite
would duplicate that access path for no measurable gain at realistic
per-employee row counts, so it was deliberately **not** added. Revisit only if a
single employee's credit count grows large enough for the residual organization
filter to matter.

---

## 6) RPC contract

```sql
public.get_my_balance_transfer_history(
  p_organization_id uuid,
  p_limit           integer DEFAULT 25,   -- clamped to [1, 100]
  p_offset          integer DEFAULT 0     -- clamped to >= 0
) RETURNS TABLE (
  id               uuid,
  amount           numeric,
  transferred_at   timestamptz,
  payment_mode     text,
  transfer_type    text,
  credited_by_name text,
  source_bank_name text,
  total_count      bigint
)
```

`LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public`.

### Guard order

1. `auth.uid()` must be non-null → else `not_authenticated`.
2. `p_organization_id` must be non-null → else `not_authorized`.
3. Active membership: `organization_memberships` row for `(p_organization_id, auth.uid())` with `is_active = true` → else `not_authorized`.
4. `role::text = 'employee'` → else `not_authorized`. Admins, cashiers, engineers, team leaders and executives are all rejected.
5. `org_feature_enabled(p_organization_id, 'employee_transfer_history')` → else `feature_disabled`.
6. Clamp limit/offset, then return rows where `organization_id = p_organization_id AND recipient_id = auth.uid()`.

`role::text` is cast deliberately — the Hotfix 03 pattern that avoids the
`app_role` enum comparison error.

### Fields deliberately withheld

`recipient_id`, `transferrer_id`, `transferrer_role`, `recipient_role`,
`source_bank_account_id`, `source_account_number_masked_snapshot`,
`source_account_holder_snapshot`, `notes`, `transferred_at_original`,
`transferred_at_edited_at`, `transferred_at_edited_by`, `date_edited`, emails,
employee IDs, membership metadata, and any organization-wide aggregate.

`notes` is withheld on purpose: historical rows may contain internal or admin
audit text, and no current product requirement establishes transfer notes as
employee-visible. Conservative in V1; revisit only with an explicit decision.

### Credited-by name

Resolved server-side by a **single** `LEFT JOIN public.profiles`, scoped to the
same organization — never one profile lookup per row from the browser, and never
an N+1. Only the display name crosses the boundary. When it cannot be resolved
the RPC returns `null` and the UI shows the neutral localized fallback
"PesoWise allocation".

### No user-id parameter

There is no `p_user_id`, `p_recipient_id` or equivalent in the signature. The
recipient is always `auth.uid()`. An employee cannot name another user because
the API offers no place to put one — this is enforced by the shape of the
function, not by a validation branch. A test asserts the signature stays that way.

---

## 7) Route and navigation

* **Route:** `/balance-history`, `ProtectedRoute allowedRoles={["employee"]}`, inside `Layout`, lazily loaded.
* **Feature off:** the page returns `<Navigate to="/dashboard" replace />` before any query runs. No premium teaser, no disabled shell, no data request.
* **Desktop sidebar:** inserted between *My Expenses* and *Analytics*, icon `ArrowDownToLine`, only for `userRole === "employee"` with the flag on.
* **Mobile:** added to the employee **More** sheet — it does not displace any primary bottom tab. `/balance-history` was added to `MORE_ACTIVE_PREFIXES` so More reflects the active state.
* **Dashboard:** for employees with the flag on, the existing **Current Balance** card becomes clickable to `/balance-history`, using the same `onClick` affordance other stat cards already use (`cursor-pointer`, hover scale). Its description switches to the localized "View balance history". **The displayed value is unchanged**, and admin/manager/cashier cards are untouched.
* **Old Money theme:** the *Net Position* panel header gains a "Balance History" link using the existing `om-lnk` treatment, so the page stays reachable under that theme. The theme's layout was not redesigned, but it **was fully localized** — see §8a.

### 8a) Old Money dashboard localization

`OldMoneyDashboard.tsx` shipped with every user-facing string hard-coded in
English and no i18n import at all. Rev 1.0 of this feature initially matched that
idiom for its one new link; rev 1.1 localized the component properly instead.

* `useTranslation("dashboard")` with all copy under a new `oldMoney.*` block in `dashboard.json` for EN/HI/GU.
* The time-of-day greeting became `greetingKey()` returning a translation key rather than an English string.
* Amount-bearing legends use interpolation (`approvedWithAmount`, `pendingWithAmount`, `spendVsLastMonth`) rather than concatenation, so translators control word order.
* The chart `aria-label` and the "Member" / "Expense" fallbacks are localized too — screen-reader copy and fallbacks are user-facing.
* **Dates and currency follow the app language**, not just the copy: `format()` receives `getDateFnsLocale(i18n.language)` and every amount goes through a `money()` helper bound to `getDateLocale(i18n.language)`.
* The recent-activity map variable was renamed `t → tx`; `t` is now the translation function in that scope.
* `VISA` on the card face is left untranslated on purpose — it is a brand mark printed on the card graphic, not UI copy. A test asserts it stays that way, so the omission is deliberate rather than forgotten.

Covered by `oldMoneyDashboardLocalization.test.tsx`: renders in EN/HI/GU against
the real locale JSON, asserts translated headings appear and English ones do not,
asserts no raw `oldMoney.` keys leak into the DOM, asserts `format()` always
receives a locale, and scans the source (comments stripped) for each previously
hard-coded phrase.

---

## 8) Data model and display decisions

### Current balance is NOT computed from credits

The Current Balance figure comes from `AuthContext.userBalance` — the same
authoritative `profiles.balance` value the dashboard uses, kept fresh by the
existing realtime subscription. It is **never** derived as
`sum(cash_transfer_history)`, which would be wrong: approved expenses reduce the
balance on a separate path, and manual or historical adjustments exist. A test
asserts the displayed balance differs from the sum of the listed credits.

Refresh re-runs the history query and calls the existing `refreshBalance()`.

### Last Credit

The newest row of page 1 populates the Last Credit tile (`+₹10,000` and its
date). With no history it reads "No recorded credits yet" — never `₹0`, which
would imply a transfer that never happened.

### Payment mode — legacy/null handling

Migration `20260420130500_extend_cash_transfer_history_bank_mode.sql` backfilled
`NULL → 'cash'`, set `DEFAULT 'cash'`, made the column `NOT NULL`, and added
`CHECK (payment_mode IN ('cash','bank_transfer'))`. So in the current schema a
null cannot occur.

That backfill is a **retroactive conversion, not a semantic guarantee** that null
ever meant cash. The UI therefore maps `bank_transfer → "Bank transfer"`,
`cash → "Cash"`, and anything else (including null) → **"Not recorded"**. Because
the column is `NOT NULL`, this choice has no practical effect on real rows; it
simply refuses to invent a payment method on someone's financial record if one
ever appears.

> Note: the admin page (`CashTransferHistory.tsx`) still coerces
> `payment_mode || "cash"`. That is pre-existing behaviour on an admin-only
> surface and was left unchanged — see §12.

### Transfer date

`transferred_at` is shown as the effective credit date, so an admin backdate is
reflected. The edit trail (`transferred_at_original`, `transferred_at_edited_at`,
`transferred_at_edited_by`, `date_edited`) is not exposed in V1.

### Transfer type

`transfer_type` is returned by the RPC but is **not rendered**. Employees do not
need raw strings like `admin_to_employee`, and displaying them untranslated would
leak internal routing semantics. It is carried in the contract so a future
release can map it to user-friendly language without a migration.

---

## 9) Pagination

Server-side, via `p_limit` / `p_offset`. Default 25 rows; page sizes 10 / 25 /
50 / 100 through the shared `ListPagination` component. `total_count` is a
`COUNT(*) OVER ()` scoped by the same `WHERE` clause, so it counts only this
user's rows in this organization.

The browser never downloads the full history. Page changes re-query; changing the
page size resets to page 1; and a `clampPage` effect pulls the view back to a
valid page if the record count shrinks underneath it.

---

## 10) Query and cache design

```
queryKey: ["employeeBalanceHistory", organizationId, user.id, page, pageSize]
enabled:  userRole === "employee" && featureEnabled && !!organizationId && !!user?.id
```

* Organization and user id are in the key, so switching organizations starts a fresh entry rather than briefly showing the previous organization's credits.
* The hook returns an empty result whenever `enabled` is false, so disabling the feature mid-session immediately stops rendering cached rows.
* No financial history is written to `localStorage` or `sessionStorage`.
* No realtime subscription and no polling in V1 — a manual Refresh button covers it.

---

## 11) Empty and error states

* **Empty:** Current Balance stays visible; the list reads "No balance credits recorded yet." No bare table shell, no error styling.
* **Error:** "We couldn't load your balance history. Please try again." with a Retry control. Raw Postgres messages, SQL, internal function names and user IDs are never surfaced — asserted by test.

---

## 12) Known limitations

1. **This is credit history, not a complete ledger.** Approved expenses are deducted from `profiles.balance` separately, so the credits listed here do not sum to the current balance. The page is titled "Balance History" and subtitled "See balance credits recorded to your PesoWise account", with a note that expense deductions appear in expense history. Wording such as "Complete Account Ledger", "Full Balance Ledger" or "Complete Transaction Statement" is deliberately avoided — a test enforces this.
2. Outgoing money returns (`employee_to_cashier`) do not appear: the query is scoped to rows where the employee is the *recipient*.
3. Rows predating complete transfer logging will not appear.
4. `transfer_type` is not displayed (see §8).
5. The admin `payment_mode || "cash"` coercion remains on the admin surface (out of scope for this task).
6. **RPC tests are static contract assertions over the migration SQL, not live database execution** — no Docker/local Supabase was available while writing them. The function now exists on the self-hosted instance (§5), but *existing* and *behaving correctly* are different claims. As of 2026-08-08 the following remain **unproven against a live database**, and only the §14 checklist can close them:
   * employee A cannot read employee B's credits (`recipient_id = auth.uid()` scoping);
   * an employee in org A gets nothing from org B;
   * admin, cashier, engineer, team leader and executive callers are rejected;
   * an inactive membership is rejected;
   * the server-side feature gate refuses when the flag is off.

   The only guard confirmed live so far is authentication: calling the RPC from the SQL editor, where `auth.uid()` is NULL, correctly raises `not_authenticated`.

---

## 13) Tests

| File | Covers |
|---|---|
| `employeeBalanceHistoryRpc.test.ts` | 40 assertions over the migration: SECURITY DEFINER + pinned `search_path`, STABLE, REVOKE PUBLIC/anon + GRANT authenticated only, no user-id parameter, `recipient_id = auth.uid()`, org scoping, active-membership check, employee-role check, `role::text` cast, server-side feature gate, null-org rejection, limit clamped to [1,100], negative offset clamped, ordering with tie-breaker, scoped `total_count`, exact returned-column list, absence of each withheld column, no `auth.users`/email/employee_id, single-join name resolution, no RLS or data mutation, RPC registered in generated types, no `as any` |
| `balanceHistoryFeatureAndI18n.test.ts` | Feature key registration, single Master Admin definition, default-OFF with no row, OFF when disabled, ON when enabled; all EN/HI/GU keys present and non-empty; HI/GU actually translated; no over-claiming ledger wording |
| `EmployeeBalanceHistory.test.tsx` | Flag off → redirect + no RPC; flag on → renders and queries; non-employee redirect; balance from `userBalance` not summed credits; Last Credit; empty state; bank/cash/null payment modes; neutral credited-by fallback; server row order; no account number rendered; error + retry with no leaked internals; refresh refetches both; default limit/offset; page 2 offset; clamp on shrink; org-scoped key; no user id sent |
| `DashboardBalanceHistoryEntry.test.tsx` | Current Balance card inert when off, navigates to `/balance-history` when on, value unchanged |
| `balanceHistoryNavigation.test.tsx` | Sidebar and More sheet, off/on, correct position, hidden from admin/cashier/engineer/team_leader/executive even with the flag on |
| `balanceHistoryRouteAccess.test.tsx` | **Real** react-router-dom (global mock overridden per file): employee passes, five other roles genuinely redirect to `/dashboard`, plus a guard asserting the router is not stubbed; More-active state on `/balance-history` |
| `oldMoneyDashboardLocalization.test.tsx` | Old Money theme rendered in EN/HI/GU against real locale JSON; translated headings present and English absent; amount and delta interpolation; localized `aria-label`; no raw `oldMoney.` keys in the DOM; `format()` always receives a locale; source scan (comments stripped) for 16 previously hard-coded phrases; VISA deliberately retained |

### Router test note

`src/test/setup.ts` globally mocks `react-router-dom` (`useNavigate`, `useParams`,
`Navigate`). Under that mock a redirect assertion passes because `Navigate` is a
string stub, not because routing occurred. `balanceHistoryRouteAccess.test.tsx`
therefore re-mocks the module to `importOriginal()` for that file only, drives a
real `createMemoryRouter`, asserts on the resulting `location.pathname`, and
includes an explicit check that `useLocation` is not a mock function. The global
setup was **not** modified.

---

## 14) Manual test checklist

**Feature OFF — employee**

- [ ] Sign in as employee
- [ ] No Balance History in desktop sidebar
- [ ] No Balance History in mobile More
- [ ] Current Balance card does not open history
- [ ] Enter `/balance-history` manually → redirects to dashboard
- [ ] Network tab shows no `get_my_balance_transfer_history` call

**Feature ON — employee**

- [ ] Enable `employee_transfer_history` for a controlled test organization
- [ ] Balance History appears in desktop sidebar and mobile More
- [ ] Current Balance dashboard card links to Balance History
- [ ] Current balance matches the dashboard figure
- [ ] Last credit matches the most recent incoming transfer (amount + date)
- [ ] Payment method correct when recorded; legacy/unknown shows "Not recorded", not "Cash"
- [ ] Credited-by name correct
- [ ] No source account number anywhere
- [ ] No other employee's rows; no organization-wide totals
- [ ] Refresh and pagination work

**Security**

- [ ] Employee A cannot see Employee B's transfers
- [ ] No URL or query change can select another user
- [ ] Employee from another organization gets no rows
- [ ] Admin / cashier / engineer calling the RPC are rejected
- [ ] Feature OFF causes the RPC itself to reject

**Mobile (≈390×844)**

- [ ] More sheet contains Balance History only when enabled
- [ ] No horizontal overflow; rows readable; pagination touch-friendly

**Regression**

- [ ] `/cash-transfer-history` unchanged for admin and cashier
- [ ] Admin Balances, adding balance, bank and cash allocation unchanged
- [ ] Dashboard balances, expense deduction, notifications unchanged
- [ ] Old Money dashboard functional

---

## 15) Rollout

| # | Step | Status |
|---|---|---|
| 1 | Apply `20260808120000_employee_balance_transfer_history_rpc.sql` | ✅ **done 2026-08-08** |
| 2 | Reload the PostgREST schema cache | ✅ **done** |
| 3 | Verify signature and grants (`pronargs = 3`; `authenticated` yes, `anon` no) | ✅ **done** |
| 4 | Enable `employee_transfer_history` in Master Admin for **one** pilot organization | ⬜ outstanding |
| 5 | Walk the §14 checklist as a real employee of that organization | ⬜ outstanding |
| 6 | Merge `dev` → `main` after review | ⬜ outstanding |
| 7 | Deploy the frontend to Production | ⬜ outstanding |
| 8 | Roll out to further organizations individually | ⬜ outstanding |

The database was deliberately taken first: the migration is additive and inert
until the flag is switched on, so applying it early carries no risk and removes
one variable from the browser testing in step 5.

Note the ordering consequence — the frontend currently exists only on `dev` and
its preview deployment. Step 5 must therefore be walked on the preview URL, not
on Production.

## 16) Rollback

* **Instant, no deploy:** disable `employee_transfer_history` in Master Admin. The nav entries and dashboard link disappear, the route redirects, and the RPC refuses.
* **Code:** revert the feature commit on `dev`. The migration is additive; leaving the function in place is harmless once the flag is off.
* **Database:** `DROP FUNCTION IF EXISTS public.get_my_balance_transfer_history(uuid, integer, integer);` — no data is affected, since the migration only ever read.

---

## 17) Future: Bulk Balance Import and historical opening balances

No `balance_import_*` tables, Excel upload, or opening-balance rows are created
here. Because this page reads incoming `cash_transfer_history` credits, any
future bulk allocation recorded in that table appears automatically with no
change to this surface.

**Design constraint for that future work:** historical *opening balances* must be
displayed as their own kind, separately from actual transfers. Writing an opening
balance into `cash_transfer_history` and letting it render as a credit would tell
the employee a transfer happened on a date when it did not. The `transfer_type`
column is already carried through the RPC contract (though unrendered), which
gives that future release a place to distinguish the two without a schema change.

---

## Revision log

| Date | Rev | Change | By |
|------|-----|--------|-----|
| 2026-08-08 | 1.2 | Migration applied to the self-hosted instance by the owner and verified: `pronargs = 3`, `authenticated` can execute, `anon` cannot, PostgREST schema cache reloaded. `pg_stat_activity` checked at the same time showed no locks and no blocked queries — the Supabase Studio 502/504s seen while running it were transient in the Studio→pg-meta layer and left nothing half-applied. Status, §5, §12 and §15 corrected: they previously asserted the migration was NOT applied, which had become false and would have misled anyone reading this doc into re-running it or treating it as pending. §12 now enumerates precisely which security guards remain unproven against a live database (cross-employee, cross-org, role rejection, inactive membership, feature-off) versus the one confirmed (`not_authenticated` from the SQL editor). No code change. | Claude Code |
| 2026-08-08 | 1.1 | Localized the Old Money dashboard properly (§8a) instead of matching its hard-coded-English idiom for the one new link. All 32 user-facing strings moved to a new `dashboard:oldMoney.*` block in EN/HI/GU; greeting became a key; amount-bearing legends use interpolation; chart `aria-label` and "Member"/"Expense" fallbacks localized; dates and currency now follow the app language via `getDateFnsLocale` / `getDateLocale`; recent-activity loop variable renamed `t → tx` to stop shadowing the translation function. `VISA` deliberately left as an untranslated brand mark. New `oldMoneyDashboardLocalization.test.tsx` (26 tests) plus `oldMoney` key coverage in the i18n suite. No layout, data or behaviour change. | Claude Code |
| 2026-08-08 | 1.0 | Initial implementation on `dev`: `employee_transfer_history` organization feature; `get_my_balance_transfer_history` SECURITY DEFINER RPC with auth.uid() recipient scoping, active-membership + employee-role + server-side feature checks and clamped pagination; `/balance-history` employee route; desktop sidebar, mobile More sheet and More-active prefix; Dashboard Current Balance entry point; Old Money link; EN/HI/GU translations; 6 test files. No RLS widening, no data mutation, not deployed. | Claude Code |
