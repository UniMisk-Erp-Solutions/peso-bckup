# DOC-080 — Review Expenses: Server Queue, Manual Employee Search & Debug Surface

**Last updated:** 2026-08-11 (rev 22 — Production DB fix: filtered queue RPC no longer reconciles the full reviewer scope; applied live under owner authorization)
**Status:** **SUPERSEDED on DEV — consolidating to ONE canonical `/review` = legacy EngineerReview.** Production runs the legacy page (Vercel queue flag false). On dev the flag-switch + `/debug/review-expenses` route/nav are removed (increment 1); the proven zero-request single-bar search (`useSingleBarSearch` + `ReviewSearchBar` + `ReviewEmployeeResultsPopover`) is now **promoted into EngineerReview** (rev 11.0), and the authoritative blue/amber/grey batch colour is fixed there too. The server-backed `ReviewExpensesServerPage` and `debugReviewQueue` files remain in-tree pending deletion once the promotion is human-verified. Admin helper migrations `20260810120000`/`20260810140000` remain applied on prod (unused by EngineerReview). **DEV ONLY — NOT RELEASED.**
**Branch:** `dev`
**SQL executed by this work:** **No.** `20260801140000` and `20260801150000` were applied by the operator. `20260802010000` is written but **not applied**.
**Flags:** `VITE_REVIEW_EXPENSES_SERVER_QUEUE_ENABLED`, `VITE_REVIEW_EXPENSES_SERVER_ACTIONS_ENABLED`, `VITE_DEBUG_REVIEW_EXPENSES_ENABLED`, `VITE_DEBUG_REVIEW_ACTIONS_ENABLED` — all default **false**.

---

## 1. The proven defect

Read-only diagnostic against the live database, 2026-08-01:

```
expenses_for_employee_id_6174 : 24
expenses_with_txn_like_6174   : 1
```

That single transaction-number match is `06174` — **owned by a different employee**,
Katheria Arun Amrutbhai (employee ID 6557), ₹3,960, "Opt gland work".

So searching `6174` returned one expense belonging to someone else, and **all 24
expenses belonging to Sanjaykumar Vinodbhai Katara (6174) disappeared**.

Why: `transaction_number` lives on the expense row and matched client-side.
`employee_id` only exists after a profile-enrichment call — and that call was
returning 504 under load, because V1 was bulk-enriching `expense_form_field_values`
(37,593 rows in this organization) and saturating the database.

**Identity failure did not merely blank a column. It silently removed 24 rows from a
search result** — which is worse, because the page still looked like it worked.

### Confirmed facts

| Fact | Value |
|------|-------|
| Employee | Sanjaykumar Vinodbhai Katara |
| user_id | `c76edc75…f949d1b` |
| Employee ID | 6174, active profile, active membership |
| Owned expenses | **24** |
| Reports to | `6d75cd1f…7cc78b1c` = Kunvar Thakor (5022, **executive**) |
| Org scale | 7,953 expenses · 401 profiles · 37,593 custom-field values |

---

## 2. The fix: separate the two searches

| Search | Matches | Never matches |
|--------|---------|---------------|
| **Employee** | employee ID, exact name, name prefix/contains, permitted email | **transaction numbers** |
| **Expense** | transaction number, title, purpose, category, destination, amount | — |

Employee lookup resolves to an **immutable `user_id`**, and the queue filters on
that exact value. Names change and duplicate; a user_id does not.

Both are submit-only. `useSingleBarSearch` / `useEmployeeSearch` keep `draft`
(every keystroke) and the submitted value separate. Nothing observes `draft` —
there is no effect on it and **no debounce**, because a debounce still fires while
typing, which is exactly what is forbidden.

---

## 3. Schema audit

Ran against `information_schema` on 2026-08-01. **Every column referenced by
`20260801140000` exists** — nothing was invalid. The one discovery:
`attachments.deleted_at` exists (DOC-078), and the base detail RPC returned
soft-deleted receipts as if they were live.

Because `20260801140000` had already been applied to a shared environment, it was
**not** rewritten. All corrections live in the additive
`20260801150000_debug_review_queue_v1_corrections.sql`.

---

## 4. What the corrections migration fixes

### 4.1 Actionability

The base migration approximated it as `status NOT IN ('verified','approved','rejected')`,
ignoring role, tier, hierarchy enablement, skipped tiers, direct assignment and
executive handoff — a **misleading pending count**.

`_debug_review_actionability_v1` is now the single definition, ported from
`canRoleActOnExpense()` (`src/lib/approvalHierarchy.ts`) and
`computeManagerQueueReady()` (`src/lib/managerActionableExpenses.ts`). It returns
`is_actionable`, `actionable_stage`, `actionable_reason`, `available_actions` and
`view_only`, and it is **caller-specific**. Employee-search counts, KPI counts and
row flags all call it.

### 4.2 Identity cardinality

The base page joined `profiles` on `user_id` with no uniqueness guarantee, so a
duplicate profile would have **duplicated expense rows**.
`_debug_review_resolve_identity_v1` returns at most one row per `user_id` via
`DISTINCT ON`, treating the pick as authoritative only when there is exactly one
row or exactly one active row — otherwise reporting
`identity_issue='duplicate_profiles'` rather than choosing arbitrarily.

### 4.3 Keyset null handling

`(f.created_at, f.id) < (v_c_ts, v_c_id)` evaluates to **NULL, not false**, when
`created_at` is NULL — silently dropping those rows from every page after the
first. Same for `trip_start` and `total_amount`.

Replaced with one finite numeric sort key that folds direction and null policy
together, so all six sorts share a single always-ascending, never-NULL comparison
with NULLs pinned last. The cursor carries its `sort`; a mismatch resets to page 1.

### 4.4 Soft-deleted attachments

Detail filters `deleted_at IS NULL` and returns `deleted_attachment_count`, so a
missing receipt reads as "deleted", not "the page is broken".

---

## 5. Runtime proof (2026-08-01/02)

Both migrations applied by the operator. Capabilities:

```
ready: true   schema_revision: 20260801150000
functions: page, detail, filters, identity, actionability, employee_search — all true
```

Then `/debug/review-expenses` as the executive, searching `6174`:

| Measure | Result |
|---------|--------|
| `filtered_total` | **24** |
| `returned_rows` | **24** |
| `identity_resolved` | **24** |
| `identity_unresolved` | **0** |
| `has_more` | false |
| `request_duration_ms` | **1941** |
| `error_category` | null |
| `reviewer_role` | executive |

All 24 of Sanjaykumar's expenses came back in one page, every one with a resolved
identity, and transaction `06174` was absent. That is the §1 defect disproved end
to end.

1,941 ms is acceptable for a first uncached page against a 7,953-expense org, but
it is not fast. Worth re-measuring warm and on the unfiltered scope before wide
rollout.

---

## 6. Production `/review` integration

`/review` now renders `src/pages/ReviewExpenses.tsx`, a wrapper that picks between
the existing `EngineerReview` and the new server-backed page from
`VITE_REVIEW_EXPENSES_SERVER_QUEUE_ENABLED`. **EngineerReview.tsx is untouched and
remains the default.** There is no automatic fallback: if the server page fails it
shows an error, because silently reverting to V1 would hide the failure and
reproduce the original "looks fine, wrong data" bug. A "Use legacy Review
Expenses" link exists in dev/Preview only, and only on an explicit click.

### Shared data layer

`src/features/reviewQueueServer/` is now the single implementation — schemas, RPC
argument construction, employee-search state, cursor handling, identity parsing,
filter serialization and error classification. Both `/review` and
`/debug/review-expenses` import it; the debug feature's `api.ts`, `types.ts`,
`schemas.ts`, `format.ts` and hooks are thin aliases. Query keys are scoped
(`review` vs `debug`) so the two surfaces can never share a cache entry.

The RPCs keep their `debug_` prefix. Renaming them now would mean another
migration for no behavioural gain; that belongs in a later contract-version bump
once the production UI is stable.

### One search bar, two searches

The page shows a single input in the same place and width as today. Underneath,
the proven separation is preserved exactly. On submit:

1. `txn:` / `#` prefix → expense search, employee lookup skipped entirely
2. exactly one exact employee match → select that **immutable `user_id`**
3. several matches → compact popover; nothing loads until a human picks
4. no employee match → the same text becomes `p_general_search`

Typing does none of this. Employee selection and expense text render as two
visually distinct chips so they can never read as one filter, and each clears
independently.

### Visual parity

Heading, description, the four KPI cards (same icons, same grid), the Assigned
Expenses card and its help text, filter-row spacing, the custom-fields section,
table column order, the sticky Status / Actions column and pagination styling are
all the existing ones. No contract status, schema revision, diagnostics, timings
or "Actions disabled" badge appears on `/review` — a test asserts each of those
strings is absent from every production file.

### What changed underneath

| Concern | Before | Now |
|---------|--------|-----|
| KPI cards | `getStats()` over a browser array | `scope_summary` from the RPC |
| Pagination | array slicing + Load All | keyset cursors, `page_size + 1` |
| Page numbers | computed from loaded rows | only pages actually walked |
| Filters | applied to loaded rows | server-side predicates |
| Identity | second profile request | present in the first list response |
| Custom fields | browser reads `expense_form_field_values` | filter-options RPC + stable UUIDs |
| Actionability | recomputed in React | read from the server, never recomputed |

### Request budget

1 capability + 1 filter-options + 1 page on load; **0 while typing**; 1 employee
RPC on submit, then 1 page RPC; 1 page RPC per filter/sort/page change; 1 detail
RPC per open. Tests assert the feature contains no `supabase.from(...)` and no
reference to any V1/V2 review RPC or to `reviewExpensePagination`,
`legacyReviewPagination`, `managerReviewExpenses` or `hierarchyReviewExpenses`.

---

## 7. Validation

| Check | Result |
|-------|--------|
| `git diff --check` | clean |
| `npx tsc --noEmit` | pass |
| `npm run typecheck:api` | pass |
| `npm run migrations:check` | pass |
| `npm run build` | pass, 19.2s |
| `npm test -- --run` | **2046 passed / 104 files** (was 1933 / 103) |
| `npm run i18n:check` | 184 missing — **unchanged baseline** |
| `npm run lint` | 458 problems — **unchanged baseline** |

249 tests cover this feature across the two surfaces.

**What automated tests do not prove:** the server-backed `/review` page has never
been opened against a live database. The queue underneath it is proven — the debug
page exercises the same shared code path and returned 24/24 — but the production
page's own rendering, search bar, chips, filters, pagination controls and detail
dialog have only been exercised in jsdom. Visual parity has not been compared side
by side by a human.

