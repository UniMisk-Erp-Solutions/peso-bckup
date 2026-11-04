# peso-bckup ← upstream `main` sync (2026-10-05)

**Doc ID:** DOC-143
**Status:** in progress — code merge committed locally on `sync/mithil-main-20261005` (**NOT merged to `main`, NOT pushed**); live `pesowise` database fully migrated (45/45) and verified. Push + edge-function deploy are held for the owner's go-ahead.
**Last updated:** 2026-11-04
**Owner / area:** Release / repo sync, Supabase backup instance (Coolify project `pesowise`)

---

## 1) Summary

Brought `peso-bckup` (`UniMisk-Erp-Solutions/peso-bckup`) up to date with
`Mithil1105/peso-patidar` `main` @ `f387456` (2026-10-02): 664 upstream commits, 400 changed
files. In parallel, applied the 45 schema migrations the new code needs to the live backup Supabase stack. One migration (Recycle Bin) tripped its own safety guard on data this repository never knew about (a WAL-recovery lab, §6); the guard was **not** bypassed on my initiative — the owner explicitly authorized a documented, minimal adjustment, after which the rest ran. The push is still held back: it triggers a Vercel rebuild of the frontend, and the matching edge functions have not been deployed yet.

---

## 2) Problem / requirement

`peso-bckup` main (`5de6993`) and upstream `main` have **no common git ancestor** (the backup
repo started as an "initial backup import"), so `git pull` / `git merge` cannot work and a
forced `--allow-unrelated-histories` merge would (a) report add/add conflicts on hundreds of
files and (b) copy 664 commits of foreign history into the backup repo. The two lineages also
numbered documents independently (same `DOC-xxx` ID, different documents) and re-numbered
Preet's migrations under different version prefixes.

## 3) Solution

**Method.** An explicit-base three-way merge (`git merge-recursive <base> -- HEAD mithil/main`)
with a synthetic base, then a single-parent commit — no foreign history imported.

- Base = upstream commit `1d83749` (2026-08-24). Chosen empirically: of all candidate upstream
  commits it minimised "files changed on both sides" (31) and local-only changes (82).
- 23 textual conflicts + several silent merge artefacts (duplicated route/import lines that
  merged "cleanly"; four upstream migration files lost to rename detection) were resolved
  and then **audited path-by-path against `mithil/main`** (`git diff --cached mithil/main`).

**Resolution policy.**

| Area | Outcome |
|---|---|
| Admin-submit-for-employee, bulk import, report export UI/worker, `Reports.tsx`, routes, nav, i18n | **Upstream wins** — upstream re-implemented Preet's feature as an atomic single-transaction `_v2` RPC ("the final Preet feature integrated into this lineage", DOC-109). Preet's v1 versions remain in git history (`main@5de6993`) and on `origin/feature/*`. |
| `.gitignore` | **Union** — upstream's `*.xlsx`/`tmp/` rules + the local DB-dump rules. Nothing weakened; every guard re-verified with `git check-ignore`. |
| Local-only security docs (`sensitive-local-data-policy.md` §4a) | Kept. |
| Docs numbering | **Upstream's catalog is canonical.** Local-only docs re-registered under new IDs (§5). |
| `package.json` | Upstream + Preet's `exceljs` dependency (lockfile verified consistent). |
| Not imported | `backup.sql` (0-byte, ignored by `/*.sql`) and the three Production-targeted `scripts/_ssh_apply_*`/`_ssh_verify_*` scripts that DOC-111 had already declined to import. |

**Removed local-only migrations (superseded by an upstream file defining the same objects).**
All remain in git history.

