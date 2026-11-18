# Organization block and the Master Admin organization management view

**Doc ID:** DOC-165  
**Status:** in progress  
**Last updated:** 2026-11-18  
**Owner / area:** Master Admin (`/master`), organization feature flags, auth gate

---

## 1) Summary

Two connected changes to Master Admin:

1. **Organization block.** A per-organization **`org_blocked`** feature flag. When Master Admin blocks an
   organization (after writing the message users will see), every non-master user of that organization
   (admin, employee, cashier, engineer, team leader, executive) who logs in, or is already logged in, sees a
   full-page "Organization blocked" screen with that message and only a Sign out button. The Master Admin
   account is never blocked.
2. **Master Admin redesign.** The oversized organizations table is replaced by a compact list and a dedicated
   per-organization management view with six tabs. All existing behaviour, handlers, database calls and
   feature flags are unchanged; they were moved, not rewritten.

---

## 2) Problem / requirement

- Master Admin needs to block an organization so none of its users can use PesoWise and they see a specific
  message instead.
- The old organizations table had 11 columns, a nested scrolling checkbox list of every feature flag per
  row and horizontal scrolling. The owner asked for a clean, modern admin interface.

---

## 3) Solution

### 3.1 Organization block

- Key `org_blocked` in `ORGANIZATION_FEATURE_KEYS` + `MASTER_ADMIN_FEATURE_DEFINITIONS` (label
  `features.orgBlocked`). Saved through the existing `saveOrganizationFeature` upsert into
  `organization_features`. Default OFF (no row = not blocked).
- `src/lib/orgBlocked.ts`: `isOrganizationBlocked(flags, role)` (true only when the flag is on and the role is
  not `master_admin`), the default title/message, and `validateBlockMessage` (required, max 500 characters).
- `src/components/OrgBlockedScreen.tsx`: the full-page screen. It reads `organizations.block_message` for the
  user's organization and falls back to the default text if it is empty or unreadable.
- `ProtectedRoute` renders the screen after auth has loaded and before any page or Layout, so every protected
  route is covered. A logged-in user is blocked the next time the flags refresh (page load, window focus, or
  the existing realtime update of `organization_features`).
- **Block message box:** blocking opens a dialog where Master Admin writes the message (prefilled with the last
  saved text or the default). "Block organization" saves the text to `organizations.block_message` and then the
  flag; Cancel changes nothing. Unblocking keeps the saved message for next time.

**Limitation (client-side gate):** this blocks the app UI. It does not revoke the Supabase session and does not
block direct API or RLS access. A database-level block (RLS or a login hook) is a separate, later step.

`organizations.is_blocked` (2025 master-admin migration) is a separate legacy column. It is shown (read-only) and
counts as "Blocked" in the list, but it does not stop logins.

### 3.2 Master Admin redesign (`/master`)

**List view** (default):

- Header and the three KPI cards (Organizations, Contact Leads, Storage) are kept.
- The "System notices temporarily disabled" warning is now a compact, collapsed-by-default notice that
  expands on click (same wording). When system status control is enabled the maintenance and broadcast cards
  render exactly as before.
- Organizations: a compact table (`OrganizationsTable`) with **Organization, Plan, Users, Payment, Status,
  Last active, Actions**, a search box (name, slug, subdomain), no horizontal scrolling and no feature
  checkboxes. Status shows Blocked when the `org_blocked` flag or the legacy `is_blocked` column is set. The
  Manage button (or the organization name) opens the management view.
- Data & backup, Contact leads and Storage metrics sections are unchanged apart from styling.

**Management view** (`OrganizationManagement`), opened with the URL `?org=<organization id>` so refresh and the
browser Back button work. Six tabs:

| Tab | Contents |
|-----|----------|
| Overview | Plan, payment and users summary; **Tenant settings** (subdomain, strategy); organization ID and created date |
| Features | Every feature flag in categories (Access & login, Expenses & forms, Teams & approvals, Balances & reports, Insights & integrations), search, switches, and Save / Cancel |
| Plan & Billing | Plan and payment status (saved when a value is picked, as before) |
| Users | Active members against the limit with a progress bar, and the **user limit** editor (saved on blur, empty = unlimited). Counts only, no individual users |
| Activity | Last active, created date, whether user activity insights is on |
| Security | **Block / Unblock organization**. Block opens the message box; Unblock asks for confirmation |

**Features tab behaviour.** Switches edit a local draft; nothing is saved until **Save changes**. Cancel
discards the draft. Save applies only the changed flags, one by one, with the page's existing
`saveOrganizationFeature` (same upsert, toasts and error handling). `user_activity_insights` keeps its rules:
enabling it still opens the existing confirmation dialog (which saves it and writes the audit row); disabling it
still writes the "disabled" audit row after saving. `org_blocked` is excluded from this tab (it lives in
Security). A flag that is not mapped to a category appears under "Other features" so it can never disappear.

