# DOC-062 — Reusable Sub-field Sets and Grouped Expense Field Display

**Status:** complete
**Branch:** `feature/user-activity-insights`
**Last updated:** 2026-07-15
**Files created / modified:**
- `supabase/migrations/290715_1000_reusable_subfield_sets_and_additional_info_layout.sql` (new — SQL created, NOT applied)
- `docs/sql/form-builder-presets/00_verify_reusable_subfield_sets.sql` (new — read-only verification)
- `docs/sql/additional-information-layout/00_verify_layout_configuration.sql` (new — read-only verification)
- `src/lib/formBuilder/subFieldPresets.ts` (new — pure preset helpers)
- `src/lib/formBuilder/__tests__/subFieldPresets.test.ts` (new — 38 tests)
- `src/lib/expenseFieldDisplayModel.ts` (extended — hierarchy types + buildExpenseFieldDisplayGroups)
- `src/lib/__tests__/expenseFieldDisplayModel.test.ts` (new — 10 tests)
- `src/components/form-builder/FormFieldTemplateEditorDialog.tsx` (extended — Phase 2 preset toolbar + Phase 3 matrix editor)
- `src/lib/fetchExpenseFormFieldDisplay.ts` (extended — hierarchy fetch + grouped entry point)
- `src/components/AdditionalInfoLayoutSection.tsx` (new — Phase 5 layout settings card)
- `src/pages/Settings.tsx` (extended — Phase 5 section added)
- `src/components/mobile/MobileSettingsView.tsx` (extended — Phase 5 section added)
- `src/components/ExpenseFormFieldsDisplay.tsx` (updated — grouped rendering)
- `src/components/__tests__/ExpenseFormFieldsDisplay.test.tsx` (updated — 17 tests migrated)

---

## Problem

With 400+ parent options and the "Project Unique ID" pattern, admins must manually create the same two dependent fields (Project ID + Project Name) for every single option — 836 field cards with no way to define the structure once and reuse it.

Additionally, the `ExpenseFormFieldsDisplay` rendered submitted dependent fields in a flat alphabetical list with no indication that "Project ID" and "Project Name" belong under "Project Unique ID: 202606M250". Reviewers had to mentally correlate them.

---

## Phase 1 — Reusable Sub-field Sets (DB + pure helpers)

### Database schema

Two new tables (migration created, not yet applied):

**`expense_form_field_branch_presets`**
```sql
- id uuid PRIMARY KEY
- organization_id  → organizations (RLS scoped)
- parent_template_id → expense_form_field_templates
- name text (unique per org+template, case-insensitive)
- description text?
- schema_version integer DEFAULT 1
- field_schema jsonb DEFAULT '[]'  (serialized ReusableSubFieldDefinition[])
- is_default boolean DEFAULT false
- enforce_on_all_parent_options boolean DEFAULT false
- created_by / updated_by → auth.users
- Partial unique index: only one default preset per (organization_id, parent_template_id)
- RLS: admins ALL, members SELECT
```

**`organization_expense_field_layout_items`**
```sql
- id uuid PRIMARY KEY
- organization_id
- context: 'review' | 'detail'
- parent_template_id uuid?  (null = base field layout)
- field_path text  ('template' | 'project_id' | 'project_id>site_name')
- display_order integer
- is_visible boolean DEFAULT true
- display_style: 'standard' | 'compact' | 'inline'
- RLS: admins ALL, members SELECT
```

The RPC `save_option_branch_configuration_atomically` gains a **step 6b**: after the existing hardcoded UUID integrity check (step 6), it runs a generic preset-completeness check for any preset with `enforce_on_all_parent_options = true`. If a parent option is missing required field_keys, the RPC raises `SQLSTATE P0003` with message `preset_integrity: ...`. The dialog already catches `preset_integrity:` in its error handler.

### Pure helper library (`subFieldPresets.ts`)

No React or Supabase imports — fully unit-testable.

**Types:**

