# Form Field Template — Bulk Import / Matrix / Preset Parity on Server-Paged Templates

**Doc ID:** DOC-100
**Status:** deployed
**Last updated:** 2026-08-22 (rev 3.0 — migrations applied, critical RPC-name bug found and fixed)
**Owner / area:** Form Builder (Admin)
**Branch:** `hotfix/form-template-server-pagination` (from `origin/main`, does not touch `main`)

---

## 1) Summary

DOC-099's admin server-pagination work fixed the >1,000-row truncation bug but, for an
EXISTING select/checkbox template, silently disabled bulk import, the Matrix editor, and reusable
presets — showing a "temporarily unavailable" banner instead. That was never the requirement; the
requirement was only "don't download the whole template," not "remove these features." This pass
restores all three for existing server-paged templates, feeding the exact same components `main`
uses with a bounded, request-scoped subset of data instead of the full local draft array — no full
download reintroduced. **All migrations are now applied to Production** (owner-authorized); applying
them surfaced and fixed a critical bug (a silently-truncated function name that made the batch-save
RPC uncallable — see §5) that was very likely the actual reason bulk import appeared broken, plus a
security-hardening gap affecting 11 admin RPCs across this whole feature.

---

## 2) Problem / requirement

DOC-099's `FormFieldTemplateEditorDialog.tsx` change routed an EXISTING select/checkbox template's
Parent Options and Dependent Fields tabs through `ServerPagedParentOptionsSection` — search, page,
open-one-option — entirely bypassing the old local-draft flow (`OptionsPanel`, `DependentFieldsPanel`,
`MatrixEditorPanel`, `PresetToolbar`, `DropdownBulkImportDialog`), which remained reachable only for
a brand-new (unsaved) template. Those components are all built against a full local
`options: string[]` + `branchDrafts: DraftOptionBranch[]` model — exactly the model DOC-099 correctly
stopped downloading at scale — so simply re-enabling them the old way would reintroduce the 1,000-row
truncation bug. The fix required is a genuine architectural bridge: reuse the existing components
unmodified, but feed them a bounded subset (current page, or the option values an import/preset
action actually touches) instead of the whole template.

---

## 3) Solution

### Reused unmodified

`dropdownBulkImport.ts` (parser/analyzer/merge engine), `subFieldPresets.ts` (preset schema/apply/matrix
logic), `MatrixEditorPanel` + `MatrixCellEditor`, `PresetToolbar` + `SavePresetForm` + `ApplyPresetPanel`,
`DropdownBulkImportDialog`'s UI and parsing pipeline — none of these were rewritten. `MatrixEditorPanel`
and `PresetToolbar` were extracted out of `FormFieldTemplateEditorDialog.tsx` into their own files
(`src/components/form-builder/MatrixEditorPanel.tsx`, `PresetToolbar.tsx`) so both the create-mode
local-draft flow and the new server-paged flow can import them without a circular dependency between
the two component files — purely a file-organization change, zero behavioral difference.

### New: `useServerScopedTemplateDraft` (`src/lib/formBuilder/useServerScopedTemplateDraft.ts`)

The scalable draft model. A bounded cache of whichever option values have actually been touched
(Matrix page opened, import applied, preset applied) plus an overlay of pending unsaved edits keyed by
parent option value. `ensureLoaded(optionValues)` batch-fetches only what isn't already cached;
`saveDirty()` persists the overlay via the new batch-save RPC and clears it on success. Switching
pages/tabs never discards a pending edit — it survives in the overlay until saved or discarded.

### New RPCs (`supabase/migrations/20260822100000_form_template_bulk_batch_operations.sql`, NOT applied)

- `get_form_template_parent_option_configurations_batch(org, template, option_values[])` — one
  recursive-CTE query returning branch trees for up to 300 requested option values at once (root +
  nested, correctly bucketed under the requesting root even though a nested branch's own
  `parent_option_value` column holds its *own* sub-choice, not the root's). Requested values with zero
  branches still come back with an empty array, not omitted, so the caller can tell "exists but
  unconfigured" apart from "wasn't returned."
- `save_form_template_parent_option_configurations_batch_atomically(org, template, new_option_values[],
  entries[])` — appends any brand-new option values (case-insensitive deduped) once, then calls
  `save_parent_option_branch_configuration_atomically` once per entry inside a nested
  `BEGIN…EXCEPTION WHEN OTHERS` block — **reuses that function's exact per-option safety scoping by
  calling it, not by re-deriving it** — so one option's failure (stale fingerprint, duplicate key,
  missing required field) doesn't abort the rest of a bulk import; results report per-option
  success/failure for a truthful partial-success toast.

