# Form Template Scalability — Admin Auto-Paged Browse, Employee Runtime Search, Orphan Inspector

**Doc ID:** DOC-099
**Status:** in progress
**Last updated:** 2026-08-20
**Owner / area:** Form Builder (Admin), Expense Form (Employee)
**Branch:** `hotfix/form-template-server-pagination` (from `origin/main`, does not touch `main`)

---

## 1) Summary

Fixes the Form Field Template system's ~1,000-row PostgREST cap in two places: the admin
template editor's parent-option list (was a client-side full download) and every employee-facing
expense-entry path that eagerly downloaded **all** dependent-field ("branch") rows for **every**
select-type template assigned to a category, regardless of which option the employee actually
picked. Also gives the admin editor an Expenses-page-style auto-loading browse UX (page 1 loads on
open instead of an idle "press Search" state), lightweight per-row preview columns, broadened
admin search (option value + Project ID + Project Name), and a read-only inspector for "legacy
orphan groups" (active branch trees whose parent option no longer exists in the template).

---

## 2) Problem / requirement

1. **Admin editor, prior pass (already fixed on this branch before this doc existed):** the
   Parent Options tab downloaded every option/branch row client-side — silently truncated at
   ~1,000 rows by PostgREST's default row cap, with no error surfaced.
2. **Admin editor UX (owner QA feedback, this pass):** even after server pagination landed, opening
   Parent Options showed "No search run yet — press Search to browse." Owner wants the Expenses-page
   pattern: open tab → page 1 loads automatically → optionally narrow with Search.
3. **Admin table content:** result rows only showed the raw option string — no Project ID/Name
   preview, no way to tell which row is which without opening it.
4. **Admin search:** could only match the option's own string, not the Project ID/Name a user
   might actually be searching by.
5. **Legacy orphan groups:** the editor's summary header shows a "N legacy orphan groups" count
   with no way to understand what they are, sitting silently in Production data.
6. **Employee expense entry (the load-bearing bug):** `ExpenseForm.tsx`, `BatchSharedCategoryFields.tsx`,
   and `ExpenseBatchForm.tsx` all eagerly fetched **every** branch row for **every** select-type
   template assigned to the chosen category via `ExpenseService.fetchOptionBranchesForTemplates` /
   `fetchOptionBranchesForCategory` — an unbounded `.in("parent_template_id", templateIds)` query —
   before the employee had picked anything. At >1,000 total branch rows this silently truncates,
   which can silently omit a real dependent field for a real option.

---

## 3) Solution

### Admin: auto-loading server-paged browse (Part 1/2)

`useServerPagedOptionSearch` now fires exactly one guarded browse request
(`query=null, page=1, page_size=25`) on mount, via a `useRef` template-id guard so React
StrictMode's dev double-invoke cannot produce two logical requests. Typing alone still issues zero
requests; Search/Enter submits; page navigation reuses the last **submitted** query, not unsent
input; a new `clearSearch()` resets to the same auto-browse. `ServerPagedParentOptionsSection.tsx`
replaced the "No search run yet" idle copy with the auto-loaded table and added a Clear (×) button
next to Search.

### Admin: preview columns + broadened search (Part 3-6)

New additive migration `20260821100000_form_template_search_preview_fields.sql` replaces
`search_form_template_parent_options` (same signature) to also return, per result, up to 2
`preview_fields: [{field_key, name, value}]` — the option's own top-2 root branches by
`display_order`. The preview *value* extraction was read against real Production rows before
implementation (not assumed): for a root branch, `value = options->>0` when it's a single-option
select/checkbox array, else `default_value` — verified against real `project_id` (`options=["17828"]`,
blank `default_value`) and `project_name` (`options=["Reliance BP NRO - COCO"]`) rows. Search now
also matches against these preview values, so admins can search by Project ID or Project Name, not
just the raw option string — done server-side via a `value_matches` CTE OR'd into the existing
filter, no N+1, no full download. `ParentOptionsTable` in the frontend is generic: it renders
whatever `previewFields` the first result with any preview data has as extra columns, so templates
without preview data keep the original Option/Dependent Fields/Status/Action layout unchanged.

### Admin: legacy orphan inspector (Part 7-9)

