# DOC-082 — Security Sweep & Merge Readiness

**Last updated:** 2026-08-02
**Status:** deployed (audit complete)
**Verdict:** **NO-GO**
**Related:** [DOC-080](./debug-review-expenses-manual-employee-search.md), [DOC-081](./review-actions-staging-plan.md)

> This document contains **no secret values**. Credentials are referenced only by
> category, path, and truncated SHA-256 fingerprint, which cannot be reversed.

---

## 1. Scope and audited SHAs

| | |
|---|---|
| Repository | `Mithil1105/peso-patidar` (private, HTTPS remote, no embedded credentials) |
| Audited branch | `dev` @ `854c092ac2f62064cf050a274649bb14e3efee67` |
| Target branch | `main` @ `2f23854426147e2403306999d9e44741f145548d` (unmodified) |
| Merge base | `2f23854` — equals `main` |
| Ahead / behind | **26 ahead, 0 behind** |
| Diff surface | 167 files, +25,463 / −185 |
| Refs scanned | 9 refs, 0 tags, 0 `refs/original` |
| Reachable objects | 5,498 with paths; 3,095 blobs scanned |

Working tree at audit time: only `.mcp.json` and `CODEX_PROJECT_NOTES.md`
untracked, both intentionally excluded. No HAR, export, dump or `.env` staged.

### Tools used / unavailable

| Tool | Status |
|---|---|
| `secretsRegression.test.ts` | run — 12/12 pass |
| Custom all-ref blob scanner (9 credential classes) | run |
| Bundle scanner over `dist/` (10 classes) | run |
| `npm audit`, `--omit=dev`, `audit signatures` | run |
| `tsc`, `typecheck:api`, `build`, `migrations:check`, `vitest`, `eslint` | run |
| **gitleaks / trufflehog** | **unavailable** — not installed; policy forbids `curl \| sh`. Compensated with the custom all-ref scanner below. Coverage limitation recorded. |
| **GitHub branch protection / secret scanning / Dependabot** | **not inspectable** — no GitHub MCP or API token in this environment. Reported as unknown, not as passing. |
| **Live database RLS / SECURITY DEFINER runtime inspection** | **not performed** — no database credentials available in this environment. Static SQL review only. |
| **Runtime tenant-isolation and controlled-action tests** | **not performed** — Preview is behind Vercel SSO; entering credentials is out of scope for an agent. |

---

## 2. Findings by severity

| ID | Sev | Title | Introduced by dev? | Status |
|----|-----|-------|--------------------|--------|
| **P0-1** | **P0** | 208 employee records with plaintext passwords tracked in the current tree | **No** — also on `main` + 3 branches | **OPEN — blocking** |
| **P1-1** | **P1** | 14 production dependency advisories (1 critical, 11 high) | No — lockfile unchanged by dev | **OPEN — needs owner acceptance or fix** |
| **P1-2** | **P1** | dev Preview mutates the **Production** database | Yes (flags) | **OPEN — control required** |
| **P2-1** | P2 | Historical `.env` with a Postgres DSN + DB password reachable in history | No | Rotated per owner; purge recommended |
| **P2-2** | P2 | No CI: no `.github/workflows`, so no enforced security gate | No | Recommendation |
| **P3-1** | P3 | Migration `20260802030000` committed but unapplied | Yes | Expected; gated |

### P0-1 — Plaintext employee credentials in the tracked tree

- **Path:** `scripts/data/microlink-remove-employees.tsv`
- **Fingerprint (SHA-256, truncated):** `7fe96a80816ee867`
- **Content:** 208 data rows × columns `name, employee_id, position, password,
  immediate_supervisor_employee_id, location`. **208 of 208 rows carry a password
  value; 126 are distinct.** The values follow a short formulaic scheme derived
  from the employee's own name, so they are guessable in bulk even without the
  file — rotation to another value under the same scheme would not remediate.
- **Also a personal-data export:** names, employee IDs, supervisor mappings and
  work locations for the whole organization.
- **Reach:** introduced in `b53691a6567c`; present in the current tree of `dev`,
  `main`, `fix/review-expense-complete-loading`,
  `safety/feature-before-backup-rollback`, `safety/main-before-backup-rollback`.
  Single commit — no later modification.
