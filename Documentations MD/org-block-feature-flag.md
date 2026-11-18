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
src/locales/en/master.json
src/locales/hi/master.json
src/locales/gu/master.json
```

---

## 5) Database / migrations

None. `organization_features.feature_key` is free text (primary key
`organization_id, feature_key`), so the new key needs no schema change.

---

## 6) Test plan

- [ ] Master Admin -> Features column shows "Block Organization"; tick it for a test organization; refresh; still ticked.
- [ ] A user of that organization logs in -> sees "Organization blocked" with Sign out only.
- [ ] A user already logged in gets the block screen after a refresh or tab refocus.
- [ ] Master Admin can still log in and open /master.
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
