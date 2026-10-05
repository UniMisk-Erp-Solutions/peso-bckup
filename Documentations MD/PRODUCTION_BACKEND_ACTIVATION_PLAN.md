# Production Backend Activation Plan

**Status:** PLANNING ONLY as originally written. **EXECUTED 2026-08-29 with one material deviation — see the outcome note immediately below before reading the plan as current.**
**Prepared:** 2026-08-29, on `integration/preet-admin-submit-expense-for-employee`.
**Prerequisite reading:** `PRODUCTION_BACKEND_MIGRATION_AUDIT.md` (the evidence this plan is built from) and `PENDING_MIGRATIONS_PREET_INTEGRATION.md` (the corrected per-migration status, now including the actual outcome).
**Requires explicit owner approval before any step below is executed.** This document does not authorize anything by existing.

---

## ACTUAL OUTCOME (2026-08-29, added after execution)

Step 1 (grant hardening) and Step 3 (Migration 5, Admin Submit) below were executed
exactly as planned and are confirmed applied and verified on Production.

**Step 2, as planned below (Migration 2's full file, including the whole-population
`project_name_ambiguous` computation), was NOT the version that ended up live.**
It was applied to Production and rolled back twice: first causing a 2+ minute hang
against MicroLink's real ~12.6k-row dataset (emergency `pg_cancel_backend` +
function restore), then — after root-causing a real `plan_cache_mode=auto`
double-execution bug via `pg_stat_statements` execution-count proofs and fixing
it with a function-scoped `set_config('plan_cache_mode','force_custom_plan',true)`
— the fix validated fast (~0.85-1.4s) on an isolated throwaway restore but still
measured a consistent ~10.5-11.3s on real Production, so it was rolled back again.
The architecture was redesigned rather than further tuned: see
`Documentations MD/daily-report-batch-ambiguity-redesign.md` (DOC-110) and the
updated Migration 2/8 rows in `PENDING_MIGRATIONS_PREET_INTEGRATION.md`. The
version of `report_daily_project_rows_v1` actually live on Production today is
the base architecture plus Remarks only, with ambiguity moved to a new,
separately-called, page-scoped RPC.

`run-report-export-job` was deployed and proven end-to-end for all four report
types via the real worker. `finalize-expense-receipts` was redeployed with its
admin-authorization fix, prior version preserved as a named rollback. Data
recovery/backfill was NOT run. `main` was NOT merged, pending the owner's own
frontend QA.

---

## 1) Exact files to execute, in exact order

