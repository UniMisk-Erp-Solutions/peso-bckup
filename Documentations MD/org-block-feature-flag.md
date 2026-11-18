# Organization block — Master Admin feature flag

**Doc ID:** DOC-165  
**Status:** in progress  
**Last updated:** 2026-11-18  
**Owner / area:** Master Admin, organization feature flags, auth gate

---

## 1) Summary

Master Admin has an **`org_blocked`** feature flag for each organization (a checkbox in the
Features column of the organizations table). **Ticking it blocks the organization:** every
non-master user of that organization (admin, employee, cashier, engineer, team leader, executive)
who logs in, or is already logged in, sees a full-page "Organization blocked" screen with only a
Sign out button, instead of the app. Unticking restores access. The Master Admin account is never
blocked. The message wording is a **placeholder** until the owner supplies the final text.

---

## 2) Problem / requirement

Master Admin needs to block a particular organization so none of its users can use PesoWise and
they see a specific message instead. The owner asked for the flag first, then for ticking the box
to actually block. The final message text will be provided later.

---

## 3) Solution

- Key `org_blocked` in `ORGANIZATION_FEATURE_KEYS` + `MASTER_ADMIN_FEATURE_DEFINITIONS`
  (label `features.orgBlocked`). Master Admin renders it automatically and saves it through the
  existing `saveOrganizationFeature` upsert into `organization_features`. Default OFF (no row = not blocked).
- `src/lib/orgBlocked.ts`: `isOrganizationBlocked(flags, role)` (true only when the flag is on and the
  role is not `master_admin`) and the placeholder title/message constants (one place to edit the wording).
- `src/components/OrgBlockedScreen.tsx`: the full-page screen with a Sign out button.
- `ProtectedRoute` renders the screen, after auth has loaded, before any page or Layout, so every
  protected route is covered. A user already logged in is blocked the next time the flags refresh
  (page load, window focus, or the existing realtime update of `organization_features`).

**Limitation (client-side gate):** this blocks the app UI. It does not revoke the Supabase
session and does not block direct API or RLS access. A database-level block (RLS or a login hook)
is a separate, later step if required.

**Master Admin UI refresh (rev 1.2, styling only):** the Master Admin page was restyled (header with
icon, coloured stat cards, bordered tables with a tinted header, Features column in a scrollable
bordered panel with "Block Organization" highlighted in red, Blocked column as a badge and blocked
rows tinted, backup and storage tiles in bordered boxes). Only class names and wrapper markup
changed in `MasterAdminDashboard.tsx`; no state, handler, query or save logic was touched.

Note: `organizations.is_blocked` (2025 master-admin migration) is a separate, read-only column and is
not used by this feature.

---

## 4) Key files

```
src/lib/organizationFeatureKeys.ts
src/lib/orgBlocked.ts
src/components/OrgBlockedScreen.tsx
src/components/ProtectedRoute.tsx
src/lib/__tests__/orgBlocked.test.ts
src/pages/MasterAdminDashboard.tsx
supabase/migrations/20261118120000_organization_block_message.sql
src/locales/en/master.json
src/locales/hi/master.json
src/locales/gu/master.json
```

---

## 5) Database / migrations

- The flag itself needs none: `organization_features.feature_key` is free text.
- **Block message (rev 1.4):** `supabase/migrations/20261118120000_organization_block_message.sql`
  adds `organizations.block_message text`. **Run it manually** (user runs SQL), then PostgREST reloads
  its schema (the file issues `NOTIFY pgrst, 'reload schema'`). Until it is applied, ticking "Block
  Organization" shows a "Could not save the message" error and does not block; an already blocked
  organization simply shows the default message.

**Block message box (rev 1.4):** ticking "Block Organization" opens a dialog where Master Admin
writes the message (required, max 500 characters, prefilled with the last saved text or the default).
"Block organization" saves the text to `organizations.block_message` and then saves the flag; Cancel
changes nothing. The block screen reads `block_message` for the user's organization (falls back to the
default text if empty or unreadable). Unticking keeps the saved message for next time. Validation lives
in `validateBlockMessage` (`src/lib/orgBlocked.ts`).

---

## 6) Test plan

- [ ] Master Admin -> Features column shows "Block Organization"; tick it for a test organization; refresh; still ticked.
- [ ] A user of that organization logs in -> sees "Organization blocked" with Sign out only.
- [ ] A user already logged in gets the block screen after a refresh or tab refocus.
- [ ] Master Admin can still log in and open /master.
- [ ] Tick the flag -> a message box opens; Cancel leaves it unticked; empty message is refused; "Block organization" saves and ticks.
- [ ] The blocked user sees exactly the message Master Admin typed (after the migration is applied).
- [ ] Without the migration: saving shows the migration hint and nothing is blocked.
- [ ] Untick the flag -> the user can log in and use the app again.
- [ ] Users of other organizations are unaffected.
- [ ] `npx vitest run src/lib/__tests__/orgBlocked.test.ts` passes (6 tests).

---

## 7) Related docs

- Pattern copied from the Tally flag in [`pesowise-tally-system-document.md`](./pesowise-tally-system-document.md).

---

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-11-18 | 1.0 | Claude Code | Flag and Master Admin toggle added. No enforcement yet. Not deployed. |
| 2026-11-18 | 1.1 | Claude Code | Ticking the flag now blocks the organization in the app (block screen via ProtectedRoute, placeholder message, master admin exempt). Client-side gate only. Not deployed. |
| 2026-11-18 | 1.2 | Claude Code | Master Admin page UI refresh, styling only (`src/pages/MasterAdminDashboard.tsx`); no logic changes. Branch `ui/master-admin-redesign`, not merged, not deployed. |
| 2026-11-18 | 1.5 | Claude Code | "Block organization" checkbox moved out of the Features list into its own highlighted box in the Activity / Blocked column; it still opens the message box when ticked; the Blocked badge and row tint now reflect the flag as well as the old `is_blocked` column. Display change only. |
| 2026-11-18 | 1.4 | Claude Code | Message box when blocking (required message, saved in new `organizations.block_message`, shown on the block screen); migration `20261118120000_organization_block_message.sql` prepared, not applied; label text updated. |
| 2026-11-18 | 1.3 | Claude Code | Organizations table made to fit one screen with no horizontal scroll: 11 columns merged into 6 (Organization, Tenant / Strategy, Features, Plan / Payment, Users, Activity / Blocked), fixed-width layout. Same inputs and handlers, only moved. |
