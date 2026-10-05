# Admin Submits an Expense on Behalf of an Employee

**Doc ID:** DOC-109
**Status:** in progress
**Last updated:** 2026-08-28
**Owner / area:** Expenses — Admin-delegated submission

---

## 1) Summary

Lets an organization admin create an expense for a selected employee, instead of the employee submitting it themselves. This is the final Preet feature integrated into this lineage; `Preet-Patel/feature/balance-ledger-bulk-import` is separately marked SUPERSEDED / NO INTEGRATION REQUIRED (see `PENDING_MIGRATIONS_PREET_INTEGRATION.md` §9). Built as a single atomic, idempotent RPC rather than the source branch's two/three-step client-orchestrated pattern — see §5 for why. No database migration applied, no data touched, no Edge Function deployed.

## 2) Problem / business goal

An admin sometimes needs to record an expense for an employee who cannot submit it themselves (no app access, urgent reimbursement, bulk historical entry). This must remain **delegated action, not impersonation**: the admin never becomes the employee, the employee's own review routing/balance/audit trail must behave exactly as if they had submitted it themselves (except for the provenance record of who actually acted), and the browser must never be trusted as the authority for organization, employee identity, or financial state.

## 3) Source branch

`Preet-Patel/feature/admin-submit-expense-for-employee`, tip `225a31429da5bbc3ac8582d2b872ea36b5b55172`, verified unchanged from the prior audit's known tip; no later commits exist upstream. No shared git history with `main` (`git merge-base` returns nothing).

**Full commit history reviewed:** 16 commits total. Commits 1–10 (`e35e1999` through `461b3ff9`) are unrelated prior work sharing this physical branch — an initial full-codebase import, an unrelated "cloud maintenance control plane" merge, and a self-contained server-side-report-generation feature already integrated separately as DOC-106. Only the last 6 commits belong to this feature:

| Commit | Date | Summary |
|---|---|---|
| `91e6d13e` | 2026-08-24 | Origin: `admin_submit_expense_for_employee_v1`, `AdminSubmitExpense.tsx`, route/nav |
| `25ee6150` | 2026-08-24 | Bulk CSV/Excel import, `admin_bulk_submit_expenses_v1` |
| `3aa8f66d` | 2026-08-24 | Excel roster generator with live dropdowns (`exceljs`), DD-MM-YYYY dates |
| `46ea9f9b` | 2026-08-25 | Org-accurate custom expense fields, `orgExpenseFieldConfig.ts`, >1,000-row-safe pagination |
| `01d60835` | 2026-08-25 | Optional receipts, Submitted/Verified/Approved status choice, History tab, 2 RLS fixes |
| `225a3142` | 2026-08-25 | Inline receipt upload, Add Category, `finalize-expense-receipts` ownership-bypass fix (tip) |

Full per-commit classification (A–H) and the exact before/after SQL for every fix is in `PENDING_MIGRATIONS_PREET_INTEGRATION.md` §5c — not duplicated here.

## 4) Current integration parent

`integration/preet-daily-report-data-recovery-render` @ `2f6edfc50611741e61c8fb2b138ab23acf0e2494` (verified exact tip before branching; this parent branch was not modified after branching).

## 5) Actor vs. subject identity model

| Concept | Value | Never conflated with |
|---|---|---|
| SUBJECT / owner | `p_employee_id` → `expenses.user_id` | the admin |
| ACTOR | `auth.uid()` inside the RPC (the signed-in admin) | the employee |
| `created_by_admin_id` | set to the actor on every admin-submitted expense; NULL for every self-submitted one | — |
| audit actor | the admin, on every `audit_logs` row this feature writes | — |
| audit subject | the expense / the employee, named in the audit comment | — |
| review routing | computed from the **employee's** `reporting_engineer_id`/role/team | the admin's own hierarchy — never read |
| balance deduction target | the employee (`review_approve_expense_v2` resolves this from the expense row itself, unchanged) | — |
| uploader | the admin (`attachments.uploaded_by`), receipts staged under `temp/{adminId}/...` | the employee |
| timestamps / roles | server-generated / server-derived throughout | client-supplied values |

No impersonated session is required or possible: the admin's own `auth.uid()` is the only identity the database ever sees.

## 6) Authorization model

Every check happens **inside** `admin_submit_expense_for_employee_v2` (`SECURITY DEFINER`), not in RLS and not in React:

