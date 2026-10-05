# Exact Month+Year Expense Filtering (Review Expenses + My Expenses)

**Doc ID:** DOC-127
**Status:** in progress
**Last updated:** 2026-09-15 (rev 1.1)
**Owner / area:** Expenses, Review Expenses

---

## 1) Summary

Adds an exact calendar-month filter (authoritative date: `expenses.trip_start`)
to both Review Expenses and My Expenses, switching to true server-side
pagination/filtering when a specific month is selected, on desktop and
mobile. Default "All months" preserves prior behavior exactly. This doc also
covers a follow-up hardening pass that fixed several correctness issues found
in independent review of the initial implementation.

---

## 2) Problem / requirement

Both list pages fetched a bounded window (or, via "Load all", the caller's
entire history) and filtered client-side. A month could contain far more rows
than that bounded fetch, so an exact-month view needed genuine server-side
paging/filtering, not client-side slicing of a pre-fetch — while leaving the
default "All months" behavior byte-for-byte unchanged.

---

## 3) Solution

- `src/lib/expenseMonthFilter.ts` — shared, unit-tested utility: month-bounds
  (half-open `[from, toExclusive)`), month-option generation (every calendar
  month from earliest accessible expense through max(current month, latest
  future-dated expense) — including zero-data months), UTC-safe arithmetic.
- **Review Expenses**: needed no new backend capability — the existing
  Debug Review queue RPCs already filter `trip_start`. Month applies
  immediately (no draft/Search-submit gate), mutually exclusive with the
  relative Time Period control.
- **My Expenses**: no existing RPC fit (all others are reviewer-scoped), so a
  new RPC (`get_my_expenses_page_v1`) was authored, unconditionally scoped to
  `auth.uid()` (no `p_user_id` parameter at all).
- **Hardening pass (2026-09-15)** fixed, after independent review:
  - A real race condition where switching out of exact-month mode before an
    in-flight request resolved could let a stale response overwrite the list
    (`src/lib/monthFetchGuard.ts`, generation-token + `AbortController`).
  - Search-semantics parity: the RPC's search now matches the client's
    cross-field, multi-word `expenseRowMatchesSearch()` semantics (including
    custom-field labels/values) via literal `strpos()`, closing a wildcard-
    injection gap from `ILIKE '%...%'`.
  - Draft-population parity: the RPC no longer excludes `status='draft'`,
    matching the pre-existing All-months list (which never excluded drafts).
  - Sort parity: `ORDER BY lower(title/destination)` with a stable `id`
    tiebreaker, matching the client's case-insensitive sort.
  - A Review Expenses bug where a stale, uncommitted relative-Time-Period
    draft could silently clear an unrelated later Month selection on the next
    Search commit — fixed by splitting one combined "mirror all applied
    filters to all drafts" effect into eight independent per-field effects,
    and having Month selection force the relative period to "all" directly.
  - Mobile's relative Time Period values (`7d/30d/3m/6m/1y`) were never
    recognized by `deriveDateRange` at all (silently producing no date
    bound) — extended to support both desktop's and mobile's value sets.
  - A custom-field label-collision comment claimed a "template wins"
    precedence the client itself does not actually guarantee (no `ORDER BY`
    on the backing query) — corrected the comment and made the server side
    deterministic instead.
  - Zod validation of the RPC's JSON payload (`src/lib/myExpensesPageSchema.ts`),
    replacing an unchecked cast.
  - Performance: `EXPLAIN ANALYZE` against real Production data found the
    search aggregate scanning the entire platform-wide custom-fields table
    (~1.85s); fixed by scoping it to the caller's own expenses first (~35ms).