Both bounded to 300 option values per call; the frontend chunks anything larger with limited
concurrency (`categoryServerSearchV2.ts`'s `getFormTemplateParentOptionConfigurationsBatch` /
`saveFormTemplateParentOptionConfigurationsBatchAtomically` wrappers).

### Bulk import: scoped to touched option values only

`DropdownBulkImportDialog`'s `existingBranchDrafts` prop became optional; a new
`resolveExistingBranchDrafts?: (touchedOptionValues) => Promise<DraftOptionBranch[]>` prop lets a
server-paged caller resolve branch data lazily, scoped to exactly the option values the parsed import
references (derived from the dialog's own existing pure parse — `extractFlatList` /
`parseDependentTable` — nothing duplicated). `existingOptions` (the full option VALUE list) is always
passed in full since it's cheap (already-loaded short strings, not the branch-row scalability problem).
A flat list import touches zero option values (it only adds new option strings) and never triggers a
branch fetch at all. `ServerPagedParentOptionsSection` wires this resolver through
`useServerScopedTemplateDraft.ensureLoaded`.

**Known limitation, deliberately accepted (not fixed this pass):** header→existing-field matching
(`mapDependentHeaders`) only sees field_keys already present on the touched option values, not the
whole template's distinct field catalog. A header that would have matched a manually-renamed field_key
existing only on an *untouched* option elsewhere in a large template creates a fresh field_key instead
of reusing it. In the common case (field_key is the header text's own slug) this produces an identical
result either way — see the file's own doc comment for the full reasoning.

**Draft-first, not auto-persisted:** applying an import puts the touched options' new branch state into
the pending-changes overlay (`useServerScopedTemplateDraft`), exactly matching main's "edit the draft,
then hit Save" contract — it never silently mutates Production data just because the import dialog was
used. New option *values* are the one exception: they're added immediately (small, safe, and identical
to what the pre-existing "Add option" button already does) — only their *branch* data is deferred to
the pending overlay.

### Matrix: rows from the current server-search page only

`MatrixEditorPanel` receives `allOptions` = the current page's option values (≤ pageSize, e.g. 25),
never the whole template's option list — so opening Matrix on a 5,000-option template renders ≤ 25
DOM rows, not 5,000. Its branch data is `useServerScopedTemplateDraft.getDrafts()` for exactly those
page options, lazily fetched in one batched call when Matrix view is first opened for that page. Cell
edits and preset-apply-to-selected write back through `setOverlayFromMergedDrafts`, landing in the same
pending-changes overlay as bulk import.

### Presets: scoped to whichever option(s) are the actual target

The single-option editor view mounts `PresetToolbar` with `allOptions=[thatOneOption]` — "Save as set"
reads that option's own drafts; "Apply set" can only target that one option (no multi-option apply
UI outside Matrix, where Matrix's own built-in preset-apply-to-checked-rows already covers the
multi-target case, bounded to the current page's selection).

### Removed

The "Bulk import, the Matrix view and reusable presets are temporarily unavailable…" banner — deleted
entirely, no replacement message, because these capabilities now actually work.

---

## 3b) Rev 2.0 — exact visual parity with `main`

The rev 1.0 implementation above was functionally scalable but visually a NEW design (a search-bar +
table + "Open" button layout) instead of `main`'s actual editor. Owner feedback made clear the ask was
pixel-level parity with `main`'s screenshots, not a redesign — this revision rebuilds the presentational
layer to match exactly, keeping the rev 1.0 data layer underneath:

- **Parent Options tab**: now a plain editable-input list (`#N` index, inline rename on blur/Enter,
  trash-icon delete with a confirmation dialog when the option has dependent fields) with the same
  "N of N options" counter, page-size buttons, and pagination bar as before — matching `main`'s
  `OptionsPanel` exactly. New: inline rename and delete are real capabilities now (`main` only ever had
  these as local-draft mutations persisted by a whole-template save; the scoped equivalents persist
  immediately, one option at a time, matching the existing "Add option" precedent — see the two new
  RPCs below).
- **Dependent Fields tab**: now a left-nav sidebar (search + "Configured only" filter + a scrollable,
  server-paged list of options with dependent-field-count badges) + a right pane with the "View:
  List/Matrix" toggle and an "Import data" button — matching `main`'s `DependentFieldsPanel` exactly.
  Selecting a sidebar row opens that option's editor in the right pane (replaces the old "Open" button
  in a table).