---

## 8. Rollout / rollback

**Preview variables:**

```
VITE_REVIEW_EXPENSES_SERVER_QUEUE_ENABLED=true
VITE_REVIEW_EXPENSES_SERVER_ACTIONS_ENABLED=false
VITE_DEBUG_REVIEW_EXPENSES_ENABLED=true
VITE_DEBUG_REVIEW_ACTIONS_ENABLED=false
```

1. Deploy to Preview with the queue flag on and the actions flag **off**.
2. Compare `/review` side by side against a screenshot taken with the flag off.
3. Search `6174`: confirm zero requests while typing, one employee RPC on Search,
   the chip showing `Sanjaykumar Vinodbhai Katara · 6174`, 24 rows across server
   pages, and transaction `06174` absent.
4. Clear, then search `txn:06174`: confirm it appears, owned by employee 6557.
5. Walk every filter, both directions of every sort, and page forward/back.
6. Confirm in DevTools: no `profiles`, `expense_form_field_values`, `audit_logs`
   or `expense_correction_logs` request; no legacy review RPC; no 57014 or 504.
7. Test as engineer, team_leader and executive — not only executive.

**Rollback:** set `VITE_REVIEW_EXPENSES_SERVER_QUEUE_ENABLED=false`. `/review`
returns to `EngineerReview` immediately; nothing else changes, because the wrapper
is the only integration point and EngineerReview was never modified.

### Before enabling actions

The actions flag stays off until the read-only page is confirmed. Enabling it
means trusting `_debug_review_actionability_v1` — a fresh port of two client
functions — to decide what may be verified or approved. Its counts have not yet
been compared against `/review` for the same reviewer. Acting at the wrong tier is
not a display bug.

### Before merging to main

Visual parity confirmed by a human; all three reviewer roles tested; the 6174
regression, pagination and detail all passing in Preview; no legacy enrichment
call and no 57014/504 in the network tab; mutations tested separately behind their
own flag; and the rollback flag exercised in both directions.

---

## 9. Four defects found once the page was running (2026-08-02)

Reported from the live Preview page. All four are corrected together in the
additive migration `20260802010000_review_queue_scope_filters_and_anchor.sql`,
which does not touch either applied migration.

### 9.1 "Assigned to Me" disagreed with the table

The card showed **5,674** while the unfiltered table showed **7,450**.

Not a rounding or caching problem — two different questions rendered as one
number. `20260801150000` computed `assigned_to_me` as
`assigned_reviewer_id = me OR assigned_engineer_id = me`, the **direct**
assignment count, while the list shows the whole reviewer-visible scope
(hierarchy + owned teams + direct). Both were correct; only one belonged on that
card.

The card now reports the complete visible scope — the population the list pages
through — so `assigned_to_me`, `scope_total` and the unfiltered `filtered_total`
are the same number by construction. The direct count is preserved separately as
`scope_summary.directly_assigned`, which nothing currently renders.

| State | Assigned to Me | Bottom total |
|-------|----------------|--------------|
| No filters | 7,450 | 7,450 |
| Employee 6174 | 7,450 | 24 |
| Status = Submitted | 7,450 | submitted total |

`Pending Review` continues to report the actionable subset, so the two cards
answer different questions on purpose.

A dev-only assertion warns in the console when no filter is active and
`assigned_to_me != filtered_total` — that combination means the server is on an
older revision, and a warning beats rendering two contradictory numbers.

### 9.2 A dozen duplicate "Project ID" filters

`get_debug_review_filter_options_v1` returned every template `UNION ALL` every
option branch with **no parent information**, so the client rendered one dropdown
per branch row. An org with three project names, each with its own
"Project Unique ID" branch, each with two "Project ID" children, produced ten
controls with three distinct labels.

Branch definitions are a **tree**. The response now carries
`parent_template_id`, `parent_branch_id`, `parent_option_value`,
`display_order`, a cycle-safe recursive `depth` and `is_root`, and the client
walks it:

- initially only root templates render;
- a branch appears only when its parent holds exactly its `parent_option_value`;
- changing or clearing a parent clears every descendant and removes them from
  `p_custom_filters`, so a hidden control can never narrow results invisibly.

Two branches sharing a label but sitting under different parents are never both
visible, because a single-select parent holds one value.

For the reported configuration: **1** control initially, **2** after choosing a
project name, **3** once the chain completes — never ten. Retired branches
(`retired_at IS NOT NULL`) and branches with no stored value anywhere in the org
are excluded server-side.

### 9.3 No way to reach page 298

Keyset paging cannot jump to an unvisited page from the current cursor alone, so
the old control only offered pages already walked.

`get_debug_review_queue_page_anchor_v1(p_organization_id, p_target_page,
p_page_size, p_sort, p_employee_user_id, p_general_search, p_statuses,
p_categories, p_date_from, p_date_to, p_actionable_only, p_custom_filters)`
resolves a target page to the cursor immediately before it. An explicit jump
costs one anchor call plus one ordinary page call; **Next/Previous remain a
single keyset request with no OFFSET**.

Locating a position fundamentally requires counting, so the anchor uses
`row_number()` over an id + sort-key relation. That is the only positional scan
in the contract.

**Parity is structural, not asserted.** Both the page RPC and the anchor call one
helper, `_debug_review_keyed_scope_v1`, which owns the visible scope, every
filter predicate, the sort key, null handling and the uuid tie-breaker. They
cannot drift because there is nothing to drift.

The anchor rejects page < 1, page > total_pages, an unsupported sort, malformed
custom filters and a caller outside the organization. Quick links show 1/2/3, the
last page and the current neighbours, with an ellipsis only where a real gap
exists; a `Page [n] Go` input accepts Enter or the button and validates against
`total_pages`. A failed jump leaves the current page exactly as it was — a
half-applied jump would show one page number above another page's rows.

Page-number controls only render when `capabilities.functions.page_anchor` is
true, so a server on an older revision hides them rather than calling a function
that does not exist.

### 9.4 The loading indicator was missing

`AsyncOperationProgress` is back, in indeterminate `running` state — one
authoritative server request has no meaningful percentage, and the old
"loading 4,000 of 7,450" partial-dataset message is exactly what this
architecture removed.

It appears for the initial load, employee search, filter/sort/date changes,
Next/Previous, quick links, manual jumps and retry, with a label naming the work
(`Loading page 125…`). During a background refetch the current table stays
visible with `aria-busy` on the result region and navigation disabled, so results
are replaced only when the new response arrives. It hides on success or failure.

### Request budget (unchanged except jumps)

| Action | Requests |
|--------|----------|
| Initial load | 1 capability + 1 filter-options + 1 page |
| Typing | **0** |
| Next / Previous | 1 page (or cache) |
| Quick link / manual jump, unvisited | 1 anchor + 1 page |
| Quick link, already walked | 1 page (cached cursor) |


---

## 10. Review actions and detail-modal parity (2026-08-02)

### 10.1 Actions layer

`src/features/reviewActions/` wraps the **existing** `ExpenseService` methods —
`verifyExpense`, `approveExpense`, `rejectExpense`,
`applySingularExpenseCorrection`. It adds no new mutation path, so role, tier,
assignment and approval-limit checks stay exactly where they already were and are
still enforced server-side.

Three properties are worth stating because they are what the tests assert:

- `assertActionsEnabled()` is the **first statement** in every mutating path, so
  the flag cannot be bypassed by calling the service directly.
- Nothing is applied optimistically. The queue and the KPI summary are
  invalidated only after the server confirms, so a failed verify can never leave
  a row looking verified.
- Bulk work runs at `BULK_CONCURRENCY = 3` with input order preserved, and
  batch rows are excluded outright — one line of a batch is not the batch.

Client-side eligibility (`actionEligibility.ts`) is **presentation only** and can
only ever *subtract*: it hides actions on batch lines and on the reviewer's own
expense. It never adds an action the server did not return in
`available_actions`.

### 10.2 Why the detail modal was rebuilt

The server-backed modal had been written from scratch and did not resemble the
All Expenses review dialog it replaces. It used `max-w-3xl`, nested `Card`
components, a separate employee-information card, compact invented field grids,
plain `<a>` attachment links, plain-text timeline rows, an extra bordered action
box inside the scrolling content, and a green-outline **Approve** that read as
weaker than **Verify**. Two lists opening what is conceptually the same screen
produced two different-looking products.

The presentation now comes from `src/pages/AdminPanel.tsx` (the review dialog at
~L2478-2741), not from imagination:

| Element | Value, taken from the reference |
|---------|--------------------------------|
| Dialog width | `max-w-[95vw] sm:max-w-2xl md:max-w-4xl` |
| Dialog height | `max-h-[95vh] sm:max-h-[85vh]` |
| Summary grid | `grid grid-cols-1 sm:grid-cols-2 gap-4` |
| Field label | `text-sm font-medium` |
| Field value | `text-sm`; secondary `text-xs text-muted-foreground` |
| Amount | `text-lg font-semibold` |
| Section rhythm | `space-y-2 border-t pt-4 mt-4` |
| Attachment row | `flex items-center justify-between p-3 border rounded-lg` |
| Thumbnail | `h-14 w-14 shrink-0` |
| Footer order | Cancel, Correct expense, Reject, Verify, Approve |
| Footer variants | `outline`, `secondary`, `destructive`, `outline`, default |

Three presentational components were extracted to
`src/components/expense-review/` so both dialogs can converge on one source
rather than two copies drifting apart:
`ExpenseReviewDialogShell`, `ExpenseReviewSummary` (+ `ExpenseReviewSection`,
`ExpenseReviewAttachments`) and `ExpenseReviewActionFooter`. None of them query,
authorize or mutate anything.

The body itself now uses the same components the reference uses —
`ExpenseBaseFieldsDisplay`, `ExpenseFormFieldsDisplay`, `ExpenseReviewTimeline`,
`ExpenseCorrectionAuditList`, `AttachmentThumbnail` and
`AttachmentPreviewDialog` — fed entirely from the single detail RPC via
`prefetchedFields`, so matching the reference costs **zero extra requests**.

### 10.3 The one deliberate divergence

AdminPanel puts **both** the header and the `DialogFooter` inside its scrolling
`div`, so on a long expense the action buttons and the close icon scroll out of
the viewport. Here the header and footer sit outside the scroll container and
only the body moves. This was the highest-priority UX correction of the task and
it changes no spacing the reference defines.

