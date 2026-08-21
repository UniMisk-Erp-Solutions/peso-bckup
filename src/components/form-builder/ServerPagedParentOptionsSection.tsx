/**
 * DOC-097/DOC-099/DOC-100 — the Parent Options AND Dependent Fields tabs for
 * an EXISTING select/checkbox template in server-paged mode.
 *
 * UI PARITY (DOC-100): this renders the SAME layout as main's `OptionsPanel`
 * / `DependentFieldsPanel` — a plain editable-input list with pagination for
 * Parent Options, a left-nav sidebar + List/Matrix toggle for Dependent
 * Fields — not a redesigned table+"Open" UI. Only the DATA SOURCE differs:
 * every list here is server-searched/paged (≤ pageSize rows in memory at
 * once), never a full local array, and bulk import / Matrix / presets are
 * fed a bounded, request-scoped subset instead of the whole template. See
 * "Documentations MD/form-template-bulk-import-matrix-preset-parity.md".
 *
 * A brand-new (unsaved) template has no id to search against, so it keeps
 * using the old local options[] array — this component only mounts for
 * `selectedTemplate` truthy.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Search, ChevronLeft, ChevronRight, AlertCircle, Plus, Loader2, Upload, List, LayoutGrid, Filter, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { OptionBranchEditor } from "@/components/OptionBranchEditor";
import { supabase } from "@/integrations/supabase/client";
import {
  createFormTemplateParentOption,
  renameFormTemplateParentOption,
  deleteFormTemplateParentOption,
  saveParentOptionBranchConfigurationAtomically,
  saveFormTemplateParentOptionConfigurationsBatchAtomically,
  type DraftOptionBranchV2,
} from "@/lib/formBuilder/categoryServerSearchV2";
import { useServerPagedOptionSearch } from "@/lib/formBuilder/useServerPagedOptionSearch";
import { useOptionConfiguration } from "@/lib/formBuilder/useOptionConfiguration";
import { useServerScopedTemplateDraft } from "@/lib/formBuilder/useServerScopedTemplateDraft";
import { buildBranchIndexes } from "@/lib/formBuilder/templateEditor";
import {
  buildPresetFromParentOption,
  applyPresetToParentOptions,
  serializePresetSchema,
  deserializePresetSchema,
  type ApplyPresetMode,
  type PresetSummary,
  type ReusableSubFieldSet,
} from "@/lib/formBuilder/subFieldPresets";
import {
  DropdownBulkImportDialog,
  type DropdownBulkImportApplyPayload,
} from "@/components/form-builder/DropdownBulkImportDialog";
import { MatrixEditorPanel } from "@/components/form-builder/MatrixEditorPanel";
import { PresetToolbar } from "@/components/form-builder/PresetToolbar";

// Mirrors the hardcoded rule inside save_parent_option_branch_configuration_atomically
// and search_form_template_parent_options (kept in sync manually — see those
// migrations' own comments for why: Postgres has no shared-constant mechanism
// between functions).
const PROJECT_INTEGRITY_HARDCODED_TEMPLATE_ID = "51181324-68cc-4174-bbe0-4834e5e22c48";
const PROJECT_INTEGRITY_REQUIRED_FIELD_KEYS = ["project_id", "project_name"];

function computeMissingRequiredKeys(templateId: string, drafts: DraftOptionBranchV2[]): string[] {
  if (templateId !== PROJECT_INTEGRITY_HARDCODED_TEMPLATE_ID) return [];
  const rootKeys = new Set(
    drafts
      .filter((d) => d.parent_branch_local_id === null && d.name.trim() !== "")
      .map((d) => d.field_key.trim()),
  );
  return PROJECT_INTEGRITY_REQUIRED_FIELD_KEYS.filter((k) => !rootKeys.has(k));
}

function findDuplicateRootKey(drafts: DraftOptionBranchV2[]): string | null {
  const seen = new Set<string>();
  for (const d of drafts) {
    if (d.parent_branch_local_id !== null || d.name.trim() === "") continue;
    const key = (d.field_key.trim() || d.name.trim()).toLowerCase();
    if (seen.has(key)) return d.field_key.trim() || d.name.trim();
    seen.add(key);
  }
  return null;
}

function PaginationBar({
  page,
  totalPages,
  onGoToPage,
  compact = false,
}: {
  page: number;
  totalPages: number;
  onGoToPage: (p: number) => void;
  compact?: boolean;
}) {
  if (totalPages <= 1) return null;
  if (compact) {
    return (
      <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground py-1">
        <Button variant="ghost" size="icon" className="h-6 w-6" disabled={page <= 1} onClick={() => onGoToPage(page - 1)} aria-label="Previous page">
          <ChevronLeft className="h-3.5 w-3.5" />
        </Button>
        <span>Page {page} of {totalPages}</span>
        <Button variant="ghost" size="icon" className="h-6 w-6" disabled={page >= totalPages} onClick={() => onGoToPage(page + 1)} aria-label="Next page">
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 text-sm">
      <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => onGoToPage(1)} disabled={page <= 1} aria-label="First page">
        «
      </Button>
      <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => onGoToPage(page - 1)} disabled={page <= 1} aria-label="Previous page">
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <span className="text-muted-foreground">Page {page} of {totalPages}</span>
      <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => onGoToPage(page + 1)} disabled={page >= totalPages} aria-label="Next page">
        <ChevronRight className="h-4 w-4" />
      </Button>
      <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => onGoToPage(totalPages)} disabled={page >= totalPages} aria-label="Last page">
        »
      </Button>
    </div>
  );
}

const PAGE_SIZES = [25, 50, 100];

/** One row of the Parent Options list — an editable text input (rename on
 *  blur/Enter) + a delete icon, exactly like main's OptionsPanel row, just
 *  backed by a scoped rename/delete RPC instead of local array mutation. */
