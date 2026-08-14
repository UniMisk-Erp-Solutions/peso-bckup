# DOC-063 — Paginated User/Balance Management and Identity-Aware Search

**Status:** complete  
**Branch:** `feature/user-activity-insights`  
**Date:** 2026-07-16  
**Commits:** Phase 1 `a967f65`, Phase 2 `be9258f`, Phase 3 `9bf31d2`, Phase 4 `979dbe0`

---

## 1. Overview

This document covers a multi-phase feature that:

1. **Centralizes organization identity policy** into a single canonical model (`OrganizationIdentityPolicy`) so all search/display surfaces make consistent decisions about email vs. employee ID visibility.
2. **Adds client-side pagination** to every large user/expense/balance list in the app (default 25 rows/page, options 10/25/50/100).
3. **Makes all search inputs identity-mode-aware** — synthetic auth emails are never exposed when an org is in `employee_id_only` mode.

---

## 2. Identity Policy Model (Phase 1)

### Files

| File | Role |
|------|------|
| `src/lib/organizationIdentityMode.ts` | Policy type + `resolveOrganizationIdentityPolicy()` |
| `src/hooks/useOrganizationIdentityMode.ts` | React hook wrapping the resolver |
| `src/lib/personIdentitySearch.ts` | `userMatchesManagementSearch()`, `employeeIdFromSyntheticEmail()` |
| `src/lib/approvalHierarchy.ts` | Bug fix: case-sensitivity in synthetic email fallback |

### Three Modes

| Mode | `employeeIdLoginEnabled` | `userEmailAuto` | Email visible | Employee ID visible |
|------|--------------------------|-----------------|---------------|---------------------|
| `email_only` | false | any | Yes | No |
| `employee_id_and_email` | true | false | Yes | Yes |
| `employee_id_only` | true | true | No | Yes (or parsed from synthetic email) |

### Synthetic Email Format

`emp.{orgSlug}.{employeeId}.{suffix}@{domain}`

When `employee_id` is null but the email matches this pattern, `employeeIdFromSyntheticEmail()` extracts the ID fragment for search — the raw email is never surfaced.

### Hook Output

```typescript
const {
  policy,                        // full OrganizationIdentityPolicy
  expenseSearchIdentityOptions,  // ready for expenseRowMatchesSearch()
  getSearchPlaceholderKey,       // i18n key for search placeholder
  formatIdentitySubline,         // display sub-line for person rows
} = useOrganizationIdentityMode();
```

### `userMatchesManagementSearch` Signature

```typescript
function userMatchesManagementSearch(
  user: UserSearchRow,
  query: string,
  roleLabels: Record<string, string> | null,
  policy: OrganizationIdentityPolicy,
): boolean
```

---

## 3. Pagination Helpers (Phase 1)

### Files

| File | Role |
|------|------|
| `src/lib/listPagination.ts` | Pure helpers: `paginateItems`, `clampPage`, `getTotalPages`, `getVisiblePageNumbers`, `getPaginationRange` |
| `src/components/ListPagination.tsx` | Reusable UI component |

### `ListPagination` Props

```typescript
{
  page: number;
  pageSize: number;
  totalItems: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  pageSizeOptions?: number[];   // default [10, 25, 50, 100]
  className?: string;
}
```

Renders: rows-per-page Select + First/Prev/numbered pages (with ellipsis)/Next/Last buttons + showing-range text.  
Returns `null` when `totalItems === 0`.  
Uses `useTranslation("common")` with `pagination.*` keys.

### `clampPage`

Returns `max(1, min(page, ceil(totalItems / pageSize)))`. Used to prevent stale page numbers after filter changes.

---

## 4. Translations (Phase 1)

Keys added to `src/locales/{en,hi,gu}/common.json`:

```jsonc
"pagination": {
  "rowsPerPage": "...",
  "showing": "{{from}}–{{to}} of {{total}}",
  "firstPage": "...",
  "previousPage": "...",
  "nextPage": "...",
  "lastPage": "..."
},
"searchPlaceholder": {
  "nameEmail": "...",
  "nameEmployeeId": "...",
  "nameEmployeeIdEmail": "...",
  "nameEmailRole": "...",
  "nameEmployeeIdRole": "...",
  "nameEmployeeIdEmailRole": "..."
}
```

