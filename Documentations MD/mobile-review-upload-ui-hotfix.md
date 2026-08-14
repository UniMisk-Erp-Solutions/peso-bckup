# DOC-038 — Mobile Review Card Parity + Receipt Filename Layout Hotfix

**Status:** complete
**Branch:** `staging/mobile-rc`
**Date:** 2026-07-02
**Tests:** T57–T70 (14 new tests; 582 total)

---

## Summary

Two mobile UI hotfixes applied to `staging/mobile-rc`. No new Supabase queries, RLS changes, migrations, or service/payload changes. Desktop layouts unaffected.

---

## Bug A — Review queue cards present expense information poorly

### Problem

`MobileReviewExpenseCard` had expense title and employee name grouped together in one flex block, with no visual separation between the primary title row and employee identity. The expense date was isolated at the bottom of the card after the badge row. The `category` field was missing from the card entirely.

`MobileReviewDetailView` had the expense title crammed inline next to the "Queue" back button on the same header row, making long titles unreadable on narrow phones.

### Fix A1 — `src/components/mobile/MobileReviewExpenseCard.tsx` (complete rewrite)

New information hierarchy matches `MobileAdminExpenseCard` parity spec:

**TOP ROW** — `expense.title` (font-semibold, truncate) with `expense.total_amount` right-aligned (tabular-nums, shrink-0)

**SECONDARY IDENTITY** — `expense.user_name` (font-medium, separate block) then `formatSubline(expense)` on the line below with `aria-label={expense.user_email}` and `title={expense.user_email}` so the full email is always accessible even when the visible text shows an employee ID

**CONTEXT ROW** — flex-wrap row containing, in order:
- `ExpenseStatusWithCorrectionBadge` (status + wasReviewerCorrected)
- `expense.category` text span (only when present, `capitalize`)
- Formatted `expense.trip_start` date
- Batch badge (only when `batch_id` is non-null)
- Resubmitted badge (only when `isResubmitted` is true)
- "Action needed" badge (only when `isPending` is true)

Removed: isolated `<div>` date line at bottom. Date moved into context row alongside badges.

### Fix A2 — `src/components/mobile/MobileReviewDetailView.tsx`

**Header:** Removed `<h1 className="text-base font-semibold truncate flex-1">{expense.title}</h1>` from the back-button row. Changed back button label from `"Queue"` to `"Review Queue"` for clarity. The header now contains only the back navigation.

**Summary card:** Added `expense.title` as the first line inside the summary card, above `expense.user_name`, with `font-bold text-sm truncate`. The title now reads prominently, with room to wrap or truncate gracefully.

### Test fix — `src/components/mobile/__tests__/MobileReview.test.tsx`

Existing test at line 387 used `getByRole("button", { name: /view/i })` to locate the attachment "View" button. After the button label change to "Review Queue" (which contains "view"), the regex matched two buttons. Fixed to `{ name: /^view$/i }` (exact match).

---

## Bug B — Receipt filenames extend beyond viewport on mobile

### Problem

`FileUpload.tsx` rendered uploaded-file cards and the upload dropzone without explicit mobile width constraints. On narrow phones (360–390 px), the outer file-row flex container had no `min-w-0`, `w-full`, or `max-w-full` guard, allowing content to push the card wider than the viewport. The metadata line (content type + file size + date) had no `truncate` class and could overflow unconstrained.

Root cause was a width-hierarchy gap, NOT a CSS overflow-x issue. The fix avoids `overflow-x: hidden`.

### Fix — `src/components/FileUpload.tsx`

Three `cn()` additions, all gated on `forceMobileLayout` (`variant === "mobile" || isMobile`):

| Location | Class(es) added when `forceMobileLayout` |
|----------|------------------------------------------|
| Upload dropzone `<div>` (line 472) | `min-w-0 w-full max-w-full` |
| Outer file-row `<div>` (line 619) | `min-w-0 w-full max-w-full` |
| Metadata `<p>` (content type + size + date, line 625) | `truncate` |

Filename `<p>` already had `truncate` — no change needed.

No upload behavior, callbacks, retry logic, preview, compression, or temp/final path logic was changed.

---

## Files changed

| File | Change |
|------|--------|
| `src/components/mobile/MobileReviewExpenseCard.tsx` | Complete rewrite — three-section hierarchy (top, secondary, context row) |
| `src/components/mobile/MobileReviewDetailView.tsx` | Title removed from header; title added to summary card; back button → "Review Queue" |
| `src/components/FileUpload.tsx` | Three `cn()` mobile guards: dropzone + file-row div + metadata p |
| `src/components/mobile/__tests__/MobileReview.test.tsx` | `/view/i` → `/^view$/i` exact match (regression fix for "Review Queue" button) |
| `src/components/mobile/__tests__/mobileReviewUploadHotfix.test.tsx` | 14 new tests T57–T70 |

---

## Tests (T57–T70)

| ID | Description |
|----|-------------|
| T57 | Review card: title is first text element in DOM (precedes employee name) |
| T58 | Review card: amount has `tabular-nums` class and is present in top row |
| T59 | Review card: employee name element has `font-medium` (secondary, not primary) |
| T60 | Review card: formatSubline div carries `aria-label` equal to `user_email` |
| T61 | Review card: category shows in context row when expense.category is set |
| T62 | Review card: date appears inside the `flex-wrap` context row alongside status badge |
| T63 | FileUpload `variant="mobile"`: dropzone renders in the DOM |
| T64 | FileUpload `variant="mobile"`: dropzone has `min-w-0` class |
| T65 | FileUpload `variant="mobile"`: dropzone has `w-full` class |
| T66 | FileUpload `variant="mobile"`: dropzone has `max-w-full` class |
| T67 | FileUpload file-row div has `min-w-0` class in mobile mode (with loaded attachment) |
| T68 | FileUpload file-row div has `w-full` class in mobile mode (with loaded attachment) |
| T69 | FileUpload metadata line has `truncate` class in mobile mode (with loaded attachment) |
| T70 | FileUpload filename element always has `truncate` class regardless of variant |

All 582 tests pass (567 pre-existing + 15 new — T57–T70 + 1 existing test fix).

---

## Architecture constraints respected

- No new Supabase queries, RLS, migrations, storage, or Edge Functions touched.
- No ExpenseService modifications.
- No approval, batch, or permission logic changed.
- No `overflow-x: hidden` used as a width fix (root width hierarchy addressed instead).
- Desktop layouts unaffected: all `FileUpload` changes gated behind `forceMobileLayout`.
- Upload behavior preserved: file input, camera capture, compression, retry, preview, callbacks, temp/final paths all unchanged.