- **Not introduced by dev.** Merging dev does not worsen it, but the merge gate
  requires it resolved.
- **Code dependencies:** referenced by `scripts/generate-link-microlink-supervisors-sql.mjs`,
  `scripts/generate-microlink-import-csv.mjs`,
  `scripts/generate-remove-org-employees-sql.mjs`. Deleting the data file alone
  breaks all three, which is why this audit did **not** remove it unilaterally.

**Remediation (owner-approved, coordinated — do not split):**
1. Confirm every one of the 208 accounts was reset to a value **not** derivable
   from the old scheme. Password *rotation* is insufficient if the new value
   follows the same formula.
2. Delete the TSV and the three generator scripts (one-off onboarding tooling,
   no runtime dependency).
3. Purge from history — see §5.
4. Empty `KNOWN_EXPOSURES` in `src/__tests__/credentialDataFiles.test.ts`.

### P1-1 — Production dependency advisories

`npm audit --omit=dev`: **moderate 2, high 11, critical 1 (total 14).**
Critical: `jspdf` (direct). High direct: `postcss`, `react-router-dom`, `xlsx`.
High transitive: `@remix-run/router`, `brace-expansion`, `glob`, `lodash`,
`minimatch`, `picomatch`, `react-router`, `ws`.

All-dependency total: 25 (4 critical, 17 high, 4 moderate).

`git diff origin/main..origin/dev -- package.json package-lock.json` is **empty** —
inherited from `main`, not introduced by this branch. Not fixed here: the gate
forbids `npm audit fix --force` and sweeping upgrades, and `xlsx`/`jspdf` handle
untrusted spreadsheet and PDF generation paths where a silent major bump is its
own risk. Requires an explicit remediation pass or a documented owner acceptance.

**Supply chain otherwise clean:** 613 packages with verified registry signatures,
52 with attestations; no `preinstall`/`postinstall`/`prepare` lifecycle script in
`package.json`; no dependency sourced from a git URL, tarball URL or `file:`.

### P1-2 — Preview writes to Production

`VITE_REVIEW_EXPENSES_SERVER_ACTIONS_ENABLED=true` is set on the `dev` Preview,
and the Preview points at the Production PesoWise database. Any Verify / Approve
/ Reject / Correct issued from the Preview URL is a **Production mutation**.

Compensating controls confirmed: Vercel SSO deployment protection is active
(anonymous `/review` redirects to a Vercel login), env vars are **branch-scoped
to `dev`** (so an arbitrary branch or fork Preview does not receive them), and
`VITE_DEBUG_REVIEW_ACTIONS_ENABLED=false`.

Residual risk: anyone with Vercel team access plus an application login can
mutate Production from a URL that reads as non-production. Choose one before
merge: disable actions on Preview, provision a staging database, or document the
exposure with named authorized operators.

---

## 3. Clean results

### Current-tree secret scan — PASS (except P0-1)
`secretsRegression.test.ts` 12/12. Independent scan of all tracked files for SSH
passwords, DB passwords, inline-credential DSNs, service-role JWTs, `sb_secret_`
keys, GitHub/Vercel tokens, SMTP credentials, PEM blocks, AWS keys and
basic-auth URLs: **no match**. `scripts/_ssh_credentials.py` resolves from
environment only, with no literal fallback. `scripts/sync-microlink-passwords*.mjs`
read `process.env.SUPABASE_SERVICE_ROLE_KEY` — no embedded value. `backup.sql` is
tracked but **empty (0 bytes)**.

### Browser-bundle scan — PASS
101 files in `dist/`. One JWT found, in two chunks, identical
(`fp=e3d47d49d9fa`, 169 chars). Decoded header/claims: **`role: anon`**,
`iss: supabase` — the publishable key, expected in a browser bundle. **No**
service-role key, secret key, database password, SSH credential, Vercel token,
GitHub token or SMTP secret. All 22 `VITE_*` variables referenced in source are
public by design (URLs, feature flags, analytics IDs, Turnstile site key).

