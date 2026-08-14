# Batch Review & Production Issues — Fix Report (June 2026)
**DOC-015** | Status: in progress | Last updated: 2026-06-30

## Summary

Three production issues were diagnosed and fixed across two sessions (June 29–30, 2026):

1. **"Batch not found" for Manager users** — hierarchy reviewers (team_leader / executive) could not open any batch expense review page
2. **Dashboard 400 errors** — the "Old Money" dashboard theme was querying a non-existent column (`amount` instead of `total_amount`)
3. **Post-submit backup 400 errors** — IndexedDB receipt backup was requesting files with broken storage paths

All code fixes are **local and uncommitted**. The SQL migration has been created but not yet applied to production.

---

## Issue 1: "Batch not found or you do not have access." (Manager / team_leader / executive)

### Symptom
A manager (role: `team_leader` or `executive`) can see batch expenses listed in their review queue (the EngineerReview page), clicks the "Review batch" button, and is taken to `/expenses/batch/{batchId}/review`. The page loads but shows:

> Batch not found or you do not have access.

No HTTP errors or console errors appear — all requests return HTTP 200.

### Root Cause

The `expense_batches` table was created in **May 2026** (`20260513160000_expense_batches.sql`) with an RLS SELECT policy covering only:
- The submitter (`user_id = auth.uid()`)
- Org admins
- Engineers assigned to any expense line (`assigned_engineer_id`)

Hierarchy roles (`team_leader`, `executive`) were added **9 days later** (`20260522139900_app_role_add_hierarchy_roles.sql`). The expenses table RLS was updated on May 24 (`20260524200000_tl_executive_expense_submit_and_select.sql`) to allow hierarchy reviewers to read their assigned expenses. **The `expense_batches` table RLS was never updated.**

As a result, when `BatchExpenseReviewPanel` queries `expense_batches`, the RLS blocks it and returns `null`. Supabase PostgREST returns HTTP 200 with a null body (not an error), so no console errors appear.

### Timeline of the gap

| Date | Migration | What happened |
|------|-----------|---------------|
| 2026-05-13 | `20260513160000_expense_batches.sql` | `expense_batches` table + RLS created (no hierarchy roles yet) |
| 2026-05-22 | `20260522139900_app_role_add_hierarchy_roles.sql` | Added `team_leader` / `executive` roles |
| 2026-05-24 | `20260524200000_tl_executive_expense_submit_and_select.sql` | Updated `expenses` RLS for hierarchy reviewers — **missed `expense_batches`** |
| 2026-06-26 | `20260626120000_expense_batches_reviewer_rls.sql` | SQL fix created — **never applied, then superseded** |
| 2026-06-30 | `20260630120000_expense_batches_reviewer_select.sql` | Duplicate SQL fix created — **never applied, then superseded** |
| 2026-06-30 | `20260630085810_fix_batch_review_rls_and_attachment_paths.sql` | **Authoritative fix via `supabase migration new` — unique timestamp** |

### Fix: SQL migration (canonical)

**File:** `supabase/migrations/20260630085810_fix_batch_review_rls_and_attachment_paths.sql`

```sql
DROP POLICY IF EXISTS "Users can view own expense batches" ON public.expense_batches;

CREATE POLICY "Users can view own expense batches"
  ON public.expense_batches FOR SELECT
  USING (
    user_id = auth.uid()
    OR EXISTS (SELECT 1 FROM public.organization_memberships om
               WHERE om.user_id = auth.uid()
                 AND om.organization_id = expense_batches.organization_id
                 AND om.role = 'admin' AND om.is_active = true)
    OR EXISTS (SELECT 1 FROM public.expenses ex
               WHERE ex.batch_id = expense_batches.id
                 AND ex.organization_id = expense_batches.organization_id
                 AND ex.assigned_engineer_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.expenses ex
               WHERE ex.batch_id = expense_batches.id
                 AND ex.organization_id = expense_batches.organization_id
                 AND ex.assigned_reviewer_id = auth.uid())
  );
```

This migration also creates:
- `idx_expenses_batch_assigned_engineer` — covering index for the engineer EXISTS arm
- `idx_expenses_batch_assigned_reviewer` — partial index for the reviewer EXISTS arm

### Fix: Frontend (BatchExpenseReviewPanel)