1. `auth.uid()` must exist.
2. Caller must be an **active** `admin` membership of `p_organization_id`.
3. `p_employee_id` must be an **active** member of the **same** `p_organization_id` (a UUID valid in a different org resolves to no role and is rejected — cross-org fails closed, not with a confusing downstream error).
4. Employee cannot equal the admin (self-submission uses the regular form).
5. Employee cannot be an accountant-cashier; a cashier employee requires the org's `allow_cashier_expense_submission` setting.
6. Status transitions delegate to `review_admin_verify_expense` / `review_approve_expense_v2`, which independently re-verify the caller is a permitted approver — no authorization logic is duplicated, only reused.
7. Receipt finalization is now admin-aware (see §10) with the identical org-admin-membership check pattern.

No single canonical `expense.submit_for_employee` capability function exists yet in this codebase (see Phase 6 of the task instructions) — authorization remains the established per-RPC inline-predicate style already used throughout this codebase (`expense_manager_can_review`, `expense_hierarchy_reviewer_can_act`). Centralizing this into one reusable capability helper would be a valuable, separate refactor spanning every existing expense RPC, not something to introduce silently as a side effect of one new feature.

## 7) Creation RPC architecture (Phase 7 — the central design decision)

**Source:** two/three separate round trips — create RPC, then `replace_expense_form_field_values`, then optionally a verify/approve call. The source's own documentation discloses the resulting gap: a failed second call leaves an already-created, already-reviewer-notified expense permanently missing a required field.

**This integration:** `admin_submit_expense_for_employee_v2`, one `SECURITY DEFINER` function, one transaction:

1. Authenticate actor, derive org, resolve employee, validate permission.
2. Validate base fields.
3. Check idempotency (replay or conflict, before anything is created).
4. Compute hierarchy routing from the **employee's** context.
5. Insert the expense (`status = 'submitted'`).
6. Save custom-field values by calling the existing `replace_expense_form_field_values` **inline, same transaction** — not reimplemented.
7. Write audit rows, notification rows.
8. Optionally call `review_admin_verify_expense` or `review_approve_expense_v2` — **same transaction**, canonical functions, unmodified.
9. Record the idempotency key.
10. Return the authoritative expense summary.

Any exception anywhere in steps 4–9 rolls back the entire transaction: no partial expense, no orphaned notification, no incomplete custom-field state, no status transition on an incomplete record. Structural proof (not just narrative) is in `src/lib/__tests__/adminSubmitExpenseSqlContract.test.ts`, which asserts the ordering and the absence of any duplicated financial/validation logic directly against the migration's own source text.

**What this does not close:** `replace_expense_form_field_values` does not itself enforce "this template is required" — a pre-existing, system-wide gap shared with the employee's own self-submission path (`ExpenseService.submitExpenseBatch`), not something this feature introduced or can safely fix in isolation without redesigning the whole custom-field validation architecture for every submission path at once. Documented, not hidden — see Outstanding Risks.

## 8) Custom-field architecture

Reuses the employee's own field engine unchanged: `CategoryFormFieldsSection`, `BaseExpenseFieldInput`, `useOnDemandOptionBranches` (on-demand branch fetch, never an eager "every branch for every template" download), and a new `src/lib/orgExpenseFieldConfig.ts` providing the org's base-field config, categories, category-assigned templates, and option branches to both the single-submit page and the bulk CSV parser. No second field-rendering engine was built.

## 9) >1,000-row protection

`expense_form_field_option_branches` has been observed to exceed 1,000 rows for a single organization (the same DOC-097 incident this codebase already learned from). `orgExpenseFieldConfig.ts`'s `fetchAllRows` pages via `.range()` until a page returns fewer than 500 rows — never a single unbounded select. Verified with a mocked Supabase client across 0/1/499/500/501/999/1000/1001/1999/2000/2001/5000 rows (`src/lib/__tests__/orgExpenseFieldConfigPagination.test.ts`, 14 tests): exact count, zero duplicates, correct termination at every boundary.

## 10) Receipt architecture (Phase 16/17/18)

Full path: `FileUpload` (unchanged, `expenseId="new"` stages to `temp/{adminId}/...`, no attachments row yet) → atomic RPC creates the real expense → `finalizePendingReceiptsForExpense` calls the same `finalize-expense-receipts` Edge Function (now admin-aware, see §11) → the browser inserts the `attachments` row only after a genuine `finalized`/`temporary_fallback` result. A storage-side "finalized" result whose metadata insert fails is counted as **failed**, never as success — no attachment row means no evidence exists, regardless of what Storage did (`src/lib/__tests__/adminSubmitExpense.test.ts`, "receipt evidence integrity" suite). Deletion safety is untouched: this feature never calls `storage.remove()` and reuses the existing `removeAttachmentSafely`/soft-delete architecture wherever attachments are later managed.

