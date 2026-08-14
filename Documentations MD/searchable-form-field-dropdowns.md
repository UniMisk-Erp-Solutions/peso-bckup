# Searchable form field dropdowns

**Last updated:** 2026-06-24  
**Status:** deployed (frontend)  
**ID:** DOC-003

## Purpose

Category **Additional Information** select fields (templates + conditional branch dropdowns) use a searchable combobox with up to **4 recent** options at the top, based on per-user usage history.

## Behavior

- Click field → search bar filters all options.
- **Recent** group: top 4 values from `form_field_option_usage_tracking` (falls back to first options for new users).
- **All options** group: remaining choices (no duplicates under Recent).
- Recents update when the expense is saved/submitted (`trackFormFieldSelections`).

## Key files

- `src/components/SearchableSelectField.tsx` — combobox UI
- `src/components/CategoryFormFieldsSection.tsx` — template selects
- `src/components/BranchFieldInputs.tsx` — conditional branch selects
- `src/lib/recommendedFormFieldOptions.ts` — usage fetch + `RECENT_FORM_FIELD_OPTIONS_LIMIT`

## Database

Uses existing `form_field_option_usage_tracking` + `increment_form_field_option_usage` RPC (no new migration).

## Test plan

1. Open expense form with a category that has select custom fields.
2. Open dropdown → confirm search box and Recent section (after prior submissions).
3. Pick a value, submit expense, open form again → value appears under Recent.
4. Test nested conditional branch dropdowns the same way.

## Revision log

| Date | Author | Summary |
|------|--------|---------|
| 2026-06-24 | agent | SearchableSelectField + 4 recents for additional form field dropdowns |
