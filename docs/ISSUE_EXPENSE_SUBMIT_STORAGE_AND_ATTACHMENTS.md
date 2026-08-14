# Issue report: Expense submission, receipt uploads, and Supabase Storage

**Project:** Pesowise (expense claims app)  
**Stack:** React (Vite), Supabase (Postgres, Auth, Storage), hosted receipt bucket `receipts` with temp paths under `temp/{userId}/…`.

---

## 1. Summary

Users could upload multiple bill photos (within the configured size limits), see them listed in the UI with success messaging, but **Submit** would fail or hang. Common outcomes:

- Error toast: *“Bill photos are required for expenses above ₹…”* even though files appeared uploaded.
- Expense left in **draft** or submission appeared “stuck.”
- Browser console showed **HTTP 544** and *“The connection to the database timed out”* on **Storage** API calls (notably `list` on the `receipts` bucket).
- Very slow submits (20–30+ seconds) when many orphaned objects existed under `temp/{userId}/`.

---

## 2. Symptoms (observed)

| What the user sees | What happens technically |
|--------------------|---------------------------|
| “7 bill photos uploaded,” totals e.g. 1.5 MB / 2 MB | UI state and/or Storage **objects** exist under `temp/`. |
| Submit shows error about missing bill photos | **No rows** (or incomplete rows) in `attachments` for that expense; validation in `submitExpense` checks the DB only. |
| Console: `storage/v1/object/list/receipts` → **544** | Supabase Storage **list** operation backed by DB timed out or failed. |
| `Error listing temp files: StorageApiError: The connection to the database timed out` | Our code called `.list()` before moving temp → permanent paths. |

---

## 3. Root causes (analysis)

### 3.1 Dependency on Storage `list()` during submit

Submission flow for **new** expenses:

1. Create expense (often `draft` first).
2. **`moveTempFilesToExpense`**: list `temp/{userId}`, then **copy** each object to `{expenseId}/{filename}`, **insert** `attachments`, **remove** temp object.

If **`list()`** fails (e.g. **544** / DB timeout), the **original** implementation **returned early without moving files** and **without surfacing a clear error**. The rest of the pipeline could still run until **`submitExpense`**, which requires attachment rows in the database → **“bill photos required”** despite a full UI list of uploads.

### 3.2 Moving every file in `temp/{userId}/`

An earlier design moved **all** objects under the user’s temp prefix on every submit. Failed or abandoned submits left many files in `temp/`. The next submit tried to **copy + insert + delete** for **all** of them → **many sequential Storage/DB operations**, long runtimes, and timeouts.

### 3.3 `FileUpload` `expenseId` flipping mid-submit (new expense)

Passing the freshly created expense UUID into `FileUpload` **during** submit caused `useEffect` to reload attachments from the DB **before** temp moves finished. The list was often **empty**, which **wiped local attachment UI state** and contributed to confusing behavior and inconsistent totals.

### 3.4 Attachment metadata when moving from temp

Rows created in **`moveTempFilesToExpense`** sometimes omitted **`file_size`** (and used storage object name as `filename`), so **server-side total size checks** and the UI could disagree.

### 3.5 Pre-submit validation and `list()`

Validation that required “at least one temp file” consulted **`list()`**. When **`list()`** failed, the app could wrongly conclude there were **no** temp files even when the user had already uploaded (URLs/state present).

---

## 4. Plan / fixes implemented (application-side)

These changes were made in the codebase to make behavior correct and resilient **even when Storage `list()` is flaky**:

1. **Stable `expenseId` for new drafts**  
   Keep `FileUpload` on **`"new"`** for create flow so it does not switch to the new expense UUID mid-submit and clear state.

2. **Scope temp moves to this session only**  
   Track temp object names (and metadata) in refs / parsed public URLs so we **only move** receipts tied to the current form, **not** every historical object under `temp/{userId}/`.

3. **Do not hard-fail when `list()` errors**  
   Retry `list()` a few times with backoff; if it still fails, **derive file names from session refs + temp URLs** and run **`copy` + DB insert** without requiring a successful `list()`.

4. **Session metadata map**  
   Store display `filename`, `file_size`, `content_type` per temp object on upload so attachment rows are correct if `list()` returns no metadata.

5. **Pre-submit attachment checks**  
   Treat **session temp keys + temp URLs in state** as evidence of pending uploads, not only a successful `list()`.

6. **Vite dev cache (Windows)**  
   Separate issue: `EPERM` on `node_modules/.vite` → set `cacheDir` to project `.vite/` to reduce file locks (e.g. OneDrive).

---

## 5. What may still require Supabase / infrastructure help

- **HTTP 544** and *“connection to the database timed out”* on **Storage** APIs indicate **server-side** pressure, connectivity, or project limits—not something the frontend can fully eliminate.
- If **`copy`** or **`insert`** also begins failing with timeouts at scale, investigate:
  - Supabase project region, compute, and spikes
  - Whether Storage metadata DB is unhealthy (status page, support tickets)
  - RLS/policies (should not block the same operations that already succeed for `upload`)

---

## 6. Reproduction notes (for support)

1. Create a **new** expense over the org’s “attachment required above” amount (e.g. ₹2,400 vs ₹50).
2. Upload **multiple** PNG/JPG/PDF receipts (total under 2 MB combined if that is the org rule).
3. Click **Submit**.
4. In DevTools **Network**, filter for **`list`** or **`receipts`**; note **544** or timeout on **list** while objects still exist under `temp/{userId}/` in the dashboard.
5. Confirm whether **`attachments`** table has **zero** rows for the new expense when the error appears.

---

## 7. References (code locations)

- `src/pages/ExpenseForm.tsx` — `saveExpense`, `moveTempFilesToExpense`, attachment validation, session refs.
- `src/components/FileUpload.tsx` — upload to `temp/` for new expenses, metadata on upload, `storage_path` for parent tracking.
- `src/services/ExpenseService.ts` — `submitExpense` attachment requirement check (DB-backed).

---

## 8. Contact / next steps

- **App team:** Ensure the fixes above are deployed; re-test submit with many small files and with flaky network.
- **Supabase support:** Provide project ref, timestamps (UTC), failing request IDs if available, and this document—especially for recurring **544** on `storage/v1/object/list/`.

---

*Document generated for handoff to support or engineering; update with your Supabase project reference and exact timestamps when opening a ticket.*