- **Final correctness pass (2026-09-15, same day)** fixed three further gaps
  from an independent final audit:
  - `myExpensesPageSchema.ts` silently normalized malformed values (numeric
    fields fell back to `0`, several fields fell back via `.catch()`) instead
    of failing validation. Rewrote the numeric schema to reject non-finite
    values (`NaN`, `Infinity`, `"abc"`, `""`, `" "`, objects/arrays) and
    modeled every field's required/nullable-ness from the RPC's actual SQL
    response shape — a malformed response now always throws
    `MyExpensesPageValidationError` instead of displaying corrupted values.
  - `get_my_expenses_page_v1` computed its custom-field template-wins
    precedence THREE different ways (display map correct, search and filter
    matching both read raw rows independently with no precedence at all) —
    so a filter or search word could match only through a losing (branch)
    value while the displayed `custom_fields` showed the winning (template)
    value for the same label, a visibly self-contradictory row. Fixed by
    extracting one canonical `(expense_id, label, value)` resolution into a
    new internal helper, `_my_expenses_canonical_custom_fields_v1` (no
    EXECUTE for anon/authenticated), reused for search, filtering, and
    display. A read-only Production audit found zero expenses with a genuine
    template/branch label collision across 21,918 expenses with custom
    fields, so this is forward-safe.
  - `reviewAppliedQuery.ts`'s `month/3m/6m/year/1y` relative-time bounds used
    raw `date.setUTCMonth()`/`setUTCFullYear()`, which overflows at month
    ends (e.g. March 31 minus one month became March 3, not February 28).
    Added `subtractUtcMonthsClamped()`, which clamps the day to the target
    month's actual last day while preserving time-of-day; `7d`/`30d` were
    already correct (exact day-count subtraction has no such overflow).
  - Also fixed two brittle fixed-byte-offset source-contract assertions in
    `reviewSubmitModel.test.ts` (unrelated pre-existing test fragility
    surfaced by running the full suite in a clean tracked git worktree,
    isolating the release signal from untracked `_fixdoc`/`_julydoc` copies).

---

## 4) Key files

```
src/lib/expenseMonthFilter.ts
src/lib/monthFetchGuard.ts
src/lib/myExpensesPageSchema.ts
src/lib/reviewDateMode.ts
src/lib/reviewAppliedQuery.ts
src/lib/reviewWorkspaceState.ts
src/lib/reviewReturnCache.ts
src/pages/EngineerReview.tsx
src/pages/Expenses.tsx
src/components/mobile/MobileReviewQueueView.tsx
src/components/mobile/MobileExpenseListView.tsx
src/components/mobile/MobileExpenseListFilters.tsx
supabase/migrations/20260915120000_my_expenses_page_v1.sql
```

---

## 5) Database / migrations

- `supabase/migrations/20260915120000_my_expenses_page_v1.sql` — creates
  `get_my_expenses_page_v1`. **NOT applied to Production** (branch-only,
  validated via rolled-back transactions against real Production data).
  Reload PostgREST's schema cache after applying.

---

## 6) Test plan

- [x] Month-bounds/option-generation unit tests (`expenseMonthFilter.test.ts`)
- [x] Real deferred-promise race-condition tests (`monthFetchGuard.test.ts`)
- [x] Zod schema validation tests (`myExpensesPageSchema.test.ts`)
- [x] Real behavioral date-mode mutual-exclusion tests (`reviewDateMode.test.ts`)
- [x] Source-contract wiring tests for both pages
- [x] SQL search/sort/draft-parity/label-collision matrix (rolled-back
      transactions against real Production data)
- [x] Full security matrix (unauthenticated/inactive-membership/cross-org/
      cross-user isolation/anon EXECUTE/injection-shaped input DENY)
- [x] Pagination regression (55 real pages, zero dup/missing) and month
      boundary tests (Aug31/Sep1, leap Feb)
- [ ] `get_my_expenses_page_v1` applied to Production (pending owner approval)

---

## 7) Related docs

- None yet indexed under this feature.

---

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-09-15 | 1.0 | Agent | Initial doc, covering both the original feature and the same-day hardening pass. |
| 2026-09-15 | 1.1 | Agent | Added the same-day final correctness pass: strict RPC response validation, canonical custom-field precedence (search/filter/display unified), clamped UTC calendar subtraction, and two source-contract test fixes found via a clean tracked-worktree full suite run. |
