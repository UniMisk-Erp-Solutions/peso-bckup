# DOC-076 — Receipt Preview: Stale `temp/` Path Recovery

**Last updated:** 2026-08-01
**Status:** in progress (code complete, not deployed)
**Branch:** `fix/tenant-pwa-auth-origin`
**SQL executed:** **No.** All diagnostics are SELECT-only.
**Related:** [DOC-077 — Missing Receipt Files (open incident)](./missing-receipt-files-incident.md)

---

## 1. Summary

Some expenses showed *"This file is no longer available in storage."* while most previewed
normally. A SELECT-only audit split those failures into two unrelated classes:

| Class | Cause | Fixable in code? |
|-------|-------|------------------|
| **A** | The object is genuinely absent from the bucket | **No** — tracked in DOC-077 |
| **B** | The object exists, but `attachments.file_url` still points at the old `temp/` path | **Yes — this document** |

This change fixes class B. It is a **read-path change only**: no upload behaviour, no
temp-file movement, no data migration, no SQL.

---

## 2. Problem

`attachments` rows for expense `361fbbcc-6ada-4442-8848-ba0d59b74169` record:

```
temp/22ba24a5-40dc-4618-a2de-098974237111/1782737966702-yrc2mnmcdyi.png
```

while the object actually lives at:

```
361fbbcc-6ada-4442-8848-ba0d59b74169/1782737966702-yrc2mnmcdyi.png
```

The temp → expense copy succeeded, but `file_url` was never updated to the final path.

The preview loader could not recover from this. In `candidateReceiptPaths()`:

```ts
const candidates = [
  storagePath,
  userId && !storagePath.startsWith("temp/") ? `temp/${userId}/${filename}` : null,
];
```

When the stored path **already** begins with `temp/`, the second candidate is `null`, so the
only path attempted is the stale temp one. `{expenseId}/{filename}` was never tried.

`LoadAttachmentBlobOptions.fallbackExpenseId` existed and was documented as *"Expense id —
used to try `{expenseId}/file` when the stored path points elsewhere"*, but it was **never
read** by `candidateReceiptPaths()` and **never passed** by any caller. The documented
recovery had no implementation behind it.

---

## 3. Root cause

Two-directional staleness was possible, only one direction was handled:

| Direction | Stored path | Real location | Handled before? |
|-----------|-------------|---------------|-----------------|
| (a) move never ran | `{expenseId}/file` | `temp/{userId}/file` | Yes |
| (b) move ran, URL not updated | `temp/{userId}/file` | `{expenseId}/file` | **No** |

---

## 4. Solution

`candidateReceiptPaths()` now adds the mirror-image fallback:

```ts
const storedIsTemp = storagePath.startsWith("temp/");
const candidates = [
  storagePath,
  userId && !storedIsTemp ? `temp/${userId}/${filename}` : null,     // (a)
  expenseId && storedIsTemp ? `${expenseId}/${filename}` : null,     // (b)
];
```

`fallbackExpenseId` is now threaded from every preview surface. The dialog and thumbnail
components gained an `expenseId` prop; the render sites pass `selectedExpense?.id` /
`expense.id`. **No callback signatures changed.**

The candidate list stays capped at three entries, preserving the deliberate
"don't multiply failed requests for genuinely-missing receipts" design, and the existing
session negative-cache (`KNOWN_MISSING_RECEIPTS`) is untouched.

---

## 5. Key files touched

| File | Change |
|------|--------|
| `src/lib/attachmentPreview.ts` | `candidateReceiptPaths()` reads `fallbackExpenseId`; adds `{expenseId}/{filename}` when the stored path is a `temp/` path |
| `src/components/AttachmentPreviewDialog.tsx` | new `expenseId` prop, forwarded as `fallbackExpenseId` |
| `src/components/AttachmentThumbnail.tsx` | new `expenseId` prop, forwarded as `fallbackExpenseId` |
| `src/pages/AdminPanel.tsx` | passes `selectedExpense?.id` (dialog ×2, thumbnail ×1) |
| `src/pages/EngineerReview.tsx` | passes `selectedExpense?.id` (dialog ×2) |
| `src/pages/ExpenseDetail.tsx` | passes `expense?.id` |
| `src/components/BatchExpenseDetailCard.tsx` | passes `expense.id` (dialog + thumbnail) |
| `src/components/mobile/MobileAdminExpenseDetailView.tsx` | passes `expense.id` |
| `src/lib/__tests__/receiptStaleTempPathRecovery.test.ts` | **new** — 5 tests |
| `scripts/diagnose-missing-receipts.sql` | **new** — SELECT-only diagnostics (Q1–Q7) |

---

## 6. Database / migrations

**None.** No migration, no data change, no SQL executed.

An optional data-repair `UPDATE` to rewrite the stale `file_url` values is deliberately
**not** included: the read-path fix makes those receipts display without touching data,
which is the lower-risk option. If the rows are ever normalised, the code fix remains
correct either way.

---

## 7. Expected impact

Measured from the Q4/Q5/Q6 audit on 2026-08-01:

| Group | Rows | After this fix |
|-------|------|----------------|
| 2026-06-29, expense `361fbbcc` | 6 | **Display again** (bytes confirmed present at `{expenseId}/`) |
| 2026-07-13, expense `61ad7216` | 3 | Still broken — bytes absent (DOC-077) |
| 2026-07-30, expense `bcb9dbc8` | 1 | Still broken — bytes absent (DOC-077) |
| On/before 2026-05-27 | ~1,865 | Still broken — restore data loss (DOC-077) |

So this change recovers **6 of the 10** post-restore failures. It does not and cannot
recover anything in DOC-077.

---

## 8. Test plan

`src/lib/__tests__/receiptStaleTempPathRecovery.test.ts` — 5 tests, all passing:

1. finds the object at `{expenseId}/file` when the record still says `temp/` (the production case)
2. the normal case (recorded path correct) still resolves
3. the reverse case (recorded permanent, file still in temp) still resolves
4. returns `null` when the bytes are genuinely absent everywhere
5. no speculative path explosion — at most 3 candidates attempted

### Validation

| Check | Result |
|-------|--------|
| `npx tsc --noEmit` | pass |
| `npm test -- --run` | **1716 passed / 99 files** |

### Manual verification after deploy
1. Open expense `361fbbcc-6ada-4442-8848-ba0d59b74169` in Review/Admin.
2. Confirm the PNG and the PDF now preview.
3. Confirm the network tab shows a successful GET on `361fbbcc…/1782737966702-yrc2mnmcdyi.png`.
4. Open an expense with a genuinely-missing receipt and confirm the
   "no longer available in storage" message still appears (no infinite retry).
5. Confirm a normal, healthy receipt still previews on the first request.

---

## 9. Rollback

Revert the commit. Read-path only — no data, schema or storage changes, so rollback simply
restores the previous (broken) fallback behaviour for the 6 affected rows.

---

## Revision log

| Date | Rev | Author | Notes |
|------|-----|--------|-------|
| 2026-08-01 | 1.0 | Agent | Initial — `fallbackExpenseId` was documented but never read or passed; wired it through 8 files and added the `{expenseId}/{filename}` candidate for stale `temp/` records. Recovers 6 of 10 post-restore broken previews. 5 new tests (1716 total). SELECT-only diagnostics added. **No SQL executed.** |
