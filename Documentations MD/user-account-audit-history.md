# Immutable user-account audit history

**Doc ID:** DOC-158  
**Status:** deployed (database migrations, edge functions and frontend are live in Production since 2026-10-24; PR #26 merged as `0291f66`)  
**Last updated:** 2026-10-24  
**Owner / area:** Admin / User Management / Supabase (database, edge functions)  

---

## 1) Summary

Every change to a user account (create, rename, e-mail, employee id, role, team, supervisor, cashier assignment, location, deactivate / reactivate, ban / unban, password events, bulk import, delete) is now written to one **append-only** table, `user_account_audit_events`, with **who** did it (a frozen snapshot of the human administrator), **what** changed (field, old, new), **which account** (a frozen snapshot of the target *as it was at that moment*), **when**, and **from where** (source, request id, batch id, execution context).

The decisive property: when an admin's request passes through an edge function and the **service role**, the audit row still names the **human admin** (`actor_user_id` + `actor_snapshot`), and records `service_role` only as the *execution context*. The actor is derived from the verified JWT and re-checked by the database; it can never be supplied by the browser.

## 2) Problem / requirement

The Patidar Travels / Krish Patel incident: an account was deactivated, reactivated, had its login e-mail changed and was renamed to a different person within minutes. Only the service role showed up as the actor, the profile had no history, and nobody could say **which admin** did it. Required: a conclusive answer to who / what / when / which account / which path, surviving later renames, without ever storing a credential.

## 3) Solution

### 3.1 Architecture

| Layer | What it does |
|---|---|
| `user_account_audit_events` | Append-only. No INSERT/UPDATE/DELETE privilege for any API role; `BEFORE UPDATE OR DELETE` and `BEFORE TRUNCATE` triggers also stop the table owner. RLS: `SELECT` for the organization's active admins (and master admins). |
| **Triggers** on `profiles`, `organization_memberships`, `user_roles`, `team_members`, `engineer_locations`, `auth.users` | Capture **every** path (UI, RPC, edge function, bulk import, operator SQL) in the **same transaction** as the business write. Only real changes are logged (`IS DISTINCT FROM`; hot paths such as balance updates never invoke the trigger). |
| Actor resolution (`_uaa_resolve`) | (1) the authenticated JWT (`auth.uid()`); else (2) a **trusted context** registered by server code for the target; else (3) *unattributed* (`actor NULL`, `source database` / `auth_flow`) — **never guessed**. |
| Trusted context (`register_user_account_audit_context_v1`) | **service_role only.** The edge function derives the actor from the caller's JWT, then registers it; the database re-verifies the actor is an active admin of that organization (or a master admin). TTL 120 s per target (bulk: 900 s, organization scope, cleared in `finally`). |
| `record_user_account_audit_event_v1` | **service_role only.** For events no table trigger can see (password reset, failures, denials). Actor must be a real profile; actor *type* and target snapshot are computed in the database. |
| Edge helper `_shared/accountAudit.ts` | `registerAuditContext` **fails closed** (if the audit trail is unavailable the privileged change is refused); `recordAuditEvent` is best-effort and stores only category codes. |
| `user_identity_timeline_v1` | Chronological identity timeline for one user with a human-readable `summary` and the identity the account had *at each moment*. Security invoker, so RLS applies. |
| UI | **Audit History** button on each User Management row (dialog), **Administration → User Audit** page (`/admin/user-audit`: filters for user, actor, event type, source, date range; paginated). |

### 3.2 Event types (36)

`baseline_snapshot`, `user_created`, `user_deleted`, `membership_added`, `membership_removed`, `profile_updated` (name), `email_changed` (`layer` = `auth` or `profile`), `employee_id_changed`, `role_changed`, `legacy_role_changed`, `accountant_cashier_changed`, `supervisor_changed`, `team_changed`, `cashier_assignment_changed`, `location_changed`, `profile_status_changed`, `organization_changed`, `master_admin_flag_changed`, `user_deactivated`, `user_reactivated`, `user_banned`, `user_unbanned`, `password_changed`, `password_reset_requested`, `password_reset_completed`, `admin_password_reset`, `account_identity_changed`, and failure/denial events `user_creation_failed`, `email_change_failed`, `deactivation_failed`, `reactivation_failed`, `password_reset_failed`, `account_change_denied`, `auth_ban_failed`, `auth_unban_failed`, `auth_sync_recovered`.

Deactivation keeps the three states apart: `user_deactivated` / `user_reactivated` are the **membership** transition; the row's metadata carries `profile_active` and `auth_banned` *as they were at that moment*; `profile_status_changed` and `user_banned` / `user_unbanned` are separate events.

### 3.3 Actor model and service-role attribution

```
Admin A (browser, JWT)
  → edge function: auth.getUser(jwt) → actorId            (never read from the request body)
  → registerAuditContext(actorId, org, requestId, source, targets)   [service-role RPC, fail-closed]
  → DB: actor must be an active admin of org  (spoofed / foreign / non-admin actor → refused)
  → service-role write (auth.admin.updateUserById …)
  → trigger → row: actor = Admin A, actor_type = org_admin, metadata.execution_context = "service_role"
```

* A context is only honoured for the **target(s) it was registered for** (or, for bulk, the organization), and a *signed-in human's own JWT always wins*: another admin cannot ride on a live context registered by Admin A (tested).
* Account creation (auth id unknown) registers by **e-mail**; the lookup also matches by the profile's e-mail, which is how the membership row written *inside* `handle_new_user` is attributed (found by running the migration against the real Production schema; regression-tested).
* Self-service: `register_my_account_audit_context_v1` (authenticated; actor = target = `auth.uid()`) makes a password change from account settings read *"Password changed — by the user, Account settings, self_service"*.
* Anything with no provable actor (recovery link, GoTrue self e-mail confirmation, Supabase Dashboard, operator SQL) is stored **unattributed** and labelled as such in the UI. That visible gap is intentional.

### 3.4 Immutability, RLS, least privilege

* `REVOKE ALL … FROM PUBLIC, anon, authenticated, service_role`; `GRANT SELECT` only. The two audit tables and every `_uaa_*` helper / trigger function are not executable by API roles.
* The browser cannot insert, so it cannot supply `actor_user_id`, `organization_id`, `old_value` or `new_value`.
* Cross-organization: an admin reads only `organization_id`s they administer; the timeline, summary and confirmation RPCs re-check administrator-of-this-organization **and** that the target belongs to it. Employees and cashiers see nothing; `anon` has no privilege. **Master admins can read all organizations** (`is_master_admin()`), matching how master-admin access works elsewhere.
* The pre-existing `account_audit_events` (deactivate/reactivate log, 14 rows) was editable by the app role; the migration revokes `UPDATE/DELETE/TRUNCATE` from `authenticated`/`anon` and leaves its writers alone.

### 3.5 Credentials are never stored

* Password events are **event-only**: `field_name`, `old_value`, `new_value` are empty. `encrypted_password` appears in the migration only inside an `IS DISTINCT FROM` comparison (pinned by a test).
* `_uaa_scrub` runs on every JSON column on insert: it **drops** keys that look like secrets (`pass|pwd|secret|token|jwt|otp|hash|api_key|service_role|session|credential|cookie|bearer`) and **redacts** JWT-shaped and bcrypt-shaped *values*.
* Edge functions pass category codes only (`failureReason`), never an upstream message, payload, password or header.
* The UI refuses to render a value for password events even if one existed.

### 3.6 Identity timeline and the name + e-mail warning

* `target_snapshot` is the account's identity **before** the change (name, e-mail, employee id, role, organization). Old rows therefore keep saying "Krish Patel" after the account becomes "Dakshit Prajapati"; nothing is resolved from the current profile when rendering.
* If one save changes **both** the display name **and** the login e-mail of an account that has history (expenses, review entries, balance entries, batches), User Management shows: *"This account already has historical activity. Changing both the user's name and login email may reassign another person's account. Creating a new user is recommended."* with the expense count and account-creation date, and requires an explicit confirmation. The confirmation is recorded as `account_identity_changed` (old values read from the database; declared new values; history counts; confirming admin). A genuine correction is **never blocked**; an unrecorded confirmation is (fail-closed). If the summary RPC is unavailable the warning is still shown.
* Business ownership is untouched: the edit path never writes `expenses.user_id`, `created_by` or `submitted_by`; the auth user id is stable (tested).

### 3.7 Atomicity

* `profiles`, `organization_memberships`, `user_roles`, `team_members`, `engineer_locations`: business write and audit insert are **one transaction**. If the audit insert fails the business change aborts (tested by taking the audit table offline).
* `auth.users` is written by GoTrue / the Auth Admin API (an external service); its trigger **never blocks authentication** — on error it raises a `WARNING` and the auth operation proceeds. Edge functions sequence: validate actor → register context (fail-closed) → Auth API → DB mirror; failures record `*_failed` events (category only). There is no cross-service atomicity and none is claimed.

### 3.8 Backfill policy (hard evidence only)

Done in the migration: (a) the 14 existing `account_audit_events` rows are carried over with their **recorded** actor, `source historical_backfill`, `target_snapshot` **absent** (`snapshot_unavailable`) because the identity at that time is unknown; (b) one `baseline_snapshot` per existing profile (`actor_type migration`, no human) recording state at migration time and stating that earlier history is unavailable.  
**Not done:** GoTrue `audit_log_entries` / Logflare reconstruction, and anything that would name an admin for a past action. That is a separate, evidence-by-evidence step.

## 4) Key files

```
supabase/migrations/20261031100000_user_account_audit_history_v1.sql
supabase/migrations/20261031120000_user_roles_privilege_escalation_fix.sql
supabase/migrations/20261031130000_user_account_audit_denial_snapshot_fix.sql
supabase/tests/user_roles_security/                (baseline + pre/post-fix assertions)
supabase/functions/_shared/accountAudit.ts
supabase/functions/admin-create-user/index.ts
supabase/functions/admin-update-user-email/index.ts
supabase/functions/admin-reset-password/index.ts
supabase/functions/admin-set-user-auth-status/index.ts
supabase/functions/bulk-users-import/index.ts
src/lib/userAccountAudit.ts
src/components/UserAuditHistoryDialog.tsx
src/pages/UserAudit.tsx                       (route /admin/user-audit)
src/pages/UserManagement.tsx                  (Audit History button, User Audit link, name+email warning)
src/components/Layout.tsx                     (self password change registers its context)
src/lib/bulkUsersImportClient.ts              (one batch_id per upload)
supabase/tests/user_account_audit/            (00_harness.sql, 10_audit_test.sql, run.sh)
```

## 5) Database / migrations

Applied to Production **2026-10-24**, in this order, each in its own transaction as `supabase_admin` (the migrations create triggers on `auth.users`), with `lock_timeout` / `statement_timeout` and `ON_ERROR_STOP`:

| # | Migration | Purpose |
|---|---|---|
| 1 | `20261031100000_user_account_audit_history_v1.sql` | audit table, context table, triggers, trusted RPCs, timeline, backfill |
| 2 | `20261031120000_user_roles_privilege_escalation_fix.sql` | closes the `user_roles` / `profiles` privilege escalation (section 10) |
| 3 | `20261031130000_user_account_audit_denial_snapshot_fix.sql` | forward-fix found in review: a denied cross-organization attempt no longer copies the foreign target's identity into the caller's history |

This project applies migrations as manual SQL; `supabase_migrations.schema_migrations` has not been maintained since 2026-06-08, so application was verified **by objects**, not by that table.

**Deploy order (important):** migrations first, then the five edge functions, then the frontend. The edge helper fails closed, so functions deployed *before* the migration would refuse user create / e-mail / reset / ban / bulk import with "Audit trail unavailable".

**Rollback / forward-fix:** the security fix must not be rolled back (it would reopen the escalation). For the audit feature: redeploy the previous functions (`/tmp/rollout/edge_backup` on the host at rollout time, identical to `main` except `bulk-users-import`, see section 11), then `ALTER TABLE ... DISABLE TRIGGER` on the `uaa_*` triggers if ever needed. The audit table itself is append-only and should be kept. Any change is a new forward migration.

---
## 6) Mutation-path inventory (36 paths)

| # | Path | Layer | Covered by |
|---|---|---|---|
| 1–3 | `UserManagement` edit: `profiles` name / e-mail / employee id; supervisor; cashier + cashier engineer / location | browser, user JWT | profiles trigger |
| 4 | `UserManagement` edit: `organization_memberships` role, accountant-cashier | browser, user JWT | memberships trigger |
| 5 | `UserManagement` edit: `engineer_locations` delete + insert | browser, user JWT | engineer_locations trigger |
| 6 | `UserManagement` edit/create: `team_members` delete + insert | browser, user JWT | team_members trigger |
| 7 | `UserManagement` create follow-ups (assigned cashier, supervisor) | browser, user JWT | profiles trigger |
| 8 | `TeamManagementSection` team membership replace | browser, user JWT | team_members trigger |
| 9 | `AdminPanel.updateUserRole` → `user_roles.upsert` (legacy) | browser, user JWT | user_roles trigger (direct writes only) |
| 10 | `Layout` self name change | browser, user JWT | profiles trigger (`self_service`) |
| 11 | `Layout` self password change (`auth.updateUser`) | browser → GoTrue | auth.users trigger + self context |
| 12–13 | `profiles.preferred_language`, `notification_settings` | browser | **excluded** (not account identity; no noise) |
| 14 | `profiles.balance` (admin edit, money functions) | browser / DB functions | **excluded** by design (financial, own ledger) |
| 15 | `admin-create-user` | edge, service role | context by e-mail + id, triggers |
| 16 | `admin-update-user-email` | edge, service role | context + auth.users trigger |
| 17 | `admin-reset-password` | edge, service role | context + auth.users trigger + `admin_password_reset` |
| 18 | `admin-set-user-auth-status` — deactivate / reactivate / retry | edge: DB RPC as caller + service-role ban | JWT actor on membership; context on ban |
| 19 | `bulk-users-import` — create, update, password set, supervisor, location, team | edge, service role | organization-scope context + batch id |
| 20–30 | DB functions: `assign_user_to_organization`, `create_organization_with_admin`, `deactivate_organization_member(_v2)`, `reactivate_organization_member(_v1)`, `undo_organization_member_deactivation`, `handle_new_user`, `sync_user_role_from_membership` (derived, not double-counted), `sync_engineers_with_location_cashier`, `trigger_sync_engineer_on_location_assignment` | database | triggers |
| 31–34 | GoTrue flows with no app code: recovery link, magic link, self e-mail change confirmation, Auth Admin API called elsewhere | auth service | auth.users trigger (unattributed unless a context exists) |
| 35 | Legacy operator scripts at the repo root (`create_master_admin_user.sql`, `assign_cashier_to_location.sql`, `master_migration.sql`, `reset_balances*.sql`, …) and ad-hoc SQL | operator | triggers → recorded as unattributed `database` |
| 36 | Supabase Dashboard edits | operator | triggers → unattributed |

No Master Admin screen mutates users (`MasterAdminDashboard` only toggles organization features). There is no in-app forgot-password screen; recovery goes through GoTrue (row 31).

## 7) Test plan / results

* **Database acceptance (113 assertions, 0 failures)** — `supabase/tests/user_account_audit/run.sh`, on a disposable container of the Production Postgres image (no volume, no published port): create, name / e-mail / employee id / role / team / supervisor / location / cashier changes, deactivate / reactivate, ban / unban, self and admin password events, bulk create + update, service-role path preserving the human, unchanged values not logged, request-id and batch correlation, anti-spoof (non-admin, foreign-org admin, browsers calling trusted RPCs, another user riding a live context), cross-org read blocked, cross-org insert blocked, UPDATE / DELETE / TRUNCATE blocked for admins, service role **and the owner**, historical snapshot preserved after rename, name + e-mail summary and confirmation, historical expense ownership unchanged, no password / hash / JWT in any row, scrubber, audit outage rolls back business writes yet never blocks auth, named-argument RPC compatibility, indexes and grants.
* **Real-schema check:** the migration applies cleanly to a schema-only dump of Production `public` (13 audit triggers created) and a smoke test through the real `handle_new_user`, membership triggers and `assign_user_to_organization` attributes every row to the admin.
* **Vitest:** 87 new tests (helpers and labels in lock-step with the database CHECK lists; edge helper fail-closed / best-effort; structural contract for all five functions; dialog rendering incl. password events and unattributed rows; named-argument parity). Full suite 331 files / 5,419 tests passing.
* TypeScript errors 610 = `main` baseline (0 new); `npm run build`, `migrations:check`, `security:secrets` pass.
* End-to-end through the deployed edge functions on Production with disposable QA users: see section 11. The browser UI (Audit History dialog, User Audit page, name + e-mail confirmation dialog) is verified in the browser after the frontend deploys with the merge.

## 8) Known limitations

1. Attribution of service-role writes depends on a registered context. Writes with none are stored **unattributed** (visible in the UI), not guessed.
2. An organization-scope (bulk) context applies to *all* service-role writes in that organization while it lives (cleared when the import ends; hard cap 15 minutes). A different service-role writer touching the same organization in that window would be attributed to the importer.
3. A normal e-mail change yields **two** `email_changed` events (auth layer by the edge function path, profile mirror by the browser), sharing one request id.
4. The audit table can be disabled by a database superuser (triggers) — retention/archival, if ever needed, must be a separate controlled mechanism.
5. GoTrue re-hashes passwords at sign-in when cost parameters change; that would appear as an unattributed `password_changed` (never with a value).
6. UI is English-only and has no export yet.
7. The `user_roles` / `profiles` privilege-escalation found during review is **fixed** in `20261031120000_user_roles_privilege_escalation_fix.sql` (section 10). One stale legacy `admin` row for an orphan account (no profile, no membership, 2025-12-09) was left in place for the owner to decide.

## 9) Related docs

* [pwa-submit-upload-reliability.md](./pwa-submit-upload-reliability.md) (DOC-157) — FUTURE_PLANS items 30 / 31 originated there.
* `FUTURE_PLANS.md` §30 (now implemented, pending Production migration).

---

## 10) Security fix: privilege escalation through `user_roles` and `profiles` (found 2026-10-24)

**Finding (verified on an isolated copy of the real Production schema, synthetic users only):** the policies were exploitable by any signed-in user.

| # | Path | Effect |
|---|---|---|
| 1 | `Users can insert / update their own roles` on `user_roles` | an employee made themselves `admin` / `cashier` in the legacy role table |
| 2 | `Admins can manage roles` — `has_role(uid(),'admin')`, `ALL`, **not organization-scoped** | that user (or any admin of any organization) could insert, update and delete role rows of users in **every** organization |
| 3 | `Users can update their own profile` has no column limit | an employee set `profiles.is_master_admin = true` on their own row: `is_master_admin()` became true, they saw **all organizations and all profiles** and could insert `master_admin_memberships` (full tenant takeover) |
| 4 | same policy | an employee edited their own balance, supervisor, cashier assignment, employee id, e-mail and active flag |
| 5 | `Admins can update any profile`, `Cashiers can update managed profiles` | an org admin or a cashier could flip `is_master_admin` on other users |
| 6 | `admin_reset_user_password()` (dead code, executable by `anon`/`authenticated`) | any legacy admin could read any user's e-mail across organizations |

**No evidence of exploitation** was found in Production (one master admin, the original from 2025-12-27, matching its membership row; no self-invited memberships; `user_roles` agrees with memberships except one orphan row from 2025-12-09).

**Fix (new migration, no applied migration edited):**
* drop the three unsafe `user_roles` write policies; the existing org-scoped restore INSERT/UPDATE policies stay; add an org-scoped DELETE; SELECT policies untouched;
* revoke `anon` write privileges and `TRUNCATE` (which bypasses RLS) on the identity tables;
* revoke API access to `admin_reset_user_password` (no caller; `service_role` keeps it);
* `BEFORE INSERT OR UPDATE` trigger `aaa_guard_profile_privileged_columns` on `profiles`, active **only for direct API callers** (`current_user` = `authenticated`/`anon`): only a master admin may change `is_master_admin` or `organization_id`; a non-admin editing their **own** profile may change name, language and notification settings only. SECURITY DEFINER money RPCs, `service_role` edge functions and operators are unaffected.

**Verification:** `supabase/tests/user_roles_security/run.sh` — 67 assertions on a disposable container: the vulnerabilities **reproduce on Production's verbatim policies** (baseline), then are closed after the migration, with legitimate flows (self name/language, org-admin role and profile edits, membership role changes via the sync trigger, service role, definer money RPC, cashier-managed edits) preserved, organization isolation, and idempotent re-run. The same attack matrix on a schema-only copy of Production gave identical results with the audit migration applied first.

**Residual (not changed):** `user_roles` SELECT policies remain readable across organizations by legacy admins/cashiers (metadata only); `system_config` / `money_assignments` still authorize through the global `has_role(...)` on legacy tables (now unreachable by self-promotion); a master admin has no implicit write on other organizations' role rows (by design).

## 11) Production rollout record (2026-10-24)

1. **Pre-flight:** nothing of this feature present; no name collisions; all required tables / functions present; rollback artifacts saved on the host (`/tmp/rollout`: prior `user_roles` policies, prior `admin_reset_user_password`, schema of the identity tables).
2. **Database:** migrations 1 → 2 → 3 applied. Verified by objects: both audit tables with RLS on; 11 audit triggers on `profiles`, `organization_memberships`, `user_roles`, `team_members`, `engineer_locations`, `auth.users` plus the 2 append-only guards; the trusted RPCs executable by `service_role` only; `authenticated` holds `SELECT` only on the audit table. 14 legacy rows carried over and 537 baseline snapshots written. As real roles inside rolled-back transactions: forged INSERT, UPDATE, DELETE, TRUNCATE blocked for `authenticated`, UPDATE / DELETE / INSERT blocked for `service_role`, UPDATE / DELETE / TRUNCATE blocked even for the owner; a QA-org admin sees only their own organization's rows; the master admin sees all (intended scope).
3. **Security fix verified on Production** with disposable QA users in rolled-back transactions: every escalation attempt blocked (section 10), self-service edits (name / language) still allowed.
4. **Edge functions:** `_shared/accountAudit.ts` and `admin-create-user`, `admin-update-user-email`, `admin-reset-password`, `admin-set-user-auth-status`, `bulk-users-import` deployed to the Production edge container after backing up the previous files. Four were byte-identical to `main` before the deploy. **`bulk-users-import` in Production was an older build than `main`** (it lacked main's already-merged duplicate-profile `limit(1)` fix and the `profile_patch_failed` handling), so this deploy also ships those two fixes.
5. **Production QA** (disposable users in the QA test organization only; audit rows are never deleted): create, name, e-mail (auth + profile layers), role, supervisor / team / location, deactivate, reactivate, admin password reset, name + e-mail with history, anti-spoof (body-supplied actor ignored), non-admin refused, cross-organization refused and recorded without the foreign identity, timeline, cross-organization read blocked, tamper attempts refused, no password / hash / JWT in any audit row; bulk import (dry run writes nothing; per-user events share one batch id; organization context cleared afterwards; update path audited). The QA users remain, named *Audit QA …* / *Bulk QA …* with `@example.invalid` addresses in the QA test organization; their audit history is permanent by design.

---
## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-10-24 | 1.0 | Claude Code | Initial implementation: table, triggers, trusted-actor plumbing, edge functions, timeline, warning, Audit History UI, tests, docs. Migration prepared, not applied. |
| 2026-10-24 | 1.1 | Claude Code | Security review: user_roles / profiles privilege escalation found, reproduced on the real schema, fixed in `20261031120000_user_roles_privilege_escalation_fix.sql` with a 67-assertion regression suite. |
| 2026-10-24 | 1.2 | Claude Code | Rolled out: migrations 1-3 applied to Production, five edge functions deployed, Production QA passed. Forward-fix for foreign-target snapshot in denial events. Rollout record (section 11). |
| 2026-10-24 | 1.3 | Claude Code | PR #26 merged, Production frontend deployed. Post-merge check: the exact data calls of the Audit History dialog / User Audit page as the QA org admin (harmless name change and its revert, both audited as separate events; org-wide listing and filters; no cross-organization rows). FUTURE_PLANS.md §30 -> IMPLEMENTED — PRODUCTION. |