**File:** `src/components/BatchExpenseReviewPanel.tsx` — `loadBatch()` function

The synthetic fallback that derived batch metadata from the `expenses` table (workaround for the broken RLS) has been **reverted**. `loadBatch` now relies entirely on the corrected RLS:

```
query expense_batches → found → show batch
                      → null  → "Batch not found or you do not have access."
```

This is cleaner, correct, and prevents the batch review page from appearing to work without proper authorization.

**Deploy order:** Apply the SQL migration **before** deploying the frontend.

### Old duplicate migrations — do not apply

The following files exist in the repo but should NOT be applied (they are superseded by the new canonical migration):
- `supabase/migrations/20260626120000_expense_batches_reviewer_rls.sql`
- `supabase/migrations/20260630120000_expense_batches_reviewer_select.sql`

---

## Issue 2: Dashboard 400 Errors (Old Money Theme)

### Symptom
Every user with the "Old Money" dashboard theme generates continuous 400 errors:
```
GET /rest/v1/expenses?select=id,title,amount,...  →  400
```

### Root Cause
`src/hooks/useOldMoneyDashboardData.ts` was selecting column `amount` from the `expenses` table. The actual column name is `total_amount`.

### Fix Applied

**File:** `src/hooks/useOldMoneyDashboardData.ts` — three locations:

1. Type `OldMoneyTxn`: `amount: number` → `total_amount: number`
2. `.select()` string: `"id, title, amount, ..."` → `"id, title, total_amount, ..."`
3. Computation: `num(r.amount)` → `num(r.total_amount)`

---

## Issue 3: Post-Submit IndexedDB Backup 400 Errors

### Symptom
After submitting an expense with bill photos, the browser made HTTP 400 requests:
```
GET /storage/v1/object/public/receipts/1749123456789-abc123.png  →  400
```
The correct path should be `receipts/temp/{userId}/1749123456789-abc123.png`.

### Root Cause

`FileUpload.tsx` stores `storage_path: fileName` (bare filename like `1749123456789-abc.jpg`) on the returned attachment object. When `saveBackupReceiptsToIndexedDB` processed `sessionTempMeta` entries, each entry's `path` field was just the bare filename. The backup function then tried to download `receipts/{bareFilename}` — which doesn't exist (the actual file is at `receipts/temp/{userId}/{filename}`).

### Fix Applied

**File:** `src/lib/expenseSubmittedBackupReceipts.ts` — `collectReceiptSources()`

Processing order reversed:
1. Full attachment URLs (from `payload.attachments`) are processed first — they always have the correct path
2. Each URL's bare filename is added to a `seen` set
3. `sessionTempMeta` entries whose filename is already in `seen` are skipped

This prevents the backup from requesting bare-filename paths that don't exist in storage.

---

## Attachment Storage Path — DB Fix

### Problem
The `storage_path` column was not being persisted to the `attachments` table in three places. Edit mode needed the full bucket path to locate files precisely.

### Fix

`storage_path` (full bucket-relative path) is now written on all attachment inserts:

| File | What changed |
|------|-------------|
| `src/components/FileUpload.tsx` | Added `storage_path: uploadPath` to the DB insert (where `uploadPath = ${expenseId}/${fileName}` for existing expenses) |
| `src/pages/ExpenseForm.tsx` (moveTempFilesToExpense) | Added `storage_path: finalPath` to the DB insert |
| `src/lib/expenseBatchAttachments.ts` (moveTempFilesToExpense) | Added `storage_path: newPath` to the DB insert |

The migration (`20260630085810`) adds the `storage_path TEXT` column and a partial unique index `uq_attachments_expense_storage_path(expense_id, storage_path)` to enforce deduplication.

The Supabase types file (`src/integrations/supabase/types.ts`) was updated to include `storage_path: string | null` in the `attachments` Row, Insert, and Update types (along with `file_size` and `organization_id` which were also missing).

---

## Other Changes

### Attachment size limit raised to 50MB (from earlier session)

| File | Change |
|------|--------|
| `src/components/FileUpload.tsx` | `MAX_TOTAL_SIZE` raised to 50MB |
| `src/lib/expenseBatchAttachments.ts` | Size cap and error message updated |
| `supabase/functions/compress-upload/index.ts` | `MAX_INPUT_BYTES` raised to 50MB |

