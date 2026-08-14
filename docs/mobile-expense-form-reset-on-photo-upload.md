# Mobile expense form reset when uploading a photo

**Product:** PesoWise  
**Area:** Employee expense form (`/expenses/new`, `/expenses/:id/edit`)  
**Reported symptom:** User fills in expense details, opens the camera or gallery to attach a bill photo, and when they return to the app **all entered data is gone**. This makes it hard to keep accounts accurate.  
**Related (separate issue):** Admin panel loading ~1,800+ expenses slowly — addressed with smaller initial fetch and background enrichment in `AdminPanel.tsx`.

---

## User-visible problem

1. Open **Create expense** (or edit an expense).
2. Enter title, amount, destination, category, custom fields, etc.
3. Tap **Take Photo** or **Choose Files**.
4. Use the device camera or file picker.
5. Return to the expense form.

**Expected:** All previously entered fields remain.  
**Actual (reported):** Form appears empty or partially reset; user must re-enter everything.

This happens most often on **mobile** (Android/iOS browsers, in-app WebViews). Desktop is less affected but not guaranteed safe.

---

## Why this is hard to fix

Mobile browsers do not behave like desktop tabs:

| Behavior | Effect on React forms |
|----------|------------------------|
| App goes to background when camera opens | `visibilitychange` / `pagehide` fires |
| Low memory | Full page reload; React state is lost |
| bfcache (back-forward cache) | Page may restore without re-running all effects |
| Private / restricted storage | `localStorage` may fail silently |
| Auth token refresh | Can trigger loading UI and brief unmount |

The form is a large React component with many `useState` hooks. **If the component unmounts or the page reloads, in-memory state is gone** unless it was copied somewhere durable first.

---

## Technical issues identified (root causes)

### 1. Stale closure on “save draft when leaving” (first major bug)

A `visibilitychange` / `pagehide` listener was registered in a `useEffect` that **did not depend on form state**. The handler called `persistExpenseDraft()` from the **first render**, which still had **empty** `expense`, `formFieldValues`, etc.

**Sequence:**

1. User types data (state updates).
2. User opens camera → page hidden → flush runs.
3. Flush saves **empty** draft to `sessionStorage` / `localStorage`.
4. Good draft is **overwritten**.
5. User returns → restore loads **empty** draft → form looks reset.

**Fix direction:** Always read **current** values (refs updated every render, or `useCallback` with full deps, or force-save with explicit payload).

---

### 2. Autosave racing with async restore (second major bug)

Draft restore ran in `useEffect` and called **async** `fetchCategoryFormFields()` before applying custom field values. Meanwhile:

1. `draftReadyRef` was set to `true` immediately.
2. Autosave scheduled ~300–500ms later with **still-empty** state.
3. Empty autosave **overwrote** the stored draft (see also issue 1).

**Fix direction:** Restore **synchronously** in `useLayoutEffect` (title, amount, attachments, custom fields) before showing inputs; load category metadata with `preserveFormValues`; gate autosave until **hydration complete**.

---

### 3. Form rendered before draft was applied

Inputs mounted with default empty state, then restore ran later → flash of empty form and race with autosave.

**Fix direction:** `formReady` flag — show **“Loading your saved entries…”** until draft is loaded (create flow) or server fetch completes (edit flow).

---

### 4. Edit flow: server fetch overwriting in-progress edits

On `/expenses/:id/edit`, `fetchExpense()` loads DB rows, then draft restore ran late or was skipped. Unsaved local edits could be lost if the user had changed fields before upload.

**Fix direction:** After `fetchExpense()`, call `restoreDraftIfAny()` so **local draft wins** when it exists and is meaningful.

---

### 5. Draft not saved before picker opens

If the user opened the camera within ~300ms of the last keystroke, debounced autosave might not have run yet.

**Fix direction:** `onBeforePickerOpen` on `FileUpload` + `onFocus` on hidden file inputs → **synchronous** save before OS picker opens.

---

### 6. Only `sessionStorage` initially

`sessionStorage` is cleared in some mobile scenarios. Later switched to **`localStorage` + `sessionStorage` + in-memory Map**.

---

### 7. Empty saves wiping good drafts

Autosave on mount or after failed restore could write an “empty” payload.

**Fix direction:** `isExpenseFormDraftMeaningful()` + **do not overwrite** a meaningful existing draft with an empty one (unless `force: true` for explicit flush before camera).

---

### 8. Possible auth / route remount (mitigated, not fully eliminated)

`AuthContext` can set `loading: true` during sign-in profile load. `ProtectedRoute` was updated to **not unmount** children if the user was already authenticated (`hadAuthenticatedUserRef`), so the form should stay mounted during token refresh.

If the **entire page** reloads, only storage + memory cache help.

---

## What we implemented (attempts over time)

### Attempt 1 — Basic session draft (commit `a311826`)

