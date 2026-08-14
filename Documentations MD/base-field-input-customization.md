# Customizable base field inputs

**Last updated:** 2026-06-25
**Status:** in progress (requires migration on prod)
**ID:** DOC-004

## Purpose

Let org admins change the **input type** of base expense fields (`category`, `title`, `destination`, `expense_date`, `purpose`, `amount`) to `text`, `number`, or `dropdown`, with static admin-defined options. For example: `destination` as a dropdown of locations, or `amount` as a dropdown of fixed amounts. Dropdowns reuse the searchable + recents control. Optional, gated by a Master Admin switch; configured in the org admin Settings form builder.

## How it works

1. Master Admin enables the feature `allow_base_field_input_customization` for an org.
2. Org admin opens Settings -> "Expense Form Builder (Base Fields)". Fields show as a compact list with status badges (Core / Required / Hidden / input type). Clicking **Edit** opens a dialog to set label, display order, visibility, required, **Input type**, and (for dropdown) the **Options** list. Changes apply locally; **Save Form Builder** persists them.
3. Config is stored on `organization_expense_form_fields` (`input_type`, `options`).
4. Single + batch expense forms render each base field via `BaseExpenseFieldInput`, which falls back to the built-in control when the input type is `default` or the feature is off.
5. Dropdown selections are usage-tracked (`field_kind = 'base'`) so the top 4 recents surface in the searchable dropdown.

## Key files

- `src/lib/organizationFeatureKeys.ts` - feature key + master definition
- `src/locales/{en,hi,gu}/master.json` - master switch label
- `src/lib/expenseFormConfig.ts` - `BaseFieldConfig.input_type` + `options`, `normalizeBaseFieldOptions`
- `src/pages/Settings.tsx` - gated input-type + options editor; numeric guard for amount
- `src/components/BaseExpenseFieldInput.tsx` - shared renderer
- `src/components/SearchableSelectField.tsx` - dropdown + recents (reused)
- `src/pages/ExpenseForm.tsx`, `src/pages/ExpenseBatchForm.tsx`, `src/components/BatchExpenseLinesTable.tsx` - render sites
- `src/lib/recommendedFormFieldOptions.ts` - `'base'` field kind + `trackBaseFieldSelections`
- `src/locales/{en,hi,gu}/settings.json` - builder strings

## Database

Run in Supabase SQL Editor, then reload the API schema:

- `supabase/migrations/20260703120000_base_field_input_customization.sql`

Adds `input_type` + `options` to `organization_expense_form_fields`; allows `field_kind = 'base'` in `form_field_option_usage_tracking` and `increment_form_field_option_usage`.

## Guardrails / caveats

- `category`: dropdown options must match existing category names, otherwise category-driven custom fields will not load. Default control recommended.
- `expense_date`: override values must be valid dates (`YYYY-MM-DD`). Default date picker recommended.
- `amount`: dropdown options must be numeric (enforced on save); value is parsed to a number and still validated as positive.
- Existing orgs default to `input_type = 'default'` (current behavior); no backfill needed.

## Test plan

1. Master Admin: enable "Customizable base field inputs" for a test org.
2. Settings: set `destination` to Dropdown with options (e.g. `Site A`, `Site B`); set `amount` to Dropdown with `100`, `250`, `500`; Save.
3. Single Expense Form: `destination` and `amount` render as searchable dropdowns; submit picks values; recents appear on next visit.
4. Batch Expense Form (cards + table views): same fields render as dropdowns per line.
5. Disable the feature: forms revert to default controls regardless of stored config.

## Revision log

| Date | Author | Summary |
|------|--------|---------|
| 2026-06-25 | agent | Initial implementation: master switch, migration, settings builder, shared renderer, single + batch wiring, recents |
| 2026-06-25 | agent | Form builder UI redesign: compact summary list with status badges + per-field edit dialog (label, order, visible, required, input type, options) |