| Removed | Replaced by (upstream) |
|---|---|
| `20260822120000_server_side_expense_reports.sql` | `20260827170000_server_side_expense_reports.sql` |
| `20260822160000_report_export_history.sql` | `20260827180000_report_export_history.sql` |
| `20260824100000_admin_submit_expense_for_employee.sql` (v1) | `20260828100000_admin_submit_expense_for_employee_v2.sql` |
| `20260824140000_admin_bulk_submit_expenses_for_employees.sql` (v1) | v2 bulk RPC inside `20260828100000_…_v2.sql` |
| `20260824100500_historical_balance_anchors_schema.sql` (+rollback) | `20260824100000_historical_balance_anchors_schema.sql` |
| `20260824140500_revoke_legacy_transfer_offer_rpcs.sql` (+rollback) | `20260824140000_revoke_legacy_transfer_offer_rpcs.sql` |
| `20260826100000_daily_report_dynamic_project_name.sql` (+rollback) | built into `20260827160000_daily_project_report_shared_core.sql` |
| `20260826110000_daily_report_project_name_ambiguity_rpc.sql` (+rollback) | `20260829120000_daily_report_remarks_and_batch_ambiguity.sql` (`_batch_v2`) |
| `20260827100000_…_source_expense_purpose.sql`, `20260827110000_…_worker_rows_purpose.sql` (+rollback) | `20260827160000` / `20260829120000` |
| `290825_1000_org_scoped_audit_logs_select.sql` | `20260828110000_org_scoped_audit_logs_select.sql` |
| `20260819155000_money_tables_organization_id_prereq.sql` (+rollback) | not needed — columns already exist and are populated live (4/4, 7/7) |

Four of those shared a 14-digit version prefix with a *different* upstream migration
(`20260824100000`, `20260824140000`, `20260826100000`, `20260826110000`), which is why they could
not simply be kept. **Kept (no upstream equivalent):** `20260823100000_generated_report_snapshots.sql`
(+rollback), `20260901115900_restore_v1_fns_after_backup_reload.sql` (v1 compatibility bridge
for the previously deployed frontend; **renamed from `20260901120000_…`** because it shared that
version prefix with upstream `additive_credit_v3` and `npm run migrations:check` correctly flagged
it as a new duplicate — it was renamed, not added to the baseline, so the guard is untouched), and
`290825_1100_admin_receipts_storage_insert.sql`.

**Orphans left in place (unreferenced, not bundled):** `SavedReportsPanel.tsx`,
`generatedReportStore.ts` (feature removed upstream). `generateBulkExpenseExcelTemplate.ts`
was deleted — it imports exports upstream's parser no longer has and does not compile.

## 4) Key files

- Merge result: branch `sync/mithil-main-20261005` (single commit on top of `main@5de6993`).
- Docs: this file, `index.md`, the six renumbered docs (§5).
- `supabase/migrations/20260820160000_daily_project_report_server_pagination.sql` — header
  reference updated `DOC-116` → `DOC-142` (comment only).

## 5) Document renumbering map

| Old (pre-sync `peso-bckup` index) | New | File |
|---|---|---|
| DOC-103 | **DOC-139** | `generated-report-server-persistence.md` |
| DOC-113 | **DOC-140** | `daily-report-gap-analysis-2026-08-26.md`, `daily-report-fix-applied-2026-08-26.md` |
| DOC-113 (2nd follow-up) / DOC-114 | **DOC-141** | `daily-report-project-id-backfill-2026-08-26.md`, `daily-report-full-recovery-detail-2026-08-26.md` |
| DOC-116 | **DOC-142** | `backup-database-restore-2026-09-01.md` |
| — | **DOC-143** | this file |

Docs that exist on both sides were reset to upstream's numbering (e.g. old local DOC-111/112 are
upstream DOC-103/104; old local DOC-115 is upstream DOC-107). **Collision risk:** IDs 139+ were
allocated here from upstream's "Next ID"; if upstream allocates the same numbers independently the
numbering will collide again. Re-check upstream's index before the next sync.

## 6) Database (Coolify project `pesowise`, host 192.168.23.46)

**Scope control.** The host runs three independent Supabase stacks. Identified by Coolify labels
(`coolify.projectName`): `…kar0ro1k6jiyfxzzw7acnsza` = **pesowise** (the only one touched),
`…sgl3iyrx68m0vezo8a8os9it` and `…y136xmh1lcm9jt88siwawkrc` belong to two other, unrelated Coolify projects (not touched). The
helper pins the container name; nothing else on the host was modified.

