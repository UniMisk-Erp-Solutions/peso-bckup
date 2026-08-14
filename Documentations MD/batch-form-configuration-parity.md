# DOC-036 — Batch Form Configuration Parity

**Last updated:** 2026-07-02  
**Status:** complete (staging RC applied + Batch Review parity + column ordering correction)
**Tests:** 556 total (T1–T45; 15 from Phase 9, 7 from RC fix, 11 from Batch Review parity, 12 from column ordering)

---

## What changed

### Phase 9 (initial)

Phase 9 closes the configuration gap between `ExpenseBatchForm` and `ExpenseForm`. Before this phase, Batch Expense displayed hardcoded English field labels ("Title", "Category", "Purpose", "Amount") even when an admin had configured custom labels (e.g. "Heading" for title) or when the UI language was set to a non-English locale. Single Expense already used `translateBaseFieldConfig` and resolved labels correctly; Batch Expense did not.

No new Supabase queries, services, migrations, Edge Functions, or backend changes were made.

### Staging RC fix (same session, 2026-07-02)

After Phase 9, four additional reproduction paths were found during staging RC review. Even with Phase 9 in place, the correct configured label ("Purpose / Title") could still appear as "Title" in specific Batch UI surfaces. The RC fix closes these remaining gaps. See [Staging RC — Root cause](#staging-rc--root-cause) and [Staging RC — Fixes](#staging-rc--fixes) sections below.

---

## Root cause (Phase 9)

`ExpenseBatchForm.tsx` loaded field config from `organization_expense_form_fields` via `resolveBaseFieldConfig` (which applies DB-stored custom labels), but was **missing** the `translateBaseFieldConfig` layer that:

- Replaces DEFAULT English labels (e.g. "Title") with the active locale translation (e.g. "शीर्षक")
- Preserves custom admin labels (e.g. "Heading") unchanged

Additionally, three UI locations hardcoded English strings instead of reading from `getBaseField()`:
1. `ExpenseBatchForm.tsx` — `placeholder="Title for all expenses"` (step 1 shared title input)
2. `ExpenseBatchForm.tsx` — table headers `Title`, `Category`, `Purpose`, `Amount` in step 3 desktop review table
3. `BatchExpenseLinesTable.tsx` — table headers `Category`, `Title`, `Amount`, `Purpose` and `placeholder="Title"` in the step 2 desktop table

And `expenseBatchValidation.ts` had a Zod constraint `title: z.string().min(1, "Title is required")` that:
- Always required a non-empty title regardless of `is_required` config
- Used a hardcoded English error message regardless of the configured label

---

## Files changed

| File | Change |
|------|--------|
| `src/pages/ExpenseBatchForm.tsx` | Added `useMemo`; imported `translateBaseFieldConfig`; destructured `i18n` from `useTranslation`; added `translatedBaseFields` memo; updated `getBaseField` to use translated config; updated validation calls to pass translated config; fixed placeholder; fixed step-3 review table headers; passed `titleLabel`/`titleRequired`/`amountLabel` to `BatchExpenseLinesTable` |
| `src/components/BatchExpenseLinesTable.tsx` | Added `titleLabel: string`, `titleRequired?: boolean`, `amountLabel: string` props; replaced all four hardcoded `<TableHead>` strings with prop values; fixed `placeholder="Title"` to use `titleLabel` |
| `src/lib/expenseBatchValidation.ts` | Removed `.min(1, "Title is required")` from Zod `lineSchema`; added `titleCfg` config-aware check in `validateBatchLines` loop (matching pattern of category and purpose checks) |
| `src/lib/__tests__/batchFormConfigParity.test.ts` | **New** — 15 tests (T1–T15) covering config resolution, translation, validation parity, and table header/placeholder rendering |

---

## Configuration flow — before vs after

### Before Phase 9

```
DB → resolveBaseFieldConfig → baseFieldConfig → getBaseField()
                                             ↓
                                    (no translate layer)
                                    ExpenseBatchForm displays English only
```

### After Phase 9

```
DB → resolveBaseFieldConfig → baseFieldConfig → translateBaseFieldConfig → translatedBaseFields → getBaseField()
                                                         ↓
                                               Preserves custom labels ("Heading")
                                               Translates DEFAULT labels ("Title" → locale)
                                               Same behaviour as ExpenseForm
```

---

## Behaviour by label type

| Scenario | Before | After |
|----------|--------|-------|
| Admin custom label ("Heading") — any locale | "Heading" ✓ | "Heading" ✓ |
| Admin default label, English locale | "Title" ✓ | "Title" ✓ |
| Admin default label, Hindi locale | "Title" ✗ | "शीर्षक" ✓ |
| `is_required: false`, title empty | Zod error "Title is required" ✗ | Allowed ✓ |
| `is_required: true`, custom label "Heading", title empty | Error: "Title is required" ✗ | Error: "Heading is required" ✓ |

---

## Specific fixes

### 1. `translateBaseFieldConfig` layer added to `ExpenseBatchForm`

```typescript
// imports added
import { useMemo } from "react";
import { translateBaseFieldConfig } from "@/lib/translateBaseFieldConfig";

// i18n instance for language dep
const { t, i18n } = useTranslation(["expenses", "common"]);

// memo mirrors ExpenseForm.tsx pattern exactly
const translatedBaseFields = useMemo(
  () => translateBaseFieldConfig(baseFieldConfig, t),
  [baseFieldConfig, t, i18n.language],
);

const getBaseField = (key: BaseExpenseFieldKey): BaseFieldConfig =>
  translatedBaseFields[key] ||
  translateBaseFieldConfig(DEFAULT_BASE_FIELD_CONFIG, t)[key];
```

Validation calls updated to pass `translatedBaseFields` so error messages also use configured labels:
```typescript
validateBatchSharedContext({ expenseDate, sharedDestination, label: batchLabel }, translatedBaseFields);
validateBatchLines(linesWithTemps(), translatedBaseFields);
```

### 2. Hardcoded placeholder fixed (step 1 shared title)

```tsx
// Before
placeholder="Title for all expenses"

// After
placeholder={getBaseField("title").is_required
  ? `${getBaseField("title").label} *`
  : `${getBaseField("title").label} (same for all expenses)`}
```

### 3. Step-3 review table headers fixed

```tsx
// Before
<TableHead>Title</TableHead>
<TableHead>Category</TableHead>
{getBaseField("purpose").is_visible && <TableHead>Purpose</TableHead>}
<TableHead>Amount</TableHead>

// After
<TableHead>{getBaseField("title").label}</TableHead>
<TableHead>{getBaseField("category").label}</TableHead>
{getBaseField("purpose").is_visible && <TableHead>{getBaseField("purpose").label}</TableHead>}
<TableHead>{getBaseField("amount").label}</TableHead>
```

### 4. `BatchExpenseLinesTable` new props and fixed headers

New props added to the component:
- `titleLabel: string` — configured label for the Title field
- `titleRequired?: boolean` — used in placeholder
- `amountLabel: string` — configured label for the Amount field

```tsx
// Before
{showCategory && <TableHead className="min-w-[180px]">Category</TableHead>}
{sharedTitle === undefined && <TableHead className="min-w-[120px]">Title</TableHead>}
<TableHead className="min-w-[100px]">Amount</TableHead>
{showPurpose && <TableHead className="min-w-[160px]">Purpose</TableHead>}
// ...
placeholder="Title"

// After
{showCategory && <TableHead className="min-w-[180px]">{categoryLabel}</TableHead>}
{sharedTitle === undefined && <TableHead className="min-w-[120px]">{titleLabel}</TableHead>}
<TableHead className="min-w-[100px]">{amountLabel}</TableHead>
{showPurpose && <TableHead className="min-w-[160px]">{purposeLabel}</TableHead>}
// ...
placeholder={titleRequired ? `${titleLabel} *` : titleLabel}
```

### 5. Zod schema and `validateBatchLines` fixed

```typescript
// Before — always required, hardcoded message
const lineSchema = z.object({
  title: z.string().min(1, "Title is required"),
  ...
});

// After — no min constraint in Zod; manual config-aware check added
const lineSchema = z.object({
  title: z.string(),
  ...
});

// In validateBatchLines loop (same pattern as category/purpose):
const titleCfg = baseFields?.title;
const titleRequired = titleCfg?.is_visible !== false && titleCfg?.is_required === true;
// ...
if (titleRequired && !String(lines[i].title || "").trim()) {
  return { ok: false, message: `Line ${i + 1}: ${titleCfg?.label || "Title"} is required` };
}
```

---

## Staging RC — Root cause

Four additional gaps found after Phase 9. Any of these could cause the user to see default labels ("Title") instead of the configured label ("Purpose / Title"):

### RC-1: Timing race (primary)

`baseFieldConfig` state is initialized to `DEFAULT_BASE_FIELD_CONFIG`. The existing loading guard:

```typescript
if (canSubmitLoading || batchEntryLoading) { return <Loading /> }
```

allows form render to proceed as soon as `canSubmitLoading` and `batchEntryLoading` resolve — but the async `init()` function that fetches org config from `organization_expense_form_fields` is still in flight. This creates a window (200–500ms+) where the form renders with English defaults before the DB config is applied.

**Fix:** Added `baseFieldConfigLoaded` boolean state (starts `false`). Set to `true` in the `finally` block of `init()` so it fires whether the fetch succeeded, errored, or was skipped (`!organizationId || !user?.id`). Updated loading guard:

```typescript
if (canSubmitLoading || batchEntryLoading || !baseFieldConfigLoaded) {
  return <div className="py-12 text-center text-muted-foreground">{t("batch.loadingForm")}</div>;
}
```

### RC-2: Purpose placeholder hardcoded in per-line card view

In the mobile/cards per-line view (`ExpenseBatchForm.tsx` ~line 924), the purpose field had:

```tsx
placeholder="What was this expense for?"
```

This English-only string bypassed all config resolution.

**Fix:**

```tsx
placeholder={purposeRequired ? `${getBaseField("purpose").label} *` : getBaseField("purpose").label}
```

### RC-3: Missing `placeholder` prop on `BaseExpenseFieldInput` in `BatchExpenseLinesTable`

`BaseExpenseFieldInput` uses the `placeholder` prop when rendering non-default input types (`input_type="text"`, `"number"`, or `"dropdown"` with `featureEnabled=true`). Three fields in `BatchExpenseLinesTable` lacked this prop, so non-default input types would show `undefined` as placeholder.

**Fix:** Added `placeholder` prop to all three:
- Title: `placeholder={titleRequired ? \`${titleLabel} *\` : titleLabel}`
- Purpose: `placeholder={purposeRequired ? \`${purposeLabel} *\` : purposeLabel}`
- Destination: `placeholder={destinationLabel}`

Also added `placeholder={destinationLabel}` to the destination `defaultControl` `<Input>` which was missing it.

### RC-4: Untranslated `baseFieldConfig` passed to `BatchExpenseLinesTable`

The `baseFieldConfig` prop on `BatchExpenseLinesTable` feeds `fieldConfig(key)` which is used as `config` for `BaseExpenseFieldInput`. The `config` object carries `label`, `input_type`, and `options`. The table was receiving untranslated `baseFieldConfig`, so even when custom-field feature is enabled, the config label was the raw DB value — not the translated version.

**Fix:** Changed the prop from `baseFieldConfig={baseFieldConfig}` to `baseFieldConfig={translatedBaseFields}` so the table always receives the fully-resolved, translated config.

---

## Staging RC — Fixes

### Files changed (RC additions, beyond Phase 9)

| File | RC change |
|------|-----------|
| `src/pages/ExpenseBatchForm.tsx` | Added `baseFieldConfigLoaded` state; wrapped `init()` body in `try/finally`; updated loading guard to `|| !baseFieldConfigLoaded`; fixed per-line card purpose placeholder; changed `baseFieldConfig={baseFieldConfig}` → `baseFieldConfig={translatedBaseFields}` |
| `src/components/BatchExpenseLinesTable.tsx` | Added `placeholder` prop to title, purpose, destination `BaseExpenseFieldInput` calls; added `placeholder={destinationLabel}` to destination `defaultControl` `<Input>` |
| `src/lib/__tests__/batchFormConfigParity.test.ts` | Added T16–T22 (7 new tests) |

### Configuration flow — after RC fix

```
DB → resolveBaseFieldConfig → baseFieldConfig ──────────────────────────────┐
                                                                              │
                             translateBaseFieldConfig → translatedBaseFields  │
                                      │                          │            │
                                 Preserves custom labels         │            │
                                 Translates DEFAULT labels       │            │
                                                                 ▼            ▼
                                                         getBaseField()   BatchExpenseLinesTable
                                                         (renders label)  .baseFieldConfig prop
                                                                          (input type/options)
```

`baseFieldConfigLoaded` gates form render: the form does not mount until `init()` resolves, so default-label flash is eliminated.

### Batch UI surface coverage (all surfaces verified)

| Surface | Desktop | Mobile | Fixed |
|---------|---------|--------|-------|
| Step 1 shared title placeholder | `getBaseField("title").label` | same | Phase 9 |
| Step 2 table column headers (Category, Title, Amount, Purpose) | props from parent | — | Phase 9 |
| Step 2 table title `defaultControl` Input placeholder | `titleLabel` | — | Phase 9 |
| Step 2 table purpose `defaultControl` Textarea placeholder | `purposeLabel` | — | Phase 9 |
| Step 2 table destination `defaultControl` Input placeholder | `destinationLabel` | — | **RC** |
| Step 2 table title `BaseExpenseFieldInput` placeholder prop | `titleLabel` | — | **RC** |
| Step 2 table purpose `BaseExpenseFieldInput` placeholder prop | `purposeLabel` | — | **RC** |
| Step 2 table destination `BaseExpenseFieldInput` placeholder prop | `destinationLabel` | — | **RC** |
| Step 2 per-line card purpose placeholder (mobile + card mode) | `getBaseField("purpose").label` | same | **RC** |
| Step 3 review table headers (Title, Category, Purpose, Amount) | `getBaseField("*").label` | — | Phase 9 |
| Config loading guard (no default-label flash) | `baseFieldConfigLoaded` gate | same | **RC** |
| `BatchExpenseLinesTable` config object (input type, options) | `translatedBaseFields` | — | **RC** |
| Validation error messages | `translatedBaseFields` | same | Phase 9 |

`MobileBatchLineCard` — intentionally NOT touched. That component is in the **reviewer** flow and displays the stored `expense.title` value from the DB, not a field label. No label rendering involved.

---

## Tests added (Phase 9 — T1–T15, RC — T16–T22)

All in `src/lib/__tests__/batchFormConfigParity.test.ts`.

| Test | Phase | Description |
|------|-------|-------------|
| T1 | 9 | `resolveBaseFieldConfig` merges custom label "Heading" from DB row |
| T2 | 9 | `translateBaseFieldConfig` replaces DEFAULT "Title" with locale t() result |
| T3 | 9 | `translateBaseFieldConfig` preserves custom "Heading" unchanged |
| T4 | 9 | `validateBatchLines`: empty title allowed when `is_required=false` |
| T5 | 9 | `validateBatchLines`: empty title blocked when `is_required=true` |
| T6 | 9 | `validateBatchLines`: error message shows configured label "Heading" not "Title" |
| T7 | 9 | `validateBatchLines`: no hardcoded "Title is required" when title is optional |
| T8 | 9 | `BatchExpenseLinesTable`: `titleLabel` prop shown as column header |
| T9 | 9 | `BatchExpenseLinesTable`: `categoryLabel` prop shown as column header |
| T10 | 9 | `BatchExpenseLinesTable`: `purposeLabel` prop shown as column header |
| T11 | 9 | `BatchExpenseLinesTable`: `amountLabel` prop shown as column header |
| T12 | 9 | `BatchExpenseLinesTable`: placeholder equals `titleLabel` when not required |
| T13 | 9 | `BatchExpenseLinesTable`: placeholder appends `*` when `titleRequired=true` |
| T14 | 9 | `validateBatchLines`: category error uses configured label "Expense Type" |
| T15 | 9 | `validateBatchLines`: purpose error uses configured label "Business Reason" |
| T16 | RC | `resolveBaseFieldConfig` + `translateBaseFieldConfig`: "Purpose / Title" flows end-to-end |
| T17 | RC | `validateBatchLines`: error is "Line N: Purpose / Title is required" (not bare Zod string) |
| T18 | RC | `BatchExpenseLinesTable`: purpose placeholder uses `purposeLabel` |
| T19 | RC | `BatchExpenseLinesTable`: destination placeholder uses `destinationLabel` |
| T20 | RC | `BatchExpenseLinesTable`: default config renders "Title" column header correctly |
| T21 | RC | `BatchExpenseLinesTable`: destination column header uses `destinationLabel` |
| T22 | RC | `resolveBaseFieldConfig`: canonical `field_key` is `"title"`, never renamed after custom label applied |

**Test notes:**
- T17 assertion uses `.toMatch(/^Line \d+:/)` rather than `.not.toContain("Title is required")` — the latter fails when the configured label is "Purpose / Title" because the substring "Title is required" appears inside "Purpose / Title is required".

---

## Automated verification results

| Check | Result |
|-------|--------|
| `npx tsc --noEmit` | **CLEAN** — no errors |
| `npm test -- --run` | **533 tests, all passing** (T1–T22 in batchFormConfigParity.test.ts) |
| `npm run build` | **CLEAN** — no errors (chunk size warnings are pre-existing) |
| `npm run migrations:check` | Not re-run (no schema changes) |
| `git diff --check` | CRLF warnings only (Windows-normalized, no whitespace errors) |
| Branch | `staging/mobile-rc` |

---

## What was NOT changed

- No new Supabase queries, DB migrations, or Edge Functions
- No changes to `ExpenseService`, `BatchExpenseReview`, or receipt/attachment flows
- `MobileBatchLineCard` (batch review, not submission) — untouched per spec
- `BatchSharedCategoryFields` — already correct for custom fields
- `BatchLineFormFields` — renders per-line custom fields, already correct
- `resolveBaseFieldConfig` — no changes to the resolution function itself
- Draft and edit mode: `getBaseField` is the single source of truth for all steps, so draft restore and edit mode automatically use the same configured labels

---

## Architecture notes

- The `translatedBaseFields` memo in `ExpenseBatchForm` re-computes whenever `baseFieldConfig`, `t`, or `i18n.language` change — matching the exact pattern in `ExpenseForm.tsx`.
- `translatedBaseFields` is passed to both `validateBatchSharedContext` and `validateBatchLines` so validation error messages use the same configured label as the UI labels.
- The `translateBaseFieldConfig` function only replaces labels when they equal the English default (`DEFAULT_BASE_FIELD_CONFIG[key].label`). Admin-set custom labels are preserved verbatim — this is the same guard used by `ExpenseForm`.
- `BatchExpenseLinesTable` receives `titleLabel`, `titleRequired`, and `amountLabel` as explicit props (same pattern as the existing `categoryLabel`, `purposeLabel`, `destinationLabel` props) rather than the full `baseFieldConfig` object, keeping the component interface stable and testable.

---

## Batch Review parity correction (2026-07-02)

### Problem

The previous fixes (Phase 9 + RC) only corrected the **Batch Entry** screens (`ExpenseBatchForm`, `BatchExpenseLinesTable`). The **Batch Review** screen — "Consolidated Expenses" (`BatchExpenseReviewPanel`) — was still broken: it received `organizationId` but never loaded `organization_expense_form_fields`. All labels were locked to English i18n keys.

**Affected surfaces (before this fix):**
- Desktop "Consolidated Expenses" table — column headers hard-coded via `t("batchReview.tableTitle")` → "Title", `t("batchReview.tablePurpose")` → "Purpose", etc.
- Desktop reviewer correction dialog — labels "Title", "Destination", "Purpose", "Category", "Total amount" hardcoded
- Desktop selected-line detail card (`BatchExpenseDetailCard`) — "Amount", "Destination", "Category", "Purpose" via `t()` keys
- Mobile line detail + correction form (`MobileBatchLineDetail`) — same hardcoded English strings

**Not affected:** "From location" / "To location" columns. These are org-specific custom form field columns returned by `fetchBatchExpenseCustomFields` as `customFieldColumns`. They are NOT canonical base fields and were already rendered correctly. They were not touched.

**Not affected:** `MobileBatchLineCard` (shows stored values `expense.title`, `expense.category`, `expense.total_amount` — no field labels). Not touched per spec.

### Root cause

`BatchExpenseReviewPanel.tsx` was entirely missing the `resolveBaseFieldConfig` + `translateBaseFieldConfig` chain. It imported `organizationId` but never used it to fetch org field config. The component also only destructured `{ t }` from `useTranslation` — it was missing `i18n` needed for the language dependency in the memo.

### Fix architecture

The same resolution chain already used by Single Expense and (after Phase 9) Batch Entry is now used by Batch Review:

```
saved organisation config
  → organization_expense_form_fields (fetched inside loadBatch, parallel with batch header fetch)
  → resolveBaseFieldConfig(fields)
  → baseFieldConfig state
  → translateBaseFieldConfig(baseFieldConfig, t)  [memo, deps: baseFieldConfig, t, i18n.language]
  → translatedBaseFields
  → getBaseField(key).label
  → BatchExpenseReviewPanel (desktop table headers + correction dialog)
  → BatchExpenseDetailCard (label props)
  → MobileBatchLineDetail (label props + passes through to BatchExpenseDetailCard)
```

`organization_expense_form_fields` fetch is added to the existing `Promise.all` inside `loadBatch`. The existing `loading` state already gates all rendering until `loadBatch` resolves, so no new `baseFieldConfigLoaded` state was needed.

### Files changed

| File | Change |
|------|--------|
| `src/components/BatchExpenseReviewPanel.tsx` | Added imports for `resolveBaseFieldConfig`, `DEFAULT_BASE_FIELD_CONFIG`, `BaseExpenseFieldKey`, `BaseFieldConfig`, `translateBaseFieldConfig`; destructured `i18n` from `useTranslation`; added `baseFieldConfig` state + `translatedBaseFields` memo + `getBaseField` helper; added org fields fetch inside `loadBatch` Promise.all; fixed 4 table headers; fixed 5 correction dialog labels; passed 4 label props to `BatchExpenseDetailCard`; passed 5 label props to `MobileBatchLineDetail` |
| `src/components/BatchExpenseDetailCard.tsx` | Added optional props `categoryLabel?`, `purposeLabel?`, `amountLabel?`, `destinationLabel?`; replaced 4 `t()` label calls with prop values (fallback to `t()`) |
| `src/components/mobile/MobileBatchLineDetail.tsx` | Added optional props `titleLabel?`, `destinationLabel?`, `purposeLabel?`, `categoryLabel?`, `amountLabel?`; replaced 5 hardcoded correction form labels; passed 4 label props through to `BatchExpenseDetailCard` |
| `src/components/__tests__/batchReviewConfigParity.test.tsx` | **New** — 11 tests T23–T33 |

### Batch Review surface coverage

| Surface | Desktop | Mobile | Fixed |
|---------|---------|--------|-------|
| "Consolidated Expenses" table headers (Title, Category, Purpose, Amount) | `getBaseField("*").label` | — | This fix |
| Reviewer correction dialog labels (Title, Destination, Purpose, Category, Amount) | `getBaseField("*").label` | — | This fix |
| Selected-line detail card (Amount, Destination, Category, Purpose) | prop from panel | — | This fix |
| Mobile line detail + correction form (Title, Destination, Purpose, Category, Amount) | — | prop from panel | This fix |
| Mobile detail card inside `MobileBatchLineDetail` | — | prop threaded through | This fix |
| "From location" / "To location" custom columns | `customFieldColumns` (untouched) | — | Already correct |
| `MobileBatchLineCard` stored values (title, category, amount) | — | untouched | N/A (not labels) |

### Tests added (T23–T33)

All in `src/components/__tests__/batchReviewConfigParity.test.tsx`.

| Test | Description |
|------|-------------|
| T23 | `resolveBaseFieldConfig` + `translateBaseFieldConfig`: "Purpose / Title" flows end-to-end |
| T24 | `resolveBaseFieldConfig` + `translateBaseFieldConfig`: "Remark" for purpose flows end-to-end |
| T25 | Default config produces non-null labels for all base fields |
| T26 | `BatchExpenseDetailCard`: `categoryLabel` prop replaces hardcoded "Category" |
| T27 | `BatchExpenseDetailCard`: `purposeLabel` prop replaces hardcoded "Purpose" |
| T28 | `BatchExpenseDetailCard`: `amountLabel` prop replaces hardcoded "Amount" |
| T29 | `BatchExpenseDetailCard`: `destinationLabel` prop replaces hardcoded "Destination" |
| T30 | `MobileBatchLineDetail`: `titleLabel` prop used in correction form label |
| T31 | `MobileBatchLineDetail`: `purposeLabel` prop used in correction form label |
| T32 | `MobileBatchLineDetail`: `categoryLabel` passed through to `BatchExpenseDetailCard` |
| T33 | canonical `field_key` values never renamed by resolve+translate chain |

### Verification results

| Check | Result |
|-------|--------|
| `npx tsc --noEmit` | **CLEAN** — no errors |
| `npm test -- --run` | **544 tests, all passing** (T23–T33 in batchReviewConfigParity.test.tsx) |
| `npm run build` | **CLEAN** — no errors |
| `npm run migrations:check` | Clean (no schema changes) |
| `git diff --check` | CRLF warnings only (Windows, not whitespace errors) |
| Branch | `staging/mobile-rc` |

### What was NOT changed

- No new Supabase queries beyond the one added to `loadBatch`
- No new services, migrations, Edge Functions, or RLS rules
- No changes to `ExpenseForm`, `ExpenseBatchForm`, `BatchExpenseLinesTable`, or Batch Entry flow
- No changes to `BatchExpenseReview.tsx` (page controller — passes `organizationId` down, no config work needed there)
- `MobileBatchReviewView` — shows aggregate stats (Total, Lines, Pending), not base-field labels — not touched
- `fetchBatchExpenseCustomFields` / `customFieldColumns` — already correct for org custom fields — not touched
- `resolveBaseFieldConfig`, `translateBaseFieldConfig` — resolver functions unchanged

---

## Batch Review custom-field ordering correction (2026-07-02)

### Problem

The "Consolidated Expenses" table in Batch Review displayed custom field columns in **alphabetical order** instead of the configured order. For a batch with project-tracking and route fields, the broken order was:

```
From location | Project ID | Project Name | Project Unique ID | To location
```

The correct order, matching admin-configured field order and parent/dependent field relationships:

```
Project Unique ID | Project ID | Project Name | From location | To location
```

### Root cause

`fetchBatchExpenseCustomFields` in `src/lib/batchExpenseReview.ts` collected all column labels into a `Set<string>` then sorted them alphabetically:

```typescript
// Lines 79–81 (before fix) — alphabetical sort, ignores configured order
const columns = [...columnSet].sort((a, b) =>
  a.localeCompare(b, undefined, { sensitivity: "base" }),
);
```

This discarded all configured order (`expense_category_form_fields.display_order`) and all parent/dependent relationships (`expense_form_field_option_branches.parent_template_id`). Alphabetically: "F" (From location) < "P" (Project fields) < "T" (To location) — exactly the wrong order.

### Fix strategy

The fix uses **stable structural metadata only** — never label strings, never hardcoded field names:

- **Parent/dependent identification**: a template is a "parent group" if its `id` appears as `parent_template_id` in any fetched branch row. All other templates are "leaf" templates (typically location/route fields). No field_key matching needed.
- **Column ordering**: parent groups sorted by `expense_category_form_fields.display_order` (admin-configured order), then their dependent branches sorted by `expense_form_field_option_branches.display_order`, then leaf templates sorted by their configured display_order.
- **Deduplication of display_order**: a template can appear in multiple category assignments; the minimum display_order across all categories for the org is used.

### Algorithm (`orderBatchCustomFieldColumns`)

```
1. Build min-display_order map from expense_category_form_fields
2. Identify parent templates: template_ids referenced as parent_template_id in any branch
3. Group branches by parent_template_id; sort each group by branch.display_order asc
4. Separate templates into: parent group templates | leaf (location) templates
5. Sort parent group templates by configured display_order
6. Sort leaf templates by configured display_order
7. Output:
   - For each parent template (in display_order): [parent label] [branch labels in branch.display_order]
   - For each leaf template (in display_order): [leaf label]
   - Fallback: any label in columnSet not yet placed (orphan branches)
```

### Files changed

| File | Change |
|------|--------|
| `src/lib/batchExpenseReview.ts` | Added `OrderColumnsInput` type; added exported `orderBatchCustomFieldColumns` pure helper; expanded template fetch to `id, name, field_key`; expanded branch fetch to `id, name, display_order, parent_template_id`; added third parallel fetch for `expense_category_form_fields(template_id, display_order)` filtered by org; replaced alphabetical sort with `orderBatchCustomFieldColumns` call |
| `src/lib/__tests__/batchReviewColumnOrder.test.ts` | **New** — 12 tests T34–T45 |

### No panel changes required

`BatchExpenseReviewPanel.tsx` already uses `cfResult.columns` for both table headers and row cells. Since `cfResult.columns` is now the ordered array from `orderBatchCustomFieldColumns`, both surfaces automatically use the correct order — no panel code changes needed.

### Tests added (T34–T45)

All in `src/lib/__tests__/batchReviewColumnOrder.test.ts`. Tests operate on `orderBatchCustomFieldColumns` directly — no Supabase mock needed (pure function).

| Test | Description |
|------|-------------|
| T34 | "Project Unique ID" index < "Project ID" index |
| T35 | "Project ID" index < "Project Name" index |
| T36 | All three project fields precede "From location" |
| T37 | "From location" precedes "To location" |
| T38 | Calling the function twice with the same inputs produces identical arrays (stable/idempotent) |
| T39 | Parent template always precedes all its branch children |
| T40 | Two independent parent groups preserve configured display_order relative to each other |
| T41 | Empty columnSet returns `[]` (no phantom columns when no expenses have custom values) |
| T42 | Single location template yields one column; the absent location does not appear |
| T43 | Labels come from DB row `.name` — renaming a template is reflected without code change |
| T44 | `orderBatchCustomFieldColumns` is a synchronous pure function callable from mobile context |
| T45 | Return value is not a Promise — no async/DB behaviour introduced by the helper |

### Verification results

| Check | Result |
|-------|--------|
| `npx tsc --noEmit` | **CLEAN** — no errors |
| `npm test -- --run` | **556 tests, all passing** (T34–T45 in batchReviewColumnOrder.test.ts) |
| `npm run build` | **CLEAN** — built in 18 s (chunk size warnings are pre-existing) |
| Branch | `staging/mobile-rc` |

### What was NOT changed

- No new DB migrations or Edge Functions
- No new services or RLS rules
- `BatchExpenseReviewPanel.tsx` — no changes (uses `cfResult.columns` which is now ordered)
- `MobileBatchLineDetail.tsx` / `BatchExpenseDetailCard.tsx` — custom field display uses `ExpenseFormFieldsDisplay`, not `customFieldColumns`, so ordering there is unaffected
- `resolveBaseFieldConfig`, `translateBaseFieldConfig` — resolver functions unchanged
- Batch Entry flow — not touched
- `field_key` values — not used for ordering logic (structural parent/child detection is used instead)
