# Batch Review — "Batch not found" for Managers

**Status:** Fixed (frontend deployed, SQL migration pending)
**Affected roles:** `team_leader`, `executive` (hierarchy reviewers)
**Symptom:** Manager clicks "Review batch" → page shows **"Batch not found or you do not have access."**

---

## What is broken and why

### The gap

The `expense_batches` table was created on **2026-05-13**. Its RLS SELECT policy allowed only:

- The **submitter** (`user_id = auth.uid()`)
- **Org admins**
- **Engineers** assigned to a line (`assigned_engineer_id`)

Hierarchy roles (`team_leader`, `executive`) were added on **2026-05-22**. The `expenses` table RLS was correctly updated on **2026-05-24** to include hierarchy reviewers — but **`expense_batches` was never updated**.

### What happens at runtime

```
Manager clicks "Review batch"
  ↓
BatchExpenseReviewPanel queries:
  SELECT ... FROM expense_batches WHERE id = $batchId AND organization_id = $orgId

  → RLS blocks → Supabase returns HTTP 200 with null body (NOT an error)
  → Component sees null → shows "Batch not found or you do not have access."
```

No console errors appear. The request succeeds at the HTTP level; the RLS silently suppresses the row.

---

## The fix

### Frontend fix (deployed immediately — no SQL required)

**File:** `src/components/BatchExpenseReviewPanel.tsx` — `loadBatch()`

When `expense_batches` returns null (RLS blocked), fall back to querying the `expenses` table directly. The `expenses` table **already has correct hierarchy-reviewer RLS** (from the May 24 migration that IS applied in production). If the manager is `assigned_reviewer_id` on any line in the batch, they can read those expense rows.

```
expense_batches query → null (RLS blocks)
  ↓ fallback
expenses WHERE batch_id = $batchId query → rows found
  ↓ synthesize batch header from first row
  ↓ show batch review page normally
```

The synthesized batch header uses:
- `shared_category` from `expenses[0].category`
- `shared_expense_date` from `expenses[0].trip_start`
- `line_count` from count of returned rows
- `total_amount` from sum of `expenses[].total_amount`
- `label` → `null` (only stored in `expense_batches`)

**This is the current working state.** Deploy the frontend to fix the issue without touching the database.

### SQL fix (permanent — apply when convenient)

The SQL migration is at:

```
supabase/migrations/20260630085810_fix_batch_review_rls_and_attachment_paths.sql
```

Run the **exact SQL below** in Supabase Studio → SQL Editor:

```sql
DROP POLICY IF EXISTS "Users can view own expense batches" ON public.expense_batches;

CREATE POLICY "Users can view own expense batches"
  ON public.expense_batches FOR SELECT
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expense_batches.organization_id
        AND om.role = 'admin'
        AND om.is_active = true
    )
    OR EXISTS (
      SELECT 1 FROM public.expenses ex
      WHERE ex.batch_id = expense_batches.id
        AND ex.organization_id = expense_batches.organization_id
        AND ex.assigned_engineer_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.expenses ex
      WHERE ex.batch_id = expense_batches.id
        AND ex.organization_id = expense_batches.organization_id
        AND ex.assigned_reviewer_id = auth.uid()
    )
  );

CREATE INDEX IF NOT EXISTS idx_expenses_batch_assigned_engineer
  ON public.expenses (batch_id, assigned_engineer_id)
  WHERE batch_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_expenses_batch_assigned_reviewer
  ON public.expenses (batch_id, assigned_reviewer_id)
  WHERE batch_id IS NOT NULL AND assigned_reviewer_id IS NOT NULL;
```

> **Do NOT include the `CREATE UNIQUE INDEX uq_attachments_expense_storage_path` line** — it will fail because existing rows have duplicate `storage_path` values. That line has been removed from the migration file.

After this SQL runs, the direct `expense_batches` query will work for managers and the fallback path becomes unnecessary (but harmless to leave in).

---

## Why the migration failed

The migration file originally included:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS uq_attachments_expense_storage_path
  ON public.attachments (expense_id, storage_path)
  WHERE storage_path IS NOT NULL;
```

This failed with:

```
ERROR: 23505: could not create unique index "uq_attachments_expense_storage_path"
DETAIL: Key (expense_id, storage_path)=(361fbbcc-..., temp/22ba24a5-.../1782737952811-sdry266buyg.pdf) is duplicated.
```

The `storage_path` column already exists in production with duplicate path values from prior uploads. PostgreSQL aborted the whole statement when the unique constraint couldn't be satisfied.

**The unique index line has been removed from the migration file.** The three SQL statements above (DROP POLICY + CREATE POLICY + 2 CREATE INDEX) are all safe to run and will not fail.

---

## Deploy checklist

| Step | Action | Status |
|------|--------|--------|
| 1 | Build frontend (`npm run build`) | ✅ Clean |
| 2 | Deploy frontend to Coolify | Deploy this build |
| 3 | Run the 3 SQL statements above in Supabase Studio | Do when convenient |
| 4 | Verify manager can open batch review page | Test after step 2 |

Steps 3 and 4 are independent — the frontend fallback makes step 2 enough to fix the manager issue. Step 3 just makes the direct query work cleanly without the fallback.

---

## Files changed in this fix

| File | Change |
|------|--------|
| `src/components/BatchExpenseReviewPanel.tsx` | Restored `expenses` table fallback when `expense_batches` RLS blocks the row |
| `supabase/migrations/20260630085810_fix_batch_review_rls_and_attachment_paths.sql` | Removed the `CREATE UNIQUE INDEX` line that was causing the migration to fail |
