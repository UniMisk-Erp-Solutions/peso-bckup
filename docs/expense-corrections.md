# Manager / admin expense corrections

## Feature flag

Per organization, in **Master Admin** → organization feature matrix:

- Key: `allow_manager_admin_expense_corrections`
- When **disabled** (or no row in `organization_features`), correction UI is hidden and the RPC returns an error.

## Who can correct

- **Admin**: any other user’s expense in the org (not your own row as the submitter — the RPC blocks self-correction).
- **Assigned manager (engineer)**: only expenses where `assigned_engineer_id` is their user id, and the org feature is on.

## Allowed statuses

Corrections are allowed for: `submitted`, `verified`, `under_review`, `rejected`, `edited`.  
Not allowed: `draft`, `approved`, `paid`.

## After a correction

- Expense status becomes **`edited`** (shown as **Adjusted** to reviewers).
- **`expense_correction_logs`** stores JSON `before_json` / `after_json` for the corrected header fields and optional `reason`.
- **`audit_logs`** receives action `expense_corrected_by_reviewer`.
- **Employees** see the badge as **Submitted** (same pipeline messaging); they cannot open the edit form while status is `edited`.

## Verify / approve after `edited`

`ExpenseService.verifyExpense` and `approveExpense` treat **`edited`** like **`submitted`** where relevant so the normal review flow continues.

## Database (run in this order)

1. **`20260513139900_expense_status_add_edited_enum.sql`** — adds enum value `edited` only (must commit before step 2).
2. **`20260513140000_expense_corrections_edited_status.sql`** — audit table, `apply_expense_correction` RPC, RLS.
3. **`20260513150000_org_admin_expense_select_rls.sql`** — admins can see the full expense list.

If using the SQL Editor, run **step 1 alone**, wait for success, then run **step 2** (do not paste both in one run).

After all: **Supabase Dashboard → Settings → API → Reload schema**.

Enable the org feature in **Master Admin** → organization feature matrix → **Allow manager/admin to correct employee expenses**.

## RPC

`apply_expense_correction(p_expense_id uuid, p_updates jsonb, p_reason text default null)` — `p_updates` may include any of:

`title`, `destination`, `trip_start`, `trip_end`, `purpose`, `category`, `total_amount`, `admin_comment`
