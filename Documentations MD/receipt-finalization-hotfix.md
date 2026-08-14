# DOC-016 — Receipt finalization hotfix: false move accounting, 504 probe, stale backup, concurrency

**Status:** in progress  
**Last updated:** 2026-06-30  
**Area:** Expense submission — receipt storage finalization

---

## Summary

A regression in expense receipt finalization caused 7 receipts to be misreported as successfully
moved when all 7 were actually stuck at their temporary storage paths.  
The console log `tempCount: 7, movedCount: 7, failedCount: 0` was **wrong** — the receipts were
at `temp/{userId}/{filename}`, not at `{expenseId}/{filename}`.  
Post-submit backup then made repeated `POST /storage/v1/object/move → 400` requests against those
stale temp paths.

---

## Root causes

### RC-1 — False move accounting
`moveTempFilesToExpense` in `ExpenseForm.tsx` returned `true` for both `"finalized"` and
`"temporary_fallback"` results, so `movedCount` was inflated.  
`tempFallbackCount` did not exist — there was no way to distinguish "moved" from "stranded at temp".

### RC-2 — No 504 probe
After a `move()` error the code immediately fell through to `copy()`.  
A 504 Gateway Timeout means the server likely *completed* the move but the gateway dropped the
response.  Without probing the final path first, valid moves were being treated as failures and
triggered unnecessary copy + download attempts.

### RC-3 — Stale backup payload
`persistSubmittedSafetyCopy` called `buildDraftPayloadFromRef()`, which reads `formStateRef.current.attachments` — these are still the original temp URLs from upload time.  
After `moveTempFilesToExpense` the form state is NOT updated to the final paths, so the backup
called `loadAttachmentBlobForPreview` on stale temp URLs, triggering 3 network fallbacks per file
(public URL → download → signed URL) that all 400.

### RC-4 — Uncontrolled parallelism
`Promise.all` for all N files at once overwhelmed the self-hosted Storage gateway with concurrent
`move()` requests, causing cascading 504s that made RC-2 worse.

### RC-5 — 3 fallbacks per stale URL (backup)
`loadAttachmentBlobForPreview` tries public URL fetch → `.download()` → `.createSignedUrl()` for
each source. For moved files, every attempt hit a stale temp path → 3 × 400 per file per backup.

---

## Fix

### New file: `src/lib/receiptFinalization.ts`

Exports:
- `ReceiptFinalizationStatus` — `"finalized" | "temporary_fallback" | "failed"`
- `ReceiptFinalizationResult` — typed result with `sourcePath`, `desiredFinalPath`,
  `resolvedPath`, `status`, `filename`, `fileUrl`, `cachedBlob?: Blob`
- `runWithConcurrency<T>(tasks, limit)` — worker-pool preserving input order, max 2 concurrent
- `finalizeReceiptFile({ supabase, userId, expenseId, fileName })` — full waterfall:
  - **A** probe final path → already there → `"finalized"` immediately
  - **B** move + probe → `"finalized"` if probe succeeds (catches 504 false failures)
  - **C** copy + ghost-probe → `"finalized"` if probe succeeds (catches ghost writes)
  - **D** download + re-upload + probe → `"finalized"` if probe succeeds
  - **E** temp-path fallback → `"temporary_fallback"` + `cachedBlob` (file IS accessible)
  - **F** complete failure → `"failed"`

### `src/pages/ExpenseForm.tsx`

- Added import for `finalizeReceiptFile`, `runWithConcurrency`, `ReceiptFinalizationResult`
- Added `finalizationResultsRef = useRef<ReceiptFinalizationResult[]>([])` ref
- Replaced `Promise.all` in `moveTempFilesToExpense` with `runWithConcurrency(tasks, 2)`
- Counts: `movedCount` only for `"finalized"`, new `tempFallbackCount` for `"temporary_fallback"`
- Throws only when `movedCount === 0 && tempFallbackCount === 0 && tempFileNames.length > 0`
- `persistSubmittedSafetyCopy` passes `finalizationResults: finalizationResultsRef.current`
- Both cleanup sequences (draft path + success path) reset `finalizationResultsRef.current = []`

### `src/lib/expenseSubmittedBackupReceipts.ts`

- Added `finalizationResults?: ReceiptFinalizationResult[]` param to `saveBackupReceiptsToIndexedDB`
- **Fast path** (results present):
  - `"finalized"` → use `result.fileUrl` (one network call, confirmed final path)
  - `"temporary_fallback"` → use `result.cachedBlob` directly (zero network calls)
  - `"failed"` → skip
- **Fallback path** (no results, e.g. edit mode): original `collectReceiptSources(payload)` logic

### `src/lib/expenseBatchAttachments.ts`

- Replaced sequential `for` loop with `runWithConcurrency(tasks, 2)` + `finalizeReceiptFile`
- Fixed counting: `movedCount` / `tempFallbackCount` — same pattern as ExpenseForm.tsx

### New file: `Documentations MD/receipt-finalization-diagnostics.sql`

Six read-only SQL queries for diagnosing storage finalization issues in Supabase Studio:
1. Receipt objects for a user/expense (temp vs final)
2. Attachment rows for an expense
3. Cross-check: attachments with temp storage_path
4. Count path quality across all attachments
5. Storage RLS policies
6. Receipt bucket settings

---

## Invariants preserved

- Temp-path fallback from DOC-013 (§1b) is **kept** — when all write strategies fail but the
  file is readable, the expense submits with the temp path as the attachment URL.
- Receipt upload failure does NOT block submission when a verified temp fallback exists.
- No unique index on `(expense_id, storage_path)`.
- No Storage RLS changes.
- No receipts bucket public/private change.
- No service-role key in frontend.

---

## Diagnostic console output after fix

```
[moveTempFilesToExpense] done {
  durationMs: <ms>,
  tempCount: 7,
  movedCount: 7,      ← increments only for "finalized"
  tempFallbackCount: 0,
  failedCount: 0,
  expenseId: "..."
}
```

If `tempFallbackCount > 0`, a toast informs the user that receipts are temporarily stored.

---

## Test coverage

`src/lib/__tests__/receiptFinalization.test.ts` — 14 cases:

1. Path generation from bare filename
2. Bare filename guard (no `/` or URL scheme)
3. move 400 + final confirmed → `"finalized"`
4. move 504 + final confirmed → `"finalized"`
5. All writes fail, temp readable → `"temporary_fallback"` with `cachedBlob`
6. `tempFallbackCount` separate from `movedCount`
7. All strategies fail + temp unreadable → `"failed"` with `resolvedPath: null`
8. `resolvedPath` equals expense-folder path for finalized result
9. `fileUrl` never contains "temp/" for a finalized result
10. `cachedBlob` present on `"temporary_fallback"` result
11. `download()` not called during successful move (no wasted network call)
12. 7 tasks run with concurrency 2, results in order
13. Already-at-final-path → `"finalized"` immediately, `move()` never called
14. `"failed"` result has `resolvedPath: null` and no `fileUrl`

---

## Revision log

| Date | Change | Author |
|------|--------|--------|
| 2026-06-30 | Initial: 5 root causes, waterfall lib, ExpenseForm + backup + batch edits, 14 tests, diagnostics SQL | Agent |
