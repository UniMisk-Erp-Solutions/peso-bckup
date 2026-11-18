# Organization block — Master Admin feature flag

**Doc ID:** DOC-165  
**Status:** in progress  
**Last updated:** 2026-11-18  
**Owner / area:** Master Admin, organization feature flags

---

## 1) Summary

Master Admin now has an **`org_blocked`** feature flag for each organization (a checkbox in the
Features column of the organizations table, next to the other per-organization flags). It is the
switch that will be used to block a whole organization. **This step adds only the flag and its
toggle.** Nothing reads the flag yet: turning it on does not stop anyone from logging in.

## 2) Problem / requirement

Master Admin needs a way to block a particular organization so that none of its users can log in
and instead see a specific message. The owner asked for the feature flag first; the login
enforcement and the message wording will be specified later.

## 3) Solution

- New key `org_blocked` in `ORGANIZATION_FEATURE_KEYS`, and a matching entry in
  `MASTER_ADMIN_FEATURE_DEFINITIONS` (label key `features.orgBlocked`, no subdomain requirement).
- Master Admin renders every definition automatically, so the checkbox appears with no change to
  `MasterAdminDashboard.tsx`. Toggling saves a row in `organization_features`
  (`feature_key = 'org_blocked'`, `enabled = true|false`) through the existing
  `saveOrganizationFeature` upsert.
- Default is OFF for every company: no row means not blocked.
- Label added in English, Hindi and Gujarati (`master.json`).

Note: `organizations.is_blocked` (boolean, from the 2025 master-admin migration) already exists and is
shown read-only in the table. It is a separate column and is not changed here. When enforcement is
built, decide whether the login check reads this flag, `is_blocked`, or both.

## 4) Key files

```
src/lib/organizationFeatureKeys.ts
src/locales/en/master.json
src/locales/hi/master.json
src/locales/gu/master.json
```

## 5) Database / migrations

None. `organization_features.feature_key` is free text (primary key
`organization_id, feature_key`), so the new key needs no schema change.

## 6) Test plan

- [ ] Master Admin → organizations table → Features column shows "Block Organization".
- [ ] Tick it for a test organization; toast "Feature updated"; refresh; still ticked.
- [ ] Untick it; refresh; unticked.
- [ ] Organizations never touched have it unticked.
- [ ] Users of the blocked organization can still log in (enforcement not built yet).

## 7) Related docs

- Pattern copied from the Tally flag in [`pesowise-tally-system-document.md`](./pesowise-tally-system-document.md).

---

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-11-18 | 1.0 | Claude Code | Flag and Master Admin toggle added. No enforcement yet. Not deployed. |