| Type | Purpose |
|---|---|
| `ReusableSubFieldDefinition` | One field in a preset schema (may have `children[]` for nesting) |
| `ReusableSubFieldSet` | A saved preset row with metadata + `fieldSchema` |
| `PresetSummary` | Lightweight summary for toolbar lists |
| `ApplyPresetMode` | `"merge"` \| `"sync"` \| `"replace"` |
| `PresetConflict` | `type_mismatch` \| `name_mismatch` conflict for the preview dialog |
| `ApplyPresetResult` | `{ drafts, appliedTo, skipped }` |
| `MatrixCell / MatrixRow` | Data structure for the Phase 3 matrix view |
| `FieldLayoutContext` | `"review"` \| `"detail"` for additional-info layout |
| `FieldLayoutItem` | One row in `organization_expense_field_layout_items` |
| `LayoutGroup` | UI grouping of layout items per template |

**Key functions:**

| Function | Description |
|---|---|
| `countPresetFields(schema)` | Recursive field count including children |
| `validatePresetSchema(schema)` | Blank names, missing/duplicate field_keys |
| `normalizePresetFieldKeys(schema)` | Slugify blank field_keys from name |
| `buildPresetFromParentOption(rootDrafts, allDrafts, includeOptions?)` | Extract structure of one option's branches as a preset schema; strips DB IDs and parent option values; optionally includes dropdown choices |
| `clonePresetForParentOption(schema, parentOptionValue)` | Clone schema to `DraftOptionBranch[]` with new localIds, dbId=null |
| `mergePresetIntoParentOption(existing, schema, option)` | Add missing field_keys only; preserves per-option choices and custom fields |
| `syncPresetIntoParentOption(existing, schema, option)` | Update name/type/required/order from preset; preserve choices; add missing |
| `replaceParentOptionWithPreset(existing, schema, option)` | BFS-remove all root+descendants for option, then clone preset in |
| `applyPresetToParentOptions(allDrafts, schema, targets, mode)` | Multi-option bulk apply; returns `ApplyPresetResult` |
| `getUnconfiguredOptions(allOptions, allDrafts)` | Options with no named root branches |
| `applyDefaultPresetToNewOptions(existing, newOptions, allDrafts, schema)` | Auto-apply default preset to genuinely new options |
| `findPresetConflicts(existing, schema, option)` | Detect type_mismatch and name_mismatch before applying |
| `serializePresetSchema / deserializePresetSchema` | DB jsonb ↔ typed array roundtrip |
| `buildPresetMatrix(options, schemaColumns, allDrafts)` | `MatrixRow[]` for the Phase 3 grid UI |

**Tests:** 38 passing in `subFieldPresets.test.ts`

---

## Phase 2 — Preset Management Toolbar

Added to the Dependent Fields tab right-pane header in `FormFieldTemplateEditorDialog`.

### Preset load on dialog open
When a template is opened, the dialog tries to load `expense_form_field_branch_presets` from the DB. If the table doesn't exist (migration pending), `presetDbAvailable` is set to `false` — the toolbar degrades gracefully with a user-facing message instead of crashing.

### PresetToolbar
Two buttons appear in the right-pane header alongside the field count:
- **Save as set** (disabled until at least one named root field exists)
- **Apply set** (shows badge with saved-preset count)

### SavePresetForm (Popover)
Compact form with three inputs:
- Set name (required)
- Description (optional)
- "Include dropdown choices" toggle — when off (default), only structure is saved; when on, per-option choices are copied to options that don't already have their own.

Calls `buildPresetFromParentOption` → Supabase `INSERT` on save.

### ApplyPresetPanel (Popover)
- **Preset selector** — dropdown of saved presets with field count
- **Apply to** — "Current option only" | "Unconfigured options (N)" | "All options (N)"
- **When fields already exist** — merge / sync / replace with per-mode description

All three apply modes use the pure helpers from `subFieldPresets.ts` — no additional DB calls at apply time.

---

## Phase 4 — Grouped Expense Field Display

### Hierarchy fields on fetch rows

`ExpenseFormFieldDisplayRow` extended with:
- `templateId?: string | null`
- `branchId?: string | null`
- `parentTemplateId?: string | null` (from `expense_form_field_option_branches.parent_template_id`)
- `parentBranchId?: string | null`
- `fieldKey?: string | null`

`BRANCH_SELECT_ATTEMPTS` now tries `parent_template_id, parent_branch_id` first, falling back gracefully to columns without them.

### fetchExpenseFormFieldDisplayGrouped

New entry point that calls `fetchExpenseFormFieldDisplaySafe` and then passes the result through `buildExpenseFieldDisplayGroups`. Returns:
```ts
{ ok: true; nodes: ExpenseFormFieldDisplayNode[] }
| { ok: false; error: FieldDisplayError }
```

