# Removed attachments reappearing after submission

**Doc ID:** DOC-143  
**Status:** in progress (merge-ready on PR #13; deploy pending)  
**Last updated:** 2026-10-08  
**Owner / area:** Expenses / receipt upload / finalize / attachment persistence  

---

## 1) Summary

An employee uploaded several bill photos on the expense form, removed some of them from the list **before** pressing Submit, and still saw the removed photos on the submitted expense (employee detail and admin views). One report: 4 photos were meant to remain, many more were attached.

Root cause: the upload list shown to the employee and the list the form **finalizes at submit** were two independent structures. Removing a photo changed only the upload component's own list. The form's registries of temp uploads were append-only, and the submit step finalized and linked **every file ever uploaded in the session**.

The persisted expense must equal the attachment set the employee sees when pressing Submit. It now does: the finalize list is derived only from the visible attachments, removals are propagated to every registry at the moment they happen, and a retried draft is reconciled so stale or duplicated rows cannot stay active.

This incident is about **submission and upload**. It is separate from the admin attachment preview slowness (DOC-141) and is not mixed with it.

## 2) Symptoms

- After Submit, the expense lists more attachments than the employee had left in the form.
- Removed photos are visible to admin reviewers and in the employee's own expense detail.
- No error anywhere: every call succeeded.

## 3) Exact flow and where removed files stayed alive

| Step | What happens | Removed file still present? |
|---|---|---|
| File selected | `FileUpload` uploads the file to `receipts/temp/{user}/{unique name}` | n/a |
| Upload completes | `FileUpload` adds it to **its own** list; the form's `onUploadComplete` appends the public URL to `attachments` (state + `formStateRef`) and records the temp name in `sessionTempFilenamesRef`, its metadata in `sessionTempUploadMetaRef`, the URL to name map in `tempStoragePathByUrlRef`, and the bytes in `sessionBlobCacheRef` | n/a |
| **Remove clicked** | `deleteAttachment` removes the item from `FileUpload`'s own `attachments` state and, for a temp item, does nothing else (`removeAttachmentSafely` returns `local_only`). **No callback existed, so the form was never told.** | **YES: the form's `attachments`, `sessionTempFilenamesRef`, `sessionTempUploadMetaRef`, `tempStoragePathByUrlRef` and `sessionBlobCacheRef` all still held the file** |
| Draft autosave | `buildDraftPayloadFromRef` serialises `attachments` and the session registries (stale) | YES |
| Submit, attach step | `moveTempFilesToExpense` built the finalize list from `Array.from(sessionTempFilenamesRef.current)` (plus names re-derived from the stale `attachments` URLs) | **YES: removed files were in the finalize payload** |
| `finalize-expense-receipts` | Copies every file it is sent to `{expenseId}/{name}` | YES |
| Attachment rows | One `attachments` insert per finalized file | **YES: removed files got active rows** |
| Safety copy / backup | Built from the same stale payload plus the finalize results | YES (inherited) |
| Detail / admin views | Read the active rows | YES (the symptom) |

The temp objects themselves are harmless orphans; what made the bug real is that removed temp files were **finalized and linked** (case B in the audit brief), not merely left in temp storage (case A).

## 4) Root cause

1. `FileUpload` owned a private list and exposed no removal event.
2. `ExpenseForm` kept five parallel, append-only structures for the same uploads and never removed from any of them.
3. `moveTempFilesToExpense` treated the append-only `sessionTempFilenamesRef` as the source of truth for what to finalize, instead of the attachments the employee could see.

Nothing fails when this happens, so no monitoring fired.

## 5) State arrays involved (before the fix)

| Structure | Owner | Shrinks on remove? |
|---|---|---|
| `attachments` (urls) / `formStateRef.attachments` | ExpenseForm | no |
| `sessionTempFilenamesRef` (temp names) | ExpenseForm | no (this was the finalize manifest) |
| `sessionTempUploadMetaRef` | ExpenseForm | no |
| `tempStoragePathByUrlRef` | ExpenseForm | no |
| `sessionBlobCacheRef` (blob fallback) | ExpenseForm | no |
| `attachments` state | FileUpload | yes (visible list only) |

## 6) Fix

**One canonical attachment set:** the attachments currently visible in the form (`formStateRef.current.attachments`). Everything downstream derives from it.

- `FileUpload`: new `onAttachmentRemoved` callback (called after any persisted row was unlinked); new `seedAttachments` so restored draft attachments are listed and removable; pending uploads are now listed with a remove button; every upload has a stable id; a removed or torn-down in-flight upload is ignored when it completes (and, in edit mode, an already-inserted row is unlinked); a double click cannot remove twice; soft-deleted rows are never listed.
- `src/lib/expenseAttachmentManifest.ts` (new, pure and tested): `buildFinalizeManifest` (visible URLs only), `removeAttachmentFromSessionRegistries`, `registerUploadedAttachment`, `finalizeAndLinkReceipts` (extracted from the form, unchanged behaviour), `planAttachmentReconciliation` / `reconcileExpenseAttachments`.
- `ExpenseForm`: `handleAttachmentRemoved` drops the file from the canonical list and all registries immediately and re-saves the draft; `moveTempFilesToExpense` takes the manifest from the visible list and re-aligns `sessionTempFilenamesRef` to it; the upload-complete path updates the canonical list synchronously; restoring a draft remounts the upload list so restored files are visible.
- **MicroLink attach-first flow:** a retry replays the **same draft expense**. After attaching, `reconcileExpenseAttachments` unlinks (soft delete, metadata only) any active row for a file that is no longer wanted and any later duplicate row of the same file. An empty manifest on a bill-required expense is treated as "already linked" and never wipes rows.
- Other screens with the same defect class: `AdminSubmitExpense` (pending receipts) and `ExpenseBatchForm` / `BatchLineReceiptSection` / `BatchExpenseLinesTable` (per-line and shared bills) now drop removed receipts too.
- Readers: `ExpenseDetail`, `EngineerReview`, `AdminPanel`, `BatchExpenseDetailCard` and the edit-form load no longer show soft-deleted rows (client-side filter on `deleted_at`, safe whether or not the column exists in an environment).

**Delete semantics chosen:** removal before submit is metadata and registry only; the temp object is left as an orphan for the retention job (DOC-078 forbids browser-issued physical deletes). A removed file is never finalized or linked. Persisted rows (edit mode, retried drafts) are soft-deleted with the existing `soft_delete_attachment` function, never hard-deleted by this change.

## 7) Counts

| | Before | After |
|---|---|---|
| Local reproduction: 8 uploaded, 4 removed in the list | finalize payload **8**, active rows **8** | finalize payload **4**, active rows **4** |
| Draft flow: 6 uploaded, 2 removed | 6 | 4 |
| Retried draft: 6 attached, 2 more removed, re-submitted | 12 (the old form re-attached all 6 as duplicates) | 4 |

(Local reproduction against the real `FileUpload` component and an in-memory Supabase fake. It is not a Production trace.)

## 8) Tests

`src/components/__tests__/FileUploadAttachmentRemoval.test.tsx` (20), `src/lib/__tests__/expenseAttachmentManifest.test.ts` (15), `src/pages/__tests__/removedAttachmentsWiring.test.ts` (structural guards). They assert the finalize payload, the inserted rows, the persisted count and that no removed file was finalized or linked, for: 8 to 4 removal; first/middle/last; rapid and double clicks; remove before and after upload completes; re-adding the same file; duplicate filenames; PDFs and images; restored drafts; draft save then remove then submit; retry after a lost finalize response; retry after the edge function was down; repeated attach (double submit); edit mode soft delete; and old call sites that pass none of the new props. Mutation checks: disabling the callback fails 13 of the 20 behavioural tests; breaking manifest de-duplication fails the unit suite.

## 9) Not covered / open

- **Production audit of historical expenses was not run.** Whether past expenses contain unintended attachments cannot be told from the database alone (intent is not recorded). A read-only pool query is in section 10. Nothing is deleted, backfilled or corrected by this change.
- **Soft-deleted rows in readers (closed in rev 1.1).** `AdminPanel`, `BatchExpenseDetailCard` and the edit-form load now read `*` and filter `deleted_at` client-side, like `ExpenseDetail`, `EngineerReview` and `FileUpload`. Not verified against Production whether the DOC-078 migration is applied.
- A removed in-flight upload leaves an orphan temp object (retention job).
- No real browser run was possible in this session (login required); behaviour was verified against the real component with a fake backend.

## 10) Read-only audit query (for the owner to run; counts only)

```sql
-- Active attachments per expense (bucketed), submitted/approved expenses, last 90 days.
SELECT least(n, 10) AS attachments, count(*) AS expenses
FROM (
  SELECT a.expense_id, count(*) AS n
  FROM public.attachments a
  JOIN public.expenses e ON e.id = a.expense_id
  WHERE to_jsonb(a)->>'deleted_at' IS NULL
    AND e.status <> 'draft'
    AND e.created_at > now() - interval '90 days'
  GROUP BY a.expense_id
) t
GROUP BY 1 ORDER BY 1;
```

An expense with an unusually high count is a **candidate**, not proof: intent is not stored, so each needs an owner decision.

## 11) Key files

```
src/lib/expenseAttachmentManifest.ts            (new)
src/components/FileUpload.tsx
src/pages/ExpenseForm.tsx
src/pages/AdminSubmitExpense.tsx
src/pages/ExpenseBatchForm.tsx
src/components/BatchLineReceiptSection.tsx
src/components/BatchExpenseLinesTable.tsx
src/pages/ExpenseDetail.tsx
src/pages/EngineerReview.tsx
src/test/fakeReceiptBackend.ts                  (test helper)
```

No migration. No edge-function change.

## 12) Revision log

| Date | Rev | By | Change |
|---|---|---|---|
| 2026-10-08 | 1.0 | Claude Code | Incident analysed, canonical attachment set implemented, retried-draft reconciliation, other screens aligned, tests and documentation added. Not deployed. |
| 2026-10-08 | 1.1 | Claude Code | Soft-deleted rows now filtered in all attachment readers; merge-ready. |