| Change | File(s) |
|--------|---------|
| `expenseFormDraft.ts` — save/load draft | `src/lib/expenseFormDraft.ts` |
| Autosave every ~500ms, flush on `pagehide` / `visibilitychange` | `src/pages/ExpenseForm.tsx` |
| Save on upload complete | `ExpenseForm.tsx`, `FileUpload.tsx` |
| `onBeforePickerOpen` before camera/files | `src/components/FileUpload.tsx` |
| `USER_UPDATED` / token refresh without full reload | `src/contexts/AuthContext.tsx` |
| Keep route mounted during auth refresh | `src/components/ProtectedRoute.tsx` |

**Result:** User still reported data loss after deploy.

---

### Attempt 2 — Stale-closure and anti-wipe fixes (commit `438dc0b`)

| Change | Purpose |
|--------|---------|
| `draftSnapshotRef` updated each render | Flush uses latest fields |
| `useLayoutEffect` for restore on create | Restore before paint |
| `fetchCategoryFormFields(..., { preserveFormValues })` | Don’t reset custom fields after restore |
| `isExpenseFormDraftMeaningful` + skip empty overwrite | Protect stored draft |
| `localStorage` instead of only `sessionStorage` | Better mobile persistence |
| Draft scope per expense id for edit mode | Edit + create both covered |
| Unit tests | `src/lib/__tests__/expenseFormDraft.test.ts` |

**Result:** User still reported the issue (could not use console on client devices).

---

### Attempt 3 — Robust persistence layer (local, may not be pushed yet)

| Change | Purpose |
|--------|---------|
| **In-memory draft cache** (`memoryDraftByKey` Map) | Survives React remount in same tab without disk |
| **`useExpenseFormDraft` hook** | Central bootstrap, autosave, listeners |
| **`formReady` gate** | No inputs until draft loaded or edit fetch done |
| **Restore on `visibilitychange` visible + `pageshow`** | Re-apply draft when returning from camera |
| **`ExpenseFormDraftBanner`** | User-visible: saved / restored / failed (no console needed) |
| **Force save** (`{ force: true }`) before picker | Save even when debounce hasn’t fired |
| **Loading copy** | `form.draft.loading` — “Loading your saved entries…” |

**Files added/updated:**

- `src/lib/expenseFormDraft.ts`
- `src/hooks/useExpenseFormDraft.ts`
- `src/components/ExpenseFormDraftBanner.tsx`
- `src/pages/ExpenseForm.tsx`
- `src/components/FileUpload.tsx`
- `src/locales/en/expenses.json` (draft strings)
- `src/lib/__tests__/expenseFormDraft.test.ts`

---

## How to verify (no developer console required)

1. Deploy build that includes the latest draft changes.
2. On a **phone**, open **New expense**.
3. Enter at least **title** and **amount**.
4. Look for a **green banner**: “Progress saved” (optional but confirms save path works).
5. Tap **Take Photo**, capture an image, return to the browser.
6. **Expected:** Fields still filled; optional **amber banner**: “Entries restored”.
7. If **red banner** appears: storage may be blocked — try normal (non-private) browser tab.

---

## What is still uncertain

| Risk | Notes |
|------|--------|
| Full WebView kill + no storage | Some OEM browsers clear storage aggressively; memory cache only helps same JS session without reload. |
| Very old cached JS bundle | User must hard-refresh or redeploy hosting after git push. |
| Edit vs create | Confirm which path user uses when reporting bugs. |
| Custom fields only (no title/amount) | Meaningful-draft rules were expanded (category ≠ `other`, attachments, etc.) but edge cases may remain. |
| iOS PWA vs Safari tab | Behavior can differ; not fully tested on every device. |

---

## Admin slow loading (related report, fixed separately)

**Symptom:** Admin “All Expenses” stuck on “Loading expenses…” with 1,000+ rows.

**Causes:**

- Fetched up to **1,000 rows** upfront.
- Waited for heavy enrichment (audit logs, custom fields, corrections) before `loading` became false.

**Mitigations in `AdminPanel.tsx`:**

- Initial fetch **150** rows.
- Show table after basic rows + profiles; enrich in background.
- Separate `expensesLoading` from global panel `loading`.

---

## Git history (reference)

| Commit | Message |
|--------|---------|
| `a311826` | fix: preserve expense drafts on mobile upload and speed up admin list |
| `438dc0b` | fix: robust expense form draft restore on mobile photo upload |
| *(local)* | In-memory cache, `useExpenseFormDraft`, banner, `formReady` gate |

---

## Recommended next steps if issue persists

1. **Confirm deployed version** — hosting must serve latest `main` after push.
2. **Ask user:** New or Edit? Phone model + browser (Chrome, Safari, in-app WebView).
3. **Ask user:** Do they see green/amber/red draft banner?
4. **Consider** lifting form state to a **React Context above `Layout`** so remount scope is smaller.
5. **Consider** **IndexedDB** fallback if `localStorage` is blocked (larger change).
6. **Consider** saving draft to server as “draft expense” row on first field blur (requires API).

---

## Summary

The issue is **loss of in-progress form state** when the mobile OS interrupts the page for the camera. Fixes rely on **saving early, saving correctly (no stale/empty overwrites), restoring before showing the form, and re-restoring when the user returns** — plus **visible feedback** so users and support can tell if persistence worked without opening the browser console.