New RPC `get_form_template_legacy_orphan_groups(org, template)` (admin-only, read-only) in the same
additive migration as the two employee RPCs below
(`20260821110000_form_template_orphan_inspector_and_runtime_search.sql`). Lists active root
branches whose `parent_option_value` is not in the template's current `options[]`, with dependent
field names/count and `updated_at`. `LegacyOrphanGroupsDialog.tsx` (new) renders this read-only —
plain-English explanation copy, per-group Parent Option / Dependent Fields / Last Updated, an
"Inspect" affordance only. **No delete/restore/repair action exists anywhere in this dialog or its
RPC** — cleanup is explicitly out of scope for this pass and requires separate owner authorization.
The "N legacy orphan groups" badge in `FormFieldTemplateEditorDialog.tsx` is now a button that opens
this dialog.

### Employee: on-demand branch fetching (Part 11-24, the core fix)

New hook `src/hooks/useOnDemandOptionBranches.ts` replaces the eager, unbounded
`ExpenseService.fetchOptionBranchesForTemplates` call with an on-demand fetch of exactly the
**selected** option's branches, via the already-live, employee-safe
`get_runtime_form_option_configuration` RPC. Returns the identical `OptionBranchDefinition[]` shape,
so nothing downstream (`getVisibleBranches`, `buildInitialBranchValues`,
`validateVisibleBranchFields`) needed to change. Results are cached by `templateId::optionValue` so
re-selecting an already-opened option is instant and never re-fetched. `CategoryFormFieldsSection.tsx`
gained an optional `onSelectOptionValue?: (templateId, optionValue) => void` callback, fired from
`handleTemplateSelectChange`, so the parent can trigger the on-demand fetch exactly when a value is
picked.

Wired into:
- `ExpenseForm.tsx` (primary single-expense entry — replaces the eager category-level fetch;
  pre-selected values on edit/resubmit still resolve their config on demand)
- `BatchSharedCategoryFields.tsx` (shared-once-per-batch category field)

**Employee-facing option search/recents (Parts 13, 15-17):** investigation found the existing
`SearchableSelectField.tsx` (cmdk/Radix combobox) + `useRecommendedFieldOptions` (backed by the
live `form_field_option_usage_tracking` table) already provide a searchable-with-recents UX for the
top-level option value itself, and already exclude options no longer in the template's current
list. At the current real scale (≤501 short option strings, not 1,000+ branch rows) this is cheap
client-side filtering and was judged not to need replacing. Two new RPCs
(`search_runtime_form_template_parent_options_v1`, `get_my_recent_form_template_options_v1`) were
still built and deployed as part of the same additive migration for forward-compatibility if the
option count grows into the thousands, but are **not wired into the primary UI this pass** — the
real, load-bearing gap was the unbounded branch fetch, not the option list.

### Not yet migrated (explicit, known gap — not silently dropped)

- `src/lib/loadCorrectionCustomFields.ts` (Review/correction custom-field loading) still performs
  an unbounded `.in("parent_template_id", selectTemplateIds)` branch fetch.
- `src/pages/ExpenseBatchForm.tsx`'s per-line category case still calls
  `ExpenseService.fetchOptionBranchesForCategory` eagerly per category.
- `src/components/CorrectionCustomFieldsSection.tsx` is unchanged (thin wrapper around
  `CategoryFormFieldsSection`; would need `onSelectOptionValue` threaded through once its data
  source above is fixed).
- `src/lib/expenseCustomFieldFilters.ts` and `src/components/DailyExpenseReportMappingSection.tsx`
  each still run an org-wide unbounded scan for filter-dropdown/reporting UI population.

These were judged too risky to rush in this pass given the sensitivity of Review/live-batch-entry
code, consistent with the conservative scoping used earlier on this same branch. They remain capped
at ~1,000 branch rows until addressed in a follow-up pass.

---

## 4) Key files

```
supabase/migrations/20260820200000_form_template_server_pagination.sql            (prior pass, applied)
supabase/migrations/20260820210000_form_template_option_summary_and_create.sql    (prior pass, applied)
supabase/migrations/20260820220000_form_template_runtime_option_configuration.sql (prior pass, applied)
supabase/migrations/20260821100000_form_template_search_preview_fields.sql        (this pass, applied)
supabase/migrations/20260821110000_form_template_orphan_inspector_and_runtime_search.sql (this pass, applied)
src/lib/formBuilder/categoryServerSearchV2.ts
src/lib/formBuilder/useServerPagedOptionSearch.ts
src/lib/formBuilder/useOptionConfiguration.ts
src/lib/formBuilder/useTemplateEditorSummary.ts
src/components/form-builder/ServerPagedParentOptionsSection.tsx
src/components/form-builder/FormFieldTemplateEditorDialog.tsx
src/components/form-builder/LegacyOrphanGroupsDialog.tsx
src/hooks/useOnDemandOptionBranches.ts
src/components/CategoryFormFieldsSection.tsx
src/components/BatchSharedCategoryFields.tsx
src/pages/ExpenseForm.tsx
```