function EditableOptionRow({
  displayIndex,
  value,
  branchCount,
  onRename,
  onDeleteRequest,
  busy,
}: {
  displayIndex: number;
  value: string;
  branchCount: number;
  onRename: (nextValue: string) => void;
  onDeleteRequest: () => void;
  busy: boolean;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== value) onRename(trimmed);
    else if (!trimmed) setDraft(value); // don't allow blanking out
  };

  return (
    <li className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground w-10 text-right shrink-0">#{displayIndex}</span>
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
          if (e.key === "Escape") setDraft(value);
        }}
        disabled={busy}
        className="h-9 flex-1"
        aria-label={`Option ${displayIndex}`}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-9 w-9 shrink-0 text-muted-foreground hover:text-destructive"
        onClick={onDeleteRequest}
        disabled={busy}
        aria-label={`Remove option ${value || displayIndex}`}
        data-branch-count={branchCount}
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </li>
  );
}

export function ServerPagedParentOptionsSection({
  organizationId,
  templateId,
  existingOptions,
  allowNested,
  section,
  savedPresets,
  presetSummaries,
  presetsLoadState,
  presetDbAvailable,
  onPresetCreated,
  onOptionSaved,
}: {
  organizationId: string;
  templateId: string;
  /** The template's full current option VALUE list — cheap (short strings),
   *  already loaded by the caller, never the scalability problem. Used to
   *  detect which imported/added values are brand-new vs already existing
   *  ANYWHERE in the template, not just the current server-search page. */
  existingOptions: string[];
  allowNested: boolean;
  /** Which tab this instance is rendering chrome for. The same underlying
   *  search/pagination/draft state is shared between both tabs (one
   *  instance is mounted at a time, matching the dialog's existing
   *  single-shared-instance pattern) — only the toolbar/layout differs. */
  section: "options" | "dependent";
  savedPresets: ReusableSubFieldSet[];
  presetSummaries: PresetSummary[];
  presetsLoadState: "idle" | "loading" | "success" | "error";
  presetDbAvailable: boolean | null;
  onPresetCreated: (preset: ReusableSubFieldSet) => void;
  onOptionSaved?: () => void;
}) {
  const { toast } = useToast();
  const search = useServerPagedOptionSearch(organizationId, templateId);
  const config = useOptionConfiguration(organizationId, templateId);
  const draft = useServerScopedTemplateDraft(organizationId, templateId);

  const [newOptionValue, setNewOptionValue] = useState("");
  const [addingOption, setAddingOption] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [bulkImportOpen, setBulkImportOpen] = useState(false);
  const [savingPending, setSavingPending] = useState(false);
  const [dependentViewMode, setDependentViewMode] = useState<"list" | "matrix">("list");
  const [matrixPresetId, setMatrixPresetId] = useState("");
  const [matrixPage, setMatrixPage] = useState(1);
  const [matrixSelectedOptions, setMatrixSelectedOptions] = useState<Set<string>>(new Set());
  const [busyOptionValue, setBusyOptionValue] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ value: string; branchCount: number } | null>(null);

  const pageOptionValues = useMemo(
    () => search.page?.results.map((r) => r.optionValue) ?? [],
    [search.page],
  );

  // Matrix needs every visible row's branches loaded — bounded to the
  // current page (≤ pageSize), on demand, never the whole template.
  useEffect(() => {
    if (dependentViewMode !== "matrix" || pageOptionValues.length === 0) return;
    void draft.ensureLoaded(pageOptionValues);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dependentViewMode, pageOptionValues]);

  const matrixBranchDrafts = useMemo(
    () => pageOptionValues.flatMap((v) => draft.getDrafts(v)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pageOptionValues, draft.getDrafts],
  );
  const matrixBranchIndexes = useMemo(() => buildBranchIndexes(matrixBranchDrafts), [matrixBranchDrafts]);
  const matrixLoading = pageOptionValues.some((v) => draft.loadingKeys.has(v));

  // ── Pending-changes save bar (Matrix edits + preset-apply-to-selected +
  //    a dependent-table bulk import's touched-option branch data). ───────
  const handleSavePending = useCallback(async () => {
    setSavingPending(true);
    try {
      const { results } = await draft.saveDirty([], undefined, "server_paged_bulk_edit");
      const failed = results.filter((r) => r.status === "error");
      const ok = results.filter((r) => r.status === "ok");
      if (failed.length === 0) {
        toast({ title: `${ok.length} option${ok.length === 1 ? "" : "s"} saved` });
      } else {
        toast({
          variant: "destructive",
          title: `${ok.length} saved, ${failed.length} failed`,
          description: failed.map((f) => `"${f.parentOptionValue}": ${f.errorMessage}`).join(" · "),
        });
      }
      search.retry();
      onOptionSaved?.();
    } catch (e: unknown) {
      toast({
        variant: "destructive",
        title: "Could not save pending changes",
        description: e instanceof Error ? e.message : "Unknown error.",
      });
    } finally {
      setSavingPending(false);
    }
  }, [draft, toast, search, onOptionSaved]);

  const handleDiscardPending = useCallback(() => {
    draft.dirtyOptionValues.forEach((v) => draft.clearDraft(v));
    setMatrixSelectedOptions(new Set());
  }, [draft]);

  // ── Bulk import wiring ─────────────────────────────────────────────────
  const resolveExistingBranchDrafts = useCallback(
    async (touchedOptionValues: string[]) => {
      const map = await draft.ensureLoaded(touchedOptionValues);
      return touchedOptionValues.flatMap((v) => map.get(v) ?? []);
    },
    [draft],
  );

  const handleBulkImportApply = useCallback(
    async (payload: DropdownBulkImportApplyPayload) => {
      const existingLower = new Set(existingOptions.map((o) => o.toLowerCase()));
      const newOptionValues = payload.options.filter((o) => !existingLower.has(o.toLowerCase()));

      if (newOptionValues.length > 0) {
        try {
          await saveFormTemplateParentOptionConfigurationsBatchAtomically(
            organizationId,
            templateId,
            newOptionValues,
            [],
            "bulk_import_new_options",
          );
        } catch (e: unknown) {
          toast({
            variant: "destructive",
            title: "Could not add the new options",
            description: e instanceof Error ? e.message : "Unknown error.",
          });
          return;
        }
      }

      if (payload.branchDrafts.length > 0) {
        draft.setOverlayFromMergedDrafts(payload.branchDrafts as DraftOptionBranchV2[]);
      }

      const touchedFieldsNote =
        payload.branchDrafts.length > 0
          ? ` Review the pending changes below and Save to apply the dependent-field data.`
          : "";
      toast({
        title: "Import applied",
        description: `${payload.summaryText}${newOptionValues.length > 0 ? ` ${newOptionValues.length} new option${newOptionValues.length === 1 ? "" : "s"} added.` : ""}${touchedFieldsNote}`,
      });
      search.retry();
      onOptionSaved?.();
    },
    [organizationId, templateId, existingOptions, draft, toast, search, onOptionSaved],
  );

  // ── Preset handlers (server-paged: scoped to whichever option(s) are
  //    actually the target, never the whole template) ────────────────────
  const handleSavePreset = useCallback(
    async (presetName: string, description: string, includeOptions: boolean) => {
      if (!organizationId || !config.selectedOption) return;
      const rootDrafts = config.drafts.filter(
        (d) => d.parent_branch_local_id === null && d.parent_option_value === config.selectedOption,
      );
      const schema = buildPresetFromParentOption(rootDrafts, config.drafts, includeOptions);
      if (schema.length === 0) {
        toast({ description: "No fields to save. Configure some dependent fields first." });
        return;
      }
      if (presetDbAvailable === false) {
        toast({
          variant: "destructive",
          description: "Preset storage requires a database migration. Contact your administrator.",
        });
        return;
      }
      const payload = {
        organization_id: organizationId,
        parent_template_id: templateId,
        name: presetName.trim(),
        description: description.trim() || null,
        field_schema: serializePresetSchema(schema),
        is_default: false,
        enforce_on_all_parent_options: false,
      };
      const { data, error } = await supabase
        .from("expense_form_field_branch_presets" as "expense_form_field_templates")
        .insert(payload as Record<string, unknown>)
        .select("id, name, description, field_schema, is_default, enforce_on_all_parent_options, created_at, updated_at")
        .single();
      if (error) {
        toast({ variant: "destructive", description: `Could not save set: ${error.message}` });
        return;
      }
      const newPreset: ReusableSubFieldSet = {
        id: data.id as string,
        organizationId,
        parentTemplateId: templateId,
        name: data.name as string,
        description: (data.description as string | null) ?? null,
        fieldSchema: deserializePresetSchema(data.field_schema),
        isDefault: Boolean(data.is_default),
        enforceOnAllParentOptions: Boolean(data.enforce_on_all_parent_options),
        createdAt: data.created_at as string,
        updatedAt: data.updated_at as string,
      };
      onPresetCreated(newPreset);
      toast({ description: `"${newPreset.name}" saved as a reusable set.` });
    },
    [organizationId, templateId, config.selectedOption, config.drafts, presetDbAvailable, onPresetCreated, toast],
  );

  const handleApplyPreset = useCallback(
    async (preset: ReusableSubFieldSet, targetOptions: string[], mode: ApplyPresetMode) => {
      if (!config.selectedOption || !targetOptions.includes(config.selectedOption)) return;
      const { drafts, appliedTo, skipped } = applyPresetToParentOptions(
        config.drafts,
        preset.fieldSchema,
        [config.selectedOption],
        mode,
      );
      config.setDrafts(drafts);
      const msg =
        appliedTo > 0
          ? `Applied "${preset.name}"${skipped > 0 ? ` (already complete, no changes)` : ""}.`
          : `Already has the full structure — nothing changed.`;
      toast({ description: msg });
    },
    [config, toast],
  );

  // ── Parent option actions (immediate persist, one option at a time —
  //    matches the existing "Add option" precedent; see this file's own
  //    doc comment for why these aren't draft-buffered like branch edits) ──
  const handleAddOption = async () => {
    const trimmed = newOptionValue.trim();
    if (!trimmed) return;
    setAddingOption(true);
    try {
      await createFormTemplateParentOption(organizationId, templateId, trimmed);
      setNewOptionValue("");
      toast({ title: "Option added", description: `"${trimmed}" was added to this template.` });
      search.retry();
      onOptionSaved?.();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Could not add this option.";
      toast({ variant: "destructive", title: "Could not add option", description: msg });
    } finally {
      setAddingOption(false);
    }
  };

  const handleRenameOption = async (oldValue: string, newValue: string) => {
    setBusyOptionValue(oldValue);
    try {
      await renameFormTemplateParentOption(organizationId, templateId, oldValue, newValue);
      toast({ title: "Option renamed", description: `"${oldValue}" → "${newValue}"` });
      if (config.selectedOption === oldValue) config.clearSelection();
      search.retry();
      onOptionSaved?.();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Could not rename this option.";
      toast({ variant: "destructive", title: "Could not rename option", description: msg });
      search.retry(); // revert the optimistic-looking input back to the real value
    } finally {
      setBusyOptionValue(null);
    }
  };

  const performDelete = async (value: string) => {
    setBusyOptionValue(value);
    try {
      const result = await deleteFormTemplateParentOption(organizationId, templateId, value);
      toast({
        title: "Option removed",
        description: `"${value}" removed${result.branchesRetired > 0 ? ` along with ${result.branchesRetired} dependent field${result.branchesRetired === 1 ? "" : "s"}` : ""}.`,
      });
      if (config.selectedOption === value) config.clearSelection();
      search.retry();
      onOptionSaved?.();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Could not remove this option.";
      toast({ variant: "destructive", title: "Could not remove option", description: msg });
    } finally {
      setBusyOptionValue(null);
      setDeleteConfirm(null);
    }
  };

  const handleDeleteRequest = (value: string, branchCount: number) => {
    if (branchCount > 0) {
      setDeleteConfirm({ value, branchCount });
    } else {
      void performDelete(value);
    }
  };

  const handleSaveOption = async () => {
    if (!config.selectedOption) return;
    setSaveError(null);

    const dup = findDuplicateRootKey(config.drafts);
    if (dup) {
      setSaveError(`Parent option "${config.selectedOption}" already contains a "${dup}" field.`);
      return;
    }
    const missing = computeMissingRequiredKeys(templateId, config.drafts);
    if (missing.length > 0) {
      setSaveError(
        `Parent option "${config.selectedOption}" is missing required field(s): ${missing.join(", ")}`,
      );
      return;
    }

    setSaving(true);
    try {
      const result = await saveParentOptionBranchConfigurationAtomically(
        organizationId,
        templateId,
        config.selectedOption,
        config.fingerprint,
        config.drafts,
      );
      config.retry();
      toast({
        title: `"${config.selectedOption}" saved`,
        description: `${result.branchesInserted} inserted, ${result.branchesUpdated} updated, ${result.branchesRetired} retired. No other option was touched.`,
      });
      onOptionSaved?.();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Could not save this option.";
      setSaveError(msg);
    } finally {
      setSaving(false);
    }
  };

  const pendingBar = draft.dirtyOptionValues.length > 0 && (
    <div className="flex items-center justify-between gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2">
      <span className="text-sm">
        {draft.dirtyOptionValues.length} option{draft.dirtyOptionValues.length === 1 ? "" : "s"} with unsaved
        dependent-field changes.
      </span>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" onClick={handleDiscardPending} disabled={savingPending}>
          Discard
        </Button>
        <Button size="sm" onClick={handleSavePending} disabled={savingPending}>
          {savingPending ? "Saving…" : `Save ${draft.dirtyOptionValues.length} option${draft.dirtyOptionValues.length === 1 ? "" : "s"}`}
        </Button>
      </div>
    </div>
  );

  const bulkImportDialog = (
    <DropdownBulkImportDialog
      open={bulkImportOpen}
      onOpenChange={setBulkImportOpen}
      existingOptions={existingOptions}
      resolveExistingBranchDrafts={resolveExistingBranchDrafts}
      onApply={handleBulkImportApply}
    />
  );

  const deleteConfirmDialog = deleteConfirm && (
    <AlertDialog open onOpenChange={() => setDeleteConfirm(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove option?</AlertDialogTitle>
          <AlertDialogDescription>
            &quot;{deleteConfirm.value}&quot; has {deleteConfirm.branchCount} dependent field
            {deleteConfirm.branchCount !== 1 ? "s" : ""}. Removing it will also remove those
            dependent-field configurations.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep option</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => void performDelete(deleteConfirm.value)}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            Remove option and fields
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  const page = search.page;

  // ── Option editor view (one option open, List mode) ──────────────────────
  const optionEditor = config.selectedOption !== null && (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium text-sm truncate min-w-0">
          Dependent fields for &quot;{config.selectedOption}&quot;
        </h3>
        <div className="flex items-center gap-1.5 shrink-0">
          {config.loadState === "success" && (
            <PresetToolbar
              selectedParentOption={config.selectedOption}
              allOptions={[config.selectedOption]}
              branchDrafts={config.drafts}
              savedPresets={savedPresets}
              presetSummaries={presetSummaries}
              presetsLoadState={presetsLoadState}
              hasSavedTemplate
              onSavePreset={handleSavePreset}
              onApplyPreset={handleApplyPreset}
            />
          )}
        </div>
      </div>

      {config.loadState === "loading" && (
        <div className="flex items-center justify-center gap-2 py-10 text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading this option…
        </div>
      )}

      {config.loadState === "error" && (
        <div className="flex flex-col items-center gap-3 py-10 text-center">
          <AlertCircle className="h-6 w-6 text-destructive" />
          <p className="text-sm text-muted-foreground max-w-sm">
            {config.error ?? "This option's configuration could not be loaded."}
          </p>
          <Button size="sm" variant="outline" onClick={config.retry}>
            Retry
          </Button>
        </div>
      )}

      {config.loadState === "success" && (
        <>
          <OptionBranchEditor
            options={[config.selectedOption]}
            drafts={config.drafts}
            onChange={config.setDrafts}
            allowNested={allowNested}
          />
          {saveError && (
            <p className="text-sm text-destructive flex items-start gap-1.5">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              {saveError}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={config.clearSelection} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleSaveOption} disabled={saving}>
              {saving ? "Saving…" : `Save "${config.selectedOption}"`}
            </Button>
          </div>
        </>
      )}
    </div>
  );

  // ── Parent Options tab ──────────────────────────────────────────────────
  if (section === "options") {
    return (
      <div className="space-y-4">
        {pendingBar}
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-48">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <Input
              value={search.searchInput}
              onChange={(e) => search.setSearchInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") search.runSearch(); }}
              placeholder="Search parent options…"
              className="pl-9"
            />
          </div>
          <span className="text-sm text-muted-foreground whitespace-nowrap">
            {page ? `${page.totalResults} of ${page.totalResults} option${page.totalResults !== 1 ? "s" : ""}` : "Loading…"}
          </span>
          <div className="flex items-center gap-1">
            {PAGE_SIZES.map((ps) => (
              <Button
                key={ps}
                variant={search.pageSize === ps ? "secondary" : "ghost"}
                size="sm"
                className="h-8 px-2 text-xs"
                onClick={() => search.setPageSize(ps)}
              >
                {ps}
              </Button>
            ))}
          </div>
        </div>

        {/* Pagination bar */}
        {page && <PaginationBar page={page.page} totalPages={page.totalPages} onGoToPage={search.goToPage} />}

        {/* Option rows — current server page only */}
        <div className="min-h-[120px]">
          {search.loadState === "loading" && page && (
            <div className="flex items-center justify-center gap-2 py-10 text-muted-foreground text-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              Searching…
            </div>
          )}
          {search.loadState === "error" && (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <AlertCircle className="h-6 w-6 text-destructive" />
              <p className="text-sm text-muted-foreground max-w-sm">{search.error}</p>
              <Button size="sm" variant="outline" onClick={search.retry}>
                Retry
              </Button>
            </div>
          )}
          {search.loadState === "success" && page && (
            page.results.length > 0 ? (
              <ul className="space-y-1.5">
                {page.results.map((r) => (
                  <EditableOptionRow
                    key={r.optionValue}
                    displayIndex={r.displayIndex}
                    value={r.optionValue}
                    branchCount={r.activeTotalBranchCount}
                    onRename={(next) => void handleRenameOption(r.optionValue, next)}
                    onDeleteRequest={() => handleDeleteRequest(r.optionValue, r.activeTotalBranchCount)}
                    busy={busyOptionValue === r.optionValue}
                  />
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground py-4 text-center">
                {search.submittedSearch ? `No options matching "${search.submittedSearch}"` : "No options yet. Add some below."}
              </p>
            )
          )}
          {(search.loadState === "idle" || (search.loadState === "loading" && !page)) && (
            <div className="flex items-center justify-center gap-2 py-10 text-muted-foreground text-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading…
            </div>
          )}
        </div>

        {/* Add manually / bulk import */}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Input
            value={newOptionValue}
            onChange={(e) => setNewOptionValue(e.target.value)}
            placeholder="Type option and press Enter or Add"
            className="h-9 flex-1 min-w-40"
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); void handleAddOption(); }
              if (e.key === "Escape") setNewOptionValue("");
            }}
          />
          <Button type="button" variant="outline" size="sm" className="h-9 shrink-0" onClick={() => void handleAddOption()} disabled={!newOptionValue.trim() || addingOption}>
            <Plus className="h-4 w-4 mr-1" />
            {addingOption ? "Adding…" : "Add option"}
          </Button>
          <Button type="button" variant="secondary" size="sm" className="h-9 shrink-0" onClick={() => setBulkImportOpen(true)}>
            <Upload className="h-4 w-4 mr-1" />
            Paste / Import data
          </Button>
        </div>

        {bulkImportDialog}
        {deleteConfirmDialog}
      </div>
    );
  }

  // ── Dependent Fields tab ────────────────────────────────────────────────
  return (
    <div className="space-y-3">
      {pendingBar}
      <div className="flex flex-1 min-h-0 divide-x border rounded-md" style={{ minHeight: 420 }}>
        {/* Left pane: parent option navigator (server-searched, bounded) */}
        <div className="w-64 shrink-0 flex flex-col overflow-hidden">
          <div className="p-3 space-y-2 border-b">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <Input
                value={search.searchInput}
                onChange={(e) => search.setSearchInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") search.runSearch(); }}
                placeholder="Search options…"
                className="h-8 pl-8 text-sm"
              />
            </div>
            <button
              type="button"
              onClick={() => search.setConfiguredOnly(!search.configuredOnly)}
              className={cn(
                "flex items-center gap-1.5 text-xs px-2 py-1 rounded-md transition-colors w-full",
                search.configuredOnly ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted",
              )}
            >
              <Filter className="h-3 w-3" />
              Configured only
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {search.loadState === "loading" && !page ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            ) : page && page.results.length === 0 ? (
              <p className="text-xs text-muted-foreground p-3">No options match</p>
            ) : (
              <ul>
                {(page?.results ?? []).map((r) => {
                  const isSelected = config.selectedOption === r.optionValue;
                  return (
                    <li key={r.optionValue}>
                      <button
                        type="button"
                        onClick={() => config.selectOption(r.optionValue)}
                        aria-current={isSelected ? "true" : undefined}
                        className={cn(
                          "w-full text-left px-3 py-2 text-sm flex items-center justify-between gap-2 hover:bg-muted/50 transition-colors",
                          isSelected && "bg-primary/10 text-primary font-medium",
                        )}
                      >
                        <span className="truncate min-w-0">{r.optionValue}</span>
                        {r.activeTotalBranchCount > 0 && (
                          <Badge variant="secondary" className="text-xs shrink-0 h-5">
                            {r.activeTotalBranchCount}
                          </Badge>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          {page && <PaginationBar page={page.page} totalPages={page.totalPages} onGoToPage={search.goToPage} compact />}
        </div>

        {/* Right pane: view toggle + content */}
        <div className="flex flex-col flex-1 min-h-0">
          <div className="flex items-center gap-1 px-3 py-1.5 border-b shrink-0">
            <span className="text-xs text-muted-foreground mr-1">View:</span>
            <button
              type="button"
              onClick={() => setDependentViewMode("list")}
              className={cn(
                "flex items-center gap-1 text-xs px-2 py-1 rounded-md transition-colors",
                dependentViewMode === "list" ? "bg-primary/10 text-primary font-medium" : "text-muted-foreground hover:bg-muted",
              )}
            >
              <List className="h-3 w-3" />
              List
            </button>
            <button
              type="button"
              onClick={() => setDependentViewMode("matrix")}
              className={cn(
                "flex items-center gap-1 text-xs px-2 py-1 rounded-md transition-colors",
                dependentViewMode === "matrix" ? "bg-primary/10 text-primary font-medium" : "text-muted-foreground hover:bg-muted",
              )}
            >
              <LayoutGrid className="h-3 w-3" />
              Matrix
            </button>
            <Button type="button" variant="ghost" size="sm" className="h-7 ml-auto text-xs" onClick={() => setBulkImportOpen(true)}>
              <Upload className="h-3.5 w-3.5 mr-1" />
              Import data
            </Button>
          </div>

          {dependentViewMode === "matrix" ? (
            matrixLoading && pageOptionValues.every((v) => !draft.isLoaded(v)) ? (
              <div className="flex-1 flex items-center justify-center gap-2 text-muted-foreground text-sm">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading this page's dependent fields…
              </div>
            ) : (
              <MatrixEditorPanel
                allOptions={pageOptionValues}
                savedPresets={savedPresets}
                branchDrafts={matrixBranchDrafts}
                setBranchDrafts={(next) => draft.setOverlayFromMergedDrafts(next as DraftOptionBranchV2[])}
                branchIndexes={matrixBranchIndexes}
                matrixPresetId={matrixPresetId}
                setMatrixPresetId={setMatrixPresetId}
                matrixPage={matrixPage}
                setMatrixPage={setMatrixPage}
                matrixSelectedOptions={matrixSelectedOptions}
                setMatrixSelectedOptions={setMatrixSelectedOptions}
              />
            )
          ) : (
            <div className="flex-1 overflow-y-auto p-4">
              {config.selectedOption === null ? (
                <div className="flex h-full items-center justify-center">
                  <p className="text-muted-foreground text-sm">
                    Select a parent option from the left to configure its dependent fields.
                  </p>
                </div>
              ) : (
                optionEditor
              )}
            </div>
          )}
        </div>
      </div>

      {bulkImportDialog}
      {deleteConfirmDialog}
    </div>
  );
}
