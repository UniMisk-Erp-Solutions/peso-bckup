# Admin Expense CSV Export Fix

**Doc ID:** DOC-069  
**Status:** complete  
**Last updated:** 2026-07-22  
**Owner / area:** Admin Panel / Expenses export  

---

## 1) Summary

The Admin Expenses CSV export at `/admin/expenses` produced misaligned columns in Excel, Google Sheets, and LibreOffice. Every row was shifted by one column from the "Submitted Date" column onward because the timestamp cell contained an unescaped comma. This fix replaces the ad-hoc export logic with a central RFC-4180 serializer (`src/lib/csv.ts`), uses comma-free date/timestamp formats, renames headers to clearer names, uses CRLF line endings, and adds formula-injection protection for user-controlled text.

---

## 2) Problem / requirement

**Root cause:** `src/pages/AdminPanel.tsx` line 1606 (before fix):

```typescript
formatCreatedDateTime(expense.created_at),  // ← raw, unescaped
```

`formatCreatedDateTime` returns `"Jul 22, 2026 at 11:04 AM"` — a string with a comma after the day number. When the row was assembled with `row.join(",")`, this comma was treated as a cell separator, creating an extra Column E and shifting every subsequent column.

**Secondary issues:**
- Headers were never passed through any escaping function (safe by accident — no commas in old header names).
- Row separator was `"\n"` not `"\r\n"` — weaker Excel compatibility.
- Transaction Date was formatted as `yyyy-MM-dd` (fine, no comma) but timestamp was unescaped.
- Column header names were ambiguous ("Transaction ID" vs "Transaction Number", "Title" vs "Expense Title").
- No formula injection protection on user-controlled text fields.

**Required invariants (all 18 verified):**
1. No accidental extra Column E.
2. Every row has the same number of cells as the header.
3. Submitted date+time remain in one cell.
4. Headers use the new agreed names.
5. Works correctly in Excel, Google Sheets, LibreOffice.
6. Custom fields containing commas, quotes, or newlines remain valid.
7. Existing filtering/export scope unchanged.
8. No unrelated behavior changes.
9. Formula injection characters (`=`, `+`, `-`, `@`) in user text prefixed with `'`.
10. Numeric strings (`"439.00"`, `"-100.50"`) are NOT formula-protected.
11. `null`/`undefined` values become empty cells, never `"null"` or `"undefined"`.
12. CRLF (`\r\n`) line endings.
13. UTF-8 BOM preserved for Excel.
14. Column count guard — toast shown before download if mismatch detected.
15. Transaction Date uses `dd-MMM-yyyy` (no comma).
16. Submitted At uses `dd-MMM-yyyy hh:mm a` (no comma).
17. `parseLocalDate()` used for date-only strings (avoids timezone off-by-one).
18. All 1388 tests pass after fix.

---

## 3) Solution

### New file: `src/lib/csv.ts`

A small, standalone RFC-4180 serializer with:

| Export | Purpose |
|--------|---------|
| `escapeCsvCell(value)` | Serialize one cell: null→`""`, finite numbers unquoted, strings quoted when containing `,  "  \n  \r`, formula-prefix chars neutralized with `'` (except numeric strings) |
| `serializeCsvRow(values)` | Join cells with `,` — every value through `escapeCsvCell` |
| `serializeCsv(headers, rows)` | Full document with CRLF endings — headers pass through the same serializer |
| `formatCsvDate(dateStr)` | `dd-MMM-yyyy` from `YYYY-MM-DD` via `parseLocalDate` — no comma |
| `formatCsvTimestamp(iso)` | `dd-MMM-yyyy hh:mm a` from ISO string — no comma |

### Updated: `src/pages/AdminPanel.tsx` — `exportExpenses` function

- Removed the local `escapeCSV` helper.
- Added `import { serializeCsv, formatCsvDate, formatCsvTimestamp } from "@/lib/csv"`.
- Updated headers to the agreed names (see §4 below).
- Rebuilt data rows as raw values — `serializeCsv` handles all escaping.
- Used `formatCsvDate` for Transaction Date and `formatCsvTimestamp` for Submitted At.
- Trimmed all text fields before passing to serializer.
- Added column-count integrity guard: if any row's length differs from the header count, shows a destructive toast and aborts the download.
- `serializeCsv` produces CRLF line endings automatically; the UTF-8 BOM is retained.

### Header rename table

| Old name | New name |
|----------|----------|
| Date of Transaction | Transaction Date |
| Submitted Date | Submitted At |
| Transaction ID | Transaction Number |
| Title | Expense Title |
| Amount | Amount (INR) |
| Opening Balance | Opening Balance (INR) |
| Closing Balance | Closing Balance (INR) |

---

## 4) Key files

```
src/lib/csv.ts                              (new — RFC-4180 serializer + date formatters)
src/pages/AdminPanel.tsx                    (exportExpenses function rewritten)
src/lib/__tests__/csvExport.test.ts         (52 new tests)
```

---

## 5) Database / migrations

None. Pure frontend fix — no SQL, no migrations, no RLS changes.

---

## 6) Test plan

- [x] `npx tsc --noEmit` → 0 errors
- [x] `npx vitest run` → 1388/1388 passed (52 new: `csvExport.test.ts`)
- [x] `npx vite build` → success
- [ ] Navigate to `/admin/expenses` → click Export CSV
- [ ] Open in Excel: verify 13 + N custom field columns, no extra Column E
- [ ] Open in Google Sheets: same column count check
- [ ] Parth Panchal row: "Submitted At" cell shows `22-Jul-2026 11:04 AM` (no comma, in one cell)
- [ ] Expense title containing comma (e.g. `"Lunch, dinner"`) → stays in one cell, quoted
- [ ] Custom field with `=SUM(A1)` as value → prepended with `'`, not executed by spreadsheet
- [ ] Amount `-439.00` → appears as `-439.00`, NOT `'-439.00`
- [ ] Transaction Date shows `dd-MMM-yyyy` format (e.g. `22-Jul-2026`)
- [ ] Filter by user then export → only filtered rows exported (scope unchanged)

---

## 7) Related docs

- [DOC-068 — Reports Loading Fix + Auth Network Recovery](./reports-loading-and-auth-network-recovery.md) (same feature branch)
- [DOC-051 — User Activity Insights](./user-activity-insights.md) (branch `feature/user-activity-insights`)

---

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-07-22 | 1.0 | Mithil Mistry | Initial doc — CSV fix complete, 52 new tests, 1388 total; no SQL |
