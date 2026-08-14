# DOC-017 — Edge Function: finalize-expense-receipts + Sticky Actions column

**Status:** in progress
**Last updated:** 2026-06-30
**Area:** Expense submission — receipt storage finalization (server-side); Review table usability

---

## Summary

Phase 2 of the receipt finalization fix.
Phase 1 (DOC-016) implemented a browser-side waterfall that still called `storage.move`,
`storage.copy`, `storage.createSignedUrl`, and `storage.download` — all of which fail with
`400` or `504 Gateway Timeout` on the self-hosted Supabase gateway.

Phase 2 moves ALL finalization to a Supabase Edge Function (`finalize-expense-receipts`)
that uses the service-role key server-side. The browser never calls Storage APIs during
finalization or post-submit backup.

Additionally: sticky Actions column on Review Expense and Review Batch tables.

---

## Root cause (Phase 2)

Any browser-originated `storage.move` / `storage.copy` / `storage.createSignedUrl` /
`storage.download` hits the self-hosted gateway (Kong/NGINX), which returns:
- `POST /storage/v1/object/move → 400` — gateway rejects the method
- `504 Gateway Timeout` — gateway drops the response before storage finishes

The Phase 1 waterfall (`finalizeReceiptFile`) worked around these by probing after each
step, but the underlying problem (browser→gateway→storage) cannot be fixed client-side.

---

## Fix

### New file: `supabase/functions/finalize-expense-receipts/index.ts`

Server-side Deno edge function:

**Auth & security:**
- JWT validated via `serviceClient.auth.getUser(jwt)` using `SUPABASE_SERVICE_ROLE_KEY`
- Expense ownership validated: `expenses.eq("user_id", user.id)`
- Filenames validated: must be bare names (no `/`, no URL scheme)
- Source path built server-side: `temp/${userId}/${filename}` — client cannot override
- Destination path built server-side: `${expenseId}/${filename}`
- CORS: explicit allowed origins (`pesowise.unimisk.com`, `localhost:5173/3000/8080`) with `Vary: Origin` — NOT wildcard

**Per-receipt algorithm (concurrency = 2):**
1. **Probe** destination via `storage.list(expenseId, { search: filename })` → if exists, return `"finalized"` immediately (idempotent)
2. **Download** source → if fails, return `"failed"` (source file missing)
3. **Upload** source blob to destination with `upsert: true`
4. **Download-verify** destination → if succeeds, return `"finalized"`
5. If verify fails → return `"temporary_fallback"` at source path (expense submits; file remains accessible at temp path)

No `move`, `copy`, or `createSignedUrl` — only `list`, `download`, `upload`, `getPublicUrl`.

**Deploy:** see `docs/coolify-edge-functions-deploy.md` (DOC-L12).
The function must be deployed to Coolify for production use. Until deployed, the frontend
fallback path handles the failure gracefully (see below).

---

### `src/lib/receiptFinalization.ts`

**Removed:** `probeObjectExists`, `finalizeReceiptFile` (browser-side waterfall)
**Kept:** `ReceiptFinalizationStatus`, `ReceiptFinalizationResult`, `FinalizeReceiptsInput`, `runWithConcurrency`
**Added:** `invokeFinalizeExpenseReceipts(supabase, { expenseId, userId, receipts, blobCache? })`

`invokeFinalizeExpenseReceipts`:
- Calls `supabase.functions.invoke("finalize-expense-receipts", { body: { expenseId, receipts } })`
- On success: enriches each result with `cachedBlob` from `blobCache` (keyed by bare filename)
- On EF error/unavailable: creates synthetic results:
  - Has blob in cache → `"temporary_fallback"` at temp path (expense still submits)
  - No blob in cache → `"failed"` (expense blocked if all files fail)

The `cachedBlob` on every result means post-submit backup has **zero network calls**.

---

### `src/components/FileUpload.tsx`

- `onUploadComplete` prop extended: `(attachment: Attachment, blob?: Blob) => void`
- Passes `fileToUpload` (the `File` object, available in-memory at upload time) as second argument

---

### `src/pages/ExpenseForm.tsx`

- Added `sessionBlobCacheRef = useRef<Map<string, Blob>>(new Map())`
- `onUploadComplete` handler stores blob: `sessionBlobCacheRef.current.set(attachment.storage_path, blob)`
- `moveTempFilesToExpense`: replaced per-file `finalizeReceiptFile` with one `invokeFinalizeExpenseReceipts` call, then `runWithConcurrency(insertTasks, 2)` for DB attachment inserts
- Both cleanup paths reset `sessionBlobCacheRef.current = new Map()`
- Import: `invokeFinalizeExpenseReceipts` + `FinalizeReceiptsInput` (removed `finalizeReceiptFile`)

---

### `src/lib/expenseBatchAttachments.ts`

- Replaced per-file `finalizeReceiptFile` with `invokeFinalizeExpenseReceipts` (no blob cache for batch)
- DB inserts remain as separate `runWithConcurrency` tasks