### Full-history scan — findings are historical infrastructure only
Across all 9 refs / 3,095 blobs: `pg_dsn_pw` (31 distinct) and `db_pw_assign`
(1 distinct), confined to `.env`, `.env.example` and
`scripts/BACKUP-INSTRUCTIONS.md`. **`.env` is not in the current tree of any
ref** (4 commits, 2025-12-09 → 2026-06-16) and is `.gitignore`d. `.env.example`
matches are placeholder templates. No service-role JWT, private key, GitHub
token, AWS key or SMTP credential in any reachable blob. No `refs/original`, no
tags.

**Category split:** (A) rotated infrastructure credentials — `.env`,
`BACKUP-INSTRUCTIONS.md`; (B) potentially active/reused — none identified beyond
P0-1; (C) plaintext user passwords — **P0-1**; (D) personal-data exports —
**P0-1**; (E) placeholders — `.env.example`.

### SECURITY DEFINER audit — PASS (static)
All seven review-queue migrations parsed and each `SECURITY DEFINER` function
matched against its own `REVOKE … FROM PUBLIC`:

| Migration | DEFINER fns | Missing REVOKE PUBLIC |
|---|---|---|
| `20260801120000` | 2 | none |
| `20260801130000` | 5 | none |
| `20260801140000` | 7 | none |
| `20260801150000` | 7 | none |
| `20260802010000` | 5 | none |
| `20260802020000` | 4 | none |
| `20260802030000` | 3 | none |

**33/33** carry `SET search_path = ''`, revoke PUBLIC **and** `anon`, and grant
`authenticated` only. **Zero `GRANT … TO anon`** in any dev migration. Every
table-reading function asserts an active reviewer membership via
`_debug_review_assert_reviewer_v1` and scopes by `p_organization_id`.
Caller-supplied UUIDs are constrained by `_debug_review_assigned_scope_v1`, which
excludes `e.user_id = auth.uid()` (self-review) outright.

### Review-action authorization — PASS (static)
`grep` for `.from("expenses").update|insert|delete` across `src/components`,
`src/features`, `src/pages`: **no hit**. Every privileged mutation routes through
`ExpenseService`. In `reviewActionService.ts` the order is invariant across all
four actions: `assertActionsEnabled()` → `assertAllowed(expense, kind, ctx)` →
`await assertSession()`. The feature flag is not the authorization boundary;
client eligibility (`actionEligibility.ts`) can only **subtract** actions from
the server's `available_actions`.

### PWA / service worker — PASS
`public/sw.js` `shouldBypassCache()` excludes `/api/`, `/assets/`, `/rest/` and
any URL containing `supabase`, so authenticated Supabase REST/Auth/Storage
responses are never cached.

### CSP / headers — PASS
Enforced `Content-Security-Policy` present (a separate report-only header also
exists). `Strict-Transport-Security`, `X-Content-Type-Options`,
`Referrer-Policy`, `Permissions-Policy`, `frame-ancestors`, `object-src`,
`base-uri`, `form-action` all present. **Zero occurrences of `vercel.live`** —
the Preview toolbar CSP warnings were correctly not accommodated.

dev's only `vercel.json` change **tightens** security: the tenant manifest moves
from `public, max-age=300` to `private, no-cache, no-store, must-revalidate`
with `Vary: Host, X-Forwarded-Host`, preventing one tenant's manifest being
served to another.

### Production debug routes — PASS
`VITE_DEBUG_REVIEW_EXPENSES_ENABLED` and `VITE_DEBUG_REVIEW_ACTIONS_ENABLED` are
strict `=== "true"` comparisons, so anything unset/absent is `false`. Production
does not set them.

### Migration `20260802030000` — PASS, ready to apply
Additive and read-only: 3 × `CREATE OR REPLACE FUNCTION`, comments, revokes,
grants. Comment-stripped scan confirms **zero** `INSERT`, `UPDATE`, `DELETE`,
`TRUNCATE`, `ALTER TABLE`, `DROP TABLE`, `CREATE TABLE`, `CREATE POLICY`,
`storage.` reference and `GRANT … anon`. Four tests in
`reviewEmployeeFilterAndBatchState.test.ts` assert the same so it cannot drift.
`migrations:check` clean at 173 files.