### 10.4 Behaviour that did not change

- Footer membership still comes from the server's `available_actions`.
- The optional **Admin Comment** stays separate from the required **rejection
  reason**, so an empty comment can never become a rejection reason, and Confirm
  reject stays disabled until a reason is typed.
- Every mutation button disables while one is in flight; **Cancel** never does.
- Batch lines show the batch-review link and no singular actions; the reviewer's
  own expense shows a view-only notice.
- **Correct expense** renders only when a correction editor is wired. The full
  correction editor is a separate dialog and was **not** built in this task, so
  the button is currently withheld on the server-backed page rather than
  rendered as a no-op. This is not a regression — it was never present there.

### 10.5 Validation

2168 tests across 109 files (was 2139 / 108); 29 new tests in
`reviewDetailParity.test.tsx`. `tsc --noEmit`, `typecheck:api`, `build` and
`migrations:check` clean; lint 458 unchanged. `npm run i18n:check` currently
fails to start with `ERR_UNKNOWN_FILE_EXTENSION` on a **clean tree as well**, so
it is an environment regression in the script runner, not a result of this work.

**No SQL was executed by this work, and no migration was applied.**


---

## 11. Restoring the main Review Expenses UI (2026-08-02)

### 11.1 Why rev 5.0 did not fix the page

Rev 5.0 rebuilt the detail modal against `src/pages/AdminPanel.tsx` - the **All
Expenses** review dialog. The page being replaced is **Review Expenses**, whose
dialog lives in `origin/main:src/pages/EngineerReview.tsx` and is a different
design: stacked `Card` sections, not a flat label/value grid. The modal was
matched faithfully to the wrong reference.

Worse, the task was scoped to the modal, so the table was never touched. The
concrete defects that survived:

| # | Defect | Evidence |
|---|--------|----------|
| 1 | One generic `View / Review` button on every row | `ReviewExpensesTable.tsx` rendered a single `variant="outline"` button with an `Eye` icon, unconditionally |
| 2 | The page passed `setDetailId` straight through | `onView={setDetailId}` - no `batch_id` branch anywhere |
| 3 | Batch rows opened the singular modal and fired the detail RPC | consequence of 1 + 2 |
| 4 | No batch badge, no blue mono txn, no coloured balance, no queue hint, no resizable columns | none of main's treatments were ported |
| 5 | `Correct expense` withheld entirely | rev 5.0 documented this as deliberate; it is not acceptable |

This was never a caching or Preview-tooling problem. Commit `49c4c10`'s own
source contains no batch branch.

### 11.2 What was removed

`src/components/expense-review/` (3 components) and
`__tests__/reviewDetailParity.test.tsx` were **deleted**, not adapted. They
encoded AdminPanel's shell, and keeping them would have meant building a second
abstraction on top of a wrong one.

### 11.3 What now matches main

Ported from `origin/main:src/pages/EngineerReview.tsx`:

- **Table** - column order and `useResizableColumns("pw_engineer_review_cols")`
  widths (so a reviewer's saved widths carry over from the legacy page), the
  `font-mono font-semibold text-blue-600` transaction number, the stacked
  employee cell with its `sm:hidden` restacked lines, the violet `Batch` badge,
  the green/red balance with `insufficientBalance`,
  `ExpenseStatusWithCorrectionBadge` plus queue hint, the `Resubmitted`
  override, and the sticky Status/Actions cell.
- **Row action** - `Review batch` (blue) for a batch line, `View/Approve` (blue)
  or `View` (neutral secondary) for a singular one. No eye icon; main has none.
- **Modal** - main's `Expense Review` heading, `sm:max-w-4xl max-h-[90vh]`, and
  its card order: Employee Information + Expense Summary, Trip Details,
  Attachments, Admin Comments, Review timeline, Reviewer corrections, Manager
  Review. Footer: Cancel, Correct expense, then Reject + Verify (blue) or
  Reject + Approve.
- **Mobile** - main's `MobileReviewExpenseCard` layout: title + amount top row,
  identity beneath, wrapped context row of status / category / date / Batch /
  Resubmitted / "Action needed". Whole card activates.
- **Correction** - the complete flow, reusing main's own
  `loadCorrectionCustomFields`, `validateCorrectionCustomFields`,
  `getVisibleBranchIds`, `buildCorrectionCustomFieldPatch`,
  `CorrectionCustomFieldsSection` and `ExpenseCategorySelect`, including nested
  conditional fields and required-field validation. A validation failure keeps
  every entered value.

### 11.4 Deliberate differences from main

Four, each with a reason:

1. **Batch button colour is always the pending blue.** Main computed
   all-done / partial / all-pending from every line of the batch, which it could
   do because it held all expenses in memory. The server page holds one page, so
   that state cannot be computed honestly - a batch whose remaining lines sit on
   page 4 would look finished from page 1. The button therefore never claims
   completion, which is the only claim that would cause a reviewer to skip work.
   Restoring the three-way colour needs an authoritative per-batch state from
   the server; it is not inferred from the page slice.
2. **`isPendingForCurrentReviewer` is not recomputed.** The server's
   `is_actionable` is that same logic, ported into
   `_debug_review_actionability_v1` and evaluated against data the client cannot
   see. Re-deriving it client-side is what let the old page offer Verify on rows
   at another reviewer's tier.
3. **No "Expense Line Items" card.** The detail RPC does not return line items,
   and adding a second request would undo the one-request-per-open property.
4. **Mobile keeps the transaction number and destination.** Main's card omits
   both; they are retained because reviewers identify rows by transaction number
   and the 6174/06174 regression test asserts it stays visible.

Scroll restoration uses router state rather than `sessionStorage`, so the
"no client-side result cache" guard stays meaningful.

### 11.5 Validation

2185 tests across 109 files (was 2168), 46 of them new in
`reviewMainParity.test.tsx`. `tsc --noEmit`, `typecheck:api`, `build` and
`migrations:check` clean; lint 458 unchanged.

`npm run i18n:check` fails to start with `ERR_UNKNOWN_FILE_EXTENSION`. Proven
environmental: it fails identically in a **separate git worktree checked out at
pristine `origin/dev`**. Every translation key touched by this change was
validated directly instead - the one newly introduced key without a
`defaultValue` fallback, `review.insufficientBalance`, was missing from `hi` and
`gu` and has been added.

**No SQL was executed, and no migration was applied.**


---

## 12. Employee filter, filtered KPIs and batch state (2026-08-02)

### 12.1 Why selecting employee 6174 showed nothing

Two compounding causes, both provable in source.

**(a) Filters survived the selection.** `chooseEmployee` called `onResolved()`,
a bare notification, and the page passed `onResolved: clearSelection` - which
clears row checkboxes and nothing else. A "Level 2 Verified" status filter
therefore survived, so the query became `employee 6174 AND level_2_verified`, an
intersection nobody asked for.

**(b) A stale cursor guaranteed an empty page.** `useCursorHistory` reset the
cursor in a `useEffect`. On the render where `employeeUserId` first changed, the
cursor from the previous 7,699-row ordering was still present, so the queue key
paired the new employee with the old cursor. The RPC evaluated
`WHERE (sk, id) > (a cursor from position ~4,000)` against a 24-row sequence and
correctly returned nothing - then React Query cached that empty result.

Cause (b) also explains an employee search with no queue request in the HAR: a
repeat search within the 30-second `staleTime` finds that cached empty entry and
issues no network call at all.

Not a cache, CORS, CSP, service-worker or extension problem. The employee RPC
returned 200 throughout.

### 12.2 The fix

`useSingleBarSearch` now emits a `SearchResolution` - `employee`, `expense` or
`clear` - and the page handles it as ONE deliberate transition. An employee
resolution resets every content filter (status, category, time, actionable-only,
custom fields, general search) while preserving sort and page size, because those
describe how results are shown rather than which results. It runs on a discrete
event, never from an effect watching state, so it cannot fight a reviewer who
applies filters afterwards.

`useCursorHistory` now resets during render instead of in an effect - React's
documented pattern for derived state that must not lag its input by a commit.

Submits are serialised by an in-flight ref and a sequence number, so Enter plus a
button click is one lookup, and a slow response for "617" can no longer overwrite
a later "6174".

### 12.3 filtered_summary

`scope_summary` is aggregated over the whole assigned scope before any predicate,
so it is reviewer-global by construction and no client change could fix the
cards. Migration `20260802030000` adds `filtered_summary`, aggregated over the
same rows the table pages through, before the cursor and before the page limit -
so paging cannot move it. It reuses the `scope` CTE's already-computed status
class and actionability, costing one semi-join rather than a second pass.

Cards read `scope_summary` when nothing is filtered and `filtered_summary` the
moment anything narrows the population, including a selected employee, with a
context line naming what the numbers describe. `filtered_summary` is nullable and
an older server is reported as a contract mismatch - never rendered as
"Completed 0", which would read as a real count.

### 12.4 Authoritative batch state

Rev 6.0 kept every batch button blue because a page slice cannot determine whole
-batch state honestly. The migration computes it server-side across EVERY
assigned line of each visible batch. The `scope` CTE already holds one row per
assigned expense with its actionability, so this is a single `GROUP BY` over rows
already in memory - no per-row request, no second pass, no page-slice inference.
Organization isolation, canonical assignment scope, self-review exclusion and row
deduplication all come from `_debug_review_assigned_scope_v1`.

| State | Condition | Treatment |
|-------|-----------|-----------|
| `all_pending` | every line actionable | primary blue |
| `partial` | some lines actionable | amber |
| `all_done` | no line actionable | secondary grey, still clickable |

**"Done" means no remaining action FOR THIS REVIEWER, not terminal status.** That
is why a `level_2_verified` batch reads grey for the executive who verified it,
matching the legacy page. A null state - a non-batch row, or a server older than
`20260802030000` - falls back to blue, never grey: grey would claim a batch is
finished on no evidence.

### 12.5 Empty states

Three distinct situations, previously all rendered as "this employee has no
expenses visible to you", which contradicts the employee search's own count:

- a nonzero `visible_expense_count` with zero rows and no filters is a **contract
  breach**, reported as such, with a dev-only structured warning carrying ids and
  booleans only - never an email or a token;
- an employee plus filters that match nothing says so by name and offers a clear
  control that keeps the employee selected;
- genuinely no assigned expenses keeps the original wording.

### 12.6 Validation

2219 tests across 110 files (was 2185 / 109), 34 of them new. `tsc --noEmit`,
`typecheck:api`, `build` and `migrations:check` clean; lint 458 unchanged.
`i18n:check` reproduced as failing on a pristine `4df1359` worktree, so the six
new keys were validated directly across en/hi/gu.


---

## 12) Return-from-batch state restoration (rev 8.0)

### The defect

A reviewer searched an employee, applied filters, walked to page 50, opened a batch through
**Review batch**, reviewed it, and returned to an **unfiltered page 1**. Every search, every
filter, the sort, the page size and the page number were gone.

The outbound half was never broken. `ReviewExpensesServerPage.openExpense` already built a
complete `reviewQueueState` into `location.state`. Two things discarded it:

- `BatchExpenseReview` navigated back with a bare `navigate(backPath)`, dropping the state.
- The review page never looked for a snapshot, and neither `useSingleBarSearch` nor
  `useReviewQueueFilters` had any hydration API — both initialised to blanks and page 1.

State was produced correctly and thrown away at both ends. That is also why the old suite
passed: it asserted only that the outbound navigation carried a state object.

### Why router state alone was insufficient

Router state covers the application's own Back button. **Browser** Back returns to the
previous `/review` history entry, whose state was written *before* the batch was opened, so
the snapshot has to survive somewhere the history entry does not own. Hence a second channel
in `sessionStorage`, scoped `pw.review.return.v1:<organizationId>:<reviewerUserId>`.

`useNavigationType()` decides which channel is allowed:

- valid `location.state.reviewQueueState` — **always** qualifies
- the sessionStorage fallback — qualifies **only** on `POP`
- a sidebar `PUSH` to `/review` is a request for a fresh queue and must ignore the fallback
- expired, malformed or mismatched snapshots are deleted, not merely rejected

### Why the page anchor, not the saved cursor

The snapshot deliberately carries **no cursor**. A keyset cursor is only meaningful inside
the exact filtered ordering that produced it, and reviewing a batch can change status,
actionability, filtered totals and therefore row ordering. The snapshot carries the *logical
page number*; the live cursor is re-resolved through `fetchReviewQueuePageAnchor` against the
restored query shape. The RPC clamps `target_page` itself, so a shrunken dataset lands on the
last real page rather than an empty one or a silent reset to page 1.

A genuine defect surfaced here during testing: restoration begins on mount, while the
capabilities query is still in flight, so `page_anchor` read as `undefined` and the anchor was
skipped — dropping the reviewer on page 1 of the restored shape, on exactly the browser-Back
path this feature exists for. The state machine now waits in `resolving-page` for the
capability answer. Covered by regression tests.

### sessionStorage holds query state, never expense rows

This is **navigation/query state only** — what was being *asked*, never any part of the
*answer*. No expense rows, attachments, balances, comments, audit entries, tokens or keys.
The server queue holds no client-side result cache and this must not become one by the back
door: returning always re-reads the server, so the reviewer sees the consequences of the
batch action they just performed. A test asserts no row field ever reaches storage.

### Cross-user and cross-organization validation

`sessionStorage` outlives a sign-out in the same tab. A snapshot is rejected unless its
`version`, `organizationId` and `reviewerUserId` all match the active session, and unless it
is under 30 minutes old. This grants no access on its own — rows still come from the server
queue under RLS — but without it a second reviewer on a shared machine could inherit the
first one's employee filter and page position. Restoration is identical for engineer,
team_leader and executive; there is no role-specific branch.

### Desktop and mobile

`BatchExpenseReview` previously rendered its Back header on **desktop only**, so a phone
reviewer had no in-app route home at all and the browser gesture was the only way out. Both
viewports now render a Back control bound to the same `handleBack`, which navigates with
`replace: true` so returning cannot leave a history entry that reopens the batch.

### Test-harness note (worth knowing before writing router tests here)

`src/test/setup.ts` mocks `react-router-dom` **globally** for the whole repository with
`useParams: () => ({})` and `useNavigate: () => vi.fn()`. Any routing integration test that
does not override it will silently exercise a page's failure branch — `BatchExpenseReview`
renders `unableToOpen` because `batchId` is always undefined, and clicks that should navigate
do nothing. `reviewReturnStateRoundTrip.test.tsx` restores the real module for itself with a
file-level `vi.mock(..., importOriginal)` and keeps a permanent `ParamsProbe` test that fails
loudly if that stub ever leaks back in.

---

## Revision log

| Date | Rev | Author | Notes |
|------|-----|--------|-------|
| 2026-08-11 | 22.0 | Claude Code | **Production DB performance fix — filtered queue RPC no longer reconciles the full reviewer scope (owner-authorized live application, migration `20260811130000_optimize_filtered_review_queue.sql`).** Direct continuation of rev 21's audit: a read-only SSH DB session isolated the exact cost — `get_debug_review_queue_page_v1` ran a per-row plpgsql actionability call over the ENTIRE assigned scope (~9,342 rows for the real Manager, Jayesh) on every request, measured standalone at **~47 s**, driving the full RPC to **~24 s cold**. The `authenticated` role has `statement_timeout=8s`, so the cold query was killed (`57014`) before the browser ever saw a result — explaining exactly the incident symptom (chip stuck "counting…", old rows retained). **Fix:** the function now branches on whether any filter is active (employee/general/status/category/date/custom/actionable). The **unfiltered** path is byte-identical to the previous definition (verified with full `jsonb` equality — `scope_summary` computed exactly as before, since that is the only path the frontend displays it on, per `summarySource.chooseSummary`). The **filtered** path computes per-row actionability ONLY over the filtered population + the current page's batch siblings, never the full scope; `scope_summary` becomes a cheap status-class rollup (never rendered when filtered) while `filtered_summary`/`items`/pagination/cursor are unaffected. **Validation performed live before applying** (all inside `BEGIN … ROLLBACK`, zero mutation): 7 correctness checks — full unfiltered equality, employee-6174 equality (excl. `scope_summary`), Level-2-Verified equality (excl. `scope_summary`), employee+Level-2 items/filtered_summary/filtered_total/total_pages match, `expense_date_asc` sort ordering match, page-2-via-cursor items match — **ALL PASS**. **Process:** captured the OLD definition + sha256 (`978b6ada…`) for rollback; took a fresh Production backup (`microlink_postgres_pre_queue_opt_20260811T123422Z.dump`, 15,090,683 bytes, sha256 `96b8c9eb…`) before any write; dry-ran the migration in `BEGIN…ROLLBACK` first; applied atomically (`BEGIN; CREATE OR REPLACE FUNCTION …; GRANT …; COMMIT;`); captured the NEW definition + sha256 (`81907f75…`) and confirmed signature/`SECURITY DEFINER`/`search_path`/grant all preserved. **Post-apply, under the REAL `authenticated` 8 s `statement_timeout`** (not superuser): employee 6174 → **1.02 s** and **1.13 s** (2 runs), Level 2 Verified → **0.57 s** — **no `SQLSTATE 57014`**. Signature unchanged → no PostgREST schema reload required (confirmed by the authenticated-role call succeeding through the normal execution path). Zero data mutation — this is a `STABLE` read-only function; no `INSERT`/`UPDATE`/`DELETE`, no balance/approval logic touched. **No main merge, no frontend deploy, no Vercel change** — this is a DB-only fix under a separate, narrower authorization than the rev-20/21 frontend work, which remains on `dev` pending the owner's manual test. Rollback: re-apply the captured OLD definition (sha256 above) via `CREATE OR REPLACE FUNCTION`. |
| 2026-08-11 | 21.0 | Claude Code | **Server-query robustness — bounded timeout + visible, retryable failure (DEV, no SQL). Response to a Production runtime incident.** Owner reported: on Production `/review`, searching an employee (6174) resolves the identity (chip appears) but the filtered result never replaces the old rows and the chip stays on "counting…" — i.e. the filtered queue request never successfully commits, yet looks like Search "did nothing." **Read-only audit findings:** (1) MAIN and DEV source are **identical** (`git diff origin/dev origin/main` empty; main only carries merge-history commits) — NOT a merge/source defect. (2) Live Production build is the correct release `0aba6dc` (submit-model + JSON-hardening markers both present). (3) The frontend query LIFECYCLE is correct: a search fires `fetchServerPageInternal(1)` exactly once and cancels any in-flight normal fetch via the SHARED `fetchSeqRef` + `coreRequestAbortRef`. So the stuck state is a **failed or aborted filtered request whose failure was invisible** — and the code had **no timeout** and left the chip on "counting…" indefinitely (`filteredResultCount` stays null) with no clear error. Definitive backend cause (why the query fails/hangs for a heavy Production reviewer, ~2183 assigned) could **not** be captured: read-only SSH was denied (publickey/password; no key configured — passwords are never entered), the DEV Preview bundle is Vercel-auth-gated, and there is no authenticated Production session. **DEV fix (transport/UX robustness, no behaviour change to a healthy path):** `fetchServerPageInternal` now bounds each page request with `SERVER_QUERY_TIMEOUT_MS` (25s) — a timeout aborts AND is surfaced as an error (a genuine supersession/unmount abort still stays silent); on failure/timeout it sets a retryable `serverQueryError` + `loadError`, keeps the prior rows on screen (no wipe, no ErrorBoundary, no retry loop, §54), and the search chip shows "couldn't load — retry" via a new `countError` prop instead of a perpetual "counting…" (§27/§28). Explicit Clear also resets the error. The localStorage review-list cache was inspected and deliberately left untouched — it only affects normal-mode initial paint, not the filtered fetch, so it is a red herring for this symptom (no forced global cache reset). 2 new tests (chip error render + timeout/error-surfacing wiring); full suite green; tsc/build/typecheck:api/migrations:check/secrets clean; lint 457. **No SQL/DB/financial change; `main`/Production untouched.** **Owner action needed for definitive backend root cause:** run the §14-§19 read-only DB audit (RPC signature/grants of `get_debug_review_queue_page_v1`, PostgREST schema-cache freshness, and its `pg_stat_statements` mean/max for the real reviewer) to confirm whether the filtered query is 504-ing/timing out server-side. **[UPDATE — root cause CONFIRMED via read-only SSH DB audit, same day:** the RPC inventory/signatures/grants are all correct (no stale schema, no collision — search 6174 returns the right identity in 651 ms). The real cause is **query performance vs the `authenticated` role's 8s `statement_timeout`**: `get_debug_review_queue_page_v1` for the real Manager (Jayesh, ~9,342-row assigned scope) runs **~24 s COLD** (first call, cold buffer cache) and ~2–3 s warm, because it recomputes the full-scope `scope_summary` + per-row actionability/identity/batch-state over the entire assigned scope on EVERY page even for a 30-row employee filter. `authenticated` = `statement_timeout 8s`, so the cold query is **killed at 8 s (SQLSTATE 57014)** → the browser filtered request fails → old rows stay, chip stuck. DEV Preview worked because repeated testing kept buffers warm (~2 s < 8 s). `expenses` indexes are already comprehensive (individual scope helpers run 130–730 ms) — NOT a missing index. **Proposed fix (DB change — NOT applied; needs explicit owner authorization):** make the queue RPC SKIP/defer the full-scope `scope_summary` reconciliation when a filter is active (the frontend already uses `filtered_summary` in filtered mode since rev 20), turning a filtered page into a sub-second (~130 ms) query safely under 8 s even cold. The rev-21 frontend timeout/error-surfacing already converts the 8 s failure into a visible "couldn't load — retry" (and a retry usually hits warm cache → succeeds), so it is a correct interim mitigation. No DB write performed — audit was fully read-only (`BEGIN; SET TRANSACTION READ ONLY; … ROLLBACK;`).]** |
| 2026-08-11 | 20.0 | Claude Code | **Submit-driven Review query model + true server-page-at-a-time pagination (DEV, no SQL).** The owner reproduced a glitch/request-storm: Status/Sort/Time/custom filters applied IMMEDIATELY on change, each re-filtering + re-enriching (repeated `expense_form_field_values` → 500/504). **Fix — a form-style model (§6-§8):** every filter control (Status, Sort, Direction, Time, custom fields, "Needs my verification", hierarchy toggles, search text) now writes to a DRAFT twin that nothing observes — editing them issues ZERO Review requests and leaves the table stable (§31/§32). The existing state (`statusFilter`, `sortBy`, `sortOrder`, `timePeriod`, `customFieldFilters`, `showOnlyActionable`, `include*Reports`) + `singleBar` remain the APPLIED query; ONE coordinator `handleSubmitReviewQuery` (Search button / Enter) copies draft→applied in one batch and bumps `appliedRevision`, so exactly one query runs (§8/§29). An already-resolved, UNCHANGED search commits filters WITHOUT re-hitting the employee RPC (§9/§47); a new/changed search resolves once and its resolution commits the staged filters atomically (§10/§29 C2), including the disambiguation-popover pick (§11). **Broadened server mode (§14):** `reviewFilterActive` is now `isServerQueryActive(appliedQuery)` — employee OR general OR non-default status OR non-default sort OR non-"all" time OR any custom filter. So "Level 2 Verified" alone routes through `get_debug_review_queue_page_v1` (server-filtered, `p_statuses:["level_2_verified"]`) instead of the normal full-scope fetch + client filter + enrichment storm. The 3 identity/optional-badge enrichment effects skip for ALL server-query rows (they carry identity/custom_fields/resubmission/correction on the row), so list rendering makes ZERO `expense_form_field_values` requests (§20/§44). **True pagination (§22-§27):** the old bounded pre-download (`FILTERED_MAX_PAGES×100`=300, client-sliced) is REPLACED by `src/lib/reviewServerPagination.ts` — one 25-row page per queue RPC, `next_cursor`/cursor-history for Next/Previous (no re-download), and the page-anchor RPC for direct jumps (page 67 of 1663 = one anchor + one page call, never a 66-page walk). New pure `src/lib/reviewAppliedQuery.ts` (status/sort/time/custom→server params, `isServerQueryActive`, `buildAppliedQueryKey` incl. custom filters). **KPI honesty (§28):** in server mode the cards read the server's reconciled `filtered_summary` over the whole population (Assigned = server `filtered_total`), never the 25 held rows. **Workspace/return cache (§36/§37):** the query key is now the applied-query key (custom filters + actionable + hierarchy included); versions bumped (workspace v1→v2 storing the 3 new fields, return cache v1→v2); server-mode restore lands on the exact saved page (§55). **Behaviour changes to validate (owner smoke §59):** (a) the "Level 2 Verified" manager status filter is now the LITERAL server status (`["level_2_verified"]`, e.g. 1,663) — the old engineer-tier "also show stuck submitted/edited rows" augmentation is not sent server-side; (b) "Needs my verification only" stays a CLIENT refinement over the loaded page (§41), so its resulting count is loaded-page scoped, not the global filtered total; (c) MOBILE keeps its current immediate-apply behaviour (desktop is the acceptance surface, §43) — full mobile submit UX is a separate task. New tests: `reviewAppliedQuery` (18), `reviewServerPagination` (7), `reviewSubmitModel` wiring (12), updated stability/state-wiring/workspace guards. Full suite green; tsc/build/typecheck:api/migrations:check/secrets clean. **No SQL; no DB/migration/financial/Manager-override/V2 change; `main`/Production untouched.** |
| 2026-08-11 | 19.0 | Claude Code | **PRODUCTION incident — "Unexpected end of JSON input" crash on /review (transport hardening, no SQL).** After the Review work reached main, Production /review could crash the React ErrorBoundary with `SyntaxError: Unexpected end of JSON input at JSON.parse`. **Root cause (proven by inspecting the installed dep):** `@supabase/postgrest-js` `PostgrestBuilder.js:92` calls `JSON.parse(body)` on the SUCCESS path (`res.ok`) with NO try/catch (only the error path is guarded), so an **aborted or gateway-truncated 2xx body** — a direct consequence of the new true-cancellation (`callRpc(...).abortSignal()` + one `coreRequestAbortRef`) plus the transient gateway truncation seen in rev 17 — throws a raw `SyntaxError` out of the awaited builder. A second, compounding bug: the abort classifiers used `error instanceof Error`, but a browser `AbortError` is a **DOMException (not `instanceof Error`)**, so aborts were misclassified as hard errors. **Fix (transport only):** `callRpc` now wraps `await builder` — an abort (active signal OR AbortError-shaped throw) becomes a canonical `ReviewQueueAbortError` (name `AbortError`, callers already swallow it); a non-aborted incomplete/truncated body becomes a controlled retryable `ReviewQueueNetworkError` ("incomplete response, please retry") — never a raw `SyntaxError`, so it stays inside the review error UX, not the ErrorBoundary (§8/§15). New `isReviewAbort`/`isIncompleteJsonError` inspect `name`/`message` structurally (DOMException-safe); `reviewExpensePagination`'s `isAbortError` fixed the same way and now also treats `signal.aborted` as abort. Added a single-flight guard so a background/realtime refresh never aborts-and-restarts an identical in-flight query (§12/§30 — removes the aborted-mid-body window). No cancellation was removed (§14). All feature behaviour preserved: server-filtered search, "0 visible" fix, instant Batch-Back cache, checkboxes, Manager override, V2. 6 new tests (deterministic abort/incomplete-JSON repro proving no raw SyntaxError escapes + classifier unit tests); full suite 2896; tsc/build/typecheck:api/migrations:check/secrets clean; lint 457. **No SQL; no DB/migration/financial changes.** Honest note: every *app* caller was already try/catch-wrapped, so the exact ErrorBoundary escape could not be reproduced purely from static analysis — the fix hardens the transport where the raw SyntaxError originates and is proven by the repro test. |
| 2026-08-11 | 18.0 | Claude Code | **Review polish: fixed "0 visible", instant Review-Batch Back, true request cancellation (DEV, no SQL).** **(1) "0 visible" (§2-§6):** the employee chip rendered `selectedEmployee.visible_expense_count` from the identity-resolution RPC (0/stale) while the filtered result actually held 30. The chip now takes an authoritative `selectedEmployeeCount` supplied from the queue RPC's `filtered_total` (`filteredResultCount`), shows "counting…" until the result resolves (never a false "0", §5), and the ambiguous-match popover no longer shows any count (it picks an identity, not queue stats, §6). **(2) Instant Back (§7-§14):** new short-lived, versioned, org+reviewer-scoped, TTL'd `src/lib/reviewReturnCache.ts` stores the LIST currently on screen (rows + query identity + page + counts, max-row guarded, no attachments/tokens/detail) just before navigating into a Review child; on a return-intent mount the cached rows paint **instantly** with the full-screen loader cleared, then the normal fetch effects background-refresh the same query (stale-while-revalidate). Approval stays server-authoritative regardless of cached status (§15). **(3) True cancellation (§19-§21):** `reviewQueueServer/api.ts` `callRpc` now accepts an `AbortSignal` and uses the PostgREST builder's `.abortSignal()`, threaded through `fetchReviewQueuePage` → `fetchFilteredReviewExpenses`; EngineerReview owns ONE core `AbortController` for both modes, aborting the previous request (and on unmount) so an obsolete queue/normal RPC is actually cancelled, not merely ignored — the `fetchSeq` guard stays as a second line. **(4) Back consolidation (§16/§17/§30):** `BatchExpenseReview` Back for `from="review"` now ALWAYS `navigate("/review",{replace:true})` (with or without a legacy `location.state` snapshot), so browser Back cannot reopen the batch; the canonical workspace + return cache own restoration. **(5) Filtered KPI (§23):** the Assigned card uses the server `filtered_total` in filtered mode, not the bounded held count. The commit-28ad767 storm fixes are preserved (filtered rows skip enrichment; `refreshCurrentReviewQuery`). 18 new tests (return cache 8, chip-count/popover/cancellation/KPI guards, abort unit); full suite 2891; tsc/build/typecheck:api/migrations:check/secrets clean; lint 457. **No SQL; `main`/Production/DB untouched.** |
| 2026-08-11 | 17.0 | Claude Code | **Review search stability — eliminated the request storm / 504s / normal-vs-filtered races (DEV, no SQL).** The owner's HAR/console showed the filtered page glitching: ~801 `expense_form_field_values` entries (56× 504) + normal `list_reviewer_visible_expenses_page` traffic during a filtered search. **Read-only backend correlation (`pg_stat_statements`): the custom-field query had 137,069 calls, mean 329 ms, MAX 7,891 ms — request amplification saturating the DB; the list RPC was healthy (mean 48 ms).** Root causes fixed: **(1) redundant enrichment (the storm):** filtered rows already carry identity, `custom_fields`, `is_resubmitted` and `was_reviewer_corrected` from the queue RPC, yet the generic identity + optional-badge effects still fetched them per row — both effects now early-return in filtered mode, so filtered list rendering issues ZERO `expense_form_field_values` / profile / resubmission / correction requests (§14/§43). **(2) normal↔filtered crossover:** a new single `refreshCurrentReviewQuery` dispatcher routes EVERY refresh (debounced realtime, all seven verify/approve/reject/correction/bulk mutation completions, retry) by the CURRENT committed mode via refs, so a filtered user is never sent back through the full ~9,244-row normal fetch (§3/§4/§5/§26/§30). **(3) Load-All behind search:** `handleLoadAllExpenses` returns early in filtered mode and an effect aborts any in-flight normal Load-All the moment a filter activates (§8). **(4) double free-text filter:** `applyFilters` no longer re-runs the client text search in filtered mode (the server already applied it — avoids false negatives, §25). **(5) bounded filtered download:** the interactive load is capped (`FILTERED_MAX_PAGES=3`, page size 100) so an employee (~30) loads in one page but a broad general search (e.g. `filtered_total=5000`) can never download everything — it shows the first N with a "refine your search" note (§9/§32/§46); a filtered 504 keeps prior rows, no retry loop, no fallback to normal, no enrichment storm (§34). Workspace restoration, identity first-paint, checkboxes, warning, Manager override and V2 are all preserved. 13 new tests (bounded-fetch cap + source-lifecycle guards); full suite 2876; tsc/build/typecheck:api/migrations:check/secrets clean; lint 457. **No SQL; `main`/Production/DB untouched. Separate observation (NOT fixed — no DB authorization): the `expense_form_field_values` query is intrinsically slow (mean 329 ms, max ~8 s) even without amplification and may warrant an index/optimization in a future authorized task.** |
| 2026-08-11 | 16.0 | Claude Code | **Server-filtered Review search (no more employee Load-All) + complete workspace-state restoration (DEV, no SQL).** **Efficiency (§2-§9):** selecting an employee (or submitting a general search) now fetches ONLY the matching rows from the installed `get_debug_review_queue_page_v1` via a new `fetchFilteredReviewExpenses` transport, paged until exhausted and mapped onto the legacy `Expense` shape (`reviewQueueItemToExpense`, identity already on the row → no "—" flash). The old employee-select "Load All the whole ~9,244-row scope" effect is removed; a `reviewFilterActive` gate stops the normal full-scope fetch while a filter is active, and a dedicated filtered effect re-fetches on query/sort change. The server's actionability fields are ignored — this is search transport only; EngineerReview stays authoritative for ready/waiting/completed and Manager actions (§4). **Read-only live proof:** as the real Manager, employee 6174 → `filtered_total=30`, page 1 = 25, page 2 = 5 (not 9,244). **State restoration (§10-§45):** new versioned, org+reviewer-scoped, corrupt/TTL-safe `reviewWorkspaceState` snapshot (save/load/clear + one-shot return-intent). `navigateToBatchReview` now saves the full workspace (employee via immutable user_id + validated display identity, search draft/submitted/general, status/time/sort filters, page, scrollY, anchor expense id) and marks return-intent before navigating; on the next `/review` mount, if (and only if) return-intent is present, the workspace restores — filters/sort, the search bar via `restoreSearch` (ZERO employee-search RPC, §14), the page clamped to the fresh result (§16/§31), and scroll to the anchor row (§20). A fresh sidebar visit does not restore (no trap, §22); explicit Clear drops the snapshot (§41). **Filtered results are bounded (an employee's ~30, a search's matches), so client pagination over the loaded filtered set reuses the entire existing render/selection/approval pipeline — normal mode untouched, no dual pagination model.** New pure modules + tests: workspace-state (16), filtered-fetch/mapper/sort (4), source-wiring guards (8). Full suite 2867; tsc/build/typecheck:api/migrations:check/secrets clean; lint 457. **No SQL; `main`/Production/DB untouched.** Mobile still uses the legacy text search (desktop is the acceptance surface). |
| 2026-08-11 | 15.0 | Claude Code | **Manager override — server LIVE on Production + frontend dual-path approval (owner-authorized migration).** Under explicit owner authorization, applied ONLY the two reviewed migrations for this feature over SSH after a fresh backup (`pesowise_20260811T061425Z_pre_manager_override.dump`, 14,978,245 bytes, SHA-256 `2ad98d9d…4325a1`, 1895 TOC entries). **Audit first:** override absent (no collision), and live `review_approve_expense_v2` captured and confirmed to match the repo — the override's inlined deduction block matches V2's lock/deduction semantics exactly (per §6 the live financial helper was NOT refactored; a source drift-guard test protects them instead). Applied `20260810160000_manager_override_approve_prepared.sql` (`review_approve_expense_manager_override_v1`) + `20260811120000_review_manager_override_capability.sql` (`review_manager_override_capabilities_v1`, read-only probe), `NOTIFY pgrst`; verified discoverable, `authenticated` granted / `anon` denied, capability returns `{ready:true}`. **Live validation, all under BEGIN…ROLLBACK (zero permanent mutation):** transactional E2E — a waiting executive-tier ₹30 expense for the real Manager approved (status→approved, `approved_by`=manager, one deduction ₹30, balance 0→−30 arithmetic correct + negative supported, audit says Manager override), then rolled back to submitted/0 deductions; security matrix — executive/employee/cross-org-actor/cross-org-target/over-limit/out-of-scope/terminal/self-review all REJECT with correct messages. **Frontend:** removed the hard-coded `MANAGER_OVERRIDE_AVAILABLE=false`; new `useManagerOverrideCapability` fail-closed runtime probe gates PROCEED; `classifyForApproval` reordered so over-limit is reported before waiting (§9); `ExpenseService.approveExpenseManagerOverride` wraps the RPC; `runBulkApproval` is dual-path (ready→V2, waiting→override, sequential concurrency 1, no browser balance write) with a truthful result toast ("X approved normally, Y with Manager override, Z skipped, N failed"); singular Approve on a waiting/over-limit row now routes through the same AlertDialog (STOP=zero mutation); batch approval expands selected batch keys from a FRESH server fetch of current children (off-page included, stale rows superseded — §10/§11); override offered only once the real `engineer_approval_limit` has resolved (§8); EN/HI/GU copy updated (§28). 15 new/updated frontend tests (classification §9, capability fail-closed, financial parity drift-guard); full suite 2839; tsc/build/typecheck:api/migrations:check/secrets clean; lint 457. **`main`/Production frontend/Vercel UNCHANGED; no dev→main.** Remaining: employee-search server-filtered efficiency (§17-20). |
| 2026-08-11 | 14.0 | Claude Code | **Identity hydrated BEFORE the first visible row commit — no more late-loading employee names (DEV, no SQL).** Rev 12.0 made identity resolve *reliably* but still *after* first paint, so a valid `user_id` could briefly render "—" then populate. New acceptance criterion: a row with a valid user_id must never flash "—". The fetch pipeline now hydrates identity **before** committing each page: a new `hydrateRowsIdentity(rows)` helper resolves the page's unique user_ids through the `ReviewIdentityStore` and returns the rows with `applyReviewRowIdentity` applied; every commit path awaits it before `setAllExpenses` (canonical page loader, legacy page loader, legacy single-fetch, and both Load-All continuations). To make per-page hydration possible the two page drivers (`loadReviewerExpensePages`, `loadLegacyReviewPages`) now **await** their `onPage` callback (`onPage` may return a Promise), so the next page is not fetched until the current page is committed with identity. It blocks only on the light org-scoped `profiles` lookup (a page's ~10-25 users), never the heavy custom-field enrichment, and on failure still commits the rows (degraded hint + retry) rather than hang. Optional badges (resubmitted/corrected/custom) still resolve after paint in their own effect — a badge appearing late is fine, a name is not. The post-paint identity effect is kept as a cheap safety net (realtime inserts, an opened row) — it early-returns once the visible users are resolved. Review list cache bumped **v3 → v4**: v2/v3 snapshots stored identity-less rows (they were written from the pre-hydration array and would flash "—" on restore), so the bump abandons them and forces one identity-hydrated fetch; v4 entries carry names/IDs/balances and restore instantly with no flash. The MAIN single-bar search hotfix behaviour is preserved on both Manager and Executive (unchanged). New tests: page loaders await an async onPage (ordering proof), onPage hydrates before commit, both drivers await onPage, cache key is v4. Full suite 2824; tsc/build/typecheck:api/migrations:check/secrets clean; lint 457. **No SQL; `main`/Production/DB untouched.** |
| 2026-08-10 | 13.0 | Claude Code | **Batch-aware keyed checkboxes + pre-approval waiting warning + prepared Manager-override migration (DEV, no SQL applied).** Selection is now KEYED (`expense:<id>` / `batch:<batch_id>`) via a pure `src/lib/reviewBulkSelection.ts`: ready AND waiting rows are selectable, terminal never is; a batch is ONE logical selection across all its child rows; header select-all dedupes batch keys and shows a correct indeterminate tri-state; the desktop table and the mobile card/queue share the same model (mobile `onToggleSelect(exp, checked)` + `selectionKeyOf`). Bulk actions expand keys → expense ids over all held rows (batch → every non-terminal child, deduped, never terminal). Pre-approval classification (`classifyForApproval`) buckets the selection into ready-now / over-limit / waiting / terminal; when anything is not immediately approvable an AlertDialog (EN/HI/GU) shows the four counts + selected total with STOP (zero mutation, keeps selection) and PROCEED. Because Manager-override server support is not installed (`MANAGER_OVERRIDE_AVAILABLE = false`), PROCEED is **disabled** whenever waiting rows are present, with a clear "override not enabled in this environment" note — waiting rows are never mutated and no nonexistent RPC is called; PROCEED otherwise approves only the ready-now rows through the unchanged sequential (concurrency 1) `ExpenseService.approveExpense → review_approve_expense_v2` path with no browser balance write. Verify/Reject act only on rows ready for this reviewer (waiting/terminal skipped). Prepared migration `20260810160000_manager_override_approve_prepared.sql` (`review_approve_expense_manager_override_v1`): engineer-only, same-org active membership, no self-review, non-terminal, `expense_manager_can_review` scope, `engineer_approval_limit` retained, reuses V2's atomic deduction + shared `expense_balance_deductions` UNIQUE(expense_id); executive/team_leader gain nothing; **NOT applied** (no `NOTIFY pgrst`), frontend stays disabled until a separate explicit authorization. 15 selection/classification unit tests; mobile keyed-selection tests updated; tsc/build/migrations:check/secrets clean. **No SQL executed; `main`/Production/DB untouched.** |
| 2026-08-10 | 12.0 | Claude Code | **Fixed the proven identity-enrichment race (names stuck on "—").** A live audit showed transactions 10585-10589 rendering "—" for employees who have exactly one org-scoped profile with a non-empty name and employee_id — a frontend bug, not data. Root cause in EngineerReview's page-local enrichment: it marked expense IDs "enriched" **before** the async profile fetch, incremented a global sequence, and discarded the **entire** run (successfully-fetched profiles included — the cache write sat *after* the guard) whenever a later render superseded it; the marked IDs stayed marked, so those rows never retried. Fix: a dedicated `src/lib/reviewIdentityCache.ts` (`ReviewIdentityStore` + `applyReviewRowIdentity`) treats identity as CORE data, **keyed by user_id**: a profile is cached the moment it arrives and is never discarded by a later render; applying it patches **every** held row sharing that user_id (so all lines of a batch and rows on other pages populate together); a failed fetch is retryable (`clearFailures()` on the next explicit refetch), never a permanent placeholder, and failures do not auto-retry every render. EngineerReview now runs identity in its own effect (resolve → bump version → idempotent patch-all-rows) fully separate from the optional-badge effect (resubmitted/corrected/custom), so a custom-field failure can no longer blank a name; a distinct amber "Some employee names could not be loaded" hint replaces silent "—". Cache-restored pages re-resolve missing identities automatically (store is session-scoped), so a stale core-only snapshot cannot permanently reproduce "—". 9 new unit tests incl. the exact 10585-10589 supersession regression (fails against the old mark-upfront+seq-discard model), same-user batch consistency, and failure-then-retry; tsc/build clean. **No SQL; `main`/Production/DB untouched.** |
| 2026-08-10 | 11.0 | Claude Code | **Promoted the proven search onto the canonical page + fixed the batch colour + mobile parity (DEV, no SQL).** After the `/review` rollback to legacy `EngineerReview.tsx` (`recover(review)`), two owner-confirmed defects remained on the live dev page. **(1) Batch colour:** a Manager viewing an executive-tier batch saw a **grey** "Review batch" button. Cause: `batchActionState` classified a batch "all-done" (grey) whenever no child was ready *for the current reviewer* — but every child waiting at Team Leader/Executive tier has `isPendingForCurrentReviewer=false`, so a fully-**waiting** batch read as done. Replaced the pending-count model with child-based classification in the shared `reviewStatePresentation` contract (new pure `batchReviewState`: all children terminal → completed/grey; any non-terminal child ready → ready/blue; otherwise → **waiting/amber**), wired both `batchActionState` and the singular button to it, and added `isTerminalReviewStatus` as the single source of "done". **(2) Search:** replaced the enrichment-dependent free-text `expenseRowMatchesSearch` (false negatives before async name/ID enrichment; "6174" collided with txn 06174) by wiring the already-proven, already-tested `useSingleBarSearch` + `ReviewSearchBar` + `ReviewEmployeeResultsPopover` into EngineerReview: ONE bar, employee lookup resolving an immutable `user_id` via `search_debug_review_employees_v1` (typing issues **zero** requests; submit/Enter only; `txn:`/`#` forces expense search; ambiguous → popover), expense text mirrored into the existing `searchTerm` filter. The resolved `user_id` filters rows by `expense.user_id` (no enrichment needed) and composes with the text filter; selecting an employee auto-triggers Load-All so their rows are found regardless of page depth (§8); the same one control serves Manager and Executive (they share EngineerReview). **(3) Mobile parity (§3):** `MobileReviewExpenseCard` now shows an amber **Waiting** badge for a visible-but-not-ready row, distinct from blue "Action needed" (ready) and no badge (terminal). Tests: §25 batch-state matrix incl. the all-waiting→amber regression (13 lib tests) + 3 mobile 3-state parity tests; the `useSingleBarSearch` zero-request/txn-safety and employee-filter suites already existed. tsc, build clean; lint 458 unchanged. **No SQL executed; Production, `main` and the DB untouched.** |
| 2026-08-01 | 1.0 | Agent | Initial — diagnosed the 6174/06174 collision from live data (24 employee expenses vs 1 transaction match owned by employee 6557); built the independent `debug_review_*_v1` contract with a submit-driven employee-search RPC resolving to an immutable user_id that never matches transaction numbers; keyset pagination with page_size+1; page-only enrichment. 28 tests (1822 total). Page UI and route **not built**. **No SQL executed.** |
| 2026-08-02 | 2.0 | Agent | Completed the debug page. Column audit found every reference valid; base migration already applied to a shared environment, so corrections went into additive `20260801150000`. Corrected three real defects: role/tier/hierarchy-blind actionability (one canonical helper), profile enrichment that could duplicate expense rows (`DISTINCT ON` resolver), and keyset predicates that evaluated to NULL on null `created_at`/`trip_start`/`total_amount`, silently dropping those rows from every page after the first (single finite sort key). Also excluded soft-deleted attachments. 12 components, 6 hooks, Zod validation, `/debug/review-expenses` route, sidebar entry, EN/HI/GU strings. 136 feature tests, 1933 total. **Corrections migration not yet executed.** |
| 2026-08-02 | 3.0 | Agent | Runtime proof received: capabilities `ready:true` at revision `20260801150000`, and the debug page returned **24/24 rows with 24/24 identities resolved** for employee 6174 in 1,941 ms, with transaction 06174 absent — the §1 defect disproved end to end. Extracted the proven data layer into `src/features/reviewQueueServer/` (schemas, RPC arguments, employee-search state, cursor handling, identity parsing, filter serialization, error classification) and made the debug feature a thin alias over it, so there is exactly one implementation with scoped caches. Built the server-backed `/review` page behind `VITE_REVIEW_EXPENSES_SERVER_QUEUE_ENABLED` (default false) via a wrapper that leaves EngineerReview.tsx untouched and never falls back automatically. One search bar resolves employee-vs-transaction in the proven order, with `txn:`/`#` bypassing employee lookup. KPI cards now read `scope_summary`; pagination is keyset with only walked page numbers; custom-field filters key on stable template/branch UUIDs. 112 new tests, 2046 total (was 1933); i18n 184 and lint 458 unchanged baselines. **Actions flag remains false; the production page has not been opened against a live database and visual parity has not been human-verified.** |
| 2026-08-02 | 4.0 | Agent | Corrected four defects reported from the running Preview page, all in additive `20260802010000`. (1) **KPI**: `assigned_to_me` was the direct-assignment count (5,674) while the table showed the full visible scope (7,450) — two different questions on one card. It is now the complete visible scope, equal to `scope_total` and to the unfiltered `filtered_total`; the direct count survives as `directly_assigned`. A dev-only assertion warns if they disagree with no filters active. (2) **Filters**: the filter-options RPC returned templates UNION ALL branches with no parent data, so every branch rendered its own dropdown — hence ten-plus identical Project ID controls. The response now carries `parent_template_id`, `parent_branch_id`, `parent_option_value`, `display_order`, cycle-safe recursive `depth` and `is_root`, and the client renders a child only when its parent holds its declared value, clearing and pruning descendants on change. One control initially, not ten. (3) **Pagination**: new `get_debug_review_queue_page_anchor_v1` resolves an arbitrary target page to the cursor before it, so quick links (1/2/3 … current ± 1 … last) and a validated `Page [n] Go` input work; Next/Previous stay pure keyset with no OFFSET, and both RPCs share one `_debug_review_keyed_scope_v1` helper so their filter and sort semantics cannot drift. (4) **Progress**: indeterminate `AsyncOperationProgress` restored for every request, with the table kept visible and `aria-busy` set during background refetches — no fake percentage, no Load All. Cursor cache is now a page→cursor map invalidated by a query-shape key. 40 new tests, 2086 total (was 2046); i18n 184 and lint 458 unchanged baselines. **`20260802010000` NOT applied; page-number controls stay hidden until `page_anchor` reports true. Actions remain disabled.** |
| 2026-08-02 | 5.0 | Agent | Connected the server-backed page to the **existing** review actions and rebuilt the detail modal to match the All Expenses review dialog. `src/features/reviewActions/` wraps `ExpenseService.verifyExpense/approveExpense/rejectExpense/applySingularExpenseCorrection` rather than adding a mutation path, with `assertActionsEnabled()` first in every path, no optimistic updates (invalidate only after the server confirms), `BULK_CONCURRENCY = 3` preserving input order, and client-side eligibility that can only subtract. The modal previously used `max-w-3xl`, nested cards, invented field grids, plain `<a>` attachment links and a green-outline Approve; presentation is now taken verbatim from `AdminPanel.tsx` (widths, `text-sm font-medium` labels, `text-lg font-semibold` amount, `p-3 border rounded-lg` attachment rows, `h-14 w-14` thumbnails, and the Cancel/Correct/Reject/Verify/Approve footer order and variants), with the same `ExpenseBaseFieldsDisplay` / `ExpenseFormFieldsDisplay` / `ExpenseReviewTimeline` / `ExpenseCorrectionAuditList` / `AttachmentPreviewDialog` components fed from the single detail RPC — zero extra requests. Three presentational components extracted to `src/components/expense-review/`. One deliberate divergence: the header and footer sit outside the scroll container, so the action buttons no longer scroll away on a long expense (the reference scrolls both). 29 new tests, 2168 total (was 2139); lint 458 unchanged; `i18n:check` fails to start on a clean tree too (`ERR_UNKNOWN_FILE_EXTENSION`) and is unrelated. **Correct expense is withheld on this page until the correction editor is built — it was never present there. Actions flag still default-off; no SQL executed.** |
| 2026-08-02 | 6.0 | Agent | Restored the proven Review Expenses UI from `origin/main:EngineerReview.tsx` over the server queue. Rev 5.0 had matched the **All Expenses** dialog in AdminPanel instead of the Review Expenses one, and had left the table untouched: every row rendered one generic `View / Review` button and `onView={setDetailId}` opened the singular modal for batch lines too, inviting a reviewer to approve one line of a batch and abandon the rest. Deleted `src/components/expense-review/*` rather than build on the wrong abstraction. The table now uses main's column widths (`useResizableColumns`, same storage key), blue mono transaction number, violet Batch badge, green/red balance with `insufficientBalance`, status badge + queue hint, Resubmitted override and sticky actions cell; batch rows render `Review batch` and navigate to `/expenses/batch/:id/review?from=review&expense=:id` carrying the queue state in router state, never setting `detailId` and never issuing the detail RPC. The modal is main's card hierarchy and footer. `Correct expense` is fully restored, reusing main's own custom-field loading, validation, branch pruning and patch builder. Mobile matches `MobileReviewExpenseCard`. Deliberate differences: the batch button stays the pending blue because completion cannot be computed honestly from one page; actionability is read from the server, not recomputed; no line-items card (not in the RPC); mobile keeps the transaction number. 46 new tests, 2185 total (was 2168); tsc, typecheck:api, migrations:check and build clean; lint 458 unchanged. `i18n:check` proven broken on a pristine `origin/dev` worktree, so keys were validated directly and `review.insufficientBalance` added to hi/gu. **No SQL executed.** |
| 2026-08-02 | 7.0 | Agent | Fixed the employee filter, the KPI scope and the batch colours. Selecting employee 6174 showed an empty table for two compounding reasons: `onResolved()` carried no information, so the page could only clear row checkboxes and a leftover Level 2 Verified filter silently intersected the employee; and `useCursorHistory` reset in a `useEffect`, so the render that first carried the new employee still carried the previous query's cursor - the RPC was asked for employee 6174's rows after position ~4,000 of the unfiltered ordering and correctly returned none, which React Query then cached (also why a repeat search inside the 30s staleTime issued no queue request at all). Search now emits a typed `SearchResolution` the page handles as one transition, resetting content filters while preserving sort and page size; the cursor resets during render; submits are serialised by an in-flight ref and a sequence number so Enter-plus-click is one lookup and a stale response cannot overwrite a newer one. New additive read-only migration `20260802030000` adds `filtered_summary` (aggregated over the filtered keyed scope before the cursor and the page limit, reusing the existing scope CTE) and authoritative `batch_action_state` computed across every assigned line of each visible batch in one GROUP BY - no per-row request and no page-slice inference. Cards switch source by context with a line naming what they describe, and treat a missing `filtered_summary` as a contract mismatch rather than zero. Batch buttons are blue/amber/grey, grey meaning no remaining action for this reviewer and still clickable. 34 new tests, 2219 total (was 2185); lint 458 unchanged; `i18n:check` reproduced as failing on a pristine 4df1359 worktree, six new keys validated directly across en/hi/gu. |
| 2026-08-10 | 10.0 | Claude Code | **`verified` status aligned with the admin approval contract.** A read-only follow-up audit of rev 9.0 found one residual queue↔approval mismatch: `review_approve_expense` V1 (called by V2) allows an org admin to approve `status='verified'` (it is in the `IF v_is_admin` allowed list; balance not yet deducted), and `ExpenseService`/`ADMIN_APPROVABLE_STATUSES` agree — but the queue classified `verified` as terminal (`_debug_review_status_class_v1('verified')='terminal'`) and `_debug_review_actionability_v1` returned it `view_only` for admins. Live MicroLink had **2** `verified` expenses affected. **Product decision (owner-authorized): plain `verified` is NOT financially final for an org admin — it remains eligible for final admin approval.** Chosen direction: make the queue match the existing financial contract (Option 1); do **not** tighten V1/V2. Additive migration `20260810140000` changes only the two pure helpers: (1) `_debug_review_status_class_v1` moves `verified` from terminal→**pending** (like `level_2_verified`), so those rows live in the Pending Review workflow bucket; only `approved`/`rejected`/`paid` remain terminal; (2) `_debug_review_actionability_v1` adds `verified` to the admin super-approver fast-path and evaluates that path **before** the terminal gate so the old terminal branch cannot swallow `verified` first. **Non-admin semantics unchanged** — `verified` stays in `v_terminal`, so engineer/team_leader/executive remain view-only on it (regression-guarded in the SQL contract test). The queue page RPC `get_debug_review_queue_page_v1` was deliberately **not** touched: `pending_review`/`completed_review` follow the classifier automatically, and the `verified` summary field is a Completed-bucket breakdown (`FILTER … AND class='terminal'`) that correctly reads **0** once verified rows are pending — which keeps the reconciliation invariant `completed_review = verified + approved + rejected + paid + other_terminal` balanced (both sides drop by the verified count). Applied live to `supabase-db-evo3o0…` in one transaction after backing up **both** functions (`_debug_review_status_class_v1` sha256 `da34376b…b5b`; `_debug_review_actionability_v1` sha256 `8a485919…c25`), then `NOTIFY pgrst,'reload schema'`. Live verification: contract test `ALL ASSERTIONS PASSED` (incl. non-admin verified regression + status-class assertions); the 2 verified rows now `class=pending`, admin `is_actionable=true`/`admin_approvable`/`view_only=false`, non-admin `is_actionable=false`; submitted 10483/10484/10485 remain healthy. **KPI before→after (admin, live RPC)**: `completed_review 35→33`, `verified 2→0`, `pending_review`/`actionable_now` +the 2 rows, `reconciliation_ok=true` throughout (the assigned-total drift 9896→9903 is independent user activity during the task, per design). No expense rows changed. 3 new frontend regression tests + 4 new SQL contract assertions; 2758 total (was 2755); tsc/typecheck:api/migrations:check/secrets clean; lint 458 unchanged. Rollback: re-apply the two backed-up definitions (pure functions). |
| 2026-08-10 | 9.0 | Claude Code | **Admin bulk-approval checkbox — root cause + fix (queue actionability).** After rev 8.0 shipped, the owner tested live Production Manager Review (merge `d13d846`, deploy READY) as the **MicroLink org admin** and row checkboxes were STILL missing: header select-all present but disabled, every submitted non-batch row showed **View**, KPI `Assigned 9157 / Actionable 1`. The rev 8.0 "it's just the flags" diagnosis was incomplete — both flags were already `true` and the bundle was built after them. **Read-only SSH audit** of the live DB proved the real cause: for txns 10483/10484/10485 (`status=submitted`, `approval_tier=executive`, non-batch, reviewer+engineer assigned but **not** the admin) the queue helper `_debug_review_actionability_v1` returned `is_actionable=false`, `actionable_reason=not_assigned_to_caller`, `available_actions=[]`, `view_only=true`; the whole pending population (5896 executive + 2179 engineer + 1775 team_leader) bucketed 100% `not_assigned_to_caller`, and **nothing** sits at `approval_tier='admin'`. Root cause: the helper (ported from `canRoleActOnExpense`) only lets an admin act at `tier='admin'` or by direct assignment, and **never implemented the org-admin super-approver rule** (`ADMIN_APPROVABLE_STATUSES` / `isAdminApprovableStatus`) that `review_approve_expense` V1/V2 (`IF v_is_admin`, auto-verify, skips tier gate), `ExpenseService.approveExpense/rejectExpense`, `AdminPanel`, mobile and batch review all enforce — so the **queue disagreed with the approval RPC**. The frontend was faithfully rendering server truth (`canPerform`/`isSelectableForBulk`/`reviewButtonLabel` read only `is_actionable`/`available_actions`/`view_only`), so this was a pure server-side defect — no forced checkboxes. **Fix**: additive migration `20260810120000` adds a single admin fast-path to `_debug_review_actionability_v1` — when `role='admin'` and status ∈ {submitted, edited, level_1_verified, level_2_verified} (admin-approvable ∩ non-terminal), return `is_actionable=true`, `available_actions=["approve","reject","correct"]`, `view_only=false`, `reason='admin_approvable'`; terminal (verified/approved/rejected) and all non-admin logic unchanged. Self-review still excluded upstream (`_debug_review_assigned_scope_v1` drops `user_id=auth.uid()`) + client `isSelfOwned`. Because `get_debug_review_expense_detail_v1` calls the same helper, queue and detail agree (§25). **Live-applied** to `supabase-db-evo3o0…` in one transaction after backing up the prior function def (`sha256 ccf50a83…d6969`, no drift), then `NOTIFY pgrst,'reload schema'`; live SQL contract test `ALL ASSERTIONS PASSED` incl. a non-admin regression guard; re-audit confirmed the 3 rows and all 9850 pending now `admin_approvable`. Because the frontend is server-driven, Production `/review` shows admin checkboxes immediately (no bundle change). 4 new frontend regression tests (live-proven shapes) + SQL contract test `supabase/diagnostics/review_actionability_admin_tests.sql`; 2755 total (was 2751); tsc, typecheck:api, migrations:check clean; lint 458 unchanged. Rollback: re-apply the backed-up function def (pure function → full revert). |
| 2026-08-10 | 8.0 | Claude Code | **Bulk approve — confirmation + sequential execution.** Audit finding: bulk approve was already fully implemented in the server-backed page (`ReviewBulkActions`, `useBulkReviewActions`, `bulkEligibility`, `Set<string>` selection, current-page scope, server-derived eligibility that excludes batch/view-only/wrong-tier rows, partial-failure summary) and routes through `ExpenseService.approveExpense → review_approve_expense_v2` with **no** browser `profiles.balance` write. The reason managers saw no bulk approve is that the whole surface is gated behind `REVIEW_EXPENSES_SERVER_QUEUE_ENABLED` + `REVIEW_EXPENSES_SERVER_ACTIONS_ENABLED`, and `/review` otherwise renders the legacy `EngineerReview` which has no bulk action. Two real gaps vs. the requirements were fixed: (1) approvals ran at `BULK_CONCURRENCY = 3` — now **strictly sequential** (`runBulkAction` takes a concurrency defaulting to 1 for `approve`, keeping the bounded pool for verify/reject), so the same employee's expenses settle in selection order A→B→C and never contend on the profile lock; and (2) there was **no confirmation dialog** — added an `AlertDialog` showing the approvable count and selected total (from a new pure, unit-tested `summarizeBulkApprove` helper that counts only rows whose `available_actions` include `approve`), with a live "Approving k of N…" progress line surfaced from a new hook progress state. The selected total is display-only and never treated as financial authority. Read-only SSH audit of the live PesoWise DB (`supabase-db-evo3o0…`) confirmed `review_approve_expense_v2` unchanged and matching the repo — SECURITY DEFINER, VOLATILE, `search_path=public`, authenticated-only (anon/public denied), locks the expense and the `organization_id + user_id` profile, calls V1 internally, writes `expense_balance_deductions` (UNIQUE `expense_balance_deductions_expense_key`, RLS on), and V1 remains balance-free. No server/migration change; no monitoring change. 15 new tests; 2751 total. Enabling the two flags in Vercel and the live UI walkthrough remain the owner's step (Preview is SSO-gated and approvals mutate financial data). |
