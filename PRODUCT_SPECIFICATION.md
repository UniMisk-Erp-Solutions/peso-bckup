# PesoWise — Product Specification Document

**Product name:** PesoWise  
**Document version:** 2.0  
**Last updated:** 2026-07-14  
**Status:** Living document — reflects current production + in-progress feature branch state

---

## 1. Product Overview

### 1.1 Product Name
**PesoWise** (formerly Voyage Account / Peso-Patidar)

### 1.2 Product Purpose
A multi-tenant, DPDP-compliant enterprise expense management SaaS. Organizations use PesoWise to manage expense submission, multi-step approvals, balance management, cash transfers, and admin-level activity insights — all on a single platform.

### 1.3 Target Audience
- **Primary users:** Employees, Engineers (team leads), Accountant-Cashiers, Admins, Master Admins
- **Organization types:** Small to mid-size enterprises with ≥ 10 employees and a finance/operations team
- **Use cases:** Business travel reimbursements, project costs, operational advances, cash balance management, payroll-adjacent advance management

### 1.4 Deployment
- **Frontend:** Vercel (React SPA, auto-deploy from `main`)
- **Backend:** Self-hosted Supabase on Coolify (`pesowise-supabase.unimisk.com`)
- **Storage:** Cloudflare R2 (receipts and attachments via Supabase Storage adapter)
- **Multi-tenancy:** Per-org subdomain routing (`{org}.pesowise.unimisk.com`); each org has isolated RLS-protected data

---

## 2. User Roles

| Role | Description |
|---|---|
| **Master Admin** | PesoWise platform admin. Manages all organizations, toggles per-org feature flags, cannot see transfer popups or activity gate |
| **Admin** | Org-level admin. Full access to all expenses, user management, approvals, analytics, balance management, category/form configuration |
| **Engineer / Team Lead** | Reviews and verifies expenses submitted by their assigned employees. Can approve within their team |
| **Employee** | Submits single and batch expense reports, views own balance and history |
| **Cashier** | Adds funds to employee balances; transfers from own balance; proposes balance transfer offers |
| **Accountant-Cashier** | Cashier operating in accountant mode; inherits cashier capabilities but NOT shown transfer offer popups |

Roles are per-org via `organization_memberships` (not the legacy `user_roles` table). A user may belong to multiple orgs with different roles.

---

## 3. Core Features

### 3.1 Expense Management

#### Single Expenses
- Employee creates expense with: title, amount, category, date, payment mode, destination, notes, receipts
- Optional custom form fields per category (dropdown, text, number; dependent options)
- Attachment upload with progressive compression (max 5 MB after compression)
- Multi-step workflow: Employee → Engineer (verify) → Admin (approve/reject)
- Admin hierarchy bypass: Admins can approve without waiting for TL/executive tiers (feature-flagged)
- Reviewer correction: Reviewer can edit expense fields inline from the review dialog (atomic RPC, custom fields supported)

#### Batch Expenses
- Shared title entered once, propagates to all line items
- Multiple line items with per-line amount, category, custom fields
- Reviewer sees consolidated table with custom field columns
- Required custom field validation runs before Step 2 submission
- Batch review button color-coded by action state (grey / orange / blue)
- Session-persisted search term, page position, scroll state (restored on Back navigation)

#### Expense Status Flow
```
Draft → Submitted → Under Review → Verified → Approved / Rejected
```
Each transition logged in `audit_logs` with timestamp + actor.

