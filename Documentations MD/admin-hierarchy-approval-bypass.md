# Admin hierarchy approval bypass

**Last updated:** 2026-06-23  
**Status:** in progress (requires migration on prod)  
**ID:** DOC-002

## Purpose

Organization administrators can approve expenses at any stage of the approval hierarchy without waiting for team leader, executive, or manager verification steps. Batch review works for admins, executives, and team leaders without RLS 403 errors.

## Problem

1. With `approval_hierarchy` enabled, admins were blocked when `approval_tier` was still `team_leader` or `executive`.
2. Batch **Verify** routed team leaders and executives through `adminVerifyExpense`, causing **403** on direct `expenses` UPDATE (RLS).
3. Admin **Approve** / **Verify** used direct client UPDATE; missing or narrow RLS policies returned **403**.

## Fix

- Admins skip the hierarchy tier gate in `approveExpense` (managers still require prior tier verification).
- `processBatchReview` routes verify by role: admin → admin verify RPC; TL/executive → `advanceExpenseTier` RPC; manager → `review_verify_expense`.
- `review_admin_verify_expense` and `review_approve_expense` SECURITY DEFINER RPCs for admin/manager approve paths.
- Re-assert admin and expanded engineer UPDATE RLS on `expenses`.

## Key files

- `src/services/ExpenseService.ts` — `processBatchReview`, `approveExpense`, `adminVerifyExpense`
- `src/lib/approvalHierarchy.ts` — `ADMIN_APPROVABLE_STATUSES`
- `src/lib/batchExpenseReview.ts` — `adminActionsForExpense`
- `src/pages/AdminPanel.tsx` — bulk approve filter; single-expense dialog Approve for `level_1_verified` / `level_2_verified`
- `supabase/migrations/20260702120000_expense_review_admin_approve_rpc.sql`

## Database

Run in Supabase SQL Editor (then reload API schema):

- [`supabase/migrations/20260702120000_expense_review_admin_approve_rpc.sql`](../supabase/migrations/20260702120000_expense_review_admin_approve_rpc.sql)

## Test plan

1. Apply migration and deploy frontend.
2. **Admin:** batch Approve on verified expenses at TL/executive tier — no 403, status becomes `approved`.
3. **Executive:** batch Verify on submitted expenses assigned to executive — advances tier (no 403).
4. **Team leader:** batch Verify on submitted expenses — `level_1_verified`.
5. **Manager:** cannot approve before TL/executive steps (unchanged).

## Revision log

| Date | Author | Summary |
|------|--------|---------|
| 2026-06-23 | agent | Admins bypass hierarchy tier check; expand approvable statuses |
| 2026-06-23 | agent | Admin Panel single-expense dialog: Approve/Reject for level_1/level_2 verified |