**Findings.**
- Live schema sat at upstream state ≈ `20260829`; nothing from `20260901120000` onward existed.
  `supabase_migrations.schema_migrations` is not used (1 stale row), so "applied" was determined by
  comparing every function body (md5 of `prosrc`) and object existence against the migrations.
- Some old review-queue functions in the DB match **no committed version** anywhere (older
  hand-applied iterations). They were left alone; none belongs to the apply plan.
- The DB contains objects that exist in **no** repo migration: a **WAL-recovery lab** (tables
  `expense_wal_logs`, `wal_demo_scheduled_seeds`; ~18 `_wal_*`/`wal_ops_*` functions; columns
  `expenses.is_deleted`, `deleted_at`, `recovered_from_wal`, `is_wal_lab_demo`), other upstream
  features from branches not in this repo (archive, user-activity, undo events), and unrelated
  apps' tables (cars/bookings/bills). The lab is self-contained: no core function, policy or
  trigger references it.

**Rollback artifact (kept).** Server path `~/pesowise-pre-sync-20261005/` (the SSH user's home on the host) (mode 700):
`postgres.dump` (pg_dump -Fc, 28,070,228 bytes, sha256 `cdbcfb5b…f9156`), `toc.txt`,
`schema_pre.sql`. Taken before the first write. Contains real data — never copy it into the repo.

**Applied — all 45, each in its own transaction.** The first 28: `20260827150000`, `20260827170000`,
`20260827180000`, `20260828110000`, `20260829100000`, `20260901120000`, `20260901121500`,
`20260901123000`, `20260901140000`, `20260902070000`, `20260902090000`, `20260902120000`,
`20260902130000`, `20260905150000`, `20260907120000`, `20260907121000` (MicroLink mandatory
project-field policy — one config row, revert = one-row DELETE), `20260907220000`, `20260908060000`,
`20260909100000`, `20260909130000`, `20260909140000`, `20260909172000`, `20260909200000`,
`20260910120000`, `20260910140000`, `20260910150000`, `20260915120000`, `20260922090000`. Then
`20260922120000` (below), then the last 16: `20260923000000`, `20260923010000`, `20260924000000`,
`20260925000000`, `20260926000000`, `20260927000000`, `20260928000000`, `20260929000000`,
`20260930000000`, `20261001000000`, `20261002000000`, `20261003000000`, `20261009000000`,
`20261011000000`, `20261017000000`, `20261018100000`. Skipped as already byte-identical live:
`20260827160000`, `20260828100000`, `20260829120000`.

**`20260922120000_expense_recycle_bin_v1.sql` — guard fired, then applied with an owner-authorized
adjustment.** Its own post-condition raised `rule regression: a pre-existing row was marked
deleted by this migration -- it must add columns only` and rolled itself back (nothing persisted).
Cause: `expenses.deleted_at` already exists and **1,998 MicroLink rows already had it set** (all
`is_wal_lab_demo = true`, one seeded user, one timestamp `2026-09-25 09:36:19`, 995 submitted +
1,003 approved). The lab uses `deleted_at` with its own meaning; Recycle Bin reuses the same column
as its trash marker. Measured impact: 0 balance deductions / 0 attachments / 0 audit rows on those
rows; the purge function only matches `purge_after <= now()` and `purge_after` is NULL for them, so
they can never be auto-purged. The owner authorized changing the check to "the migration must not
*change* the number of deleted rows". Applied via an apply-time-only 3-line edit (record
`count(*) WHERE deleted_at IS NOT NULL` into a transaction-local setting right after `BEGIN`, compare
at the guard); the repo file is **byte-identical to upstream**. Result: lab rows exactly as before
(1,998 deleted, 2,006 lab demo, `purge_after`/`deleted_by` NULL, total 25,213). **Behavioural
effect:** the 1,998 lab-deleted rows are now hidden from trash-aware list/count/dashboard paths and
appear in MicroLink's Recycle Bin (with no purge date). A future upstream sync will meet the same
guard again on any DB that still has those rows.