---

## 5. User Management Restructure (Phase 2)

### `src/pages/UserManagement.tsx`

**Section tabs** replace `scrollIntoView`:

- **Users** (default) — paginated user list
- **Create User** — form + guidelines
- **Bulk Upload** — CSV import

Active section persisted in `sessionStorage("userMgmt.section")`.

**Pagination state** (all sessionStorage-persisted):

```typescript
const [usersPage, setUsersPage] = useState(() => { ... sessionStorage ... });
const [usersPageSize, setUsersPageSize] = useState(() => { ... sessionStorage ... }); // default 25
```

Page resets to 1 on `searchTerm` or `teamFilter` change.

**Search** uses `userMatchesManagementSearch(u, searchTerm, roleLabels, identityPolicy)`.  
Placeholder from `getSearchPlaceholderKey({ includeRole: true })`.

**Draft preservation:** `addAmounts`/`addNotes`/`selectedBankAccountByUser` are keyed by `user_id`, so inputs survive page changes automatically.

---

## 6. Balances Pagination (Phase 3)

### `src/pages/Balances.tsx`

| Surface | State | Default | sessionStorage |
|---------|-------|---------|---------------|
| Main balances table | `balancesPage` / `balancesPageSize` | 25 | Yes |
| Transfer History tab | `transfersPage` / `transfersPageSize` | 25 | No |
| Bulk Balance dialog | `bulkPage` / `bulkPageSize` | 25 | No |

`filteredRows` useMemo replaces the inline IIFE in the table tbody. Draft inputs (`addAmounts`/`addNotes`/`selectedBankAccountByUser`) are keyed by `user_id` and survive page changes.

**Bulk Balance "Select All"** still operates on all `rows` (not just the current page) — the `selectedUserIds` Set is unaffected by pagination.

### `src/components/TransferSentOffersPanel.tsx`

Paginated via `pagedOffers` (default 10/page, options 10/25/50). Card-based layout retained.

---

## 7. Identity-Aware Search Rollout (Phase 4)

All surfaces now pass `expenseSearchIdentityOptions` (or equivalent policy fields) into their search logic.

| File | Before | After |
|------|--------|-------|
| `AdminPanel.tsx` | Inline — always searched email | `expenseRowMatchesSearch` + `expenseSearchIdentityOptions` |
| `EngineerReview.tsx` | `expenseRowMatchesSearch` with default options | Same, now passes `expenseSearchIdentityOptions` |
| `UserActivityInsights.tsx` | Inline — always searched email | Policy-gated with synthetic-email fallback |
| `MyTeams.tsx` | `memberMatchesSearch` / `expenseMatchesSearch` — always emailed | Added `policy` param to both helpers; wire via `useOrganizationIdentityMode` |
| `AccountantApprovedExpenses.tsx` | Inline — always searched email | `expenseRowMatchesSearch` + `expenseSearchIdentityOptions` |
| `Balances.tsx` | Already correct | Unchanged (reference implementation) |

---

## 8. Bug Fix — Case-Sensitivity in Synthetic Email Fallback

`src/lib/approvalHierarchy.ts` line ~150:

```typescript
// Before (broken): extracted ID uppercase vs lowercase query
if (extracted && extracted.includes(q)) return true;

// After (fixed):
if (extracted && extracted.toLowerCase().includes(q)) return true;
```

---

## 9. Test Coverage

All phases validated with `npx tsc --noEmit` (0 errors) and `npx vitest run` (72 files / 1121 tests).

New test files added in Phase 1:
- `src/lib/__tests__/listPagination.test.ts` — pagination helpers
- `src/lib/__tests__/organizationIdentityMode.test.ts` — policy resolver
- `src/lib/__tests__/identityAwareSearch.test.ts` — `userMatchesManagementSearch` + `expenseRowMatchesSearch` with all three identity modes

Integration test updates in Phase 2:
- `src/__tests__/integration/expense-flow.test.tsx` — UserManagement tests updated to navigate to "Create User" section tab before checking form elements.

---

## 10. No SQL Changes

This feature is entirely client-side. No Supabase migrations, no RLS changes, no Edge Functions modified.