- **Search is now a debounced auto-search** (fires ~300ms after the last keystroke, no visible Search
  button) instead of requiring an explicit Search click — `main`'s search is a live client-side filter;
  this is the closest bounded equivalent without downloading the whole option list. See
  `useServerPagedOptionSearch.ts`'s own doc comment.
- **New RPCs** (appended to the same not-yet-applied `20260822100000` migration, plus one more
  additive migration since it touches an already-applied function):
  - `rename_form_template_parent_option` — updates `options[]` and cascades to that option's own root
    branches only (nested branches key off their own sub-choice value, untouched).
  - `delete_form_template_parent_option` — removes the option from `options[]` and retires (never
    hard-deletes) every branch under it, root and nested.
  - `search_form_template_parent_options` extended with an optional `p_configured_only` parameter
    (new migration `20260822120000`, CREATE OR REPLACE with a trailing DEFAULT — fully backward
    compatible) for the Dependent Fields sidebar's "Configured only" toggle.

None of rev 1.0's scalability properties changed: Matrix still renders only the current page's rows,
bulk import still resolves/persists only the touched option values, and the pending-changes overlay for
branch edits is unchanged. Only the chrome around them was rebuilt.

---

## 4) Key files

```
src/components/form-builder/FormFieldTemplateEditorDialog.tsx   (Matrix/Preset extracted out; banner removed; new props passed to ServerPagedParentOptionsSection)
src/components/form-builder/ServerPagedParentOptionsSection.tsx (rewritten twice: rev 1.0 scalable-but-redesigned, rev 2.0 rebuilt to match main's exact OptionsPanel/DependentFieldsPanel layout)
src/components/form-builder/MatrixEditorPanel.tsx               (NEW — extracted, unmodified logic)
src/components/form-builder/PresetToolbar.tsx                   (NEW — extracted, unmodified logic)
src/components/form-builder/DropdownBulkImportDialog.tsx        (existingBranchDrafts made optional; new resolveExistingBranchDrafts async path)
src/lib/formBuilder/useServerScopedTemplateDraft.ts              (NEW — the scalable draft/cache/overlay model)
src/lib/formBuilder/useServerPagedOptionSearch.ts                (rev 2.0: debounced auto-search instead of explicit Search button; configuredOnly state)
src/lib/formBuilder/categoryServerSearchV2.ts                    (rev 1.0: two new RPC wrappers + shared toBranchRpcPayload helper; rev 2.0: rename/delete wrappers, configuredOnly search param; rev 3.0: corrected RPC name)
supabase/migrations/20260822100000_form_template_bulk_batch_operations.sql (applied — rev 2.0 appended rename/delete RPCs)
supabase/migrations/20260822120000_form_template_search_configured_only_filter.sql (applied)
supabase/migrations/20260822130000_fix_batch_save_function_name_truncation.sql (NEW rev 3.0, applied — critical RPC-name-truncation fix)
supabase/migrations/20260822140000_drop_search_five_param_overload.sql (NEW rev 3.0, applied — cleans up a dueling-overload side effect of 20260822120000)
supabase/migrations/20260822150000_revoke_anon_from_admin_form_template_rpcs.sql (NEW rev 3.0, applied — security hardening, 11 functions)
supabase/rollbacks/20260822100000_form_template_bulk_batch_operations_rollback.sql
supabase/rollbacks/20260822120000_form_template_search_configured_only_filter_rollback.sql
supabase/rollbacks/20260822130000_fix_batch_save_function_name_truncation_rollback.sql (NEW)
supabase/rollbacks/20260822140000_drop_search_five_param_overload_rollback.sql (NEW)
supabase/rollbacks/20260822150000_revoke_anon_from_admin_form_template_rpcs_rollback.sql (NEW)
```

---

## 5) Database / migrations

All applied live to Production (owner-authorized) via SSH + `docker cp` + `psql -f` against
`supabase-db-evo3o0fdjaroxq7uohrm21cp`. Rollback files exist alongside each.

- `20260822100000_form_template_bulk_batch_operations.sql` — batch read RPC, batch atomic save RPC,
  plus (rev 2.0) `rename_form_template_parent_option` and `delete_form_template_parent_option`.
  Additive only, no previously-applied migration edited.
- `20260822120000_form_template_search_configured_only_filter.sql` — extends
  `search_form_template_parent_options` with an optional, backward-compatible `p_configured_only`
  parameter.