**Post-run verification (read-only, except the rolled-back dry runs):**
- **Data:** no pre-existing table changed row count; none removed; `auth.users` (794) and
  `storage.objects` (19,959) identical. Row-text checksums changed only for `expenses` and
  `balance_ledger` (added columns; `balance_ledger.day_position` defaulted to 1 on all 107 rows).
  `expense_form_field_values` checksum unchanged.
- **Seeded by migrations (intended):** `expense_form_field_value_history` 85,939 baseline rows
  (one per existing custom-field value, from `20260909200000`), `organization_required_expense_fields`
  1 row (MicroLink), `report_historical_reconciliation_events` 3 rows
  (`duplicate_deduction_error`, 2026-04-17 / 04-29 / 05-08) from `20260929000000`.
- **Schema drift:** 115 of 115 function final-definitions byte-identical to the repo (0 differing,
  0 missing); 75 functions added, 0 removed; 10 new tables.
- **Security:** `anon`-executable public functions 185 → 175; 18 mutating RPCs tightened (e.g.
  `review_approve_expense`, the `undo_*` family). 8 newly `anon`-executable: 6 are pure helpers or
  trigger functions (not callable as RPCs); 2 are mutating SECURITY DEFINER date-lock RPCs
  (`create_expense_date_lock_v1`, `deactivate_expense_date_lock_v1`) — upstream's migration revokes
  `PUBLIC` but not `anon`, and Supabase default privileges grant `anon` directly. **Not exploitable**
  (both reject `auth.uid() IS NULL` and non-admins inside), left as upstream has it; a one-line
  `REVOKE EXECUTE ... FROM anon` would close the gap if wanted.
- **WAL lab:** all 25 `wal`-named functions byte-identical; rolled-back dry runs (`ROLLBACK`
  verified by counts) showed the lab's MicroLink seeding (12/12, both `submitted`/`approved`) and
  its `wal_ops_*_microlink_*` soft-delete -> recover cycle both work against the new triggers.
  The generic `expense_soft_delete_with_wal_v1`/`recover_expense_from_wal_v1` require an org-admin
  `auth.uid()` and so cannot be exercised from psql (precondition, not a regression).
- **Runtime:** PostgREST reloaded its schema cache at apply time (356 functions); all 14
  containers of the pesowise stack healthy.

**Edge functions deployed (owner-authorized, pesowise edge container only).** Four functions / five files copied into the pesowise stack's edge-runtime (`docker cp` into the bind-mounted functions dir), byte-verified by sha256 inside the container: new `admin-set-user-auth-status` and `get-report-export-download-url`; updated `finalize-expense-receipts` (now `receipt-finalizer-v4`) and `run-report-export-job` (`index.ts` + `expenseReports.ts`). All required env var *names* were already present (values never read or printed). Previous 24 files backed up in the rollback dir. No restart was needed: smoke test with the public anon key got clean rejections (400/401, no mutation, no jobs processed), `hello` 200, no edge-runtime errors. The other 12 functions were identical and left alone.

## 7) Verification

| Check | Result |
|---|---|
| `tsc -p tsconfig.app.json` (project TS 5.8.3) | error set **identical to upstream** (620 pre-existing; the generated `types.ts` is partial on both sides) after removing one uncompilable orphan; local `main` baseline was 618. |
| `vitest run` | 4,701 pass / 16 fail of 4,717 in the main checkout. 15 of the 16 fail identically on pristine upstream (jsdom/undici `AbortSignal` environment). The 16th (`MaintenanceAdminDashboard › redirects to login`) was caused by an untracked local `.env` in the main checkout: on a clean checkout of the exact commit it passes 11/11. Net: **no failure attributable to the merge.** |
| `vite build` (clean checkout of the commit) | succeeds — 4,720 modules, 209 output files. (`glitchtip-sourcemaps` upload step not run.) |
| `npm run security:secrets` | clean. |
| `npm run migrations:check` | passes (initially failed on the duplicate prefix above; fixed by renaming). |
| `.gitignore` guards | all dump/xlsx/`.local-sensitive-data` patterns verified with `git check-ignore`. |
| Typecheck/test parity method | pristine worktrees of `main` and `mithil/main` with a junctioned `node_modules` and the project's own compiler (an earlier run used the wrong TypeScript via `npx` and was discarded). |