**Prerequisites confirmed present in Production** by the operator's preflight on
2026-08-02: `assigned_scope`, `status_class`, `caller_context`, `handoff_ids`,
`assert_reviewer`, `identity`, `keyed_scope`, `actionability` — all `true`.
Rollback bodies available from `20260802020000`.

### Validation

| Check | Result |
|---|---|
| `git diff --check` | clean |
| `tsc --noEmit` | clean |
| `typecheck:api` | clean |
| `build` | clean |
| `migrations:check` | clean, 173 files |
| `npm test -- --run` | **2219 passed / 110 files, 0 failures** |
| `lint` | **458 problems** — unchanged baseline |
| `i18n:check` | fails to start (`ERR_UNKNOWN_FILE_EXTENSION`); reproduced on pristine `4df1359` in a separate worktree — broken runner, not a content failure. All changed keys validated directly across en/hi/gu. |

---

## 4. Not verified

These are **unknown**, not passing:

- **GitHub configuration** — branch protection on `main`/`dev`, required PRs and
  approvals, required status checks, force-push and deletion restrictions,
  secret scanning, push protection, Dependabot alerts, code scanning, Actions
  permissions, deploy keys, installed Apps, collaborators. No GitHub MCP or API
  token available.
- **Live RLS state** — policies on `expenses`, `expense_batches`, `attachments`,
  `profiles`, `organizations`, `organization_memberships`, `teams`,
  `team_members`, `audit_logs`, `notifications`, custom-field tables, balances,
  approval limits, `storage.objects`. No database credentials available.
- **Runtime tenant-isolation negative tests** — cross-organization expense,
  employee, batch and attachment IDs.
- **Runtime review-action behaviour** — one controlled action, audit record,
  notification, balance deduction, stale-state rejection, double-submit.
- **Action atomicity under concurrency** — the shared layer inherits
  `ExpenseService` orchestration from `main`. Static review shows a client-
  orchestrated sequence, not one database transaction. Residual risk:
  a mutation succeeding while a subsequent audit/notification write fails leaves
  a partially-recorded action. `useReviewExpenseActions` invalidates on both
  success and failure and never applies optimistically, which bounds the
  *display* consequence but not the *record* consequence. **Unquantified —
  requires runtime verification.**
- **Employee 6174 end-to-end**, filtered-KPI reconciliation, batch grey/amber/blue.

---

## 5. History-purge decision

**HISTORY PURGE REQUIRED.**

Triggered by P0-1: plaintext employee passwords and a whole-organization personal
export remain reachable in history, and this audit cannot prove the affected 208
accounts were reset to values outside the original derivable scheme. The
historical `.env` credentials (P2-1) alone would only have warranted
*recommended*.

Run as a **separate, coordinated operation** — never combined with the feature
merge:

1. Owner confirms all 208 account resets, to values not derivable from the old scheme.
2. Announce a freeze; every collaborator stops pushing.
3. `git clone --mirror` a backup, stored offline.
4. `git filter-repo --path scripts/data/microlink-remove-employees.tsv --path .env --invert-paths`
   (add the three generator scripts if also removed).
5. Force-push all refs; delete or re-cut the two `safety/*` branches and
   `fix/review-expense-complete-loading`, which also contain the blob.
6. **Every collaborator must delete their clone and re-clone.** Pushing an old
   clone silently restores the purged objects.
7. Ask GitHub Support to expire cached views and any fork network.
8. Re-run this audit's history scan to confirm zero reachable matches.

---

## 6. Verdict

**NO-GO.**

Blocking:

1. **P0-1** — plaintext employee credentials + personal export in the tracked tree
   and reachable history, with no proof of non-derivable resets.
2. **P1-1** — 14 production dependency advisories (1 critical) unfixed and
   unaccepted.
3. **P1-2** — Preview mutates Production without a documented control decision.
4. **Migration `20260802030000` unapplied** — an explicit gate.
5. **Runtime gates unmet** — employee 6174 end-to-end, filtered-KPI
   reconciliation, batch colour states, one controlled action with audit and
   notification verification.