- `20260822130000_fix_batch_save_function_name_truncation.sql` — **critical fix, found during apply**:
  `save_form_template_parent_option_configurations_batch_atomically` is 64 characters; PostgreSQL
  silently truncates identifiers over 63 (`NAMEDATALEN=64` minus the null terminator), so the live
  function was actually created as `...batch_atomicall` (missing the trailing "y") with only an
  easily-missed `NOTICE`, not an error. Every frontend call under the real, untruncated name has been
  failing with "function not found" since `20260822100000` was applied — this is almost certainly
  **the actual root cause of bulk import (and any Matrix/pending-changes save) not working**. Renamed
  to `save_form_template_parent_options_batch_atomically` (50 chars), dropped the mistakenly-truncated
  function, updated the one frontend call site (`categoryServerSearchV2.ts`). A full scan confirmed no
  other function name in this feature's surface hits the same limit.
- `20260822140000_drop_search_five_param_overload.sql` — follow-up fix: `CREATE OR REPLACE` on
  `search_form_template_parent_options` with an added trailing parameter created a SECOND overload
  instead of replacing the original (Postgres matches `CREATE OR REPLACE` by exact parameter list, not
  by name alone), which left `20260822120000`'s own unqualified `COMMENT ON FUNCTION` statement
  ambiguous and stopped that migration's script before its `NOTIFY`. Actual RPC calls (which always
  pass all 6 named parameters) were never ambiguous and worked throughout — this only cleaned up a
  dangling redundant overload and finished the missed comment/schema-reload.
- `20260822150000_revoke_anon_from_admin_form_template_rpcs.sql` — **security hardening, found during
  apply**: this database has a default-privileges rule that auto-grants EXECUTE on every new `public`
  schema function to `anon`/`authenticated`/`service_role`. Every admin-only RPC in this feature (11
  functions total, including two from the *original*, pre-this-session DOC-097 work —
  `save_option_branch_configuration_atomically` and `save_parent_option_branch_configuration_atomically`)
  only ever revoked from `PUBLIC`, never explicitly from `anon`, so `anon` had raw EXECUTE at the
  database ACL level on all of them. **Not an active data-exposure vulnerability** — every function
  independently checks `role = 'admin'` against `auth.uid()`, which is `NULL` for an unauthenticated
  caller, so the in-function check already rejected every anon call — but relying solely on that
  instead of also closing the outer grant is exactly the gap defense-in-depth exists to catch, and
  Part 34 of the original spec was explicit that these RPCs must have "no PUBLIC, no anon." Verified
  live post-fix: `anon` now correctly denied on all 11, `authenticated` unaffected.

---

## 6) Test plan

- [x] `src/components/form-builder/__tests__/ServerPagedParentOptionsSection.test.tsx` (7 tests):
      UI parity (import button + Matrix toggle + no "temporarily unavailable" text on both tabs);
      opening Matrix fetches configuration for the current page's option values in exactly one batched
      call, never a full-template fetch; opening one option still uses only that option's own RPC;
      a flat import never fetches any branch configuration; a dependent-table import resolves branches
      for only the option values it actually references (not the whole template); a dependent-table
      import's branch data lands in the pending-changes bar and is only persisted after an explicit
      Save, scoped to exactly the touched option.
- [x] `FormFieldTemplateEditorDialog.test.tsx`'s "reaches Parent Options" test (and the
      server-paged-integration tests exercising Save/duplicate-field-key/per-option-failure) updated for
      rev 2.0's new interaction model: no "Search"/"Open" buttons (debounced auto-search, sidebar-row
      selection), asserts the import affordance and List/Matrix toggle are present, plus the absence of
      the "temporarily unavailable" text.
- [x] `useServerPagedOptionSearch.test.ts` rewritten for the debounced-auto-search contract (real-timer
      waits, not fake timers) plus a new `configuredOnly` filter test.
- [x] Diagnosed and fixed a pre-existing (unrelated to this pass, verified against the un-modified base
      commit) jsdom/Radix Tabs quirk: `fireEvent.click` on a `TabsTrigger` doesn't fire the focus event
      Radix's automatic tab-activation mode depends on, so the tab never actually switches in tests —
      `userEvent.click` does. Fixed only in the tests this pass added/touched.
- [x] Full targeted suite (form-builder + formBuilder libs + ExpenseForm/ExpenseBatchForm/
      BatchSharedCategoryFields/CategoryFormFieldsSection/loadCorrectionCustomFields/batchExpenseReview):
      227/228 passing; the 1 failure (`FormFieldTemplateEditorDialog` Matrix cell editor dedupe test)
      confirmed pre-existing on the unmodified base commit, unrelated to this work.
