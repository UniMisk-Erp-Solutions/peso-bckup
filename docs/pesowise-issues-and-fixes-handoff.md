# PesoWise — Engineering Handoff Document

**Purpose:** Give any engineer or AI full context on what was built, what is deployed, what is pending, and what the current codebase state is.

**Last updated:** 2026-07-14  
**Product name:** PesoWise (rebranded from Voyage Account / Peso-Patidar)  
**Production app:** `https://pesowise.unimisk.com` (Vercel)  
**Production API/DB:** Self-hosted Supabase on Coolify — `https://pesowise-supabase.unimisk.com`  
**Primary tenant:** MicroLink — `6709c1fe-e8c8-404d-bc68-d1edda923344` (~200 users)  
**Tenant subdomain:** `https://ml.pesowise.unimisk.com`  
**Active branch:** `feature/user-activity-insights`  
**Repository:** `Mithil1105/peso-patidar`

---

## Table of contents

1. [Current branch state](#1-current-branch-state)
2. [Architecture overview](#2-architecture-overview)
3. [Original issues — current status](#3-original-issues--current-status)
4. [Features shipped since June 2026](#4-features-shipped-since-june-2026)
5. [Features in progress (on feature branch)](#5-features-in-progress-on-feature-branch)
6. [Manual actions still required](#6-manual-actions-still-required)
7. [Known risks and deferred work](#7-known-risks-and-deferred-work)
8. [Test suite summary](#8-test-suite-summary)
9. [Key files and services](#9-key-files-and-services)
10. [Safety rules for this repo](#10-safety-rules-for-this-repo)

---

## 1. Current branch state

| Branch | Remote | Status |
|---|---|---|
| `feature/user-activity-insights` | pushed | **Active working branch** — all recent feature work lives here |
| `main` | pushed | Last reflects mobile RC + performance work; several feature branch commits not yet merged |

**What's on `feature/user-activity-insights` but NOT yet on `main`:**
- User Activity Insights (DOC-051) — full DPDP compliance package, pending legal review
- Load-all persistence + manager queue perf (DOC-050)
- Legal/DPDP pages: `/legal/data-processing`, `/legal/activity-insights`, `/legal/data-rights`
- Transfer Offer Login Popup (DOC-052)
- Several performance hotfixes (audit_log chunking → org-scoped, level_2_verified gate)
- PrivacyPage + TermsPage activity insights sections
- `.catch()` → `.then(null, …)` refactor on Supabase RPC calls

**Do NOT push or merge to main without explicit instruction from the user.**

---

## 2. Architecture overview

```
Browser (pesowise.unimisk.com)
    → Vercel SPA (React 18 + TypeScript + Vite)
    → HTTPS to pesowise-supabase.unimisk.com
        → Kong / nginx (Coolify reverse proxy)
        → PostgREST (REST API layer)
        → PostgreSQL 15
        → Supabase Auth / Storage / Realtime
```

**Key mental model — "fake CORS" errors:**  
When the app shows `No 'Access-Control-Allow-Origin'`, it is almost NEVER a CORS misconfiguration. It is the Coolify reverse proxy rejecting an oversized GET query string (414 URI Too Long). PostgREST never replies → browser reports CORS error. Fix: chunk `.in()` queries or use RPCs.

**Tech stack:**
- Frontend: React 18, TypeScript, Vite, Tailwind CSS, shadcn/ui, react-router-dom v6, react-i18next, react-query
- Supabase: Auth, Postgres, Storage (R2-backed), Realtime (postgres_changes), Edge Functions (Deno)
- Testing: Vitest + Testing Library (744 tests as of 2026-07-14)
- CI/CD: Vercel auto-deploy from `main`

---

## 3. Original issues — current status

### Issue A — Fake CORS / oversized GET URLs
**Status: RESOLVED in code (deployed via main)**

- `SUPABASE_IN_QUERY_CHUNK_SIZE = 25` in `src/lib/supabaseInQuery.ts`
- All large `.in()` queries chunked or replaced with org-scoped queries + JS filter
- `fetchExecutiveHandoffExpenseIds` consolidated from 10–15 chunk queries to 1 org-scoped query (DOC-050)
- Manager RPC `list_manager_pending_expenses` rewritten as CTE (DOC-041)

**Remaining:** ~3–4 minor pages still use small `.in()` lists with < 10 IDs — acceptable.

---

### Issue B — `/users` page broken for large orgs
**Status: RESOLVED**

- `fetchOrgMembershipRolesMap(orgId)` in `src/lib/orgUsers.ts` — single short query
- `UserManagement.tsx` fully rewritten: hierarchy mode + card/table toggle + mobile card view
- React Query cache (`staleTime: 5 min`) on membership roles map

---

### Issue C — Dashboard `57014` statement timeout
**Status: RESOLVED (SQL applied to Coolify)**

- `get_dashboard_stats` RPC with proper indexes deployed
- `level_2_verified` fallback in manager queue gated behind `executiveTierEnabled` (DOC-050)
- `list_manager_pending_expenses` CTE rewrite + 6 indexes (DOC-041 migration: `290706_0900_manager_rpc_performance_fix.sql`)

---

### Issue D — Custom fields 500 on nested PostgREST embeds
**Status: RESOLVED**

- All nested embed queries replaced with flat queries + JS join
- Batch review custom field columns use parallel flat queries (DOC-012)

---

### Issue E — Manager hierarchy workflow broken
**Status: RESOLVED**

- `list_manager_pending_expenses` RPC deployed with CTE approach (DOC-041)
- Manager step skip bug fixed (explicit `level_2_verified` check in actionability branch)
- `expense-action-parallelization` (DOC-042): `approveExpense`/`rejectExpense`/`verifyExpense` use `Promise.all` for role checks

---

### Issue F — Migration / schema drift on Coolify
**Status: PARTIALLY RESOLVED — some SQL still pending manual run (see §6)**

- All new SQL is in `supabase/migrations/` with timestamped filenames
- Production-applied migrations are noted in their respective DOC files

---

### Issue G — Cloud → self-hosted migration (CSP, image URLs)
**Status: RESOLVED**

- Receipt URLs use R2 public bucket via Cloudflare
- Edge Function `finalize-expense-receipts` handles server-side file move/verify (DOC-017–019)
- CSP headers updated for Coolify endpoints

---

### Issue H — Security: service role in browser
**Status: RESOLVED**

- All privileged operations use SECURITY DEFINER RPCs or Edge Functions
- No service role key exposed in client bundle

---

### Issue I — Performance: duplicate API calls & heavy bundles
**Status: LARGELY RESOLVED**

- `useOrganizationFeatures` deduped with React Query
- `AdminPanel` O(n²) map → O(n) Map (DOC-049)
- `ExpenseForm` fire-and-forget analytics (DOC-049)
- `EngineerReview` realtime employee ID caching (DOC-049)
- Lazy-loaded routes via `lazyWithRetry`

---

### Issue J — Console noise
**Status: RESOLVED**

- `.catch()` → `.then(null, () => {})` on Supabase RPC calls (prevents unhandled-rejection noise)
- `formatApiError` prevents `[object Object]` toasts

---

## 4. Features shipped since June 2026

### Mobile UI (complete — DOC-020 through DOC-039)
Full responsive mobile experience, shipped to `staging/mobile-rc` → merged to `main`:
- **Phase 1–5:** MobileAppShell, bottom nav, employee/batch expense views, drawer nav
- **Phase 6A:** Mobile Admin Panel — card-based all-expenses + stats hub
- **Phase 6B:** Cashier operations, notifications on mobile
- **Phase 6C:** 5-tab employee nav, mobile Settings
- **Phase 7:** Analytics, MyTeams, CategoryManagement responsive
- **Phase 8:** Detailed expense report mobile cards
- **Final stabilisation (DOC-037–039):** Analytics Recharts layout, FileUpload filename truncation, UserManagement hierarchy on mobile, `MobileReviewExpenseCard` rewrite, `truncateFilenameForMobile`
- **Total tests after mobile:** 595+

### Batch improvements
- **DOC-014:** Shared batch title (entered once, applies to all line items)
- **DOC-036:** Base field config parity (`translateBaseFieldConfig`, column ordering)
- **DOC-040:** Required custom field validation before step 2 proceed
- **DOC-043:** "Review batch" button color-coded by state; search/page/scroll persisted in sessionStorage

### Expense review improvements
- **DOC-002:** Admin hierarchy approval bypass (admins can approve without TL/executive)
- **DOC-030:** Correction dialog (reviewer can correct expense fields inline)
- **DOC-044/046:** Correction dialog extended to custom form fields; atomic RPC `apply_singular_expense_correction`

### Form builder
- **DOC-003:** Searchable dropdowns in Additional Information fields
- **DOC-004:** Customizable base field input types (text/number/dropdown)
- **DOC-005:** Bulk CSV import for cascading dependent dropdowns
- **DOC-010:** Admin-configurable field display order in expense detail view
- **DOC-047:** Atomic server-side RPC `save_option_branch_configuration_atomically` — eliminates browser-side DELETE+INSERT data loss (applied to production 2026-07-13)

### Performance
- **DOC-041:** `list_manager_pending_expenses` CTE rewrite + 6 indexes; manager step-skip bug fixed
- **DOC-042:** `approveExpense`/`rejectExpense`/`verifyExpense` → `Promise.all`; chunked audit_log → 1 org query
- **DOC-048:** Team reports statement timeout: org-wide fetch + in-memory filter; missing index
- **DOC-049:** AdminPanel O(n²) fix, ExpenseForm fire-and-forget analytics, EngineerReview caching
- **DOC-050:** Load-all persists across nav; admin page position restored; manager fetch 3→2 rounds

### Balance transfer offer system (existing, shipped earlier)
- Admins/cashiers propose transfers to recipients
- `balance_transfer_offers` table + `propose_balance_transfer_offer` / `accept_balance_transfer_offer` / `reject_balance_transfer_offer` RPCs
- `BalanceTransferOfferService` with full CRUD
- `TransferOffers.tsx` + `MobileTransferOffersView.tsx` for reviewing offers

### Legal/compliance pages
- `/legal/data-processing` — DPDP data processing policy  
- `/legal/activity-insights` — user activity insights notice  
- `/legal/data-rights` — data rights & grievance redressal  
- PrivacyPage + TermsPage updated with activity insights sections  
- Auth footer links; unauthenticated users can access these pages  
- All pages open in same-tab with back navigation (no new browser tab)

---

## 5. Features in progress (on feature branch)

### User Activity Insights — DOC-051
**Status: Complete (code) — pending legal review + production SQL**  
**Feature flag:** `user_activity_insights` (per-org, master admin only)

What it does:
- Admin sees per-user: last seen, visible app time today, expenses submitted today, active days, inactivity streak
- Click any user row → day-by-day log drawer (date, status, first/last used, app time, sessions, expenses)
- Employee acknowledgement gate (`UserActivityNoticeGate`) — user must accept before using app

What IS tracked:
- Session start/end (`user_activity_sessions`)
- Visible seconds (heartbeat every 30 s while tab is visible)
- Expenses submitted (DB trigger on `expenses`)
- Daily rollups (`user_activity_daily_rollups`)

What is NOT tracked: keystrokes, screenshots, mouse, location, IP, specific pages

**DPDP compliance package (§26):**
- SQL files 08–14: retention cleanup (90-day auto-purge), access export, erasure, audit log, DPIA
- 4 supporting docs: privacy notice, data inventory, DPIA, breach runbook
- Privacy notice gate + acknowledgement (`acknowledged_at` column on `organization_memberships`)

**SQL not yet applied to production** — legal review required first. See `Documentations MD/user-activity-insights.md` §20 production checklist.

---

### Transfer Offer Login Popup — DOC-052
**Status: Complete — on `feature/user-activity-insights`**  
**Feature flag:** `transfer_recipient_acceptance` (per-org, master admin only)

- `TransferOfferPromptGate` component — blocking modal on login/app-open
- Shows pending transfer offers one by one (queue management)
- Accept: calls `acceptOffer` RPC + refreshes balance header
- Reject: requires reason (≥ 3 chars), calls `rejectOffer` RPC
- "Review later": navigates to `/transfer-offers`
- Realtime (INSERT/UPDATE on `balance_transfer_offers`), window focus + 60 s polling
- No SQL changes — uses existing tables and RPCs
- Guards: master_admin and accountant-cashier do NOT see the popup

---

## 6. Manual actions still required

### SQL to run on production Coolify PostgreSQL

> **CRITICAL: Never run SQL without verifying it against production schema first. Only run after explicit instruction.**

| Priority | Migration file | What it does | Status |
|---|---|---|---|
| High | `supabase/migrations/20260706_0900_manager_rpc_performance_fix.sql` | `list_manager_pending_expenses` CTE + 6 indexes | Confirm if applied |
| High | `supabase/migrations/20260706_2100_manager_review_indexes.sql` | 5 covering indexes on audit_logs + expenses + org_memberships | Confirm if applied |
| High | `supabase/migrations/290707_2000_singular_correction_safety.sql` | Atomic correction RPC + field value history table | Pending |
| High | `supabase/migrations/290707_3000_branch_config_atomic_save.sql` | Atomic option branch save RPC | **Applied 2026-07-13** |
| Legal gate | User activity insights SQL files 01–14 | 2 tables, 6 RPCs, trigger, DPDP controls | **Pending legal review** |

After each SQL run:
1. `NOTIFY pgrst, 'reload schema';` (reload PostgREST schema cache)
2. Test the affected feature in staging first

### Environment variables
Ensure these are set on Vercel (production) and not pointing to old Supabase cloud:
- `VITE_SUPABASE_URL` → `https://pesowise-supabase.unimisk.com`
- `VITE_SUPABASE_ANON_KEY` → Coolify anon key
- Edge function secrets: `RESEND_API_KEY`, `CLOUDFLARE_R2_*` vars

---

## 7. Known risks and deferred work

| Risk | Severity | Notes |
|---|---|---|
| User Activity Insights SQL not production-ready | High | Legal review gate. Do NOT apply without sign-off. |
| `feature/user-activity-insights` not merged to main | Medium | All recent work lives here; main is behind by ~30 commits |
| Team Reports timeout (DOC-048) | Medium | Frontend fix is in; DB index `idx_expenses_org_status_created` may not be applied |
| Correction dialog custom fields (DOC-044) | Medium | Code present; debug session ongoing — see `correction-custom-fields-debug.md` |
| Same-domain API proxy (Phase 5 from May 2026 plan) | Low | Deferred indefinitely; chunking handles the CORS problem |
| Chunk size tuning | Low | `SUPABASE_IN_QUERY_CHUNK_SIZE = 25`; some heavy pages may benefit from 50 |

---

## 8. Test suite summary

**Total:** 744 tests across 57 test files (as of 2026-07-14, all passing)

| Area | Count |
|---|---|
| Custom form fields / batch validation | ~90 |
| Mobile UI components | ~130 |
| Expense flow integration | 13 |
| Balance transfer / offer validation | ~15 |
| Manager actionable expenses | ~10 |
| Load-all persistence / queue perf | ~20 |
| Misc lib utils (format, i18n, roles) | ~100+ |

Run: `npm test -- --run`  
Type check: `npx tsc --noEmit`  
Build: `npm run build`

---

## 9. Key files and services

### Core auth & context
| File | Purpose |
|---|---|
| `src/contexts/AuthContext.tsx` | `useAuth()` — user, userRole, isAccountantCashier, hasOrganizationFeature, refreshBalance |
| `src/lib/organizationFeatureKeys.ts` | All `ORGANIZATION_FEATURE_KEYS` constants |
| `src/components/Layout.tsx` | Authenticated shell — mounts UserActivityNoticeGate + TransferOfferPromptGate + notifications |

### Expense system
| File | Purpose |
|---|---|
| `src/pages/ExpenseForm.tsx` | Single expense creation + edit |
| `src/pages/BatchExpenseForm.tsx` | Batch expense creation (multi-line) |
| `src/pages/AdminPanel.tsx` | Admin all-expenses review + approval |
| `src/pages/EngineerReview.tsx` | Engineer/TL expense verification queue |
| `src/services/ExpenseService.ts` | Core expense CRUD + action RPCs |

### Balance transfers
| File | Purpose |
|---|---|
| `src/services/BalanceTransferOfferService.ts` | proposeOffer, acceptOffer, rejectOffer, fetchPendingForRecipient |
| `src/components/TransferOfferPromptGate.tsx` | Login popup for pending transfers |
| `src/pages/TransferOffers.tsx` | Full transfer offer management page |
| `src/lib/balanceTransferOfferValidation.ts` | validateTransferRejectionReason (min 3 chars) |

### User activity insights
| File | Purpose |
|---|---|
| `src/components/UserActivityTracker.tsx` | Heartbeat + session tracking (mounted in Layout) |
| `src/components/UserActivityNoticeGate.tsx` | Acknowledgement blocking gate |
| `src/pages/admin/UserActivityInsights.tsx` | Admin dashboard page |
| `supabase/migrations/` (files 01–14 prefixed with activity) | DB schema + RPCs + DPDP controls |

### Notifications
| File | Purpose |
|---|---|
| `src/hooks/useNotificationManager.ts` | Realtime notification listener + queue |
| `src/components/NotificationPopup.tsx` | Toast popup (supports all expense + transfer types) |
| `src/services/NotificationService.ts` | Creates notification rows in DB |

### Mobile
| File | Purpose |
|---|---|
| `src/components/mobile/MobileAppShell.tsx` | Bottom nav + scroll container |
| `src/hooks/useViewportMode.ts` | `isMobile` boolean (≤ 768px) |
| `src/components/mobile/` | All mobile-specific view components |

---

## 10. Safety rules for this repo

These apply to all agents and engineers working on this codebase:

- **DO NOT run SQL** on production without explicit user instruction
- **DO NOT apply SQL migrations** without running through the staging checklist first
- **DO NOT push to `main`** without explicit instruction
- **DO NOT force push** any branch
- **DO NOT merge `feature/user-activity-insights` to `main`** without user sign-off
- **DO NOT deploy** any changes; Vercel auto-deploys from `main` only
- **DO NOT change expense submission logic** without full test run
- **DO NOT weaken RLS** policies
- **DO NOT remove** the User Activity acknowledgement gate or admin disclaimer
- **DO NOT change** balance transfer RPCs unless explicitly needed
- `git commit` is allowed; `git push` only when user explicitly says so
- Always run `npx tsc --noEmit` + `npm test -- --run` + `npm run build` before committing
