# Expense submission — storage move 400 & duplicate batch queries

**Doc ID:** DOC-013  
**Status:** in progress  
**Last updated:** 2026-06-29  
**Owner / area:** Expenses, Storage, Batch Review

---

## 1) Summary

Three production bugs fixed:

1. **Storage ghost copy** — self-hosted Supabase returns 400 on `storage.move()`, falls back to `copy()`, but `copy()` may acknowledge success without actually writing the file. The form then reports `movedCount: 1` and inserts an attachment row with a broken URL, causing the expense to be submitted without a valid receipt. Added a `createSignedUrl` probe after every successful copy to detect ghost copies and surface the failure correctly.

1b. **Storage write 504 — temp-path fallback** — when all three relocation strategies (move → copy+probe → download+re-upload) fail but the download of the temp file succeeds, the attachment is now recorded with the temp path URL instead of failing the entire submission. The expense submits successfully with working attachment URLs. `storage_path` is also written to the attachment row so edit mode can resolve the file later.

2. **Duplicate `expense_form_field_values` queries** — the `loadBatch` useCallback in `BatchExpenseReviewPanel` included `toast`, `t` (translation function), and `highlightExpenseId` in its dependency array. These references change on every re-render, causing `loadBatch` to be recreated and the `useEffect([loadBatch])` to re-fire, triggering 8+ redundant DB queries per batch page visit.

---

## 2) Problem / requirement

**Bug 1 symptoms (production at pesowise.unimisk.com):**
- Expense amount above ₹50, user uploaded a receipt photo
- Console: `storage/v1/object/move 400` → copy fallback → `{movedCount: 1, failedCount: 0}` 
- Then: `GET /receipts/${filename} 400` and `POST /sign/receipts/${filename} 400` (wrong path, missing expense-ID folder)
- Error: "Bill photos are required for expenses above ₹50"
- Expense lands in Draft instead of Submitted

**Bug 2 symptoms:**
- Chrome DevTools Network tab showed `expense_form_field_values` queried 8+ times in rapid succession when opening a batch review page
- Introduced by our parallel `fetchBatchExpenseCustomFields` in `loadBatch`

---

## 3) Solution

### Bug 1 + 1b — Storage relocation waterfall (`src/pages/ExpenseForm.tsx`)

Strategy waterfall introduced in `moveTempFilesToExpense` with a `finalPath` variable:

1. `move(tempPath, newPath)` — fast-path, works on most Supabase versions
2. `copy(tempPath, newPath)` + `createSignedUrl(newPath, 30)` probe — ghost-copy detection
3. `download(tempPath)` → `upload(newPath, blob, {upsert: true})` — bypasses move/copy API
4. **New: temp-path fallback** — if re-upload returns 504/error but the `download` in step 3 succeeded (confirming the file exists at temp), set `finalPath = tempPath`. The attachment row is inserted with the temp URL + `storage_path: finalPath`, and the expense submits successfully.

The temp file is NOT cleaned up when `finalPath === tempPath` so the attachment URL stays valid. `storage_path` is now written on every attachment insert so edit mode always resolves the correct path.

Also fixed `fetchExpense` (edit-form attachment load):
- Added `organization_id = expenseData.organization_id` filter to the attachments query so RLS cannot silently return zero rows for a draft expense
- Now selects `storage_path, filename, content_type, file_size` as well as `file_url` and populates `tempStoragePathByUrlRef` from existing attachments

### Bug 2 — loadBatch dep array (`src/components/BatchExpenseReviewPanel.tsx`)

Moved `toast`, `t`, and `highlightExpenseId` to `useRef` values that are updated on every render:

```typescript
const toastRef = useRef(toast); toastRef.current = toast;
const tRef = useRef(t); tRef.current = t;
const highlightExpenseIdRef = useRef(highlightExpenseId);
highlightExpenseIdRef.current = highlightExpenseId;
```

