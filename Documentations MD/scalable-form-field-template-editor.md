# DOC-061 — Scalable Form Field Template Editor

**Status:** in progress
**Branch:** `feature/user-activity-insights`
**Last updated:** 2026-07-15
**Files created / modified:**
- `src/components/form-builder/FormFieldTemplateEditorDialog.tsx` (new — the dialog)
- `src/lib/formBuilder/templateEditor.ts` (new — pure helpers)
- `src/lib/formBuilder/__tests__/templateEditor.test.ts` (new — 31 tests)
- `src/pages/CategoryManagement.tsx` (modified — inline dialog removed, wired to new component)

---

## Problem

The original template editor in `CategoryManagement.tsx` (lines 1148–1624) had three performance/correctness problems:

1. **All 400+ parent options rendered simultaneously.** Every `templateOptions.map(...)` call instantiated a fully-controlled `<Input>` per option, causing React to diff 400+ controlled inputs on every keystroke.
2. **All 400+ `OptionSection` components rendered.** `OptionBranchEditor` received the full `cleanedOptions` array, so 400+ collapsibles each potentially holding `DraftBranchCard` components were mounted at once.
3. **Success timing bug.** For new templates, the "Template Created" toast fired at line 1566 *before* `saveOptionBranchConfigurationAtomically` at line 1577 had completed.

---

## Solution

### Phase 1 — Pure helpers (`templateEditor.ts`)

A zero-dependency helper library with full test coverage:

| Helper | Purpose |
|---|---|
| `pageCount / paginateItems / clampPage` | Pagination math |
| `buildIndexedOptions(options, searchTerm)` | Filters options while preserving `originalIndex` for correct mutation |
| `buildBranchIndexes(drafts)` | `rootsByParentOption`, `childrenByParentLocalId`, `branchCountByParentOption` — built once, memoised |
| `validateOptions(options)` | Finds blank and duplicate (case-insensitive) options |
| `renameParentOption` | Renames an option + migrates root branch drafts only |
| `deleteParentOption` | Deletes an option + cascades to all descendants (BFS) |
| `countBranchesForOption` | Count impacted branches before a delete |
| `validateTemplate` | Full validation — name, options count, blank/duplicate options, select branches without choices |
| `buildCleanedOptions` | Deduplicates options before save |
| `buildTemplateData` | Builds Supabase insert/update payload |
| `parseBulkOptionValues` | Splits pasted text by newline or comma |
| `mergeBulkOptions` | Appends incoming options, skipping duplicates |
| `makeSnapshot / isSnapshotDirty` | JSON-string dirty-state tracking |

Tests: **31 passing** in 4.20s, no React imports.

### Phase 2 — `FormFieldTemplateEditorDialog`

Replaces the `max-w-2xl max-h-[90vh] overflow-y-auto` inline dialog with a full-viewport editor: `w-[96vw] max-w-6xl h-[92vh]`.

#### Four sections (rendered as `hidden/block` tabs to prevent unmount)

| Tab | Content |
|---|---|
| **Basics** | name, type, required, placeholder, default value, min/max (number only), help text |
| **Parent Options** | search bar, page-size selector (25/50/100, default 50), paginated option list (one page only), single-add input, bulk-add collapsible (paste or file upload) |
| **Dependent Fields** | Left nav: searchable option list with branch counts + "configured only" filter. Right pane: ONE selected option passed to `OptionBranchEditor` (instead of all 400+). |
| **Review & Save** | Template detail summary, validation error list with "Go to section" links, branch count table |

#### Section visibility
- **Parent Options** tab: shown for `select` or `checkbox` types
- **Dependent Fields** tab: shown only when `allowConditionalDropdown && type === "select"`

#### Save order fix (new templates)

**Old (buggy) order:** insert metadata → toast "Template Created" → save branches

**New (correct) order:**
1. Validate
2. Insert template metadata (need the ID first)
3. Save branches atomically (calls `save_option_branch_configuration_atomically`)
4. Call `onSaved()` (fetches latest templates from DB)
5. Show toast + close dialog

For existing templates the order is: validate → save branches → update metadata → refresh → toast.

#### Dirty-state tracking

`makeSnapshot(state)` serialises all editor state to JSON at open time. On every change, `isSnapshotDirty(current, baseline)` compares. Attempting to close with unsaved changes shows an `AlertDialog` with "Continue editing" / "Discard changes".

#### Staged save progress

Uses `useOperationProgress` + `AsyncOperationProgress` in the sticky footer. Steps are truthful:

**New template (4 steps):** Validating → Creating template → Saving dependent fields → Refreshing  
**Existing template (5 steps):** Validating → Saving dependent fields → Saving template details → Refreshing + toast

#### Stale-save detection

Passes `templateUpdatedAt` to the atomic RPC. If another session saved in the meantime, the RPC throws `stale_edit:...` and the dialog shows a retry error with "Close and reopen to load the latest."

#### Delete option confirmation

If an option has dependent branches, a confirmation `AlertDialog` shows the branch count before allowing delete. Branch deletion cascades via `deleteParentOption` (BFS over `localId` references).

---

## CategoryManagement.tsx changes

Removed (~110 lines of state + handlers):
- State variables: `templateName`, `templateType`, `templateRequired`, `templateDefaultValue`, `templatePlaceholder`, `templateHelpText`, `templateMin`, `templateMax`, `templateOptions`, `newOption`, `optionSearchTerm`, `bulkOptionsInput`, `bulkOptionsFileName`, `branchDrafts`, `branchDraftsLoading`, `templateUpdatedAt`, `cascadingCsvInputRef`
- Handlers: `normalizeOptionValue`, `parseBulkOptionValues`, `appendTemplateOptions`, `downloadCascadingSample`, `handleCascadingCsvFile`, `copyCascadingAiPrompt`
- Imports: `OptionBranchEditor`, `loadDraftBranchesForTemplate`, `saveOptionBranchConfigurationAtomically`, `DraftOptionBranch`, `parseCascadingOptionsCsv`, `buildCascadingSampleCsv`, `buildCascadingAiPrompt`

Added:
```tsx
import { FormFieldTemplateEditorDialog } from "@/components/form-builder/FormFieldTemplateEditorDialog";
```

Wired:
```tsx
<FormFieldTemplateEditorDialog
  open={templateDialogOpen}
  onOpenChange={(open) => {
    if (!open) { setTemplateDialogOpen(false); setSelectedTemplate(null); }
  }}
  selectedTemplate={selectedTemplate}
  organizationId={organizationId}
  userId={user?.id ?? null}
  allowConditionalDropdown={allowConditionalDropdown}
  onSaved={fetchTemplates}
/>
```

"Create Template" button now just: `setSelectedTemplate(null); setTemplateDialogOpen(true)`.  
"Edit" button: `setSelectedTemplate(template); setTemplateDialogOpen(true)`.

---

## Safety constraints (preserved)

- Atomic branch RPC (`save_option_branch_configuration_atomically`) is called unchanged
- No delete-and-insert branch pattern anywhere in the new dialog
- No SQL changes, no migrations
- No changes to expense submission, approval, or custom-field value persistence