### buildExpenseFieldDisplayGroups (pure function)

Algorithm:
1. Separate branch rows (source=branch AND parentTemplateId set) from non-branch rows.
2. Index branches by `parentTemplateId`.
3. For each non-branch field: if its `templateId` has branch children → emit a `{ kind: "group" }` node. Otherwise emit `{ kind: "field" }`.
4. Sort all nodes by `displayOrder` ASC.
5. Within a group, sort children by `depth ASC → displayOrder ASC → label.localeCompare`.

### ExpenseFormFieldsDisplay

Updated to call `fetchExpenseFormFieldDisplayGrouped` and render:
```
Project Unique ID: 202606M250       ← parent template field (group label + value)
  Project ID: 17451                 ← branch child, indented (pl-4)
  Project Name: Polycab India…      ← branch child, indented
From location: Kalsar               ← standalone field node
To location: Kalsar                 ← standalone field node
```

Group nodes render the parent label+value, then each child with `pl-4` indentation. Standalone nodes render as before.

**Tests:** 10 pure-function tests in `expenseFieldDisplayModel.test.ts`; 17 existing component tests migrated to the new mock interface.

---

## Phase 3 — Matrix Editor

Added to `FormFieldTemplateEditorDialog.tsx` alongside the existing list view.

### View toggle

A **List / Matrix** toggle appears in the right-pane header whenever `allOptions.length > 0` and the branch load succeeded. Switching to Matrix resets `matrixSelectedOptions`; changing the preset selector resets `matrixPage` and `matrixSelectedOptions`.

### MatrixCellEditor (Popover)

Inline component that wraps any cell trigger. On open it shows:
- Field name (read-only)
- For `select` / `checkbox_group` / `radio` types: a Textarea accepting one choice per line
- For other types: a note that no choices are required
- Cancel + Save buttons — Save calls `onSave(lines)` which upserts `branchDrafts`

### MatrixEditorPanel

Full-width panel rendered when `dependentViewMode === "matrix"`:

**Toolbar row:**
- Preset selector (columns defined by the chosen preset's schema)
- "Apply preset to selected (N)" button — visible when at least one row is checked; calls `applyPresetToParentOptions(branchDrafts, schema, targets, "merge")`
- Prev / Next pagination (page size `MATRIX_PAGE_SIZE = 20`)

**Table structure:**
- Sticky first two columns: checkbox + option name
- Sticky header row: checkbox-all + "Option" + field names (required fields show `*`)
- Cell icons: ✓ green (complete), ⚠ amber (draft but no choices), ✗ muted (not configured)
- Clicking any cell opens `MatrixCellEditor` popover
- Row checked state drives multi-select bulk-apply

**State flow:**  
`handleCellSave(parentOptionValue, fieldKey, options)` finds the existing root draft for that option+field and updates its `options[]`, or creates a new `DraftOptionBranch` if none exists. No DB call — purely in-memory until the dialog's top-level Save.

## Phase 5 — Additional Information Layout Settings

New `AdditionalInfoLayoutSection` component added to both desktop Settings and MobileSettingsView.

### Component: `src/components/AdditionalInfoLayoutSection.tsx`

Self-contained card component — not a Settings.tsx function — to keep the settings page from growing further.

**Load flow:**
1. `fetchTemplates` — loads `expense_form_field_templates` for the org (ordered by name)
2. `fetchLayoutItemsForTemplates` — tries `organization_expense_field_layout_items`; if the table is absent (`42P01`/`PGRST116`) sets `tableAvailable = false` and degrades gracefully (default order/visibility shown, Save button disabled with amber notice in description)
3. `buildLayoutState` — merges saved DB items with template list; missing entries get `displayOrder = (i+1)*10` and `isVisible = true`

**UI:**
- `Tabs` with two tabs: **Review view** and **Detail page**
- Each tab: `ContextLayoutList` — a bordered list with:
  - Row number (1, 2, 3…)
  - Template name + field_type badge
  - Visibility `Switch` (grays out the row when hidden)
  - Up / Down arrow buttons (first/last disabled)
- **Save button** per tab — calls `handleSave(context)` which upserts all entries for that context

**Save flow:**
- Builds upsert rows: `{ organization_id, context, parent_template_id, field_path: "template", display_order, is_visible, display_style: "standard" }`
- `onConflict: "organization_id,context,parent_template_id,field_path"`
- Uses `useOperationProgress` → `AsyncOperationProgress` for visual feedback
- Toast on success/failure

**Wired into:**
- `src/pages/Settings.tsx` — after the "Expense Detail View — Field Order" card, inside the admin block
- `src/components/mobile/MobileSettingsView.tsx` — same position, with `compact` prop

## Phase 6 — EN/HI/GU i18n Translations

### New translation keys

**`src/locales/{en,hi,gu}/admin.json`** — `"admin"` namespace:
- `presets.saveAsSet`, `presets.saveAsSetDisabled`, `presets.saveAsSetEnabled`, `presets.applySet`, `presets.applySetTitle`
- `presets.saveForm.*` — all labels, placeholders, hints, and buttons for the Save Preset form
- `presets.applyPanel.*` — loading/error/empty states, all labels, select options, mode hints, apply button
- `matrix.*` — noPresets, presetColumnsLabel, selectPresetPlaceholder, applyToSelected, selectPresetPrompt, columnOption, deselectAllPage, selectAllPage, toggleRow, cell title keys (cellConfigured, cellConfiguredPlural, cellDraftNoChoices, cellNotConfigured, cellMarkPresent), cellOnePerLine, choicesPlaceholder, noChoicesHint, cancel, save
- `matrix.view.*` — label, list, matrix

**`src/locales/{en,hi,gu}/settings.json`** — `"settings"` namespace:
- `additionalInfoLayout.*` — cardTitle, cardDescription, migrationWarning, loading, loadFailed, retry, tabReview, tabDetail, saving, saveReview, saveDetail, savedTitle, savedDesc, saveFailedTitle, saveFailedDesc, progressSaving, progressDesc, progressSavedReview, progressSavedDetail, noFields, moveUp, moveDown, ariaHide, ariaShow

### i18n wiring in components

**`src/components/form-builder/FormFieldTemplateEditorDialog.tsx`:**
- `PresetToolbar`: added `const { t } = useTranslation("admin")` — toolbar button labels and title attributes
- `SavePresetForm`: added `const { t } = useTranslation("admin")` — all form labels, placeholders, hints, buttons
- `ApplyPresetPanel`: added `const { t } = useTranslation("admin")` — all loading/empty/error states, labels, select options, mode hints, apply button
- `MatrixCellEditor`: added `const { t } = useTranslation("admin")` — cellOnePerLine, choicesPlaceholder, noChoicesHint, cancel, save
- `MatrixEditorPanel`: added `const { t } = useTranslation("admin")` — noPresets, presetColumnsLabel, selectPresetPlaceholder, applyToSelected, selectPresetPrompt, columnOption, deselectAllPage/selectAllPage aria-labels, toggleRow aria-label, cell title strings, table header
- `DependentFieldsPanel`: added `const { t } = useTranslation("admin")` — view toggle label, List, Matrix button labels

**`src/components/AdditionalInfoLayoutSection.tsx`:**
- `ContextLayoutList`: `const { t } = useTranslation("settings")` — noFields, ariaHide/ariaShow, moveUp/moveDown titles
- `AdditionalInfoLayoutSection`: `const { t } = useTranslation("settings")` — all card strings, tab labels, save buttons, toast messages, progress strings

All `t()` calls include `defaultValue` fallbacks so the UI is never blank even before translations load.

**Commits:**
- `b3a7771` — Phase 3: matrix editor
- `9c3ed38` — Phase 5: AdditionalInfoLayoutSection
- `792df67` — Phase 6: EN/HI/GU translations + i18n wiring

---

## Safety constraints

- Atomic branch-save RPC (`save_option_branch_configuration_atomically`) unchanged for core behavior; step 6b is additive
- No delete-and-insert branch pattern introduced anywhere
- Migration file created, NOT applied — `presetDbAvailable` flag prevents any UI crash when table is absent
- No changes to expense submission, approval, balances, or receipt processing
- No weakening of RLS — new tables follow the admin-ALL / member-SELECT pattern already established
- Historical field display preserved — `fetchExpenseFormFieldDisplay` still exported for callers that don't need grouped output; `ExpenseFormFieldsDisplay` now calls the grouped variant but falls back correctly when hierarchy columns are absent from the DB