---

### `src/lib/expenseSubmittedBackupReceipts.ts`

Fast path (when `finalizationResults` present):
- **Before:** `"finalized"` → `loadAttachmentBlobForPreview(result.fileUrl)` (one network call)
- **After:** `"finalized"` → `result.cachedBlob` (zero network calls; skip if no blob)
- `"temporary_fallback"` → `result.cachedBlob` unchanged (already zero-network)
- `"failed"` → skip unchanged

Fallback path (edit mode, draft saves) is unchanged — still uses `collectReceiptSources` + `loadAttachmentBlobForPreview`.

---

### `src/pages/EngineerReview.tsx` — sticky Actions column

| Location | Before | After |
|----------|--------|-------|
| Wrapper `<div>` | `overflow-x-auto -mx-4 sm:mx-0` | `relative overflow-x-auto -mx-4 sm:mx-0` |
| Actions `<TableHead>` | `min-w-[120px] text-right` | `sticky right-0 z-30 min-w-[150px] border-l bg-background shadow-[-4px_0_8px_-6px_rgba(0,0,0,0.25)] text-right` |
| `<TableRow>` | (no class) | `group` |
| Actions `<TableCell>` | `text-right` | `sticky right-0 z-20 min-w-[150px] border-l bg-background group-hover:bg-muted/50 text-right` |

---

### `src/components/BatchExpenseReviewPanel.tsx` — sticky Actions column

| Location | Before | After |
|----------|--------|-------|
| Wrapper `<div>` | `overflow-x-auto` | `relative overflow-x-auto` |
| Actions `<TableHead>` | `text-right` | `sticky right-0 z-30 min-w-[140px] border-l bg-background shadow-[-4px_0_8px_-6px_rgba(0,0,0,0.25)] text-right` |
| `<TableRow>` | conditional className | `cn("group", ...)` |
| Actions `<TableCell>` | `text-right` | `sticky right-0 z-20 min-w-[140px] border-l bg-background group-hover:bg-muted/50 text-right` |

---

## Invariants preserved

- No `storage.move` / `copy` / `createSignedUrl` / `download` from browser during finalization
- Service-role key never leaves the Edge Function
- Temp-path fallback from DOC-013 remains: if EF fails and blob cached → `"temporary_fallback"` (expense submits)
- No unique index on `(expense_id, storage_path)`
- No Storage RLS changes
- No receipts bucket visibility change
- No approvals, workflow status, or Settings changes

---

## Deployment steps (Coolify)

See `docs/coolify-edge-functions-deploy.md` (DOC-L12) for the general procedure.

Specific to this function:
1. Push `supabase/functions/finalize-expense-receipts/index.ts` to the repository
2. In Coolify, trigger Edge Function deploy for project (or use Supabase Management API)
3. Verify in Supabase Studio → Edge Functions that `finalize-expense-receipts` appears
4. Test with a new expense submission containing receipts; confirm console shows `invokeFinalizeExpenseReceipts` results with `status: "finalized"`
5. Monitor for `temporary_fallback` toasts — these indicate EF reached but upload-verify failed server-side

---

## Test coverage

### `src/lib/__tests__/receiptFinalization.test.ts` — 14 tests (Phase 2 rewrite)

1. `functions.invoke` called with correct params (not storage methods)
2. EF `"failed"` result mapped for invalid filename
3. EF `"finalized"` result mapped with correct paths and fileUrl
4. EF `"temporary_fallback"` result mapped with sourcePath as resolvedPath
5. EF `"failed"` result → null resolvedPath, no fileUrl
6. `cachedBlob` populated from blobCache for `"finalized"` results
7. `cachedBlob` populated from blobCache for `"temporary_fallback"` results
8. EF error + blob cached → synthetic `"temporary_fallback"` at temp path
9. EF error + no blob → `"failed"` with null resolvedPath
10. No `storage.move/copy/createSignedUrl/download` called when EF succeeds
11. No storage calls when EF fails (fallback is pure in-memory)
12. `runWithConcurrency` — 7 tasks, concurrency 2, results in order
13. Multiple receipts — EF results in correct order
14. `movedCount` / `tempFallbackCount` / `failedCount` accounting

### `src/lib/__tests__/reviewTableStickyClasses.test.ts` — 6 tests

1. EngineerReview wrapper has `relative` alongside `overflow-x-auto`
2. EngineerReview actions TableHead has `sticky right-0 z-30`
3. EngineerReview actions TableCell has `sticky right-0 z-20`
4. BatchExpenseReviewPanel wrapper has `relative` alongside `overflow-x-auto`
5. BatchExpenseReviewPanel actions TableHead has `sticky right-0 z-30`
6. BatchExpenseReviewPanel actions TableCell has `sticky right-0 z-20`

---

## Revision log

| Date | Change | Author |
|------|--------|--------|
| 2026-06-30 | Initial: EF created, frontend refactored, sticky tables fixed, 20 tests, DOC-017 | Agent |