**Storage RLS:** this codebase's current receipts bucket INSERT policy is already `bucket_id = 'receipts' AND auth.uid() IS NOT NULL` — no ownership/org scoping at all. The admin's own temp-path upload already succeeds under this existing (over-permissive) policy without any new grant. The source branch's narrower "owner OR admin" policy was **not ported** — it would be a regression relative to this codebase's actual current state, not a fix. This pre-existing over-permissioning is a separate, out-of-scope security concern, flagged in Outstanding Risks, not silently narrowed as a side effect of this feature.

## 11) Edge Function authorization fix

`supabase/functions/finalize-expense-receipts/index.ts`'s ownership check was `expense.user_id = auth.uid()` only — inherited, unmodified legacy code predating this entire branch — which would reject every admin-delegated finalize call outright (403 `EXPENSE_ACCESS_DENIED`), silently swallowed by the browser's own designed-in fallback into a per-file `"failed"` result with no visible error. Fixed to authorize the exact owner **OR** an active `admin` membership of the expense's organization, verified via a direct `organization_memberships` query, mirroring the same admin-bypass pattern already used elsewhere in this codebase (the attachments table's own INSERT policy). Structural proof in `adminSubmitExpenseSqlContract.test.ts`. **Source-only — not redeployed.**

## 12) Submitted / Verified / Approved behavior

All three reuse canonical, unmodified paths — no status is ever set via a plain `UPDATE expenses SET status = ...`, and no balance math exists anywhere in this feature's own code:

- **Submitted** — the default; normal delegated submission, employee's own routing applies, no financial effect.
- **Verified** — `review_admin_verify_expense`, called from inside the same transaction; that function independently re-verifies the admin's permission.
- **Approved** — `review_approve_expense_v2`, the same atomic, `FOR UPDATE`-locked, `expense_balance_deductions`-evidenced RPC every other approval path in this codebase uses. No client-computed balance, no duplicate-deduction risk introduced by this feature (the RPC's own `UNIQUE(expense_id)` constraint on `expense_balance_deductions` is untouched).

## 13) Financial safety

Because Approved delegates to the pre-existing, already-hardened `review_approve_expense_v2`, every financial-safety property that RPC already guarantees (row locking, idempotent single deduction, fail-closed on an already-approved expense, no client-computed before/after balance) applies here automatically, with zero new financial code written. The only new financial-adjacent code in this feature is the routing/authorization/idempotency layer around expense **creation** — never the deduction itself.

## 14) Segregation-of-duties handling

The same admin creating and approving an expense in one action is deliberately not treated as an ordinary approval: it requires a mandatory typed reason (enforced client-side by `SubmitStatusChoiceDialog`, tested), shows an explicit balance-deduction warning, and writes a distinct, machine-searchable audit action — `admin_submitted_and_approved_for_employee` — in addition to whatever `review_approve_expense_v2` itself records, so this scenario can be queried and reported on without parsing free-text comments.

## 15) History architecture

`AdminExpenseHistoryTab` is server-paginated (25/page), filters `expenses.created_by_admin_id IS NOT NULL`, carries `{ count: "exact" }` scoped to the current search predicate (never an unfiltered total), and resolves display names via the existing `fetchProfileNamesByUserIds` — never a raw UUID. Row detail reuses the existing `ExpenseTimeline`/`enrichAuditLogsWithDisplay` pipeline, the same one `ExpenseDetail.tsx` already uses.

## 16) Idempotency

`admin_submit_expense_idempotency` (new table, `SECURITY DEFINER`-only access, no RLS policy at all — direct client access denied by default) records one row per successfully **committed** submission, written in the same transaction as the expense. A rolled-back attempt (validation failure) reserves no key, so retrying after a genuine failure is never blocked. A retry with the same key and the same payload hash replays the original result (`idempotent_replay: true`); a different payload under the same key is rejected as a conflict. Bulk requires a `client_operation_id` per row, used as that row's key.

## 17) Failure model

`src/lib/adminSubmitExpense.ts`'s `classifyRpcError` maps every RPC failure to one of the task's specified codes (`UNAUTHENTICATED`, `FORBIDDEN`, `EMPLOYEE_NOT_FOUND`, `EMPLOYEE_INACTIVE`, `CROSS_ORG`, `CATEGORY_INVALID`, `BRANCH_VALUE_INVALID`, `REQUIRED_FIELD_MISSING`, `IDEMPOTENCY_CONFLICT`, `EXPENSE_CREATE_FAILED`) — never a bare "Something went wrong." UI distinguishes "nothing created" from "expense created, receipt pending" via the finalize outcome's explicit `pendingCount`/`failedCount`.

## 18) Migrations

Two new migrations, both `PENDING / NOT APPLIED`, both using this lineage's own conflict-free timestamps (`20260828100000`, `20260828110000` — never the source branch's original timestamps). Full detail in `PENDING_MIGRATIONS_PREET_INTEGRATION.md` §5c and its ordered table (Migrations 5–6).

