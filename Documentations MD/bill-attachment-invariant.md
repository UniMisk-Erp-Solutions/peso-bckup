# Bill / receipt attachment invariant (amount above the org threshold)

**ID:** DOC-150 · **Last updated:** 2026-10-26 · **Status:** in progress (implemented locally; trigger not applied to Production) · **Branch:** `fix/bill-attachment-invariant` (on top of `fix/stranded-draft-submit-flow`)

## 1) Rule
`amount > organization_settings.attachment_required_above_amount` requires at least one valid attachment before the expense becomes `submitted`. Thresholds in Production today: MicroLink **499**, every other organisation **50**. "Above" is strict (499 and 499.00 need no bill; 499.01 does).

## 2) The incident (read-only, Production)
Expense `cbf46961` (MicroLink, employee 4056, 2026-09-27, Rs 800, "Bus travel"):

| time (UTC, 2026-10-02) | event |
|---|---|
| 14:48:12 | `save_draft` receipt (attach-first draft) |
| 14:48:13 | bill uploaded (image/png, 1.15 MB, persisted path) |
| **15:57:02** | **bill soft-deleted by the employee** (`deletion_source = file_upload_component`) |
| 16:03:43 | `submit` receipt -> status `submitted` (**0 active attachments**) |
| 16:16 / 16:19 / 16:27 / 16:29 | four `update_submitted` edits, still no bill |

Attachments now: 1 total, **0 active**. Bill present before submission: **YES (draft stage)**; present at submission: **NO**; deleted before submission: **YES**; added after: **NO**. Path: **MicroLink atomic single** (receipts). Threshold now 499; at incident time inconclusive (no settings history), 499 is consistent with the app's own check. **Confirmed invariant violation.**

Root cause, two parts:
1. **Client bug:** for an existing expense the form checked for a bill with `attachments ... eq(expense_id) limit(1)` and did **not** filter `deleted_at IS NULL`, so the deleted bill counted.
2. **No server enforcement:** `submit_microlink_expense_v1`, `_persist_microlink_expense_snapshot_v1`, `submit_microlink_expense_batch_v1` and both admin RPCs never read the threshold nor look at `attachments` (verified from the live function bodies). Only the browser checked.

## 3) Fix
- **Migration `20261028100000_attachment_requirement_on_submit_v1.sql`:** `validate_expense_attachment_requirement_v1(expense_id)` (raises 23514, hint `attachment_required`, message "Bill photos are required for expenses above ₹499. ...") called by **deferred constraint triggers** on INSERT as `submitted` and on the transition into `submitted` (same mechanism as the custom-field validators). One rule for every path; a rejected NEW submit rolls back and leaves no row; an existing draft is untouched and submits later under the same id.
- **Valid attachment:** row of this expense, `deleted_at IS NULL`, and a persisted reference (`storage_path` OR `file_url`; 7,984 legacy active rows have only `file_url`). Another expense's bill, a deleted bill and a temp upload with no attachment row never count.
- **Client:** the existence check ignores soft-deleted rows; an existing draft/rejected expense given new bill photos in the same submit links them **before** the submit (no draft save, no status flip); shared `isBillRequired` / message helper.
- **Exceptions:** only organisations in a restore window. There is NO admin exemption.
- Historical rows are not touched.

## 4) Enforcement matrix

| Path | Draft first? | Server logical id | Threshold read | Live-attachment check | Server-side | Can bypass? |
|---|---|---|---|---|---|---|
| MicroLink atomic single | only attach-first (needed to hold files) | receipts (key, action) | **now yes (trigger)** | **now yes** | yes | **no** |
| MicroLink atomic batch RPC | n/a (client batch is legacy) | n/a | trigger covers it | trigger covers it | yes | no |
| Generic single (resolver) | yes (identity row) | `client_submission_id` | trigger | trigger | yes | no |
| Existing draft -> submit | no | yes | trigger | trigger | yes | no |
| Generic batch | per-line drafts | `client_batch_id` + index | trigger per line | trigger per line | yes | no (a failing line stays a draft under its identity) |
| Rejected / withdrawn -> resubmit | no | same id | trigger | trigger | yes | no |
| Direct PostgREST draft -> submitted | n/a | n/a | trigger | trigger | yes | no |
| **Admin submit-for-employee / bulk submit** (v3, attach-first) | draft -> attachments -> promote | `admin_prepare_expense_for_employee_v1` (UUID key) + idempotency table | **yes (same threshold)** | **yes** | yes | **no** |

**Admin (resolved, migration `20261029100000_admin_submit_attach_first_v1.sql`):** no silent override. `admin_prepare_expense_for_employee_v1` creates ONE employee-owned draft (identity = UUID key); the client attaches receipts; `admin_submit_expense_for_employee_v3(..., p_existing_expense_id)` validates and promotes that same row and calls the shared validator immediately. `admin_bulk_submit_expenses_v3` calls v3 per row (an above-threshold row without a bill fails alone). A failure leaves exactly one reusable draft; a lost response resolves to the same expense. Routing, approval and balance logic are copied unchanged from v2. Old v2 functions remain but now fail above-threshold at commit. Client: `prepareExpenseForEmployee`, `AdminSubmitExpense.tsx`, bulk panel.

Shared batch receipts: in "shared" mode the service copies the same receipt onto every line (`copyAttachmentsFromExpense`), so each line has its own live attachment and satisfies the rule.

## 5) Historical scan (read-only; no row changed)
Non-draft, non-rejected, not-trashed expenses above the **current** threshold: 7,723; with **zero live attachments: 247** (18 had a deleted bill). Threshold-at-the-time is unknown, so some may predate a threshold change.
- MicroLink 145 of 1,655 (125 legacy-client path, 17 atomic path since 2026-09-09, 3 other), Bikes auto Hero 67 of 1,356 (all legacy, all approved), Patidar 34 of 4,570 (7 deleted-bill, all `submitted`), Mistry And Shah 1 (admin-submitted).
- By status: approved 220, level_2_verified 15, submitted 12. Atomic-path violations by month: 2026-08 1, 09 12, 10 4. Eight MicroLink expenses had a bill deleted before their first submit.
Remediation is a separate owner-approved task.

## 6) Residual risks
- A bill can still be deleted **after** submission (not blocked; reviewers see the missing bill). Blocking the last active attachment of a submitted above-threshold expense is a product decision.
- An old cached browser bundle that finalizes bills after the submit will get the friendly refusal and must reload.

## Deploy order
Merge PR -> wait for the frontend Production deploy of the merge commit -> verify live bundle -> THEN apply `20261028100000` and `20261029100000`. Never apply the trigger before the compatible frontend is live.

## Revision log
| Date | Rev | Change | By |
|------|-----|--------|----|
| 2026-10-26 | 1.0 | Incident forensics, enforcement matrix, trigger + client fix, tests. | Claude Code |
| 2026-10-27 | 1.1 | Admin exemption removed; admin attach-first RPCs (prepare/v3/bulk v3); ExpenseService existence check ignores soft-deleted bills; deploy order. | Claude Code |