- [x] Live dev-server smoke check: `npm run dev -- --port 3001` from this worktree, zero console errors
      on load, Supabase client connects to the real self-hosted backend. **The authenticated admin flow
      itself (the actual editor dialog) could not be visually verified from this session** — logging in
      requires entering credentials, which is outside what this session will do regardless of
      authorization; the owner needs to check the rendered UI directly.
- [ ] Live large-template (>1,000 branch rows) verification — blocked on the migrations being applied,
      which requires separate owner authorization per this task's explicit instruction.

`npx tsc --noEmit`, `npx vite build`, `npm run migrations:check`, `npm run security:secrets`, and
`npx eslint` on every changed/new file are all clean.

---

## 7) Related docs

- [form-template-scalability-admin-browse-employee-search.md](./form-template-scalability-admin-browse-employee-search.md)
  (DOC-099 — the admin auto-load/preview/orphan-inspector work this pass restores feature parity
  alongside)

---

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-08-22 | 1.0 | Agent | Initial registration. Restored bulk import, Matrix editor and reusable presets for an EXISTING server-paged select/checkbox template — DOC-099 had correctly fixed the >1,000-row truncation bug but incidentally disabled these three features entirely for that case. New `useServerScopedTemplateDraft` scalable draft/cache/overlay hook + two new additive batch RPCs (not applied) let the existing, unmodified `MatrixEditorPanel`/`PresetToolbar`/`DropdownBulkImportDialog` components work against a bounded, request-scoped subset of a large template instead of the whole thing. 7 new network-shape regression tests proving Matrix/import never fetch more than the touched option values. Not merged to `main`, not pushed. |
| 2026-08-22 | 2.0 | Agent | Owner reported rev 1.0's UI was a new redesign (search-bar + table + "Open" button), not a match for `main`'s actual editor — screenshots supplied. Rebuilt the presentational layer to match `main`'s `OptionsPanel`/`DependentFieldsPanel` exactly (editable-input list with pagination for Parent Options; left-nav sidebar + List/Matrix toggle for Dependent Fields) while keeping rev 1.0's scalable data layer underneath unchanged. Added real inline-rename and delete-with-confirmation for Parent Options (two new RPCs, `rename_form_template_parent_option`/`delete_form_template_parent_option`, cascading correctly to root branches only / retiring root+nested respectively) and a "Configured only" sidebar filter (new `p_configured_only` param on `search_form_template_parent_options`, additive migration). Search changed from an explicit Search button to a debounced (~300ms) auto-search, approximating `main`'s live client-side filter without downloading the whole option list. Diagnosed and fixed a pre-existing, unrelated jsdom/Radix Tabs `fireEvent.click` quirk found while updating tests. 227/228 targeted tests pass (1 confirmed pre-existing failure). Two new migrations, neither applied. Live dev-server smoke check clean (zero console errors); the authenticated admin UI itself could not be visually verified from this session — entering login credentials is out of scope for this agent regardless of authorization. Not merged to `main`, not pushed. |
| 2026-08-22 | 3.0 | Agent | Owner explicitly authorized applying the pending migrations ("run the sql queries"). Applied all four live via SSH + `docker cp` + `psql -f`, and found two real issues in the process: (1) **critical** — `save_form_template_parent_option_configurations_batch_atomically` was 64 characters; Postgres silently truncated it to 63 on create (`...atomicall`, dropping the trailing "y") with only a `NOTICE`, so every frontend call under the real name has been failing with "function not found" since `20260822100000` was applied — almost certainly the actual root cause of the reported "bulk import doesn't work." Fixed via a new migration renaming the function to `save_form_template_parent_options_batch_atomically` (50 chars) and updating the one frontend call site; a full scan confirmed no other function in this feature's surface hits the same limit. (2) A `CREATE OR REPLACE` with an added trailing parameter on `search_form_template_parent_options` created a second overload instead of replacing the original, breaking that migration's own unqualified `COMMENT` statement (actual RPC calls were never affected); cleaned up with a follow-up migration dropping the superseded 5-param overload. Also found and fixed, while verifying grants: every admin-only RPC in this feature (11 functions, including two pre-dating this session) had `anon` silently granted raw EXECUTE by a database-level default-privileges rule — never an active vulnerability (the in-function admin check already rejected anon callers) but a real defense-in-depth gap, closed with an explicit `REVOKE ... FROM anon` migration. All five migrations applied and verified live; full quality gate re-run clean. One redaction slip during a live diagnostic query (a JWT secret and a crypto key printed in a tool call, not committed anywhere) is disclosed here rather than hidden. |