`loadBatch` uses `toastRef.current`, `tRef.current`, `highlightExpenseIdRef.current` and its dep array is `[batchId, organizationId]` only. The callback is now recreated only when the batch or org actually changes.

---

## 4) Key files

```
src/pages/ExpenseForm.tsx          — moveTempFilesToExpense copy verify + fetchExpense attachment fix
src/components/BatchExpenseReviewPanel.tsx — loadBatch dep array + ref pattern
```

---

## 4b) Edit mode re-processing fix (`src/pages/ExpenseForm.tsx`)

**Problem:** When an expense had attachments saved with temp-path URLs (because storage write
strategies all failed), re-opening in edit mode and re-submitting caused:
1. `parseTempStorageNamesFromUrls` extracted those temp filenames from the existing DB-row URLs
2. `moveTempFilesToExpense` tried to move those temp files again — but they no longer exist
3. All moves returned "Object not found" → `movedCount === 0` → "Failed to attach uploaded bill photos"

**Fix:** Added `persistedAttachmentUrlsRef` (a `Set<string>`) that records the `file_url` values
of every attachment row loaded from the DB during `fetchExpense`. In `moveTempFilesToExpense` the
submit-time URL expansion now filters those persisted URLs out:

```typescript
const freshAttachmentUrls = allAttachmentUrls.filter(
  (url) => !persistedAttachmentUrlsRef.current.has(url),
);
```

Only URLs from genuinely new uploads this session feed the expansion. Existing DB attachment rows
are left untouched. The ref is cleared when the form resets (new expense navigation or
`resetExpenseFormState`) and at both submit-success paths.

## 4c) 50 MB attachment limit

All size caps raised from 5–10 MB to 50 MB to match user requirement:

| File | Old cap | New cap |
|------|---------|---------|
| `src/components/FileUpload.tsx` | 10 MB | 50 MB |
| `src/pages/ExpenseForm.tsx` (`enforceMaxAttachmentSize`) | 5 MB | 50 MB |
| `src/lib/expenseBatchAttachments.ts` (`enforceMaxAttachmentSize`) | 5 MB | 50 MB |
| `supabase/functions/compress-upload/index.ts` (`MAX_INPUT_BYTES`) | 25 MB | 50 MB |

User-facing error messages updated to say "50MB limit" throughout.

## 5) Database / migrations

No schema changes.

---

## 6) Test plan

**Bug 1:**
- [ ] New expense above ₹50, upload receipt photo, submit → expense reaches "submitted" (not draft)
- [ ] Check console: no `GET /receipts/${filename} 400` (without expense-ID folder)
- [ ] If storage `move` is still returning 400, the copy probe should catch ghost copies and show "Failed to attach uploaded bill photos" instead of silently accepting a broken attachment
- [ ] Edit a draft expense that already has an attached receipt → the attachment appears in the form's upload section without re-uploading
- [ ] Resubmit the draft → expense reaches "submitted"

**Bug 2:**
- [ ] Open batch review panel → `expense_form_field_values` appears exactly once in network requests (not 8+)
- [ ] No spurious re-renders visible in React DevTools when the panel first mounts

---

## 7) Related docs

- [DOC-009 — Mobile upload & PWA stability fixes](./mobile-upload-and-pwa-stability-fixes.md)
- [DOC-012 — Batch expense review — org custom field columns](./batch-expense-custom-field-columns.md)
- Legacy: `docs/ISSUE_EXPENSE_SUBMIT_STORAGE_AND_ATTACHMENTS.md`

---

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-06-29 | 1.0 | Agent | Ghost copy detection + dep-array fix |
| 2026-06-29 | 1.1 | Agent | Temp-path fallback: when all write strategies fail but download succeeds, attach at temp path so expense submits; added storage_path to attachment insert |
| 2026-06-29 | 1.2 | Agent | Edit mode re-processing fix: persistedAttachmentUrlsRef prevents moveTempFilesToExpense from re-processing already-saved DB attachment rows; 50MB limit raised across FileUpload, enforceMaxAttachmentSize (×2), and compress-upload edge function |