### Edit-mode re-processing fix (from earlier session)

`src/pages/ExpenseForm.tsx` — `persistedAttachmentUrlsRef` tracks attachment URLs already stored in the DB. On form load in edit mode, these URLs are pre-populated so they are not re-processed on submit.

---

## Tests Added

**File:** `src/lib/__tests__/attachmentStoragePaths.test.ts`

10 tests covering:
- Canonical temp path structure (`temp/{userId}/{filename}`)
- Canonical final path structure (`{expenseId}/{filename}`)
- `isTempPath` detection
- `objectNameFromPath` extracts correct filename from both path forms
- Relationship consistency: temp → extract object name → final path
- DB `storage_path` is never a bare filename
- `collectReceiptSources` deduplication logic (bare filename masked by full URL)

---

## Current Architecture

### Database Tables (relevant)

#### `expense_batches`
Groups multiple expense lines submitted in one batch wizard session.

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | Batch identifier used in URL |
| `organization_id` | uuid FK → organizations | Multi-tenant isolation |
| `user_id` | uuid FK → auth.users | Submitter |
| `label` | text nullable | Optional batch name |
| `shared_category` | text | Same category for all lines |
| `shared_expense_date` | date | Same date for all lines |
| `line_count` | integer | Denormalized count |
| `total_amount` | numeric | Denormalized sum |
| `created_at` | timestamptz | Submission timestamp |

**RLS SELECT policy** (after migration): submitter OR org admin OR assigned engineer OR assigned reviewer

#### `attachments`
Receipt files attached to an expense.

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `expense_id` | uuid FK | |
| `organization_id` | uuid | |
| `file_url` | text | Full public URL |
| `storage_path` | text (nullable) | Bucket-relative path (e.g. `temp/uid/file.jpg` or `expenseId/file.jpg`) |
| `filename` | text | Original filename |
| `content_type` | text | MIME type |
| `file_size` | int | Bytes |
| `uploaded_by` | uuid | |

### Storage Architecture

**Bucket:** `receipts`
- **Temp path:** `temp/{userId}/{filename}` — during form filling (before expense saved)
- **Final path:** `{expenseId}/{filename}` — after expense is saved and files moved

### Frontend Components

#### `BatchExpenseReview` (`src/pages/BatchExpenseReview.tsx`)
Route: `/expenses/batch/:batchId/review`. Reads URL params, determines viewer role, renders `BatchExpenseReviewPanel`.

#### `BatchExpenseReviewPanel` (`src/components/BatchExpenseReviewPanel.tsx`)
Data-fetching component. `loadBatch()` queries `expense_batches` directly — no synthetic fallback. If the row is not returned (user not authorized or batch doesn't exist), renders "Batch not found or you do not have access."

#### `EngineerReview` (`src/pages/EngineerReview.tsx`)
Manager's review queue. "Review batch" button navigates to:
```
/expenses/batch/${expense.batch_id}/review?from=review&expense=${expense.id}
```

---

## What Needs to be Deployed

### Must apply first (SQL — before frontend deploy)

Run in Supabase Studio → SQL Editor:

```
supabase/migrations/20260630085810_fix_batch_review_rls_and_attachment_paths.sql
```

### Must deploy (frontend)

| File | Purpose |
|------|---------|
| `src/components/BatchExpenseReviewPanel.tsx` | Reverted synthetic fallback; relies on correct RLS |
| `src/hooks/useOldMoneyDashboardData.ts` | Column name fix (`total_amount`) |
| `src/lib/expenseSubmittedBackupReceipts.ts` | Backup path fix |
| `src/pages/ExpenseForm.tsx` | Edit-mode fix + `storage_path` in insert + 50MB |
| `src/components/FileUpload.tsx` | `storage_path` in insert + 50MB |
| `src/lib/expenseBatchAttachments.ts` | `storage_path` in insert + 50MB |
| `src/integrations/supabase/types.ts` | `storage_path`, `file_size`, `organization_id` added to attachments type |

### Must deploy (edge function)

`supabase/functions/compress-upload/index.ts` — 50MB input cap (deploy via Coolify)

### Do NOT apply

`20260626120000_expense_batches_reviewer_rls.sql` and `20260630120000_expense_batches_reviewer_select.sql` — superseded by the canonical migration above.

---

*Last updated: 2026-06-30*