6. **Unverifiable gates** — GitHub branch protection and live RLS could not be
   inspected; they cannot be marked satisfied.

None of 1–3 is introduced by `dev`. Items 4–5 are the expected state of a branch
whose migration has not yet been applied. The branch's own security posture is
sound: no secret in the tree or bundle, correct SECURITY DEFINER hygiene, all
privileged writes server-authorized, self-review structurally impossible, no
service-worker caching of authenticated APIs, and a CSP that was not weakened.

### Steps to GO

1. Resolve P0-1 (§2) and complete the history purge (§5).
2. Fix or formally accept the production advisories, in writing, per package.
3. Decide the Preview/Production control (§P1-2).
4. Grant read-only database access so RLS and SECURITY DEFINER grants can be
   verified live; grant GitHub read access so branch protection can be confirmed.
5. Apply `20260802030000` per §7 Stage 1, then run the runtime checks.
6. Re-run this audit and re-issue the verdict.

---

## 7. Staged release plan (for a future GO — do not execute now)

**Stage 1 — database.** Back up current function definitions
(`pg_get_functiondef`). Apply only `20260802030000`. `NOTIFY pgrst, 'reload schema';`
Verify `schema_revision = 20260802030000`, `batch_state: true`,
`response_features: ["filtered_summary","batch_state"]`, employee filtered
summary equals `filtered_total`, `reconciliation_ok: true`, and a mix of batch
states. Production frontend unchanged throughout.

**Stage 2 — code merge.** PR `dev` → `main`, all checks required, review the full
26-commit diff, merge without force-push. Flags stay off.

**Stage 3 — read-only rollout.** `QUEUE_ENABLED=true`, `ACTIONS_ENABLED=false`,
both debug flags `false`, `REVIEW_QUEUE_V2_ENABLED=false`. Redeploy. Verify
login, list, employee search, KPIs, pagination, singular detail, batch
navigation, and that **no mutation control renders**.

**Stage 4 — controlled actions.** `ACTIONS_ENABLED=true`, redeploy, perform
exactly one authorized action; verify prior status, eligibility, resulting
status, audit record, notification, queue and KPI refresh, and no duplicate write.

**Stage 5 — broader release.** Watch 401/403 rates, mutation failures,
stale-state rejections, audit completeness, notification delivery, KPI
reconciliation, batch navigation, latency.

**Rollback.** Set both server review flags to `false` and redeploy — the legacy
`EngineerReview` page remains available and untouched, with no automatic
fallback. Database rollback: re-run the Step 2 and Step 3 bodies from
`20260802020000`; `_debug_review_batch_state_v1` may be left in place, nothing
else calls it.

---

## Revision log

| Date | Rev | Author | Notes |
|------|-----|--------|-------|
| 2026-08-02 | 1.0 | Agent | Initial audit of `dev` @ `854c092` against `main` @ `2f23854` (26 ahead, 0 behind). Verdict **NO-GO**. Found P0-1: 208 employee records with plaintext, name-derivable passwords plus a whole-organization personal export tracked at `scripts/data/microlink-remove-employees.tsv` (fp `7fe96a80816ee867`), reachable on `main`, `dev` and three other branches — not introduced by dev, with three code dependencies, so not removed unilaterally. P1-1: 14 production dependency advisories (1 critical) inherited from main. P1-2: Preview mutates the Production database behind Vercel SSO with dev-branch-scoped variables. Clean: current-tree secret scan, browser bundle (only the `role: anon` publishable key), 33/33 SECURITY DEFINER functions with `search_path = ''` + PUBLIC/anon revoked and zero anon grants, all privileged writes server-authorized with no direct `.from("expenses").update()` in UI code, service worker bypassing all Supabase paths, CSP enforced with no `vercel.live`. History purge **REQUIRED**. Added `src/__tests__/credentialDataFiles.test.ts` as a regression control pinning the known exposure and blocking any new credential-bearing data file. GitHub configuration and live RLS could not be inspected — reported as unknown, not passing. 2219 tests / 110 files pass; lint 458 unchanged. No Production data mutated, no migration applied, no secret printed, `main` untouched. |