---

## 5) Database / migrations

All applied live to Production already (SSH + `docker cp` + `psql -f`, DDL/CREATE-OR-REPLACE only —
no DML against real tables). Rollback files exist alongside each. User does not need to re-run
these; they document what was applied:

- `20260820200000_form_template_server_pagination.sql` — search / get-config / atomic save RPCs
- `20260820210000_form_template_option_summary_and_create.sql` — summary + create-option RPCs
- `20260820220000_form_template_runtime_option_configuration.sql` — employee-safe single-option
  config RPC (`get_runtime_form_option_configuration`)
- `20260821100000_form_template_search_preview_fields.sql` — adds `preview_fields` + Project
  ID/Name search matching to `search_form_template_parent_options` (CREATE OR REPLACE, same
  signature; rollback restores the prior body byte-for-byte)
- `20260821110000_form_template_orphan_inspector_and_runtime_search.sql` — adds
  `get_form_template_legacy_orphan_groups`, `search_runtime_form_template_parent_options_v1`,
  `get_my_recent_form_template_options_v1`

The three already-applied `20260820*` files are **not edited** — any correction went into a new
additive, current-timestamp migration, per this repo's rule against rewriting applied migrations.

---

## 6) Test plan

- [x] Admin: opening Parent Options on an existing select template auto-loads page 1 exactly once
      (`FormFieldTemplateEditorDialog.test.tsx`)
- [x] Typing alone issues zero requests; Search/Enter submits exactly one
      (`useServerPagedOptionSearch.test.ts`)
- [x] Page navigation reuses the submitted query, not unsent input
- [x] Stale-response race safety (a slower earlier response cannot overwrite a newer one)
- [x] 501 results / 21 pages / correct `hasNext`/`hasPrevious` at both edges
- [x] Error + retry re-issues the same query/page
- [x] `ParentOptionsTable` renders defensively when `previewFields` is absent on a result (older
      mock/consumer shape)
- [ ] Owner manual QA: admin browse/search/orphan-inspector walkthrough on localhost
- [ ] Owner manual QA: employee expense entry with a real >1,000-branch template
      (`QA-OPT-1050` fixture from the prior pass), confirming selection still resolves config
- [ ] Full Part 26-31 acceptance scenarios (network-shape assertions, recents dedupe/ordering)

Run: `npx vitest run src/components/form-builder src/lib/formBuilder src/pages/ExpenseForm src/pages/ExpenseBatchForm src/components/BatchSharedCategoryFields src/components/CategoryFormFieldsSection src/lib/loadCorrectionCustomFields src/lib/batchExpenseReview src/components/__tests__/ExpenseFormFieldsDisplay.test.tsx` — 219/220 passing; the one failure
(`FormFieldTemplateEditorDialog.test.tsx` Matrix cell editor dedupe test) is confirmed pre-existing
on the unmodified base commit (`ab9ea4a`), unrelated to this work.

`npx tsc --noEmit`, `npx vite build`, `npm run security:secrets`, `npm run migrations:check` all
clean.

---

## 7) Related docs

- [scalable-form-field-template-editor.md](./scalable-form-field-template-editor.md) (DOC-061,
  the original client-paginated editor this branch's server-paged version supersedes)

---

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-08-20 | 1.0 | Agent | Initial registration on `hotfix/form-template-server-pagination`, covering both the prior-pass server-pagination foundation (migrations `20260820200000`-`20260820220000`, already applied) and this pass's admin auto-load UX, preview columns, broadened search, orphan inspector, and the employee on-demand branch-fetch fix (`useOnDemandOptionBranches`, wired into `ExpenseForm.tsx` and `BatchSharedCategoryFields.tsx`). Two new additive migrations applied live. `loadCorrectionCustomFields.ts` and `ExpenseBatchForm.tsx`'s per-line fetch explicitly deferred, not silently dropped. Not merged to `main`. |