### 3.2 Balance Management
- Every user has a balance tracked in `organization_memberships.balance`
- Balance is automatically deducted when admin approves an expense
- Admin, Engineer, or Cashier can add funds (deducted from cashier's own balance)
- Real-time balance display in header with refresh on transfer accept/approve

### 3.3 Balance Transfer Offers
- Cashier/Admin proposes a transfer to a recipient via the Balances page
- Recipient is notified via Supabase Realtime notification
- Recipient can accept (balance updated), reject (must provide reason ≥ 3 chars), or defer to the Transfer Offers page
- Full offer history (pending + accepted/rejected/cancelled) visible to both parties

**Transfer Offer Login Popup (feature-flagged: `transfer_recipient_acceptance`):**
When enabled, recipients see a blocking modal on login/app-open showing each pending offer one-by-one. They cannot dismiss it without acting or clicking "Review later".

### 3.4 Role-Based Dashboards
- **Employee:** personal expense list, balance card, quick submit button
- **Engineer:** assigned team pending queue, stats (pending / verified / rejected counts)
- **Admin:** org-wide expense list with filters, stats hub, approval queue
- **Cashier:** balance management, transfer history, offer management

### 3.5 Notifications
- Realtime toast popups via Supabase `postgres_changes` subscription
- Types: expense_submitted, expense_approved, expense_rejected, expense_assigned, expense_verified, balance_added, transfer_offer_received, transfer_offer_accepted, transfer_offer_rejected, transfer_offer_cancelled
- Bell icon with unread count; full notification history page
- Toast routing: transfer types → `/transfer-offers`; expense types → `/expenses/:id`

### 3.6 Form Builder
- Admins configure custom form fields per expense category
- Field types: text, number, dropdown (flat or cascading/dependent)
- Dependent dropdowns: parent → child → grandchild option branches
- Bulk CSV import for cascading option trees
- Field display order configurable per-org via drag-and-drop admin UI
- Base field types (title, amount, etc.) can be reconfigured (text/number/dropdown, admin-gated)

### 3.7 User Activity Insights *(feature-flagged: `user_activity_insights` — pending legal review)*
- Admin sees per-user: last seen, visible app time today, expenses submitted, active days, inactivity streak
- Day-by-day log drawer per user: date, status, first/last used, session count, app time, expenses
- Employee acknowledgement gate (DPDP §7 transparency requirement — must accept before app is usable)

**What is tracked:** session start/end, visible-tab heartbeat (30 s), expense submissions (trigger)  
**What is NOT tracked:** keystrokes, screenshots, mouse, location, IP, specific pages visited

Full DPDP compliance package:
- Data retention: auto-purge after 90 days
- Access export: employee can request their own data
- Erasure: admin can delete a user's activity data
- Audit log for all DPDP actions
- DPIA, breach runbook, privacy notice (4 supporting docs in `Documentations MD/`)

### 3.8 Legal / DPDP Pages
All accessible to unauthenticated users via `/legal/…` routes, opening in same tab with back button:
- `/legal/privacy-policy` — Privacy Policy (with Activity Insights section)
- `/legal/terms` — Terms & Conditions (with Activity Insights clause)
- `/legal/data-processing` — Data Processing Policy
- `/legal/activity-insights` — User Activity Insights Notice
- `/legal/data-rights` — Data Rights & Grievance Redressal

### 3.9 Analytics & Reports
- Expense analytics: chart by category, status, time period
- Detailed expense report: tabular with all fields, filterable by org/team
- Daily project report: expenses grouped by project/date
- Balance reports: per-user balance history
- Data exports: PDF and CSV

### 3.10 User Management
- Admin creates/edits/deactivates users within their org
- Role assignment, supervisor assignment, cashier assignment
- Hierarchy view: org tree with team assignments
- Card and table toggle views; mobile card view
- React Query cache with 5-min stale time; invalidated on CRUD

---

## 4. Technical Specifications

### 4.1 Frontend
- React 18, TypeScript, Vite
- Tailwind CSS + shadcn/ui component library
- react-router-dom v6 (lazy-loaded routes with retry)
- react-i18next — English, Hindi, Gujarati
- react-query (TanStack Query) for server state
- Supabase-js v2 for auth, DB, realtime, storage
- Recharts for analytics visualizations
- Vitest + Testing Library (744 tests)
- PWA-capable (service worker, manifest, installable on mobile)

### 4.2 Backend
- Supabase (self-hosted on Coolify)
  - PostgreSQL 15
  - Supabase Auth (email/password + session management)
  - Supabase Storage (Cloudflare R2 adapter for receipts)
  - Supabase Realtime (postgres_changes subscriptions)
  - Edge Functions (Deno): `finalize-expense-receipts`, `send-email`, `send-whatsapp`
- Row Level Security on all tables
- SECURITY DEFINER RPCs for privileged operations
- All new SQL in `supabase/migrations/` with timestamped filenames

### 4.3 Mobile Web (PWA)
- Full responsive mobile UI with `useViewportMode` hook (`isMobile` = ≤ 768px)
- `MobileAppShell` with 4–5 tab bottom navigation
- All pages have mobile-specific card views (no horizontal-scrolling tables)
- Progressive image compression before upload (max 5 MB)
- Installable as PWA on iOS and Android

### 4.4 Database Schema (key tables)
| Table | Purpose |
|---|---|
| `profiles` | User identity (name, email, avatar) |
| `organizations` | Org config (name, subdomain, settings) |
| `organization_memberships` | Role + balance per user per org |
| `organization_features` | Per-org feature flag overrides |
| `expenses` | Expense records |
| `expense_batches` | Batch expense containers |
| `expense_categories` | Category definitions per org |
| `expense_category_form_fields` | Custom field definitions |
| `expense_form_field_values` | Per-expense custom field values |
| `expense_form_field_branch_config` | Dependent dropdown option branches |
| `balance_transfer_offers` | Transfer proposals (pending/accepted/rejected/cancelled) |
| `notifications` | In-app notification rows |
| `audit_logs` | Expense status change history |
| `user_activity_sessions` | Session tracking (feature-flagged) |
| `user_activity_daily_rollups` | Daily aggregated activity (feature-flagged) |

---

## 5. Multi-Tenancy

- Each organization has a unique subdomain (`{slug}.pesowise.unimisk.com`)
- RLS policies scope all queries to the user's `organization_id`
- Per-org feature flags (`organization_features` table): admins enable/disable capabilities
- Master Admin (`master_admin` role) can manage all orgs and toggle flags globally

**Per-org feature flags (as of 2026-07-14):**
| Flag key | Feature |
|---|---|
| `user_activity_insights` | Admin activity dashboard + employee acknowledgement gate |
| `transfer_recipient_acceptance` | Transfer offer login popup (blocking modal) |
| `admin_hierarchy_bypass` | Admins can approve without engineer/executive tiers |
| `batch_expenses` | Multi-line batch expense submission |
| `old_money_theme` | Optional private-banking visual theme |
| `cashier_accountant_mode` | Cashier can act in accountant mode |

---

## 6. Security

- **Authentication:** Supabase Auth (email + password, JWT sessions)
- **Authorization:** RLS on every table; no service role key in browser
- **Privileged ops:** SECURITY DEFINER RPCs or Supabase Edge Functions
- **File uploads:** Type-validated, size-limited, stored in R2 via Storage API
- **Audit trail:** `audit_logs` tracks all expense status changes with actor + timestamp
- **DPDP compliance:** Retention, export, erasure, audit log, DPIA (see User Activity Insights §26)

---

## 7. Performance

- Large `.in()` queries chunked or replaced with org-scoped RPCs (`SUPABASE_IN_QUERY_CHUNK_SIZE = 25`)
- Manager review RPC uses CTE to avoid N+1 DB calls
- `fetchExecutiveHandoffExpenseIds` → single org-scoped query (was 10–15 chunk queries)
- AdminPanel enrichment (audit logs, custom fields) runs after list renders via `Promise.all`
- React Query `staleTime` on membership/feature data to deduplicate concurrent fetches
- Lazy-loaded routes via `lazyWithRetry` with retry + cooldown on chunk failures
- PWA service worker caches static assets (no aggressive reload strategy)

---

## 8. Internationalisation

- Languages: **English** (default), **Hindi**, **Gujarati**
- Framework: `react-i18next` with JSON namespace files in `src/locales/`
- All UI strings use `t()` — no hardcoded English in JSX
- All 3 languages tested via `src/lib/__tests__/locales.test.ts` (48 tests verifying key parity)

---

## 9. Testing

- Framework: **Vitest** + **@testing-library/react**
- **744 tests** across 57 files (all passing as of 2026-07-14)
- Key areas: expense flow integration, custom fields, batch validation, mobile components, manager logic, transfer offer validation, i18n key parity, util libraries
- UI component render tests use `TestWrapper` (QueryClient + BrowserRouter)
- Run: `npm test -- --run` | Type check: `npx tsc --noEmit` | Build: `npm run build`

---

## 10. Future / Deferred Work

| Item | Priority | Notes |
|---|---|---|
| Merge `feature/user-activity-insights` → `main` | High | After legal review of Activity Insights |
| Apply activity insights SQL to production | High | After legal sign-off |
| Apply singular correction safety SQL | Medium | `290707_2000_singular_correction_safety.sql` |
| Correction dialog custom fields (DOC-044) | Medium | Code present; debug ongoing |
| Team reports DB index (DOC-048) | Medium | `idx_expenses_org_status_created` may be missing on Coolify |
| Same-domain API proxy | Low | Eliminates CORS class entirely; not planned short-term |
| Push notifications (PWA) | Low | Infrastructure exists; not wired |
| Flutter mobile app | Deferred | Original spec; replaced by responsive PWA |