**What was moved, not changed:** `updateOrganization` (plan, payment, subdomain, strategy, user limit, including
its migration checks), `saveOrganizationFeature`, the Activity Insights dialog, the data loading, backup
downloads and contact leads. No database schema, API, permission or feature-flag change was made for the
redesign.

---

## 4) Key files

```
src/pages/MasterAdminDashboard.tsx                       page: state, data loading, all handlers, dialogs
src/components/master-admin/OrganizationsTable.tsx       compact list
src/components/master-admin/OrganizationManagement.tsx   management view + six tabs
src/components/master-admin/FeaturesTab.tsx              categorised flags, search, Save / Cancel
src/components/master-admin/types.ts                     Organization type, plan/payment options, subdomain rule
src/lib/masterAdminFeatures.ts                           categories, search filter, change diff (pure)
src/lib/organizationFeatureKeys.ts                       org_blocked key + definition
src/lib/orgBlocked.ts                                    block check, default message, message validation
src/components/OrgBlockedScreen.tsx                      block screen
src/components/ProtectedRoute.tsx                        shows the block screen
src/locales/{en,hi,gu}/master.json                       feature label
supabase/migrations/20261118120000_organization_block_message.sql
tests:
src/lib/__tests__/orgBlocked.test.ts
src/lib/__tests__/masterAdminFeatures.test.ts
src/components/master-admin/__tests__/masterAdminViews.test.tsx
```

---

## 5) Database / migrations

- The flag needs none: `organization_features.feature_key` is free text.
- **Block message:** `supabase/migrations/20261118120000_organization_block_message.sql` adds
  `organizations.block_message text`. **Run it manually** (SQL is run by hand), then PostgREST reloads its schema
  (the file issues `NOTIFY pgrst, 'reload schema'`). Until it is applied, blocking shows "Could not save the
  message" and does not block; an already blocked organization shows the default message.
- The redesign needs no migration.

---

## 6) Test plan

Automated (`npx vitest run src/lib/__tests__/orgBlocked.test.ts src/lib/__tests__/masterAdminFeatures.test.ts src/components/master-admin`):
block check and message validation; every flag is categorised exactly once; search and change diff; compact
table columns, search, blocked status; Features tab draft, search, Save sends only changed flags, Cancel
discards; management view tabs, user limit, Block / Unblock buttons.

Manual (use a test organization):

- [ ] `/master` shows KPI cards, a collapsed maintenance notice, and the compact table with no horizontal scroll.
- [ ] Manage opens the organization; the URL gets `?org=...`; Back returns to the list; refresh keeps the view.
- [ ] Overview: change subdomain and strategy, they save as before.
- [ ] Features: toggle flags, Save applies them, Cancel discards, search filters; enabling Activity Insights still
      asks for confirmation.
- [ ] Plan & Billing and Users: plan, payment and user limit save as before.
- [ ] Security: Block opens the message box (empty message refused); a user of that organization then sees the
      message; Unblock asks for confirmation and restores access; the Master Admin is never blocked.
- [ ] Without the migration: blocking shows the migration hint and nothing is blocked.
- [ ] Other organizations are unaffected.

---

## 7) Related docs

- Pattern copied from the Tally flag in [`pesowise-tally-system-document.md`](./pesowise-tally-system-document.md).
- The disabled-notice wording comes from [`system-status-temporary-disablement.md`](./system-status-temporary-disablement.md).

---

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-11-18 | 1.0 | Claude Code | `org_blocked` flag and Master Admin toggle added. No enforcement yet. |
| 2026-11-18 | 1.1 | Claude Code | Ticking the flag blocks the organization in the app (block screen via ProtectedRoute, master admin exempt). Client-side gate only. |
| 2026-11-18 | 1.2 | Claude Code | Master Admin styling refresh (class names only). |
| 2026-11-18 | 1.3 | Claude Code | Organizations table fit to one screen, no horizontal scroll (11 columns merged into 6). |
| 2026-11-18 | 1.4 | Claude Code | Message box when blocking; message saved in new `organizations.block_message`; migration `20261118120000` prepared, not applied. |
| 2026-11-18 | 1.5 | Claude Code | "Block organization" checkbox moved to its own box in the table (later superseded by 1.6). |
| 2026-11-18 | 1.6 | Claude Code | Master Admin redesign: compact organizations list; per-organization management view with Overview, Features, Plan & Billing, Users, Activity and Security tabs; categorised Features tab with search and Save / Cancel; Block / Unblock in Security with confirmation; compact expandable maintenance notice; tests. No logic, schema or permission change. Branch `ui/master-admin-redesign`, not merged, not deployed. |
| 2026-11-18 | 1.7 | Claude Code | Features tab category headings (Access & login, Expenses & forms, ...) made bold and highlighted (tinted bar, accent edge, primary-coloured text). Styling only. |