| Order | File | Why required | Objects changed | Risk | Rollback strategy | Pre-check | Post-check |
|---|---|---|---|---|---|---|---|
| 1 | `20260829100000_report_export_grant_hardening.sql` (new, this task) | Closes the one confirmed live grant gap: `create_expense_report_export_job_v1` and `_report_humanize_field_key_v1` are still callable by roles they were never meant to be, even though both already-live functions are otherwise correct. | `REVOKE`/`GRANT` only — no table, column, or function-body change. | **Low.** No behavior change for any legitimate caller (both functions already internally check `auth.uid()` or run only via `service_role`-owned callers); this only removes access nothing currently legitimately uses. | Re-`GRANT EXECUTE ... TO anon` / `TO authenticated` on the two functions if anything unexpectedly depended on the wider grant (extremely unlikely; nothing in this repo calls `_report_humanize_field_key_v1` directly, and the enqueue RPC already gates on `auth.uid()`). | Confirm current grants via the query in §4 below match the audit's documented "before" state exactly (no further drift since 2026-08-29). | Re-run the same grant query; confirm `anon=false` on both, `authenticated=false` on the humanize helper, `authenticated=true` (unchanged) on the enqueue RPC. Run the app's existing Claim Verification / Approval / Detailed Expense report generation end-to-end once as a normal authenticated admin — should work identically to before. |
| 2 | `20260827160000_daily_project_report_shared_core.sql` (existing file, applied AS-IS, not modified) | The audit proved the live `report_daily_project_rows_v1` base is byte-identical to this file's un-amended body. Applying the CURRENT file (base + Remarks + Ambiguity, all in one `CREATE OR REPLACE`) adds exactly the two missing, additive JSON keys — nothing else changes. | `report_daily_project_rows_v1` (`CREATE OR REPLACE`), `get_daily_project_report_page_v1` (`CREATE OR REPLACE`, wrapper only, signature unchanged), one new index (`efv_option_branches_org_key_parent_idx`, additive). | **Medium.** This function is presumably already serving live Daily Project Report traffic (backend confirmed live; frontend expectation unconfirmed — see §3 below). `CREATE OR REPLACE` on a function already in active use has a brief lock window but no data risk; the JSON contract change is additive only (new keys, nothing removed/renamed), so an OLDER frontend reading this response will simply ignore the new keys. | Re-apply the exact PRE-image of `report_daily_project_rows_v1` (captured in the pre-migration backup, see §3 of the backup plan) via a single `CREATE OR REPLACE FUNCTION` using the saved definition. | Save the current live function definition via `pg_get_functiondef` immediately before applying (independent of the general backup — belt and suspenders for the one function actually changing). Confirm row counts for a known organization/date range match a value captured just before the change. | Re-run the exact same report query for the same organization/date range immediately after; confirm identical `total_count`/`source_count`/`source_amount` to the pre-change baseline, plus the presence of `source_expenses[].purpose` and `project_name_ambiguous` in the new response. |
| 3 | `20260828100000_admin_submit_expense_for_employee_v2.sql` (existing file, applied AS-IS) | Genuinely new feature, confirmed fully absent, all four dependencies confirmed live and signature-matched. | New column `expenses.created_by_admin_id` (nullable, no default-value backfill needed), new table `admin_submit_expense_idempotency`, 9 new private routing-helper functions, 2 new RPCs (`admin_submit_expense_for_employee_v2`, `admin_bulk_submit_expenses_v2`). No existing table/function/policy modified. | **Low-Medium.** Purely additive at the schema level (`ALTER TABLE ... ADD COLUMN`, `CREATE TABLE`, `CREATE FUNCTION` — nothing replaces an existing definition). The only genuine risk is in the NEW code's own correctness, not in disturbing anything already live. | `DROP FUNCTION`/`DROP TABLE`/`ALTER TABLE ... DROP COLUMN` for the new objects only — trivially reversible since nothing else references them yet (feature is entirely unused until the frontend route ships). | Confirm (again, freshly, immediately before applying) that all four dependencies still match the signatures this file assumes — a fast, cheap re-check given how much time may pass between this plan's approval and its execution. | Call `admin_submit_expense_for_employee_v2` once, end-to-end, for a real (non-financial-impact) test case in a real organization the owner designates for this purpose — confirm the returned `expense_id` is real, `created_by_admin_id` is set correctly, and the expense is visible through the normal review pipeline exactly as a self-submitted one would be. |

**No entry for M4** — confirmed semantically identical to the live `list_report_export_jobs_v1` (one cosmetic error-message wording difference only); retired from deployment, nothing to apply.

**No entry for M6** — confirmed superseded by an already more sophisticated, independently-evolved live policy; retired, nothing to apply. See §5.

**No M1/M3 full-file entry** — both already live; only the one grant-hardening delta above is missing.

---

## 2) DO NOT EXECUTE

The following historical migration files must **not** be replayed wholesale, for the reasons already established in the audit:

- `20260827150000_report_export_jobs.sql` — table/RLS/bucket/functions already live. Re-running is a partial no-op at best (`CREATE TABLE IF NOT EXISTS`), and would not fix the confirmed grant gap (that's what the new delta migration is for) or the format/index drift (deliberately left alone, see §4 of the audit and the new migration's own header comment).
- `20260827170000_server_side_expense_reports.sql` — all 10 functions already live with matching signatures and (mostly) correct grants; only the delta migration's two `REVOKE` statements are missing.
- `20260827180000_report_export_history.sql` — confirmed semantically identical to what's live; do not replay.
- `20260828110000_org_scoped_audit_logs_select.sql` — **must never be applied as authored.** It would `DROP` and replace an already-hardened, independently-evolved live policy with a different one. See §5.

---

## 3) Live Frontend Version

**UNKNOWN — not provable from this vantage point.** The PesoWise frontend is hosted externally (Vercel per this project's prior documentation); this audit's SSH access reaches only the Coolify-hosted Supabase backend and cannot retrieve a Vercel deployment SHA, build ID, or commit hash. No `run-report-export-job` deployment, no bundled frontend asset, and no reachable `/api` version endpoint was found on the audited host that would answer this question.

**Reasoned inference (explicitly not a substitute for verification):** none of `source_expenses[].purpose`, `project_name_ambiguous`, or `admin_submit_expense_for_employee_v2` exist in any commit reachable from `main` (they only exist on unmerged integration branches). Since this project's Vercel deployments build from `main`, the live frontend almost certainly does not reference any of the three. This makes applying Migration 2's delta a **safe, forward-compatible schema change** the live frontend will simply not notice (extra JSON keys it never reads) — but this inference should be **directly confirmed** (e.g., by inspecting the live site's actual bundle, or Vercel's own deployment log) before or immediately after Migration 2's delta is applied, not relied upon indefinitely.

---

## 4) Verification queries for the manifest above

```sql
-- Pre/post-check for Order 1 (grant hardening)
SELECT p.proname, r.rolname, has_function_privilege(r.oid, p.oid, 'EXECUTE') AS can_exec
FROM pg_proc p CROSS JOIN (SELECT oid, rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')) r
WHERE p.proname IN ('create_expense_report_export_job_v1', '_report_humanize_field_key_v1')
ORDER BY p.proname, r.rolname;

-- Pre-check for Order 2 (save the exact pre-image before applying)
SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname = 'report_daily_project_rows_v1';

-- Post-check for Order 2 (confirm the delta landed, nothing else changed)
SELECT pg_get_functiondef(oid) LIKE '%project_name_ambiguous%' AS has_ambiguity,
       pg_get_functiondef(oid) LIKE '%''purpose'', g.purpose%' AS has_remarks
FROM pg_proc WHERE proname = 'report_daily_project_rows_v1';

-- Post-check for Order 3 (confirm the new objects exist and are correctly scoped)
SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='expenses' AND column_name='created_by_admin_id') AS column_exists,
       EXISTS(SELECT 1 FROM pg_proc WHERE proname='admin_submit_expense_for_employee_v2') AS rpc_exists;
```

---

## 5) M6 Disposition — Final

Re-read in full during this task; the live `"Users can view audit logs of viewable expenses"` policy (full text in the audit doc §10) was checked against the four required security properties:

| Property | Live policy result |
|---|---|
| Active same-org admin can see expected logs | **YES** — the nested `om2` `EXISTS` clause grants access when the caller is an active `admin` member of the SAME organization as the linked expense. |
| Unrelated-org admin cannot | **YES** — the `om2.organization_id = e.organization_id` predicate scopes the admin check to the expense's own organization; an admin of a different org fails this clause and also fails the OUTER `om.organization_id = audit_logs.organization_id` gate independently. |
| Owner access preserved | **YES** — `e.user_id = uid()` branch unchanged. |
| Assigned-engineer access preserved | **YES** — `e.assigned_engineer_id = uid()` branch unchanged. |
| No broader access than intended | **YES, and arguably narrower than my own proposal** — the live policy additionally requires the caller to hold ACTIVE membership in the exact organization the `audit_logs` row itself belongs to (an outer gate my own M6 draft did not include). |

**Disposition: M6 IS RETIRED / SUPERSEDED.** No replacement migration is proposed. `20260828110000_org_scoped_audit_logs_select.sql` remains in the repository as historical record of the analysis that led here, but is not a candidate for deployment.

---

## 6) M5 Final Safety Classification

Every table/column/function `20260828100000_admin_submit_expense_for_employee_v2.sql` references was re-checked against live Production in this task:

| Dependency | Live status |
|---|---|
| `replace_expense_form_field_values(uuid, uuid, jsonb)` | Live, signature matches, `SECURITY DEFINER`, `search_path=public` |
| `review_admin_verify_expense(uuid, text)` | Live, signature matches, `SECURITY DEFINER`, `search_path=public` |
| `review_approve_expense_v2(uuid, text)` | Live, signature matches, `SECURITY DEFINER`, `search_path=public` |
| `is_accountant_cashier(uuid, uuid)` | Live, signature matches |
| `organization_memberships`, `expenses`, `notifications`, `audit_logs`, `expense_balance_deductions` | All referenced by column name only (no schema changes assumed beyond what's already live); no drift found in any column this migration reads or writes |
| `organization_features`, `team_members`, `teams` (routing dependencies) | Referenced identically to how `approvalHierarchy.ts` already reads them; no drift found |

**No existing object is replaced or altered by this migration** — every statement is `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`, or `CREATE OR REPLACE FUNCTION` on functions that are confirmed absent (so `CREATE OR REPLACE` is equivalent to `CREATE` here, not a replacement of anything live).

**Classification: SAFE AS AUTHORED.** No changes required to this migration file before it is a candidate for deployment.

---

## 7) `finalize-expense-receipts` Timeout Classification

Re-examined per this task's explicit instruction not to mix an unrelated timeout fix into the authorization patch without clear evidence.

**Finding:** the authorization fix in this branch (`supabase/functions/finalize-expense-receipts/index.ts`) touches exactly one code region — the ownership check (`expense.user_id === user.id` → owner-OR-active-admin-membership). It does not touch the download → upload → verify sequence, the concurrency limit (`runWithConcurrency`, 2), or any timing-sensitive code path. The 613 early-termination events found in the audit are a property of that unrelated file-transfer sequence, not the authorization branch.

**Classification: AUTH FIX SAFE TO DEPLOY INDEPENDENTLY.** The timeout condition is real, ongoing, and pre-existing, and deploying the authorization fix will neither improve nor worsen it. It should be tracked and investigated as its own, separate piece of work — not bundled into this fix, and not treated as a blocker for this fix either.

**Edge Function deployment order (planning only, nothing deployed):**
1. `finalize-expense-receipts` — redeploy with the authorization fix once Migration 5 is live (the fix has no effect until admin-submitted expenses with receipts exist to finalize). Independent of the timeout issue.
2. `run-report-export-job` — deploy once Order 1–3 above are live and the owner has decided how job dispatch will actually be triggered (this repository's own worker code assumes something invokes it periodically or on-demand; no scheduler currently exists on the audited host for this specific function — see the audit's Phase F equivalent, not re-litigated here since no new evidence was gathered on this point this session).
3. The `finalize-expense-receipts` timeout issue: recommend a **separate, dedicated investigation** (not blocking either deployment above) — correlate isolate duration against receipt-batch size, check the actual per-file download/upload/verify timing inside the function, and determine whether Deno Edge Runtime's wall-clock limit is being approached by large batches, slow Storage round trips, or something else entirely.

---

## 8) What Was NOT Done In This Task

- No SQL was applied against Production.
- No Edge Function was deployed.
- No container was restarted.
- No backup was created (per explicit instruction — see the audit document's existing backup/restore mechanism description; a fresh pre-migration snapshot is still required before Order 1 above is ever actually executed, using that same established `supabase-backup.sh`/`pesowise-safe-backups` convention).
- `supabase/diagnostics/daily-report-recovery/` was not touched.
- `main` was not modified.