## 19) Deployment requirements (when eventually authorized)

1. Apply Migration 5 and Migration 6 to an isolated test DB, in order.
2. Redeploy `finalize-expense-receipts` with the admin-bypass fix.
3. Reload the PostgREST schema cache.
4. Run the manual QA checklist below against real (non-Production) data.

## 20) Source items superseded / excluded

- Two/three-step creation architecture → superseded by the atomic V2 RPC.
- Excel live-dropdown roster generator (`exceljs`) → excluded; CSV-only template with a reference block ships instead (documented scope decision, no new runtime dependency).
- Receipts Storage INSERT "owner OR admin" policy → superseded; this codebase's current policy is already broader (unscoped), so the source's narrower version would regress it.
- JSON backup/restore importer (`AdminExpenseImportPanel.tsx`/`expenseImport.ts`) → confirmed unrelated, not touched, not reused (it bypasses every business rule this feature depends on).

## 21) Tests

84 new tests across 5 files — see `PENDING_MIGRATIONS_PREET_INTEGRATION.md` §5c for the full breakdown. All pre-existing tests (3774) pass unmodified; two consecutive full-suite runs both 3858 passed / 0 failed.

## 22) Manual QA (for the owner, after explicit authorization to apply migrations to a non-Production database)

- Submit as Submitted / Verified / Approved for an employee with no hierarchy, with team-leader/executive tiers, with a team, and with an engineer role (should skip straight to admin).
- Submit for an employee in a different organization by passing their UUID directly (via the RPC, not the UI) — must fail with `EMPLOYEE_NOT_FOUND`.
- Submit twice with the same idempotency key and identical payload — must return the same expense, not create a second one.
- Submit a required custom field left blank — verify current behavior (accepted, since server-side required-ness enforcement is a pre-existing, not-yet-built gap — see Outstanding Risks) rather than assuming it is rejected.
- Approve on create as the same admin who submitted — verify the `admin_submitted_and_approved_for_employee` audit row and the exact `expense_balance_deductions` row.
- Upload a receipt, submit, confirm the attachment appears with `uploaded_by` = the admin and `expenses.user_id` = the employee.
- Bulk-import a CSV with one deliberately invalid row among valid ones — verify only the valid rows create expenses and the invalid row's exact error is reported.
- Bulk-import the exact same file twice — verify no duplicate expenses.
- View the History tab as an admin from a different organization — must see nothing from this org (relies on Migration 6's org-scoped `audit_logs` policy plus `expenses`' existing org-scoped RLS).

## 23) Outstanding risks

- Required custom-field enforcement is client-side only, system-wide (not unique to this feature) — a pre-existing gap, documented, not fixed here.
- The receipts Storage bucket's INSERT/UPDATE/DELETE policies remain unscoped by organization or path for ANY authenticated user, a pre-existing condition this feature does not worsen but also does not fix.
- `expense_categories`' active-flag column name (`active` vs `is_active`) is handled defensively (try/fallback on error code `42703`) rather than resolved at the schema level — mirrors the employee form's own existing `handleAddCategory` pattern exactly, not a new inconsistency.
- No live database was available this session; every SQL/Edge-Function change was verified by static review, direct schema cross-reference, and structural source-content assertions, not execution.

---

## Revision log

| Date | Change | By |
|---|---|---|
| 2026-08-28 | Initial version. Integrated ONLY `Preet-Patel/feature/admin-submit-expense-for-employee` onto `integration/preet-daily-report-data-recovery-render`. Rebuilt the two-step source creation flow as a single atomic, idempotent RPC. Ported both real security fixes (audit_logs RLS, finalize-expense-receipts ownership). Not ported: the Excel live-dropdown generator (CSV-only instead) and the Storage INSERT fix (already superseded by this codebase's broader existing policy). 84 new tests. Not merged, no database touched, Edge Function not redeployed. `Preet-Patel/feature/balance-ledger-bulk-import` marked SUPERSEDED / NO INTEGRATION REQUIRED in the same pass. | Claude Code |
