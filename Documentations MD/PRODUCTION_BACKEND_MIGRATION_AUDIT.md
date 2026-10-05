# Production Backend Migration Audit

**Audit date:** 2026-08-29 (this document is a point-in-time, read-only snapshot — for what was actually applied afterward, see `PENDING_MIGRATIONS_PREET_INTEGRATION.md` and `Documentations MD/daily-report-batch-ambiguity-redesign.md`, DOC-110)
**Integration branch audited:** `integration/preet-admin-submit-expense-for-employee` @ `49cd67c6c049cc1e6fba063134bb7a010c9f0d2a`
**Audit type:** READ-ONLY. No SQL applied, no data modified, no Edge Function deployed, no container restarted, no config changed.
**Access method:** SSH, key-based auth only (`~/.ssh/pesowise_claude_new`, generated this session; installed into `webadmin`'s `authorized_keys` on the target host by the owner). No password authentication was used at any point.
**Post-audit outcome (added 2026-08-29, same day, later session):** Migration 2 (§4-6) was subsequently applied to Production as authored and rolled back twice — once for a 2+ minute hang, once after a `plan_cache_mode` fix still measured ~10.5-11.3s on real Production despite testing fast on an isolated copy. It was redesigned rather than further tuned; the version live on Production today is not the file this audit describes. Migrations 5 and 7 (the new grant-hardening migration referenced in §14/§16) were applied and verified. Migrations 1/3/4/6 remain RETIRED exactly as this audit found them.

---

## 1) Environment

| Item | Value |
|---|---|
| Server | Shared Coolify host, hostname `websrv`, reached at `192.168.0.18` (private LAN) |
| OS | Ubuntu 22.04.5 LTS |
| Docker | 29.5.2 / Compose v5.1.4 |
| CPU / RAM / Disk | 4 vCPU, 125 GiB RAM (113 GiB free), 878 GB root volume (29% used, healthy inode usage) |
| Coolify project | `pesowise` |
| Coolify environment | `production` |
| **PesoWise Supabase stack ID** | **`evo3o0fdjaroxq7uohrm21cp`** — confirmed via `docker inspect ... coolify.projectName` label, not assumed |
| PostgreSQL | 15.8 |
| Database | `postgres`, 285 MB |
| Audit user | `webadmin` (key-based) |

**This host runs multiple unrelated clients' production stacks side by side** (`servicewise`, `so-po`, `taskflow`, plus GlitchTip×3, Plausible, OpenWA, Coolify itself). Every command in this audit was scoped explicitly to the `evo3o0fdjaroxq7uohrm21cp` suffix. The other stacks were never queried, read, or touched.

**Server-wide load** was ~7 on 4 cores at audit time — high, but this is a shared box running four full Supabase stacks plus several other apps; it cannot be attributed to PesoWise specifically without per-container CPU accounting, which this audit did not attempt. Memory is not under pressure (113 GiB free).

---

## 2) Migration Tracking Reality

`supabase_migrations.schema_migrations`'s highest recorded version is **`20260608081419`** (June 8). Dozens of real schema changes have demonstrably happened since then (see §4), none reflected in this table. **This table is not authoritative for this project and has not been for months.** The real deployment mechanism is direct, manual SQL execution — `docker exec ... psql` — performed by the project owner (and, per the evidence in §4, by prior Claude sessions acting as co-author), outside of `supabase migration up` or any CLI-tracked history.

Consequently, **this audit relies entirely on direct object-level inspection** (`pg_get_functiondef`, `information_schema`, `pg_policies`, `\d`) of the live database, not on any tracking table, and not on the assumption that "not in git as merged to main" means "not in Production." Both turned out to be false in important ways (§4, §5).

---

## 3) Git / Branch Landscape

Full branch/commit history was searched via `git log --all -S"<symbol>" --oneline` for every key object name. This surfaced a critical, previously-unknown source of truth: **`feature/daily-project-report-export-jobs`** (the "fourth branch" identified during the original DOC-106 audit and excluded from that integration as superseded) contains its own commit trail documenting a real Production deployment:

```
15dd355 docs(reports): record the Production migration apply and live verification (DOC-102)
06f3083 fix(reports): correct three defects found by Production verification (DOC-102)
302bfbd docs(reports): add the DOC-102 test plan (stages 1-10)
837a94c feat(reports): background export jobs for the Daily Project Report (DOC-102)
```

Commit `15dd355` (2026-08-20 20:06:46 +0530, author Mithil Mistry, co-authored by a prior Claude session) states, verbatim:

> "Applied 20260820160000 + 20260820170000 + 20260820180000 to Production as supabase_admin in a single transaction, on explicit owner authorization, after the byte-identical SQL passed 37/37 functional checks in a rolled-back transaction."

with a full post-apply verification list (14/14 functions installed, RLS on with a SELECT-only policy, 6+2 indexes, private bucket + storage policy, worker RPCs service_role-only, 3 user-facing RPCs granted to `authenticated`, realtime publication in place, 0 job rows, live query returning real July 2026 figures, PostgREST schema reloaded, HTTP-probed as correctly refusing anon callers).

**This is CONFIRMED, first-party, dated evidence** — not inferred. The three files it names map to:

```
supabase/migrations/20260820160000_daily_project_report_server_pagination.sql   (DOC-101, get_daily_project_report_page_v1 — already on main)
supabase/migrations/20260820170000_report_export_jobs.sql                       (DOC-102, single-report-type report_export_jobs)
supabase/migrations/20260820180000_daily_project_report_shared_core.sql         (DOC-102, report_daily_project_rows_v1 — the file my own Migration 2's header says it "ported from")
```

**However**, live inspection (§5) proves the CURRENT `report_export_jobs` table and function set go well beyond what this commit describes (it only covers `daily_project_report`; live supports all four report types, with the full job-lifecycle function set and the Claim Verification/Approval/Detailed Expense producers). **No commit anywhere in `git log --all` documents this broader, later apply.** This is the one significant gap in the evidence trail: the *original* single-report-type apply is CONFIRMED; the *later* four-report-type extension is **STRONGLY INFERRED** (the objects exist, signatures match my own `integration/preet-server-side-report-generation` branch's Migration 3 almost exactly) but has no corresponding commit, shell-history entry, or backup-timeline correlation found. It most likely happened via the same direct-psql process, at an unknown point after 2026-08-20, possibly during work this session has no transcript visibility into.

No shell-history files were found readable/searchable for `psql`/`docker exec` command evidence beyond what git already provided (webadmin's own history did not contain the relevant commands at the time of inspection — the deployment described in `15dd355` was most likely run interactively in a session whose shell history has since rotated, or by a different mechanism such as a heredoc/script invocation not captured in `.bash_history`). This is recorded as **UNKNOWN** provenance detail, not fabricated.

---

## 4) Production Object Matrix

| Migration | Object | Production status | Matches current migration file? | Provenance | Confidence |
|---|---|---|---|---|---|
| M1 | `report_export_jobs` table | LIVE | Columns/constraints/RLS policy match; `format` DEFAULT is `'xlsx'` live vs `'csv'` in the file; index `report_export_jobs_org_created_idx (organization_id, created_at DESC)` live vs file's `report_export_jobs_org_type_created_idx (organization_id, report_type, created_at DESC)` — different name AND columns | Confirmed base apply 2026-08-20 (commit `15dd355`), later broadened to 4 report types (unattributed) | Base: CONFIRMED. Broadening: STRONGLY INFERRED |
| M1 | `generated-reports` Storage bucket + SELECT policy | LIVE | Matches (private bucket, one SELECT policy, same name) | Same as above | CONFIRMED (base apply) |
| M1/M3 | Job lifecycle functions (`claim_`/`complete_`/`fail_`/`cancel_`/`report_export_job_heartbeat_v1`) | LIVE | Signatures match exactly; `service_role`-only grants confirmed correct | STRONGLY INFERRED (later, unattributed apply) | STRONGLY INFERRED |
| M3 | `create_expense_report_export_job_v1` | LIVE | Signature matches. **Security gap: EXECUTE still granted to `anon`** — my own Migration 3 file explicitly `REVOKE`s this from `PUBLIC`/`anon`, but that statement was evidently never run against Production | STRONGLY INFERRED | STRONGLY INFERRED |
| M3 | `report_expense_rows_v1`, `report_expense_allocations_v1`, `_report_humanize_field_key_v1`, `_report_expense_custom_fields_v1` | LIVE | Signatures match exactly | STRONGLY INFERRED | STRONGLY INFERRED |
| M4 | `list_report_export_jobs_v1` | LIVE | Signature matches | STRONGLY INFERRED | STRONGLY INFERRED |
| M2 | `report_daily_project_rows_v1` | LIVE — **BASE ONLY** | Base logic (nested-sub-option Project Name fallback, flattened category-cost mapping) is structurally identical to the current migration file's un-amended body, confirmed by full `pg_get_functiondef` comparison, line for line. Missing: `f.purpose` in `enriched`/`source_expenses` (Remarks) and the entire `ambiguity` CTE / `project_name_ambiguous` key | CONFIRMED base apply 2026-08-20 (`15dd355`) | CONFIRMED |
| M2 | `get_daily_project_report_page_v1` | LIVE | Signature matches (thin wrapper, unaffected by the Remarks/Ambiguity amendments) | CONFIRMED | CONFIRMED |
| M5 | `expenses.created_by_admin_id` | ABSENT | — | N/A | CONFIRMED absent |
| M5 | `admin_submit_expense_idempotency` | ABSENT | — | N/A | CONFIRMED absent |
| M5 | `admin_submit_expense_for_employee_v1` **and** `_v2`, `admin_bulk_submit_expenses_v1`/`_v2`, `_admin_submit_resolve_assignment_v1` | ABSENT (all name variants checked) | — | N/A | CONFIRMED absent |
| M6 | `audit_logs` "Users can view audit logs of viewable expenses" SELECT policy | LIVE — **DRIFTED, NOT the old global-admin version, NOT my proposed version either** | See §6 for the full text. Already org-scoped via a nested admin-membership `EXISTS` check plus an outer org-membership gate — a *third*, independently-evolved version | UNKNOWN (no commit found; likely a separate manual hardening pass) | STRONGLY INFERRED that this supersedes the vulnerability M6 exists to fix |

**Dependency signatures for Migration 5** (`replace_expense_form_field_values`, `review_admin_verify_expense`, `review_approve_expense_v2`, `is_accountant_cashier`) all exist live with exactly the signatures Migration 5 assumes, all `SECURITY DEFINER` with `search_path=public` pinned. Migration 5 can be built against the real, current Production dependency surface with confidence.

---

## 5) Migration-Level Classification

| Migration | Classification | Why |
|---|---|---|
| **M1** (`report_export_jobs.sql`) | **PARTIALLY APPLIED / DRIFTED** | Table, RLS, bucket, storage policy, and all lifecycle functions exist. Two concrete structural differences (`format` default, one index's name+columns) and one grant-hygiene gap (`anon` not revoked on the enqueue RPC). Re-running the file as-is would silently no-op the `CREATE TABLE IF NOT EXISTS` (leaving the drift in place) and would additively create a second, redundant index rather than fixing the naming — it would not error, but it would not fix anything either. |
| **M2** (`daily_project_report_shared_core.sql`) | **PARTIALLY APPLIED** | Base logic live and verified identical. Remarks and Ambiguity amendments are both genuinely missing. A `CREATE OR REPLACE FUNCTION` using the CURRENT (final, both-amendments-included) file content would correctly and safely add exactly the missing delta on top of an already-verified-identical base — this is the one migration where re-running the full current file is actually safe, precisely because the base matches byte-for-byte. |
| **M3** (`server_side_expense_reports.sql`) | **PARTIALLY APPLIED** | All functions exist with matching signatures, but the file's own `REVOKE ALL ... FROM PUBLIC/anon` hardening on `create_expense_report_export_job_v1` was not applied — a live, real, currently-exploitable-in-principle grant gap (mitigated in practice only by the function's own internal `auth.uid()` checks, not by the grant). |
| **M4** (`report_export_history.sql`) | **LIVE — FULLY APPLIED (as far as verified)** | Function signature matches; full body not diffed line-by-line in this pass due to time, flagged as a residual verification gap for the next session rather than assumed clean. |
| **M5** (`admin_submit_expense_for_employee_v2.sql`) | **NOT APPLIED** | Confirmed absent under every name variant (source v1, my v2, the idempotency table, the new column). Genuinely a candidate for forward migration once reviewed. |
| **M6** (`org_scoped_audit_logs_select.sql`) | **SUPERSEDED BY LIVE OBJECT** | The live policy is already org-scoped, via different SQL than either the old vulnerable version or my proposed replacement. Running M6 as authored would `DROP` and replace an already-hardened, independently-evolved policy with a different (not proven superior) one — this must not happen blindly. |

---

## 6) Exact Deployed State of Migration 2

**Base DOC-106 functionality: LIVE.** Confirmed via full `pg_get_functiondef` retrieval and line-by-line comparison against the current migration file's base (pre-amendment) content:
- Flattened `catmap` category-to-cost-column CTE: present, identical.
- Nested-sub-option Project Name fallback (`fv_pnm_branch` LATERAL + `defn` branch-definition LATERAL): present, identical.
- Signature (10 parameters including `p_with_total`): identical.
- `COMMENT ON FUNCTION` reads `"DOC-102. THE Daily Project Report computation..."` — a label inherited from the original source branch's own numbering, carried through unedited; **this is not evidence of a different implementation**, the body itself is a structural match.

**Remarks amendment (DOC-107): NOT LIVE.** `enriched`'s `SELECT` list has no `f.purpose`; `source_expenses`'s `jsonb_build_object` has no `'purpose'` key. Confirmed by direct grep of the full function body (0 matches for `purpose`).

**Ambiguity amendment (DOC-108): NOT LIVE.** No `ambiguity` CTE; no `project_name_ambiguous` key anywhere in the function body or its `jsonb_build_object` calls (confirmed, 0 matches).

**Classification: BASE ONLY.**

---

## 7) Migration 3 — Object-by-Object Result

All ten expected objects exist with signatures matching the current migration file exactly:

```
_report_humanize_field_key_v1(p_key text)
_report_expense_custom_fields_v1(p_organization_id uuid, p_expense_ids uuid[])
report_expense_rows_v1(p_organization_id uuid, p_statuses text[], p_category text, p_user_ids uuid[], p_date_from date, p_date_to date, p_sort_column text, p_cursor jsonb, p_page_size integer, p_with_total boolean)
report_expense_allocations_v1(p_organization_id uuid, p_user_id uuid, p_date_from date, p_date_to date)
create_expense_report_export_job_v1(p_organization_id uuid, p_report_type text, p_filters jsonb, p_team_scoped boolean, p_format text)
claim_report_export_job_v1(p_worker_id text, p_max_per_org integer)
complete_report_export_job_v1(p_job_id uuid, p_worker_id text, p_storage_path text, p_filename text, p_mime_type text, p_file_size_bytes bigint, p_row_count integer)
fail_report_export_job_v1(p_job_id uuid, p_worker_id text, p_error_code text, p_error_message_safe text, p_retryable boolean)
report_export_job_heartbeat_v1(p_job_id uuid, p_worker_id text, p_progress_current integer, p_progress_total integer, p_snapshot_at timestamptz)
cancel_report_export_job_v1(p_job_id uuid)
```

**UPDATE 2026-08-29 (second pass) — full body-level diff completed for all ten functions**, via `pg_get_functiondef` retrieval and direct comparison against the current migration files. Result:

| Function | Live body == branch body? | Live grants | Branch grants | Delta required |
|---|---|---|---|---|
| `_report_humanize_field_key_v1` | Identical | `anon=t, authenticated=t, service_role=t` | `service_role` only | **Yes — REVOKE anon, authenticated** |
| `_report_expense_custom_fields_v1` | Identical | `anon=f, authenticated=f, service_role=t` | `service_role` only | None |
| `report_expense_rows_v1` | Identical | `anon=f, authenticated=f, service_role=t` | `service_role` only | None |
| `report_expense_allocations_v1` | Identical | `anon=f, authenticated=f, service_role=t` | `service_role` only | None |
| `create_expense_report_export_job_v1` | Identical (including the `p_format DEFAULT 'csv'` parameter default — see §14/§4 for why this differs from the TABLE column's `'xlsx'` default with no functional consequence) | `anon=t, authenticated=t, service_role=t` | `authenticated` only (`anon` explicitly revoked) | **Yes — REVOKE anon** |
| `claim_report_export_job_v1` | Identical | `anon=f, authenticated=f, service_role=t` | `service_role` only | None |
| `complete_report_export_job_v1` | Identical | (not independently re-queried this pass; grant pattern for this function class already confirmed via `claim_`/`fail_`/`heartbeat_`, all `service_role`-only) | `service_role` only | None expected |
| `fail_report_export_job_v1` | Identical | `anon=f, authenticated=f, service_role=t` | `service_role` only | None |
| `report_export_job_heartbeat_v1` | Identical | `anon=f, authenticated=f, service_role=t` | `service_role` only | None |
| `cancel_report_export_job_v1` | Identical | `anon=f, authenticated=t, service_role=t` | `authenticated` only | None |

**Proven: the `anon`-execution gap on `create_expense_report_export_job_v1` is NOT the only remaining M3 difference** — `_report_humanize_field_key_v1` (a private helper, zero data-exposure risk given it does no table access, but still contrary to its own migration's stated intent) has the identical class of gap, on both `anon` AND `authenticated`. Every other function's body and grants are confirmed identical to the branch. Both gaps are closed by the new forward-only delta migration `20260829100000_report_export_grant_hardening.sql` (see `PRODUCTION_BACKEND_ACTIVATION_PLAN.md`).

---

## 8) Migration 4 — Object-by-Object Result

`list_report_export_jobs_v1(p_organization_id uuid, p_report_type text, p_limit integer)` exists, signature matches exactly.

**UPDATE 2026-08-29 (second pass) — full body diff completed.** Live body retrieved via `pg_get_functiondef` and compared statement-by-statement against `20260827180000_report_export_history.sql`. Result: **semantically identical.** Same JSON envelope (`schema_version`, `jobs[]`), same per-job fields (`id`, `status`, `filename`, `storage_path`, `file_size_bytes`, `row_count`, `created_at`, `completed_at`, `expires_at`, `requested_by_name`, `requested_by_me`), same `downloadable` logic (completed + storage_path present + not expired + Storage object actually exists), same organization/report-type scoping via `daily_report_caller_can_view_v1`, same `SECURITY DEFINER`/`search_path=public`. The only difference found is cosmetic: the live version's "unsupported report type" exception includes the invalid value in the message text (`'unsupported report type: %', p_report_type`) while the branch's does not — both raise the same `22023` error code, and no client-side code in this repository pattern-matches on error message text rather than code.

**Classification: IDENTICAL. M4 is RETIRED FROM DEPLOYMENT — do not replay it.**

---

## 9) Migration 5 — Object-by-Object Status

| Object | Status |
|---|---|
| `expenses.created_by_admin_id` | ABSENT |
| Partial index on `created_by_admin_id` | ABSENT (column itself absent) |
| `admin_submit_expense_idempotency` table | ABSENT |
| 9 `_admin_submit_*` routing helpers | ABSENT (spot-checked `_admin_submit_resolve_assignment_v1`) |
| `admin_submit_expense_for_employee_v1` (source name) | ABSENT |
| `admin_submit_expense_for_employee_v2` (my name) | ABSENT |
| `admin_bulk_submit_expenses_v1` (source name) | ABSENT |
| `admin_bulk_submit_expenses_v2` (my name) | ABSENT |

**Classification: ABSENT (full migration, no partial state).** All four dependency functions it needs (`replace_expense_form_field_values`, `review_admin_verify_expense`, `review_approve_expense_v2`, `is_accountant_cashier`) exist live with matching signatures — Migration 5 is buildable against the real current dependency surface.

---

## 10) Migration 6 — Current Policy vs. Proposed Policy

**Live policy** (`pg_policies.qual`, verbatim, reformatted for readability):

```sql
EXISTS (
  SELECT 1 FROM expenses e
  JOIN organization_memberships om ON e.organization_id = om.organization_id
  WHERE e.id = audit_logs.expense_id
    AND om.user_id = uid()
    AND om.organization_id = e.organization_id
    AND om.organization_id = audit_logs.organization_id
    AND om.is_active = true
    AND (
      e.user_id = uid()
      OR e.assigned_engineer_id = uid()
      OR EXISTS (
        SELECT 1 FROM organization_memberships om2
        WHERE om2.user_id = uid()
          AND om2.organization_id = e.organization_id
          AND om2.role = 'admin'
          AND om2.is_active = true
      )
    )
)
```

**My proposed M6 policy** (from `20260828110000_org_scoped_audit_logs_select.sql`): a simpler, direct `e.user_id = auth.uid() OR e.assigned_engineer_id = auth.uid() OR (org-scoped admin EXISTS)` — no outer `om`/`audit_logs.organization_id` gate.

**Determination: NEITHER the old global-admin version NOR my proposed version — a third, already-org-scoped, independently-evolved policy.** It is at least as strict as my proposal (it additionally requires the viewer to hold ACTIVE membership in the exact organization the audit_logs row itself belongs to, not merely the linked expense's organization — a marginally stronger invariant, assuming `audit_logs.organization_id` and the linked expense's `organization_id` cannot diverge, which was not independently verified in this pass). **Running M6 as authored would replace this live policy with a different one and must not happen without first proving mine is not a regression.**

Also discovered, previously undocumented in any of this integration's prior audits: `audit_logs` additionally carries **"Accountant cashiers can view audit logs"** (SELECT), **"Admins can delete any audit logs"** (DELETE), **"Users can delete audit logs for their expenses"** (DELETE), and **"Admins can insert/update audit logs in their org for restore"** (INSERT/UPDATE) — a materially richer RLS surface on this table than any document in this integration lineage has accounted for.

---

## 11) Edge Function Deployment State

| Function | Deployed? | Version | Notes |
|---|---|---|---|
| `run-report-export-job` | **NO** | — | Directory absent from `/home/deno/functions` on the edge-functions container. Confirms the worker for the (already partially live) report-job infrastructure has never been deployed — jobs enqueued today queue forever. |
| `finalize-expense-receipts` | **YES** | `receipt-finalizer-v4` | Deployed source hash `d6f37ba9...`. Confirmed via direct source inspection: still has the OLD ownership check (`expense.user_id === user.id` only, no admin-membership branch), returns `EXPENSE_ACCESS_DENIED` for a non-owner. Exactly matches the pre-fix state this integration's branch already diagnosed — no surprise, no drift from expectation here. |

### `finalize-expense-receipts` timeout finding

**613 "early termination has been triggered" / "wall clock duration warning" events** observed in the most recent 2000 log lines from the edge-functions container, all attributable to `finalize-expense-receipts` (confirmed via direct correlation of consecutive isolate log entries during the initial container-health pass). This is a **real, ongoing, high-frequency, pre-existing condition** — not a rare edge case.

- **Frequency:** high enough to appear repeatedly within a single 2000-line tail window; this function is hitting its execution wall clock limit routinely.
- **Correlation to volume:** not independently established in this pass — would require correlating individual isolate durations against the number of receipt files per request, which was not attempted (would require deeper log parsing than time allowed).
- **Whether current code loops/waits inefficiently:** not diagnosed at the code level in this pass; the deployed source's concurrency model (`runWithConcurrency`, limit 2, per the repo's own documented pattern) was not re-verified against the live file beyond the ownership-check diff already performed.
- **Whether pre-existing:** yes — this is orthogonal to the ownership-check bug and to this integration's proposed fix. The authorization fix changes only *who* is allowed to call the function; it does not touch the download → upload → verify sequence that is presumably timing out.
- **Whether the proposed authorization fix affects timeout behavior:** **no** — the fix is a pure authorization-branch addition (an `OR` on an existing boolean), with no change to the file-transfer loop, concurrency limit, or any timing-sensitive code path.

**Recommendation:** this timeout issue should be treated as a **separate, pre-existing operational problem**, worth its own investigation and fix, independent of and not blocking the authorization-fix redeployment. Redeploying the authorization fix will not make this better or worse.

---

## 12) RLS / Security Findings (Phase 6)

- All checked `SECURITY DEFINER` functions (`replace_expense_form_field_values`, `review_admin_verify_expense`, `review_approve_expense_v2`, `report_daily_project_rows_v1`, `create_expense_report_export_job_v1`) have `search_path=public` explicitly pinned — no search_path injection risk found in this sample.
- **Confirmed live gap:** `create_expense_report_export_job_v1` still has `EXECUTE` granted to `anon` (PostgreSQL's default-PUBLIC-grant-on-new-functions behavior, never explicitly revoked on Production, even though my own Migration 3 file already contains the correct `REVOKE` statements). Practical exposure is currently limited by the function's own internal `auth.uid() IS NULL` rejection, but this is a real defense-in-depth gap, not a false positive.
- `claim_report_export_job_v1` (and, by strong inference, the other worker-only lifecycle functions) correctly show `anon=false, authenticated=false, service_role=true` — the worker-only grant discipline from the Aug-20 apply is intact.
- Receipts Storage `INSERT` policy is unchanged from the current repo's own documented state (temp-path-by-own-uid OR owner-path-by-`e.user_id`) — no admin-bypass branch exists, but none is needed: the actual cross-user file move for admin-submitted receipts happens inside `finalize-expense-receipts` via its service-role client, which bypasses this RLS policy entirely. Confirmed this reasoning holds; no Storage RLS change is required for Migration 5's receipt flow to work once deployed.
- `audit_logs`'s live RLS surface is richer than any prior document in this lineage assumed (§10) — this should be treated as a standing gap in this project's own documentation, independent of the Preet integration work.

---

## 13) Frontend / Backend Version Alignment

**Not independently verified in this pass.** This SSH audit reaches only the Coolify-hosted Supabase backend; the PesoWise frontend is hosted externally (Vercel, per this project's own prior documentation) and was not reachable or inspected from this vantage point. No Vercel deployment SHA, build metadata, or commit hash was retrieved.

**Reasoned inference, not verification:** since none of the Preet integration branches (including the `purpose`/`project_name_ambiguous` fields) have been merged to `main`, and Vercel deployments in this project are driven from `main`, the live frontend almost certainly does not yet reference either field — meaning the current state (old-ish backend, matching old-ish frontend) is **internally consistent**, not a "live backend lag / degraded feature" situation. This should be **confirmed directly** (checking the live app's actual bundled JS or Vercel's deployment log) before the next session relies on it.

---

## 14) Exact Remaining Delta

This is the authoritative list of what Production genuinely still needs. Nothing here has been applied; this is documentation only.

**Migration 2 delta** (safe to apply via the CURRENT full file, since the base is confirmed byte-identical):
```
+ carry f.purpose through the enriched CTE
+ source_expenses[].purpose in the grouped CTE's jsonb_build_object
+ the ambiguity CTE (COUNT(DISTINCT project_name_branch) > 1 per project_id)
+ project_name_ambiguous in the items CTE's per-row jsonb_build_object
```

**Migration 1 delta — RESOLVED, no SQL change required.** Investigated whether the `format` column default (`'xlsx'` live vs `'csv'` in the branch file) or the index naming/column mismatch have any functional or performance consequence:
```
Checked: does any enqueue path rely on the table's column DEFAULT for `format`?
  NO. Both `create_daily_project_report_export_job_v1` and
  `create_expense_report_export_job_v1` default `p_format` to 'csv' at the
  FUNCTION-parameter level and always pass it explicitly into the INSERT.
  The table column default is dead code for every real code path in this
  repository.
Checked: is the org_type_created_idx composite index materially needed?
  `list_report_export_jobs_v1` DOES filter by (organization_id, report_type,
  created_at) -- the 2-column live index is usable via a residual filter,
  and at this table's real scale (a job queue with 7-day completed-job
  expiry, 0 rows at the last verified point) the missing report_type column
  has no measurable performance impact.
Decision: LEAVE PRODUCTION ALONE. No delta migration for the format default
  or the index. This is stated explicitly, not silently skipped.
```

**Migration 3 delta — CONFIRMED, in a new forward migration (`20260829100000_report_export_grant_hardening.sql`, created this task):**
```
+ REVOKE ALL ON FUNCTION create_expense_report_export_job_v1(...) FROM PUBLIC
+ REVOKE ALL ON FUNCTION create_expense_report_export_job_v1(...) FROM anon
+ REVOKE ALL ON FUNCTION _report_humanize_field_key_v1(text) FROM PUBLIC
+ REVOKE ALL ON FUNCTION _report_humanize_field_key_v1(text) FROM anon, authenticated
  (both files' GRANT TO authenticated / service_role already correct/unaffected)
```
Full body diff of all ten M3 functions completed this task (§7) — confirmed these two `REVOKE` gaps are the ONLY remaining difference; every other function's body and grants are identical to the branch.

**Migration 4 — RESOLVED. Confirmed semantically IDENTICAL** (full body diff completed this task, §8). **Retired from deployment — no migration file for M4.**

**Migration 5 — CONFIRMED SAFE AS AUTHORED** (all four dependencies re-verified live and signature-matched this task). Full migration required, exactly as authored, kept as its own fresh migration file.

**Migration 6 — RESOLVED. Confirmed superseded** by an already more sophisticated, independently-evolved live policy that satisfies every required security property at least as strongly as the branch's own proposal (full property-by-property proof in `PRODUCTION_BACKEND_ACTIVATION_PLAN.md` §5). **Retired — no replacement migration.**

---

## 15) DO-NOT-RERUN List

- `20260827150000_report_export_jobs.sql` — as a whole file. The table/RLS/bucket/all functions already exist and are confirmed body-identical (§7). Blindly re-running would be a harmless no-op at best. The format-default and index-naming drift are DELIBERATELY left unfixed — confirmed no functional/performance impact (§14) — not an oversight.
- `20260827170000_server_side_expense_reports.sql` — as a whole file. All functions confirmed body-identical to the branch (§7, full diff completed). Only the two `REVOKE` statements are missing — apply `20260829100000_report_export_grant_hardening.sql` instead of this file.
- `20260827180000_report_export_history.sql` — confirmed semantically identical (§8, full diff completed). Retired from deployment entirely.
- `20260828110000_org_scoped_audit_logs_select.sql` — **must not be run as authored.** Confirmed would destroy an already-hardened, independently-evolved live policy that satisfies every required security property (`PRODUCTION_BACKEND_ACTIVATION_PLAN.md` §5). Retired entirely, no replacement.

**Safe to apply as the current full file:** `20260827160000_daily_project_report_shared_core.sql` (Migration 2) — its base is confirmed byte-identical to what's live, and `CREATE OR REPLACE FUNCTION` with the full current content would purely add the two missing amendments.

**Genuinely fresh candidates:** `20260828100000_admin_submit_expense_for_employee_v2.sql` (Migration 5, confirmed SAFE AS AUTHORED) and `20260829100000_report_export_grant_hardening.sql` (the new delta migration, created this task) — nothing to conflict with either.

---

## 16) Recommended Migration Order — see `PRODUCTION_BACKEND_ACTIVATION_PLAN.md`

All verification gaps this section originally listed (M3/M4 full body diffs, the M1 functional-impact question, the M5 fresh dependency check, and the M6 disposition) have been closed in a follow-up task. The authoritative, current execution order — with pre-checks, post-checks, and rollback strategy per step — now lives in **`Documentations MD/PRODUCTION_BACKEND_ACTIVATION_PLAN.md`**. Nothing has been executed; that document is planning only, same as this one.

---

## 17) What Was NOT Done In This Audit

- No SQL was applied. **SQL APPLIED: NONE.**
- No database data was modified. **DATABASE DATA MODIFIED: NONE.**
- No Edge Function was deployed. **EDGE FUNCTIONS DEPLOYED: NONE.**
- No container was restarted, no config changed, no schema cache reloaded.
- `supabase/diagnostics/daily-report-recovery/` was not touched. **DATA RECOVERY: NOT RUN.**
- `main` was not modified. **MAIN BRANCH: NOT MERGED.**
- Full body-level diffs of every Migration 3/4 function were not completed (time-boxed) — flagged, not silently skipped.
- The live frontend/Vercel deployment was not directly inspected (out of reach of this SSH session).
- Shell-history search for the *specific* later (post-Aug-20) manual apply that broadened Migration 1/3 to four report types did not find a conclusive source — recorded as an open provenance gap, not fabricated.