## 8) Test plan / next steps

1. ~~Decide the Recycle Bin / lab collision~~ — done (owner authorized the guard adjustment).
2. ~~Run the remaining migrations, re-verify, audit anon grants~~ — done (§6).
3. ~~Deploy the matching edge functions~~ — done (§6).
4. **Push** `sync/mithil-main-20261005` to `origin/main` (owner's go-ahead) — Vercel rebuilds the frontend. Fast-forward local `main` first.
5. Smoke-test in the browser after deploy: login, expense submit (MicroLink mandatory project fields), review/approve, Reports (all four tabs + export history), admin submit-for-employee v2, Recycle Bin page (expect 1,998 lab rows listed with no purge date).
6. **Risk until step 4 completes:** the currently deployed (old) frontend runs against newer triggers/policies (MicroLink mandatory project fields, expense state machine, anon-execute revokes).
7. Optional: `REVOKE EXECUTE ... FROM anon` on the two date-lock RPCs (§6); decide what to do with the 1,998 lab-deleted rows now visible in the Recycle Bin.
8. Retention: delete the rollback dump under `~/pesowise-pre-sync-20261005/` (the SSH user's home on the host) (contains real data, mode 700) once the sync is accepted.

## 9) Operational note — Vercel blocks commits by non-team authors (2026-10-19)

After `feature/tally-integration` (author `priyanshubyte`) was fast-forwarded into `main` (`47f3d0f`), the
live domain kept serving the previous build. GitHub showed Vercel's status for that commit — and for all four
earlier preview builds of the same branch — as **"Deployment was blocked"**, while the earlier sync commit
(authored by the team's own identity) deployed normally. The pattern fits Vercel's rule that the author of the
newest commit must be a member of the Vercel team. Consequences and handling:

- Merging a collaborator's commits does **not** by itself deploy them; the *newest* commit on `main` decides.
  A follow-up commit authored by a team identity (this one) makes Vercel build the whole tree, including the
  collaborator's earlier commits, whose history stays attributed to them.
- Durable fix (owner, in Vercel): add the collaborator to the team, or change the project's Git author setting.
- Tally UI visibility is a **build-time** flag: `VITE_PWT_SYNC=1` must be set in the Vercel project's
  environment variables *before* the build, otherwise only `/admin/pwtally` (by URL) and the Balances credit
  history are visible. Backend state on the `pesowise` stack was verified read-only the same day: all `pwt_*`
  tables, 38 `pwt_*` functions and the five Tally edge functions are present.

## 10) Second sync (2026-11-04): upstream `main` @ `51046ec`

Upstream moved by 32 commits (303 files) since the 2026-10-05 base `f387456`: user-account audit history (upstream DOC-158), review attachment
state race (DOC-159), PWA submit/upload reliability (DOC-157), deactivated users, stale-chunk recovery, scoped report access, attachment
invariants, daily-project report fixes, `FUTURE_PLANS.md`. Same method as §3: explicit-base three-way merge (base `f387456`), single parent
on `sync/mithil-main-20261104`, then audited path-by-path against `mithil/main` (the only files that differ are listed below).

**Policy: Tally stays peso-bckup's own.** Upstream's `main` also carries the *production* variants of the Tally files. Not imported: the
per-organization `tally_integration` flag (`pwtFeature.ts`, registry key, `20261030100000_pwt_org_feature_gate` + rollback + test), the
production installer and its guard test, `tally-production-rollout-2026-10-23.md`, upstream's Tally rows (DOC-154/155/156), and its Tally
test/doc variants. The gating in `AppSidebar.tsx`, `Balances.tsx` and `Reports.tsx` stays `VITE_PWT_SYNC` only. Also not imported: three
deploy-trigger placeholder docs (`DUMMY_DOC*.md`, `deploy-trigger-note.md`). Mixed files: `.gitignore` takes upstream's database-dump
rules (nothing weakened); `ServerReportExportPanel.tsx` gets upstream's *View Report* button inside the Sync redesign's action row.

**Migration renames (collisions).** Three incoming upstream migrations shared a 14-digit version with peso-bckup's Tally ones
(`npm run migrations:check` flagged all three), and upstream's tests load theirs by name, so the Tally files were renamed to the names
production already uses. Contents are identical (100% renames); references in the tests and Tally docs were updated.

| Old | New |
|---|---|
| `20261019100000_pwt_deletion_sync` | `20261019110000_pwt_deletion_sync` |
| `20261023100000_pwt_inbound_match_by_code` | `20261030110000_pwt_inbound_match_by_code` |
| `20261024100000_pwt_inbound_cash_parent_ci` | `20261030120000_pwt_inbound_cash_parent_ci` |
| `20261024140000_pwt_inbound_list_batch` | `20261030130000_pwt_inbound_list_batch` |

**Document IDs.** Five IDs name two documents (one per repository): DOC-140, 142, 143, 147, 148. Neither side was renumbered (a text replace
would corrupt cross-references that mean different documents in each repository); upstream's rows and sections carry the qualifier
"(upstream)". The Tally guide and system document are DOC-146 / DOC-147 here and DOC-154 / DOC-155 upstream (same files). Next ID: DOC-160.

**Backup database state (read-only check, Coolify project `pesowise` only).** Of the 14 migrations that arrive, the function bodies of
`20261007120000` to `20261029100000` already match the live database (it was restored from a production snapshot). **Not applied:**
`20261027100000_profiles_notification_settings_v1` (column `profiles.notification_settings`; the frontend falls back safely),
`20261031100000_user_account_audit_history_v1` (tables and 24 functions; the audit page has nothing to read until applied),
`20261031120000_user_roles_privilege_escalation_fix` (the live database still has the permissive `user_roles` policies it removes),
`20261031130000_user_account_audit_denial_snapshot_fix`, `20261101100000_review_detail_v2_active_attachments_ordered`. Edge functions changed upstream
(`admin-create-user`, `admin-reset-password`, `admin-set-user-auth-status`, `admin-update-user-email`, `bulk-users-import`,
`finalize-expense-receipts`, `run-report-export-job`, `_shared/accountAudit.ts`) are not deployed by a git push. **This sync changed no database
and deployed no edge function;** applying them needs a backup, a rehearsal and the owner's go-ahead.

**Verification.** `tsc`: 611 errors, every one present in the peso-bckup baseline (621) or upstream's (610). Full test run: only the four
known baseline files fail (15 tests). `resync_perf.test.ts` (an absolute path from a developer machine) was fixed to a relative import.
Tally database acceptance suites pass on the renamed migrations (inbound 55, deletion 41, edit 22, posting date 4, sliced preparation 17,
per-company registry 10, voucher reuse 5); `security:secrets` clean; `migrations:check` passes (only the four approved historical
duplicates); production build with `VITE_PWT_SYNC=1` succeeds.

## Revision log

| Date | Notes |
|---|---|
| 2026-10-05 | Created. Explicit-base merge prepared on `sync/mithil-main-20261005`; DB 28/45 applied, halted on the Recycle Bin guard (WAL-lab data collision); push held. |
| 2026-10-05 (later) | Owner authorized a minimal adjustment of the Recycle Bin guard (compare before/after deleted count). Applied it plus the remaining 16 migrations (45/45). Verified: counts/checksums, 115/115 function bodies in sync, anon-exec audit (185 -> 175), lab dry runs (rolled back), PostgREST reload, container health. Push and edge-function deploy still held. |
| 2026-10-19 | Added §9: Vercel blocked every deployment of the Tally branch's commits (author not a Vercel team member); merged code was not live. Handled with a team-authored follow-up commit; flag and backend state documented. |
| 2026-11-04 | Added §10: second sync (upstream `51046ec`); Tally kept as peso-bckup's own; four Tally migrations renamed to avoid version collisions; ID collisions qualified; backup database gap recorded (5 upstream migrations not applied). |
