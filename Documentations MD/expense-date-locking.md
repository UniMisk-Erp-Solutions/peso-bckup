# Expense Date Locking

**Doc ID:** DOC-138
**Status:** in progress
**Branch:** `hotfix/date-lock-and-tally-debit` (PR [#7](https://github.com/Mithil1105/peso-patidar/pull/7), not merged)
**Last updated:** 2026-10-01
**Revision:** 2.0 — see Revision History

## Summary

Lets an organization admin block NEW expense submissions / expense-date
changes for a chosen single date, month, or custom date range (e.g. "books
closed for August"). Gated end-to-end by the existing
`organization_features` framework (key: `expense_date_locking`, Master
Admin toggled, same convention as every other feature flag in
`src/lib/organizationFeatureKeys.ts`). The UI disables locked dates in the
date picker for UX (an employee should never fill out a whole form only to
be rejected at Submit), while a database trigger enforces the actual
*submission business event* server-side, so a stale client, a direct API
call, or any future write path cannot bypass the lock. Draft creation
remains allowed regardless of a lock; the lock is checked specifically
when an expense becomes `'submitted'`.

## Original Problem

Admins need a way to close a period (commonly a month, at accounts-close
time) to new expense submissions. Nothing in PesoWise previously prevented
an employee from submitting an expense dated inside a period the business
considers closed.

## Previous Behavior

No concept of a locked period existed at all. Any expense date was
acceptable at any time, in every state (draft, submission, edit).

## Root Cause

Not a bug fix — a net-new capability requested by the business. (The one
genuine *implementation* bug found and fixed during this feature's own
review is covered under rev 2.0 below: the first version of the
enforcement trigger was broader than the actual requirement.)

## Requirements

- Admin can define one or more locked date ranges (single date, month
  shortcut, or custom From/To) per organization, each with an optional
  reason.
- Admin can deactivate (unlock) a range; history is preserved, not
  deleted.
- While a range is active and the feature is on, employees cannot select
  a date inside it in the date picker, and cannot submit an expense dated
  inside it by any other path either.
- Existing/historical expenses already dated inside a range that is
  locked *afterward* are never touched, altered, or retroactively
  invalidated.
- Feature OFF ⇒ behavior is byte-for-byte unchanged, even if lock rows
  exist in the table.

## Architecture

```
Employee/Admin                         Database (source of truth)
───────────────                        ───────────────────────────
Calendar.disabled ──reads──> useExpenseDateLocks() ──reads──> organization_expense_date_locks
      │                              │  (only when flag ON)         │ (RLS: org members SELECT,
      │                              ▼                               │  org admins INSERT/UPDATE)
      │                      isExpenseDateLocked()                   │
      │                      (pure client check,                    ▼
      │                       UX only)                    is_expense_date_locked_v1(org, date)
      │                                                     (flag check + active-range check,
      ▼                                                      SECURITY DEFINER, reused below)
Pre-submit toast/inline message                                      │
(friendly error, UX only)                                            ▼
                                                     trg_enforce_expense_date_lock
                                                     BEFORE INSERT OR UPDATE ON expenses
                                                     (THE REAL, UNBYPASSABLE GATE)
```

The client-side path (date-picker disabling + friendly pre-submit
message) and the server-side path (the trigger) are two independent
implementations of the same rule, deliberately: the client path exists
purely for UX; removing it would not weaken security at all, because
every write still passes through the trigger regardless of which
screen, RPC, or external tool performed it.

## Data Flow

1. Admin opens Settings → `ExpenseDateLockSection` (visible only when
   `expense_date_locking` is enabled and the viewer is an org admin) →
   calls `create_expense_date_lock_v1` → new row in
   `organization_expense_date_locks`.
2. Any screen that needs "is this date locked" calls
   `useExpenseDateLocks()` (fetches active-org rows only when the flag is
   on) and `isExpenseDateLocked(date, locks)` (pure range check).
3. On an actual write to `expenses` (INSERT or UPDATE, from any
   source), `trg_enforce_expense_date_lock` evaluates whether this
   specific write is a submission event (see "Business Rules" below) and,
   if so, calls `is_expense_date_locked_v1(organization_id, trip_start)` —
   which itself first checks the feature flag via the existing
   `get_organization_feature_enabled` RPC, then an active range — and
   raises an exception if locked.

## Frontend Changes

- `src/lib/expenseDateLocks.ts` (new): `isExpenseDateLocked(date, locks)`
  — the ONE canonical client-side range check every screen must use (no
  screen re-derives its own range logic); `fetchExpenseDateLocks` /
  `fetchExpenseDateLocksResult` (rev 2.0: the latter distinguishes "zero
  locks" from "fetch failed", see rev 2.0 below).
- `src/hooks/useExpenseDateLocks.ts` (new): fetches active-org locks only
  when the feature flag is on; exposes `{ locks, loading, error, enabled }`.
- `src/pages/ExpenseForm.tsx`, `src/pages/ExpenseBatchForm.tsx`:
  `Calendar`'s own `disabled` prop now also disables locked dates
  (alongside the pre-existing future-date rule); a pre-save/pre-submit
  check surfaces a friendly, i18n'd message
  (`"This expense date is closed for submission."`, optionally with the
  admin's reason) instead of letting the request reach the server and
  fail with a raw error.
- `src/components/ExpenseDateLockSection.tsx` (new): org-admin UI in
  Settings — month shortcut or custom From/To + optional reason → "Lock
  Dates"; existing ranges listed with Active/Inactive status and an
  Unlock action. Rendered in `src/pages/Settings.tsx` and
  `src/components/mobile/MobileSettingsView.tsx`.

## Backend Changes

- `public.is_expense_date_locked_v1(p_organization_id, p_expense_date)` —
  `STABLE SECURITY DEFINER`. Single source of truth for "is this date
  blocked for this org right now"; reused by the trigger and available to
  any future RPC/report needing the same answer.
- `public.trg_enforce_expense_date_lock()` / trigger
  `enforce_expense_date_lock` — `BEFORE INSERT OR UPDATE ON public.expenses
  FOR EACH ROW`. See "Business Rules" for the exact condition.
- `public.create_expense_date_lock_v1(p_organization_id, p_date_from,
  p_date_to, p_reason)` — `SECURITY DEFINER`; explicitly re-checks
  `is_org_admin(p_organization_id)` (defense in depth alongside RLS, same
  posture as `create_backup_export_job_v1` elsewhere in this codebase);
  validates `date_from <= date_to`.
- `public.deactivate_expense_date_lock_v1(p_lock_id)` — `SECURITY
  DEFINER`; derives `organization_id` from the lock row itself, THEN
  checks `is_org_admin()` against that organization — an admin of a
  different org can never pass this check regardless of which lock id
  they supply.

## Database Changes

New table `public.organization_expense_date_locks`:

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | `gen_random_uuid()` |
| `organization_id` | uuid NOT NULL | FK → `organizations(id)`, `ON DELETE CASCADE` |
| `date_from` | date NOT NULL | |
| `date_to` | date NOT NULL | `CHECK (date_from <= date_to)` |
| `reason` | text | nullable |
| `is_active` | boolean NOT NULL DEFAULT true | deactivated, never deleted, to preserve audit history |
| `created_by` | uuid | FK → `auth.users(id)`, `ON DELETE SET NULL` |
| `created_at` / `updated_at` | timestamptz NOT NULL | |

Indexes: `(organization_id)`; a partial index `(organization_id,
date_from, date_to) WHERE is_active = true` supporting the trigger's own
lookup without a sequential scan as an organization accumulates history.

## Feature Flags

`expense_date_locking` — added to `ORGANIZATION_FEATURE_KEYS` /
`MASTER_ADMIN_FEATURE_DEFINITIONS` in `src/lib/organizationFeatureKeys.ts`.
Toggled by Master Admin exactly like every other entry in that file; no
second flag framework built. OFF ⇒
`is_expense_date_locked_v1` returns `false` immediately (short-circuits
before even checking for a range), so behavior is unchanged even with
lock rows present.

## Security / Permissions / RLS

- RLS SELECT: any active member of the organization (the employee-side
  date picker needs to read active ranges).
- RLS INSERT/UPDATE: `is_org_admin(organization_id)` only.
- Both mutation RPCs re-check `is_org_admin()` explicitly as a second,
  defense-in-depth gate independent of RLS (the same posture used
  throughout this codebase for admin-mutating RPCs).
- `deactivate_expense_date_lock_v1` cannot be used cross-organization:
  the organization is derived from the lock row itself before the admin
  check runs, not trusted from caller input.
- The trigger function is `SECURITY DEFINER` so it can read
  `organization_features`/`organization_expense_date_locks` regardless of
  the writing role's own RLS visibility — it is a backstop, not a
  convenience.

## Business Rules

**Exact expense status lifecycle audited** (from
`20251005171552_...` + `20260513139900_...` + `20260524250000_...`):
`draft, submitted, under_review, verified, level_1_verified,
level_2_verified, approved, rejected, paid, edited`. Per the existing
state-machine invariant (`20260907220000_expense_state_machine_and_transaction_number_integrity.sql`),
`draft`/`rejected`/`edited` are the pre-submission "editing" states;
`submitted` is the *only* legal gateway into the protected review
workflow (`under_review`/`verified`/.../`approved`/`paid`) — nothing ever
enters a protected state except via `submitted` first.

**Write paths audited** (every `INSERT INTO public.expenses` and every
`UPDATE ... status` across `src/services`, `src/lib`, `src/pages`, and
`supabase/migrations/*.sql`):

| Path | Inserts as | Notes |
|---|---|---|
| `ExpenseService.createExpense()` (single expense) | `draft` | "Create first, then submitExpense() will move it to submitted" — the actual submission is a SEPARATE later UPDATE. |
| `ExpenseService.submitExpenseBatch()` (batch) | `draft` per line | Same two-step shape — reuses `createExpense()`, then calls `submitExpense()` per line. |
| `admin_submit_expense_for_employee_v2` (admin submits for an employee) | **`submitted` directly** | Migration's own comment: "Create the expense as 'submitted'". A genuine, live, user-facing action — must respect the lock exactly like a self-submission. |
| MicroLink atomic submission RPC (`p_action='submit'`, new row) | **`submitted` directly** | `v_status := CASE WHEN p_action='submit' THEN 'submitted' ELSE 'draft' END`. Same reasoning as above. |
| Review/approval RPCs (`review_approve_expense_manager_override_v1`, `review_admin_verify_expense`, `review_approve_expense_v2`, etc.) | n/a (UPDATE only) | Only ever move an ALREADY-submitted row PAST `submitted` (`submitted → under_review → ... → approved/paid`). `NEW.status` is never `'submitted'` again for these. |
| Admin correction (`allow_manager_admin_expense_corrections`) | n/a (UPDATE only) | Sets `status='edited'`, never keeps `'submitted'`. |

**Final trigger condition** (`trg_enforce_expense_date_lock`):

```sql
IF NEW.status = 'submitted' AND (
     TG_OP = 'INSERT'
     OR OLD.status IS DISTINCT FROM NEW.status
     OR OLD.trip_start IS DISTINCT FROM NEW.trip_start
   )
THEN
  IF is_expense_date_locked_v1(NEW.organization_id, NEW.trip_start) THEN
    RAISE EXCEPTION ... ERRCODE 'PW010';
  END IF;
END IF;
```

In plain terms: the lock is checked only for the exact moment a row
*becomes* `'submitted'` as a direct result of this write — a fresh INSERT
already at `'submitted'` (admin-submit-for-employee, MicroLink), a
transition INTO `'submitted'` from `draft`/`rejected`/`edited` (normal
create-then-submit flow, and resubmission of a rejected/corrected row,
**including a draft created before the lock existed but submitted
after**), or a `trip_start` change on a row that remains submitted.

**Why unconditional INSERT blocking was rejected:** the first version of
this trigger blocked *every* INSERT with a locked `trip_start` regardless
of status — broader than the real requirement, and would have incorrectly
blocked a brand-new `draft` (which is never itself a submission) or any
future historical-backfill/restore INSERT. Found and corrected during
PR #7's review (see rev 2.0).

**Why unrelated review transitions remain unaffected:** structurally, not
by a special-cased exclusion — `NEW.status` is never `'submitted'` again
once a row has left it for `under_review`/`verified`/`approved`/etc., so
the trigger's own top-level condition never evaluates true for those
rows.

## Validation / Error Handling

Client: Zod-validated form fields; the date-lock pre-submit check throws
a plain `Error` with the friendly i18n message, caught by the existing
save/submit error-handling path (same pattern as every other client-side
validation in `ExpenseForm.tsx`/`ExpenseBatchForm.tsx`).
Server: `RAISE EXCEPTION ... USING ERRCODE = 'PW010', DETAIL =
'EXPENSE_DATE_LOCKED'` — a stable, grep-able error code for any caller
(including a future dedicated error-mapping layer) to recognize.

## Edge Cases

- A draft created **before** a lock existed, submitted **after** the lock
  now exists → blocked (the lock applies at submission time, not
  creation time).
- An expense corrected by an admin (→ `edited`) then resubmitted while a
  lock is active → blocked (same as any other resubmission).
- A plain re-save of an already-submitted expense (no status change, no
  `trip_start` change) while a lock now covers its date → **not**
  re-checked; a lock created after legitimate submission never
  retroactively blocks unrelated housekeeping writes to that row.
- A `trip_start` change on an already-submitted expense → blocked if the
  new date is locked (moving an existing submission's date must respect
  the *current* lock state).
- Multiple overlapping/adjacent lock ranges for the same org → each
  enforced independently; a date needs to fall in only one active range
  to be blocked.
- An inactive (`is_active=false`) lock never blocks anything.

## Cross-Organization Safety

- RLS scopes every row read/write to `organization_memberships`/
  `is_org_admin()` for that specific `organization_id` — never a global
  check.
- `deactivate_expense_date_lock_v1` derives the organization from the
  target row itself before authorizing, so passing another org's lock id
  cannot succeed regardless of the caller's own org admin status
  elsewhere.
- `is_expense_date_locked_v1` and the trigger both scope strictly to
  `NEW.organization_id` — a lock on Org A can never affect Org B.
- **Requires live/staging database verification** — this specific
  boundary (RLS + `is_org_admin()`) cannot be exercised by this repo's
  Vitest unit tests (no sandboxed Postgres in this environment); see
  "Tests Added" below for exactly what WAS and was NOT proven by
  automated tests.

## Migration Details

**File:** `supabase/migrations/20261018100000_expense_date_locking_v1.sql`

**Objects created:** table `organization_expense_date_locks` (+ 2
indexes, RLS policies `expense_date_locks_select` /
`expense_date_locks_admin_write`); functions
`is_expense_date_locked_v1`, `trg_enforce_expense_date_lock`,
`create_expense_date_lock_v1`, `deactivate_expense_date_lock_v1`;
trigger `enforce_expense_date_lock` on `public.expenses`.
**Grants/revokes:** table access revoked from `PUBLIC`/`anon`, granted
`SELECT, INSERT, UPDATE` to `authenticated` (RLS still governs row
visibility/mutation); all four functions revoked from `PUBLIC`, granted
`EXECUTE` to `authenticated` (`is_expense_date_locked_v1` also to
`service_role`).
**Compatibility:** purely additive — a new table, new functions, one new
trigger on an existing table. No existing column, function, or trigger is
altered or dropped.

**Status: WRITTEN. NOT tested locally against a live database (no
sandboxed Postgres in this session's environment). NOT tested on
staging. NOT applied to production.** The only verification performed
against this SQL is: (a) the `DO $verify$` block inside the migration
itself, which only runs *if and when the migration is applied* and has
not been applied anywhere yet; (b) a hand-maintained pure TypeScript
mirror of the trigger's own condition, unit-tested in this repo's Vitest
suite (see "Tests Added"). **Do not represent this migration as proven
against a real database until it has actually been applied to one and
the documented verification steps below have been run.**

## Feature Flags

(see "Feature Flags" above — kept as one section per this doc's layout;
not duplicated content, just cross-referenced here for readers scanning
by the requested template order.)

## Deployment Requirements

1. Apply `20261018100000_expense_date_locking_v1.sql` to the target
   database (manual `psql`/Supabase CLI — this repo's convention is
   filename-only reference in docs, never an auto-apply step).
2. Confirm the migration's own `DO $verify$` block printed
   `NOTICE: expense_date_locking_v1 migration verified OK` and did not
   raise.
3. Enable `expense_date_locking` for the intended organization(s) via
   Master Admin.
4. No Edge Function redeploy or worker restart is required — this
   feature has no Edge Function or background-worker component.

## Rollback / Disable Strategy

- **Soft disable (no DB change, reversible instantly):** turn the
  `expense_date_locking` feature flag OFF in Master Admin for the
  affected organization(s). `is_expense_date_locked_v1` short-circuits to
  `false` immediately; the trigger stops blocking anything for that org
  while existing lock rows are preserved untouched, ready to re-apply
  the moment the flag is turned back on.
- **Full rollback (removes the capability entirely):** `DROP TRIGGER
  enforce_expense_date_lock ON public.expenses;` then drop the four new
  functions and the `organization_expense_date_locks` table. Safe at any
  time: nothing else in the schema references these objects (purely
  additive migration, confirmed above).
- No data migration/backfill is needed either direction — the table only
  ever holds admin-created lock rows, never expense data.

## Tests Added

`src/lib/__tests__/expenseDateLocking.test.ts` (19 tests, **pure unit
tests** — no database involved) + `src/lib/expenseDateLockTriggerLogic.ts`
(the hand-maintained pure mirror of the trigger's own condition these
tests exercise). Covers: feature OFF never blocks; a genuinely submitted
expense inside an active range is blocked; a draft created before a lock
then submitted after is blocked; a non-submitted INSERT inside a locked
range is NOT blocked; unrelated review-status transitions are
structurally unaffected; an inactive lock never blocks; range boundaries
(`date_from`/middle/`date_to` exactly, the day before/after); multiple
independent ranges.

**Explicitly NOT covered by any automated test in this repository, and
requiring live/staging database verification before this is relied upon
in production:** cross-organization isolation via RLS/`is_org_admin()`;
the feature-flag gate as implemented inside
`get_organization_feature_enabled`/`is_expense_date_locked_v1` itself (the
"feature OFF" test above simulates this at the CLIENT layer only, which
is the real shipped behavior for the UI but is not the same as proving
the SQL function returns `false` when the flag is off); the trigger
actually firing/blocking against a real Postgres instance (the test suite
exercises a TypeScript mirror of its condition, never the live trigger
itself — there is no sandboxed Postgres in this environment to run a real
SQL integration test against).

## Verification Results

`npx tsc -p tsconfig.app.json --noEmit`: 620 errors, matching `main`'s own
pre-existing baseline exactly — 0 new. `npx vitest run`: 4640/4641 (1
pre-existing, confirmed-unrelated `MaintenanceAdminDashboard` parallel-
suite timing flake, 11/11 passing in isolation). `npm run build`: clean.
`npm run migrations:check`: clean (275 `.sql` files scanned). `npm run
security:secrets`: clean. No real/staging database was reached during
this feature's development — see "Migration Details" above for the exact
status this implies.

## Known Limitations

- Cross-organization isolation and the SQL-side feature-flag gate are
  unverified against a live database (see "Tests Added"/"Migration
  Details").
- A future Backup/Restore integration (currently isolated on
  `integration/backup-restore-v2-ready`, not part of this branch) that
  bulk-inserts historical expense rows already at a protected status
  (e.g. a restored `submitted` row) would, under this trigger's rule,
  still be subject to whatever lock state is active at restore time.
  This is not applicable today (no such code exists on this branch), but
  is written down for whoever integrates that branch: the restore
  transaction should run with `SET LOCAL session_replication_role =
  replica;` (or explicitly disable `enforce_expense_date_lock` for its
  own transaction) — the standard, zero-risk Postgres pattern for a bulk
  loader bypassing per-row business-rule triggers.
- No UI surfacing yet for "how many existing expenses already fall
  inside a range you are about to lock" at lock-creation time (not part
  of this task's scope; the feature intentionally never touches existing
  rows regardless).

## Files Changed

- `supabase/migrations/20261018100000_expense_date_locking_v1.sql` (new)
- `src/lib/organizationFeatureKeys.ts`
- `src/lib/expenseDateLocks.ts` (new)
- `src/lib/expenseDateLockTriggerLogic.ts` (new, rev 2.0)
- `src/hooks/useExpenseDateLocks.ts` (new)
- `src/components/ExpenseDateLockSection.tsx` (new)
- `src/pages/ExpenseForm.tsx`, `src/pages/ExpenseBatchForm.tsx`
- `src/pages/Settings.tsx`, `src/components/mobile/MobileSettingsView.tsx`
- `src/locales/{en,gu,hi}/master.json`, `src/locales/{en,gu,hi}/expenses.json`, `src/locales/{en,gu,hi}/settings.json`
- `src/lib/__tests__/expenseDateLocking.test.ts` (new, rev 2.0)

## Revision History

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-10-01 | 1.0 | Claude Code | Initial implementation: table, canonical SQL check, enforcement trigger (first version — blocked every INSERT regardless of status, later found too broad), admin RPCs, client helper/hook, UX wiring, admin Settings UI. `hotfix/date-lock-and-tally-debit`, not merged. Migration WRITTEN only, never applied anywhere. |
| 2026-10-01 | 2.0 | Claude Code | **Review-fix pass** (ChatGPT review of PR #7, commit `ade11d7`): tightened the enforcement trigger from "every INSERT" to the actual submission business event (`NEW.status='submitted'` AND a fresh arrival), after auditing every real write path into `expenses` on this branch (see "Business Rules" table above — this audit is what the table reflects). Documented the Backup/Restore impact (not applicable today; written guidance for future integration, see "Known Limitations"). Fixed a stale-`loading` bug and added a distinguishable `error` state to `useExpenseDateLocks.ts` (new `fetchExpenseDateLocksResult()`). Moved `ExpenseDateLockSection.tsx`'s hardcoded English into the `settings` i18n namespace. Added 19 automated contract tests. Corrected this doc's own migration header, which had mismatched the DOC ID as DOC-139 (canonical index already registered this as DOC-138; no new ID allocated). This revision also expanded the document itself to the project's full feature-documentation template (Previous Behavior / Root Cause / Architecture / Data Flow / Business Rules / Edge Cases / Cross-Org Safety / Migration status WRITTEN-vs-TESTED-vs-DEPLOYED-vs-PRODUCTION-APPLIED / Rollback strategy / Known Limitations), after a documentation-completeness review found the rev 1.0 doc, while accurate, omitted several of these explicitly. Migration status unchanged: still WRITTEN only, never applied to any database. Tally (DOC-105) is a separate, unrelated change in the same branch and was not touched by this revision. Still not merged — PR #7. |
