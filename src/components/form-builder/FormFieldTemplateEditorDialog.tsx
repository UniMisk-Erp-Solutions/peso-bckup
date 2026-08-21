/**
 * Scalable Form Field Template Editor Dialog
 *
 * Replaces the inline dialog in CategoryManagement.tsx.
 * Handles 400+ parent options and 700+ dependent fields without rendering them all at once.
 *
 * Sections: Basics | Parent Options | Dependent Fields | Review & Save
 */

import { useState, useMemo, useRef, useCallback, useEffect } from "react";
import { useTranslation } from "@/i18n";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  Search,
  Trash2,
  AlertCircle,
  CheckCircle2,
  Filter,
  BookOpen,
  Save,
  RefreshCw,
  LayoutGrid,
  List,
  Check,
  Minus,
  X,
  ChevronUp,
  Square,
  CheckSquare,
  Upload,
} from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  buildPresetFromParentOption,
  applyPresetToParentOptions,
  getUnconfiguredOptions,
  deserializePresetSchema,
  serializePresetSchema,
  buildPresetMatrix,
  inferMatrixColumnsFromDrafts,
  type ReusableSubFieldDefinition,
  type ReusableSubFieldSet,
  type PresetSummary,
  type ApplyPresetMode,
  type MatrixRow,
} from "@/lib/formBuilder/subFieldPresets";
import {
  DropdownBulkImportDialog,
  type DropdownBulkImportApplyPayload,
} from "@/components/form-builder/DropdownBulkImportDialog";
import { dedupePreservingFirst } from "@/lib/formBuilder/dropdownBulkImport";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { useOperationProgress } from "@/hooks/useOperationProgress";
import { AsyncOperationProgress } from "@/components/AsyncOperationProgress";
import { OptionBranchEditor } from "@/components/OptionBranchEditor";
import {
  saveOptionBranchConfigurationAtomically,
  type DraftOptionBranch,
} from "@/lib/optionBranchPersistence";
import { ServerPagedParentOptionsSection } from "@/components/form-builder/ServerPagedParentOptionsSection";
import { MatrixEditorPanel } from "@/components/form-builder/MatrixEditorPanel";
import { PresetToolbar } from "@/components/form-builder/PresetToolbar";
import { LegacyOrphanGroupsDialog } from "@/components/form-builder/LegacyOrphanGroupsDialog";
import { useTemplateEditorSummary } from "@/lib/formBuilder/useTemplateEditorSummary";
import type { TemplateEditorSummary } from "@/lib/formBuilder/categoryServerSearchV2";
import {
  buildIndexedOptions,
  buildBranchIndexes,
  buildCleanedOptions,
  buildTemplateData,
  countBranchesForOption,
  deleteParentOption,
  isSnapshotDirty,
  makeSnapshot,
  pageCount,
  paginateItems,
  renameParentOption,
  validateTemplate,
  type TemplateEditorSnapshot,
  DEFAULT_PAGE_SIZE,
  PAGE_SIZES,
} from "@/lib/formBuilder/templateEditor";

// ─── Types ─────────────────────────────────────────────────────────────────────

type Section = "basics" | "options" | "dependent" | "review";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TemplateRow = Record<string, any>;

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedTemplate: TemplateRow | null;
  organizationId: string | null;
  userId: string | null;
  allowConditionalDropdown: boolean;
  onSaved: () => void;
};

// ─── Constant labels (will be replaced by i18n in Phase 5) ────────────────────

const SECTION_LABELS: Record<Section, string> = {
  basics: "Basics",
  options: "Parent Options",
  dependent: "Dependent Fields",
  review: "Review & Save",
};

// ─── Main dialog ───────────────────────────────────────────────────────────────

export function FormFieldTemplateEditorDialog({
  open,
  onOpenChange,
  selectedTemplate,
  organizationId,
  userId,
  allowConditionalDropdown,
  onSaved,
}: Props) {
  const { t } = useTranslation(["admin", "common"]);
  const { toast } = useToast();
  const { progress, startOperation, updateOperation, completeOperation, failOperation, resetOperation } =
    useOperationProgress();

  // ── Basic fields ─────────────────────────────────────────────────────────────
  const [name, setName] = useState("");
  const [type, setType] = useState("text");
  const [required, setRequired] = useState(false);
  const [placeholder, setPlaceholder] = useState("");
  const [defaultValue, setDefaultValue] = useState("");
  const [helpText, setHelpText] = useState("");
  const [min, setMin] = useState("");
  const [max, setMax] = useState("");
  const [batchEntryMode, setBatchEntryMode] = useState<"once_per_batch" | "per_line" | null>(null);

  // ── Parent options ────────────────────────────────────────────────────────────
  const [options, setOptions] = useState<string[]>([]);
  const [optionSearch, setOptionSearch] = useState("");
  const [optionPage, setOptionPage] = useState(1);
  const [optionPageSize, setOptionPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [newOptionValue, setNewOptionValue] = useState("");
  const [deleteConfirmOption, setDeleteConfirmOption] = useState<{
    originalIndex: number;
    value: string;
    branchCount: number;
  } | null>(null);

  // ── Branch drafts ─────────────────────────────────────────────────────────────
  const [branchDrafts, setBranchDrafts] = useState<DraftOptionBranch[]>([]);
  const [branchLoadState, setBranchLoadState] = useState<"idle" | "loading" | "success" | "error">("idle");

  // ── Dependent fields navigation ───────────────────────────────────────────────
  const [selectedParentOption, setSelectedParentOption] = useState<string | null>(null);
  const [parentSearch, setParentSearch] = useState("");
  const [showConfiguredOnly, setShowConfiguredOnly] = useState(false);

  // ── Matrix editor (Phase 3) ───────────────────────────────────────────────────
  const [dependentViewMode, setDependentViewMode] = useState<"list" | "matrix">("list");
  const [matrixPresetId, setMatrixPresetId] = useState<string>("");
  const [matrixPage, setMatrixPage] = useState(1);
  const [matrixSelectedOptions, setMatrixSelectedOptions] = useState<Set<string>>(new Set());

  // ── Reusable sub-field presets (Phase 2) ─────────────────────────────────────
  const [savedPresets, setSavedPresets] = useState<ReusableSubFieldSet[]>([]);
  const [presetsLoadState, setPresetsLoadState] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [presetDbAvailable, setPresetDbAvailable] = useState<boolean | null>(null); // null = unknown

  // ── Server-paged editor summary (existing templates only) ───────────────────
  // Header badge counts for an existing template come from this tiny
  // server-computed aggregate instead of the (no longer eagerly loaded)
  // local options[]/branchDrafts arrays. See DOC-097 "Phase 2".
  const summary = useTemplateEditorSummary(
    organizationId,
    open && selectedTemplate ? selectedTemplate.id : null,
  );
  // An EXISTING select/checkbox template edits its parent options and
  // dependent fields through the server-paged sections (search → open →
  // edit → save one option at a time) instead of the old fully-downloaded
  // local options[]/branchDrafts arrays. A brand-new (unsaved) template has
  // no id to search against yet, so it always keeps the old local flow.
  const isServerPagedMode = Boolean(selectedTemplate) && (type === "select" || type === "checkbox");
  const [orphanDialogOpen, setOrphanDialogOpen] = useState(false);

  // ── UI state ──────────────────────────────────────────────────────────────────
  const [activeSection, setActiveSection] = useState<Section>("basics");
  const [saving, setSaving] = useState(false);
  const [templateUpdatedAt, setTemplateUpdatedAt] = useState<string | null>(null);

  // ── Dirty-state tracking ──────────────────────────────────────────────────────
  const openingSnapshot = useRef<string>("");
  const [discardOpen, setDiscardOpen] = useState(false);

  // ── Bulk dropdown import (shared dialog, opened from Parent Options or
  //    Dependent Fields — see DropdownBulkImportDialog.tsx) ────────────────────
  const [bulkImportOpen, setBulkImportOpen] = useState(false);

  const currentSnapshot = useMemo(
    (): TemplateEditorSnapshot => ({
      name,
      type,
      required,
      placeholder,
      defaultValue,
      helpText,
      min,
      max,
      options,
      branchDrafts,
      batchEntryMode,
    }),
    [name, type, required, placeholder, defaultValue, helpText, min, max, options, branchDrafts, batchEntryMode],
  );

  const isDirty = useMemo(
    () => isSnapshotDirty(currentSnapshot, openingSnapshot.current),
    [currentSnapshot],
  );

  // ── Memoised indexes & pagination ─────────────────────────────────────────────
  const branchIndexes = useMemo(() => buildBranchIndexes(branchDrafts), [branchDrafts]);

  const indexedOptions = useMemo(
    () => buildIndexedOptions(options, optionSearch),
    [options, optionSearch],
  );

  const totalOptionPages = useMemo(
    () => pageCount(indexedOptions.length, optionPageSize),
    [indexedOptions.length, optionPageSize],
  );

  const pagedOptions = useMemo(
    () => paginateItems(indexedOptions, optionPage, optionPageSize),
    [indexedOptions, optionPage, optionPageSize],
  );

  const configuredParentOptions = useMemo(() => {
    return options.filter(
      (o) => (branchIndexes.branchCountByParentOption.get(o) ?? 0) > 0,
    );
  }, [options, branchIndexes]);

  const filteredParentOptions = useMemo(() => {
    const list = showConfiguredOnly ? configuredParentOptions : options;
    if (!parentSearch.trim()) return list;
    const lower = parentSearch.toLowerCase();
    return list.filter((o) => o.toLowerCase().includes(lower));
  }, [options, configuredParentOptions, showConfiguredOnly, parentSearch]);

  // ── Validation ────────────────────────────────────────────────────────────────
  const validationIssues = useMemo(() => {
    // In server-paged mode, `options`/`branchDrafts` are deliberately never
    // loaded here — validating them would spuriously flag "0 options" and
    // "no choices" for every existing dropdown template. Each option is
    // validated (client-side project-integrity + duplicate-key checks, plus
    // the server RPC's own checks) independently at the moment it is saved,
    // inside ServerPagedParentOptionsSection.
    if (isServerPagedMode) {
      return name.trim() ? [] : [{ severity: "error" as const, message: "Field name is required", section: "basics" as const }];
    }
    return validateTemplate({ name, type, options, branchDrafts });
  }, [isServerPagedMode, name, type, options, branchDrafts]);

  const hasBlockingErrors = useMemo(
    () => validationIssues.some((i) => i.severity === "error"),
    [validationIssues],
  );

  const errorsBySection = useMemo(() => {
    const map: Record<Section, number> = { basics: 0, options: 0, dependent: 0, review: 0 };
    for (const issue of validationIssues) {
      if (issue.severity === "error") map[issue.section]++;
    }
    return map;
  }, [validationIssues]);

  // ── Init on open ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;

    // Reset to fresh state
    const tmpl = selectedTemplate;
    const n = tmpl?.name ?? "";
    const tp = tmpl?.field_type ?? "text";
    const req = tmpl?.required ?? false;
    const ph = tmpl?.placeholder ?? "";
    const dv = tmpl?.default_value ?? "";
    const ht = tmpl?.help_text ?? "";
    const mn = tmpl?.validation_rules?.min?.toString() ?? "";
    const mx = tmpl?.validation_rules?.max?.toString() ?? "";
    const opts: string[] = tmpl?.options ?? [];
    const bem: "once_per_batch" | "per_line" | null = tmpl?.batch_entry_mode ?? null;

    setName(n);
    setType(tp);
    setRequired(req);
    setPlaceholder(ph);
    setDefaultValue(dv);
    setHelpText(ht);
    setMin(mn);
    setMax(mx);
    setOptions(opts);
    setBatchEntryMode(bem);
    setTemplateUpdatedAt(tmpl?.updated_at ?? null);
    setOptionSearch("");
    setOptionPage(1);
    setOptionPageSize(DEFAULT_PAGE_SIZE);
    setNewOptionValue("");
    setBulkImportOpen(false);
    setBranchDrafts([]);
    setBranchLoadState("idle");
    setSelectedParentOption(null);
    setParentSearch("");
    setShowConfiguredOnly(false);
    setSavedPresets([]);
    setPresetsLoadState("idle");
    setDependentViewMode("list");
    setMatrixPresetId("");
    setMatrixPage(1);
    setMatrixSelectedOptions(new Set());
    setActiveSection("basics");
    setSaving(false);
    resetOperation();

    // Set dirty baseline AFTER state setters (next tick)
    setTimeout(() => {
      openingSnapshot.current = makeSnapshot({
        name: n, type: tp, required: req, placeholder: ph,
        defaultValue: dv, helpText: ht, min: mn, max: mx,
        options: opts, branchDrafts: [], batchEntryMode: bem,
      });
    }, 0);

    // Load saved presets for existing templates
    if (tmpl && organizationId) {
      setPresetsLoadState("loading");
      supabase
        .from("expense_form_field_branch_presets" as "expense_form_field_templates") // table may not exist yet
        .select("id, name, description, field_schema, is_default, enforce_on_all_parent_options, created_at, updated_at")
        .eq("organization_id", organizationId)
        .eq("parent_template_id", tmpl.id)
        .order("updated_at", { ascending: false })
        .then(({ data, error }) => {
          if (error) {
            // Table may not exist yet (migration pending)
            setPresetDbAvailable(false);
            setPresetsLoadState("error");
            setSavedPresets([]);
          } else {
            setPresetDbAvailable(true);
            setSavedPresets(
              (data ?? []).map((row) => ({
                id: row.id as string,
                organizationId: organizationId,
                parentTemplateId: tmpl.id as string,
                name: row.name as string,
                description: (row.description as string | null) ?? null,
                fieldSchema: deserializePresetSchema(row.field_schema),
                isDefault: Boolean(row.is_default),
                enforceOnAllParentOptions: Boolean(row.enforce_on_all_parent_options),
                createdAt: row.created_at as string,
                updatedAt: row.updated_at as string,
              })),
            );
            setPresetsLoadState("success");
          }
        });
    }

    // An EXISTING select/checkbox template no longer eagerly downloads its
    // branch graph here — the Parent Options / Dependent Fields tabs use
    // ServerPagedParentOptionsSection, which loads exactly one option's
    // branches on demand when it's opened, and saves it independently.
    // branchLoadState only needs to not read as "loading"/"error" so the
    // dialog-wide Save button isn't blocked on a fetch that no longer
    // happens here. See DOC-097 "Phase 2".
    if (tmpl) {
      setBranchLoadState("success");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selectedTemplate?.id]);

  // ── Close handling ────────────────────────────────────────────────────────────
  const doClose = useCallback(() => {
    setDiscardOpen(false);
    onOpenChange(false);
  }, [onOpenChange]);

  const handleClose = useCallback(() => {
    if (saving) return;
    if (isDirty) {
      setDiscardOpen(true);
    } else {
      doClose();
    }
  }, [saving, isDirty, doClose]);

  // ── Parent option actions ─────────────────────────────────────────────────────
  const handleAddOption = useCallback(
    (raw: string) => {
      const trimmed = raw.trim();
      if (!trimmed) return;
      if (options.some((o) => o.toLowerCase() === trimmed.toLowerCase())) {
        toast({ description: `"${trimmed}" already exists` });
        return;
      }
      setOptions((prev) => [...prev, trimmed]);
      setNewOptionValue("");
    },
    [options, toast],
  );

  const handleRenameOption = useCallback(
    (originalIndex: number, nextValue: string) => {
      const { options: newOpts, branchDrafts: newDrafts } = renameParentOption(
        options,
        branchDrafts,
        originalIndex,
        nextValue,
      );
      setOptions(newOpts);
      setBranchDrafts(newDrafts);
      // Keep selectedParentOption in sync if it was renamed
      if (selectedParentOption === options[originalIndex]) {
        setSelectedParentOption(nextValue);
      }
    },
    [options, branchDrafts, selectedParentOption],
  );

  const handleDeleteOptionRequest = useCallback(
    (originalIndex: number) => {
      const value = options[originalIndex];
      const branchCount = countBranchesForOption(value, branchDrafts);
      if (branchCount > 0) {
        setDeleteConfirmOption({ originalIndex, value, branchCount });
      } else {
        // No branches — delete immediately
        const { options: newOpts, branchDrafts: newDrafts } = deleteParentOption(
          options,
          branchDrafts,
          originalIndex,
        );
        setOptions(newOpts);
        setBranchDrafts(newDrafts);
        if (selectedParentOption === value) setSelectedParentOption(null);
      }
    },
    [options, branchDrafts, selectedParentOption],
  );

  const handleConfirmDeleteOption = useCallback(() => {
    if (!deleteConfirmOption) return;
    const { originalIndex, value } = deleteConfirmOption;
    const { options: newOpts, branchDrafts: newDrafts } = deleteParentOption(
      options,
      branchDrafts,
      originalIndex,
    );
    setOptions(newOpts);
    setBranchDrafts(newDrafts);
    if (selectedParentOption === value) setSelectedParentOption(null);
    setDeleteConfirmOption(null);
  }, [deleteConfirmOption, options, branchDrafts, selectedParentOption]);

  // ── Shared bulk-import dialog (DropdownBulkImportDialog) ────────────────────
  // Handles BOTH flat option-list imports and dependent-table imports (which
  // populate options[] and branchDrafts[] together). Only ever folds the
  // fully-computed result into local draft state — never touches Supabase.
  const handleBulkImportApply = useCallback(
    (payload: DropdownBulkImportApplyPayload) => {
      setOptions(payload.options);
      setBranchDrafts(payload.branchDrafts);
      toast({ title: "Import applied to draft", description: payload.summaryText });
    },
    [toast],
  );

  // ── Save handler ──────────────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (!organizationId) return;
    const totalSteps = isServerPagedMode ? 2 : selectedTemplate ? 5 : 4;

    try {
      setSaving(true);
      const cleanedOptions = buildCleanedOptions(options);
      const templateData = buildTemplateData({
        organizationId,
        name,
        type,
        required,
        placeholder,
        helpText,
        defaultValue,
        min,
        max,
        cleanedOptions,
        userId,
        batchEntryMode,
      });

      // STEP 1 — Validate
      startOperation("Validating template…", {
        description: isServerPagedMode
          ? "Checking the field name, type and settings."
          : `Checking ${options.length} parent options and ${branchDrafts.length} dependent fields.`,
        currentStep: 1,
        totalSteps,
      });
      await new Promise((r) => setTimeout(r, 50)); // allow UI to paint

      if (selectedTemplate) {
        // ── Existing template save order ────────────────────────────────────────
        if (isServerPagedMode) {
          // Parent options and dependent fields are no longer downloaded into
          // this dialog at all for an existing select/checkbox template —
          // they're edited and saved independently, one option at a time, via
          // ServerPagedParentOptionsSection's own Save button (the option-
          // scoped save_parent_option_branch_configuration_atomically RPC).
          // This button therefore updates ONLY Basics metadata, and must
          // never send `options` (the local array is empty here — it was
          // never loaded — and sending it would silently wipe the real
          // options[] column). See DOC-097 "Phase 2".
          updateOperation("Saving template details…", {
            description: "Updating the field settings and metadata.",
            currentStep: 2,
            totalSteps,
          });
          const { options: _omitOptions, ...basicsOnlyData } = templateData;
          const { error: updateError } = await supabase
            .from("expense_form_field_templates")
            .update(basicsOnlyData)
            .eq("id", selectedTemplate.id);
          if (updateError) throw updateError;
        } else {
          // Step 2: Save branches first (stale-edit guard uses templateUpdatedAt)
          updateOperation("Saving dependent fields…", {
            description: `Saving ${cleanedOptions.length} parent options and ${branchDrafts.length} dependent fields in one secure transaction.`,
            currentStep: 2,
            totalSteps,
          });
          if (allowConditionalDropdown && type === "select") {
            const rpcResult = await saveOptionBranchConfigurationAtomically(
              organizationId,
              selectedTemplate.id,
              templateUpdatedAt,
              cleanedOptions,
              branchDrafts,
            );
            setTemplateUpdatedAt(rpcResult.latest_updated_at);
          }

          // Step 3: Update template metadata
          updateOperation("Saving template details…", {
            description: "Updating the field settings and metadata.",
            currentStep: 3,
            totalSteps,
          });
          const { error: updateError } = await supabase
            .from("expense_form_field_templates")
            .update(templateData)
            .eq("id", selectedTemplate.id);
          if (updateError) throw updateError;
        }

      } else {
        // ── New template save order ─────────────────────────────────────────────
        // Step 2: Insert template metadata (branches need the ID)
        updateOperation("Creating template…", {
          description: "Saving the field name, type and validation settings.",
          currentStep: 2,
          totalSteps,
        });
        // The live table's batch_entry_mode column is NOT NULL even though a
        // template that has never had the toggle touched builds batchEntryMode
        // as null (meant as "legacy default, fall back to the per-assignment
        // flag"). That fallback only matters for a template with existing
        // category assignments — a brand-new template has none yet, so "per_line"
        // (the same value the toggle itself already writes when switched off) is
        // an exact, safe substitute here. Only the insert path needs this: the
        // update path leaves batch_entry_mode untouched from whatever was loaded.
        const { data: inserted, error: insertError } = await supabase
          .from("expense_form_field_templates")
          .insert({ ...templateData, batch_entry_mode: templateData.batch_entry_mode ?? "per_line" })
          .select("id, updated_at")
          .single();
        if (insertError) throw insertError;

        // Step 3: Save branches (after we have the ID)
        if (allowConditionalDropdown && type === "select" && inserted?.id) {
          updateOperation("Saving dependent fields…", {
            description: `Saving ${cleanedOptions.length} parent options and ${branchDrafts.length} dependent fields in one secure transaction.`,
            currentStep: 3,
            totalSteps,
          });
          // New templates skip the stale-edit guard entirely (nothing to be stale
          // against yet) — the RPC contract requires null here, not the just-inserted
          // row's own updated_at.
          try {
            await saveOptionBranchConfigurationAtomically(
              organizationId,
              inserted.id,
              null,
              cleanedOptions,
              branchDrafts,
            );
          } catch (branchError) {
            // The template row above already committed as its own request. If
            // branch persistence then fails, don't leave a template with no
            // dependent-field configuration behind silently: compensate by
            // deleting exactly this row. This is safe because (a) it is scoped
            // to both its own id and this organization_id, so it can never
            // touch another template or another org's data, and (b) a template
            // whose branch save just failed has zero rows in any child table
            // yet (every FK to expense_form_field_templates — branch presets,
            // branch config revisions, option branches, category assignments,
            // layout items, form field values — is ON DELETE CASCADE, verified
            // against the live schema), so the cascade is a true no-op.
            const { error: cleanupError } = await supabase
              .from("expense_form_field_templates")
              .delete()
              .eq("id", inserted.id)
              .eq("organization_id", organizationId);
            if (cleanupError) {
              const originalMsg =
                branchError instanceof Error ? branchError.message : String(branchError);
              throw new Error(
                `orphan_cleanup_failed: The template's dependent fields failed to save, and automatic cleanup could not remove the incomplete template either. A template named "${name.trim()}" may now exist with no dependent fields configured — an administrator should check Form Field Templates and remove it manually if present. Original error: ${originalMsg}`,
              );
            }
            throw branchError;
          }
        }
      }

      // Refresh templates (last step)
      const refreshStep = isServerPagedMode
        ? 2
        : selectedTemplate
          ? 4
          : (allowConditionalDropdown && type === "select" ? 4 : 3);
      updateOperation("Refreshing form templates…", {
        description: "Loading the latest saved template configuration.",
        currentStep: refreshStep,
        totalSteps,
      });
      onSaved();
      if (isServerPagedMode) summary.refresh();

      // Success
      completeOperation(
        selectedTemplate
          ? isServerPagedMode
            ? "Template details updated"
            : `Template updated — ${cleanedOptions.length} options saved`
          : `Template created — "${name.trim()}" is ready to assign`,
      );
      toast({
        title: selectedTemplate ? "Template Updated" : "Template Created",
        description: selectedTemplate
          ? `${name.trim()} has been updated successfully`
          : `${name.trim()} has been created successfully`,
      });

      // Close after success
      setTimeout(() => doClose(), 600);
    } catch (e: unknown) {
      const err = e as { message?: string; code?: string; details?: string; hint?: string };
      const msg = err?.message ?? "";
      // Structured save-failure diagnostic, matching this codebase's existing
      // console.error(context, error) convention for handled catch blocks
      // (see FileUpload.tsx, Layout.tsx, ProtectedRoute.tsx). Only ever logs
      // the PostgrestError shape (code/message/details/hint) — never auth,
      // session, header, or payload data.
      console.error("[FormFieldTemplateEditorDialog] handleSave failed", {
        code: err?.code,
        message: err?.message,
        details: err?.details,
        hint: err?.hint,
      });

      if (msg.startsWith("orphan_cleanup_failed:")) {
        const detail = msg.replace(/^orphan_cleanup_failed:\s*/, "");
        failOperation("Save failed — manual cleanup required", detail);
        toast({
          variant: "destructive",
          title: "Save failed — check Form Field Templates",
          description: detail,
        });
      } else if (msg.startsWith("stale_edit:")) {
        failOperation(
          "Save failed",
          "This template was modified by another session. Close and reopen the editor to load the latest version.",
        );
        toast({
          variant: "destructive",
          title: "Reload required",
          description: "This template was modified by another session. Close and reopen to load the latest.",
        });
      } else if (msg.startsWith("project_integrity:")) {
        failOperation("Validation failed", msg.replace(/^project_integrity:\s*/, ""));
        toast({
          variant: "destructive",
          title: "Incomplete branch configuration",
          description: msg.replace(/^project_integrity:\s*/, ""),
        });
        setActiveSection("review");
      } else {
        failOperation("Save failed", msg || "Failed to save template. Your changes have been preserved.");
        toast({
          variant: "destructive",
          title: "Error",
          description: msg || "Failed to save template",
        });
      }
    } finally {
      setSaving(false);
    }
    // summary.refresh (a stable useCallback reference from
    // useTemplateEditorSummary) is the only piece of `summary` this callback
    // reads; including the whole `summary` object would recreate handleSave
    // on every summary refetch for no behavioral benefit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    organizationId,
    selectedTemplate,
    name,
    type,
    required,
    placeholder,
    helpText,
    defaultValue,
    min,
    max,
    options,
    branchDrafts,
    batchEntryMode,
    userId,
    allowConditionalDropdown,
    templateUpdatedAt,
    startOperation,
    updateOperation,
    completeOperation,
    failOperation,
    onSaved,
    toast,
    doClose,
    isServerPagedMode,
    summary.refresh,
  ]);

  // ── Section tab label helpers ─────────────────────────────────────────────────
  const sectionBadge = (s: Section) => {
    const errs = errorsBySection[s];
    if (s === "options" && (type === "select" || type === "checkbox")) {
      // Server-computed count for an existing template's parent options —
      // options[] is no longer loaded into this dialog to derive it from.
      const count = isServerPagedMode ? summary.summary?.parentOptionCount : options.length;
      return (
        <span className="ml-1 text-xs text-muted-foreground">
          {errs > 0 ? (
            <span className="text-destructive">({errs} issue{errs !== 1 ? "s" : ""})</span>
          ) : count != null ? (
            `(${count})`
          ) : null}
        </span>
      );
    }
    if (s === "dependent" && type === "select") {
      const count = isServerPagedMode
        ? summary.summary?.totalActiveBranchCount
        : branchDrafts.filter((d) => d.name.trim()).length;
      return (
        <span className="ml-1 text-xs text-muted-foreground">
          {errs > 0 ? <span className="text-destructive">({errs})</span> : count ? `(${count})` : null}
        </span>
      );
    }
    if (errs > 0) {
      return <span className="ml-1 text-xs text-destructive">({errs})</span>;
    }
    return null;
  };

  // ── Retry branch load ─────────────────────────────────────────────────────────
  const retryBranchLoad = useCallback(() => {
    if (!selectedTemplate?.id || !organizationId) return;
    setBranchLoadState("loading");
    loadDraftBranchesForTemplate(organizationId, selectedTemplate.id)
      .then((drafts) => {
        setBranchDrafts(drafts);
        setBranchLoadState("success");
      })
      .catch(() => setBranchLoadState("error"));
  }, [selectedTemplate?.id, organizationId]);

  // ── Preset handlers (Phase 2) ─────────────────────────────────────────────────

  const handleSavePreset = useCallback(
    async (presetName: string, description: string, includeOptions: boolean) => {
      if (!organizationId || !selectedParentOption) return;
      if (!selectedTemplate?.id) {
        toast({
          description: "Save the template first, then create reusable sets from the Edit view.",
        });
        return;
      }
      const rootDrafts = branchDrafts.filter(
        (d) => d.parent_branch_local_id === null && d.parent_option_value === selectedParentOption,
      );
      const schema = buildPresetFromParentOption(rootDrafts, branchDrafts, includeOptions);
      if (schema.length === 0) {
        toast({ description: "No fields to save. Configure some dependent fields first." });
        return;
      }
      if (!presetDbAvailable) {
        toast({
          variant: "destructive",
          description: "Preset storage requires a database migration. Contact your administrator.",
        });
        return;
      }
      const payload = {
        organization_id: organizationId,
        parent_template_id: selectedTemplate.id,
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
        parentTemplateId: selectedTemplate.id as string,
        name: data.name as string,
        description: (data.description as string | null) ?? null,
        fieldSchema: deserializePresetSchema(data.field_schema),
        isDefault: Boolean(data.is_default),
        enforceOnAllParentOptions: Boolean(data.enforce_on_all_parent_options),
        createdAt: data.created_at as string,
        updatedAt: data.updated_at as string,
      };
      setSavedPresets((prev) => [newPreset, ...prev]);
      toast({ description: `"${newPreset.name}" saved as a reusable set.` });
    },
    [organizationId, selectedTemplate?.id, selectedParentOption, branchDrafts, presetDbAvailable, toast],
  );

  const handleApplyPreset = useCallback(
    (preset: ReusableSubFieldSet, targetOptions: string[], mode: ApplyPresetMode) => {
      const { drafts, appliedTo, skipped } = applyPresetToParentOptions(
        branchDrafts,
        preset.fieldSchema,
        targetOptions,
        mode,
      );
      setBranchDrafts(drafts);
      const msg =
        appliedTo > 0
          ? `Applied "${preset.name}" to ${appliedTo} option${appliedTo !== 1 ? "s" : ""}${skipped > 0 ? ` (${skipped} already complete)` : ""}.`
          : `All selected options already have the full structure — nothing changed.`;
      toast({ description: msg });
    },
    [branchDrafts, toast],
  );

  const presetSummaries: PresetSummary[] = useMemo(
    () =>
      savedPresets.map((p) => ({
        id: p.id,
        name: p.name,
        fieldCount: p.fieldSchema.length,
        isDefault: p.isDefault,
        enforceOnAllParentOptions: p.enforceOnAllParentOptions,
        updatedAt: p.updatedAt,
      })),
    [savedPresets],
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────────

  const isSelectType = type === "select" || type === "checkbox";
  const showDependentTab = allowConditionalDropdown && type === "select";

  const saveDisabled =
    saving ||
    branchLoadState === "loading" ||
    branchLoadState === "error" ||
    hasBlockingErrors ||
    !name.trim() ||
    (isSelectType && !isServerPagedMode && options.length === 0) ||
    !organizationId;

  const savingLabel = (() => {
    if (!saving) return selectedTemplate ? "Update Template" : "Create Template";
    const phase = progress.phase;
    if (phase) return phase;
    return "Saving…";
  })();

  return (
    <>
      <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent
          className="w-[96vw] max-w-6xl h-[92vh] max-h-[92vh] overflow-hidden p-0 flex flex-col"
          onInteractOutside={(e) => {
            if (saving) e.preventDefault();
          }}
          onEscapeKeyDown={(e) => {
            if (saving) e.preventDefault();
          }}
        >
          {/* ── Sticky header ───────────────────────────────────────────── */}
          <DialogHeader className="border-b px-6 py-4 shrink-0">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <DialogTitle className="text-lg font-semibold">
                  {selectedTemplate ? "Edit Form Field Template" : "Create Form Field Template"}
                </DialogTitle>
                <DialogDescription className="sr-only">
                  Create a reusable form field template that can be assigned to multiple categories.
                </DialogDescription>
                {/* Summary chips */}
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {name.trim() && (
                    <Badge variant="outline" className="text-xs font-normal">
                      {name.trim()}
                    </Badge>
                  )}
                  <Badge variant="secondary" className="text-xs font-normal capitalize">
                    {type}
                  </Badge>
                  {required && (
                    <Badge variant="secondary" className="text-xs font-normal">
                      Required
                    </Badge>
                  )}
                  {isServerPagedMode ? (
                    summary.summary && (
                      <>
                        <Badge variant="outline" className="text-xs font-normal">
                          {summary.summary.parentOptionCount} parent options
                        </Badge>
                        <Badge variant="outline" className="text-xs font-normal">
                          {summary.summary.totalActiveBranchCount} dependent fields
                        </Badge>
                        {summary.summary.incompleteOptionCount > 0 && (
                          <Badge variant="destructive" className="text-xs font-normal">
                            {summary.summary.incompleteOptionCount} incomplete
                          </Badge>
                        )}
                        {summary.summary.legacyOrphanGroupCount > 0 && (
                          <button
                            type="button"
                            onClick={() => setOrphanDialogOpen(true)}
                            className="focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-full"
                          >
                            <Badge
                              variant="outline"
                              className="text-xs font-normal text-amber-600 border-amber-400 cursor-pointer hover:bg-amber-50"
                            >
                              {summary.summary.legacyOrphanGroupCount} legacy orphan group
                              {summary.summary.legacyOrphanGroupCount !== 1 ? "s" : ""}
                            </Badge>
                          </button>
                        )}
                      </>
                    )
                  ) : (
                    <>
                      {isSelectType && options.length > 0 && (
                        <Badge variant="outline" className="text-xs font-normal">
                          {options.length} parent options
                        </Badge>
                      )}
                      {showDependentTab && branchDrafts.filter((d) => d.name.trim()).length > 0 && (
                        <Badge variant="outline" className="text-xs font-normal">
                          {branchDrafts.filter((d) => d.name.trim()).length} dependent fields
                        </Badge>
                      )}
                    </>
                  )}
                  {isDirty && (
                    <Badge variant="outline" className="text-xs text-amber-600 border-amber-400">
                      Unsaved changes
                    </Badge>
                  )}
                </div>
              </div>
            </div>
          </DialogHeader>

          {/* ── Section tabs ─────────────────────────────────────────────── */}
          <div className="border-b px-6 shrink-0 overflow-x-auto">
            <Tabs
              value={activeSection}
              onValueChange={(v) => setActiveSection(v as Section)}
              className="w-max"
            >
              <TabsList className="h-10 bg-transparent p-0 gap-1">
                {(["basics", ...(isSelectType ? ["options"] : []), ...(showDependentTab ? ["dependent"] : []), "review"] as Section[]).map(
                  (s) => (
                    <TabsTrigger
                      key={s}
                      value={s}
                      className="data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none pb-2 text-sm"
                    >
                      {SECTION_LABELS[s]}
                      {sectionBadge(s)}
                    </TabsTrigger>
                  ),
                )}
              </TabsList>
            </Tabs>
          </div>

          {/* ── Scrollable content ───────────────────────────────────────── */}
          <div className="flex-1 overflow-y-auto min-h-0">
            {/* BASICS */}
            <div className={cn("p-6 space-y-5", activeSection !== "basics" && "hidden")}>
              <BasicsPanel
                name={name} setName={setName}
                type={type} setType={(v) => {
                  setType(v);
                  if (v !== "select") {
                    setOptions([]);
                    setOptionSearch("");
                    setBranchDrafts([]);
                    setBranchLoadState("idle");
                    setSelectedParentOption(null);
                  }
                }}
                required={required} setRequired={setRequired}
                placeholder={placeholder} setPlaceholder={setPlaceholder}
                defaultValue={defaultValue} setDefaultValue={setDefaultValue}
                helpText={helpText} setHelpText={setHelpText}
                min={min} setMin={setMin}
                max={max} setMax={setMax}
                batchEntryMode={batchEntryMode} setBatchEntryMode={setBatchEntryMode}
              />
            </div>

            {/* PARENT OPTIONS + DEPENDENT FIELDS (server-paged mode) — a single
                shared instance, since both tabs now search/browse/edit the
                same server-paged option source (DOC-097 "Phase 2"). Rendering
                two independent copies (one per tab, each merely CSS-hidden
                when inactive) would double-fetch and desync search state
                between tabs. */}
            {isServerPagedMode && organizationId && selectedTemplate && (
              <div
                className={cn(
                  "p-6 space-y-4",
                  activeSection !== "options" && activeSection !== "dependent" && "hidden",
                )}
              >
                <ServerPagedParentOptionsSection
                  organizationId={organizationId}
                  templateId={selectedTemplate.id}
                  existingOptions={selectedTemplate.options ?? []}
                  section={activeSection === "dependent" ? "dependent" : "options"}
                  savedPresets={savedPresets}
                  presetSummaries={presetSummaries}
                  presetsLoadState={presetsLoadState}
                  presetDbAvailable={presetDbAvailable}
                  onPresetCreated={(preset) => setSavedPresets((prev) => [preset, ...prev])}
                  allowNested
                  onOptionSaved={summary.refresh}
                />
              </div>
            )}

            {/* PARENT OPTIONS (create-mode / non-select-type local flow) */}
            {isSelectType && !isServerPagedMode && (
              <div className={cn("p-6 space-y-4", activeSection !== "options" && "hidden")}>
                <OptionsPanel
                  options={options}
                  indexedOptions={indexedOptions}
                  pagedOptions={pagedOptions}
                  optionSearch={optionSearch}
                  setOptionSearch={(v) => { setOptionSearch(v); setOptionPage(1); }}
                  optionPage={optionPage}
                  setOptionPage={setOptionPage}
                  totalOptionPages={totalOptionPages}
                  optionPageSize={optionPageSize}
                  setOptionPageSize={(v) => { setOptionPageSize(v); setOptionPage(1); }}
                  newOptionValue={newOptionValue}
                  setNewOptionValue={setNewOptionValue}
                  onAddOption={handleAddOption}
                  onRenameOption={handleRenameOption}
                  onDeleteOption={handleDeleteOptionRequest}
                  onOpenBulkImport={() => setBulkImportOpen(true)}
                />
              </div>
            )}

            {/* DEPENDENT FIELDS (create-mode / non-select-type local flow) */}
            {showDependentTab && !isServerPagedMode && (
              <div className={cn("flex h-full min-h-0 flex-col", activeSection !== "dependent" && "hidden")}>
                <DependentFieldsPanel
                  allOptions={options}
                  filteredParentOptions={filteredParentOptions}
                  branchDrafts={branchDrafts}
                  setBranchDrafts={setBranchDrafts}
                  branchIndexes={branchIndexes}
                  branchLoadState={branchLoadState}
                  selectedParentOption={selectedParentOption}
                  setSelectedParentOption={setSelectedParentOption}
                  parentSearch={parentSearch}
                  setParentSearch={setParentSearch}
                  showConfiguredOnly={showConfiguredOnly}
                  setShowConfiguredOnly={setShowConfiguredOnly}
                  onRetryLoad={retryBranchLoad}
                  allowNested
                  savedPresets={savedPresets}
                  presetSummaries={presetSummaries}
                  presetsLoadState={presetsLoadState}
                  hasSavedTemplate={Boolean(selectedTemplate?.id)}
                  onSavePreset={handleSavePreset}
                  onApplyPreset={handleApplyPreset}
                  dependentViewMode={dependentViewMode}
                  setDependentViewMode={(m) => { setDependentViewMode(m); setMatrixSelectedOptions(new Set()); }}
                  matrixPresetId={matrixPresetId}
                  setMatrixPresetId={(id) => { setMatrixPresetId(id); setMatrixPage(1); setMatrixSelectedOptions(new Set()); }}
                  matrixPage={matrixPage}
                  setMatrixPage={setMatrixPage}
                  matrixSelectedOptions={matrixSelectedOptions}
                  setMatrixSelectedOptions={setMatrixSelectedOptions}
                  onOpenBulkImport={() => setBulkImportOpen(true)}
                />
              </div>
            )}

            {/* REVIEW & SAVE */}
            <div className={cn("p-6 space-y-4", activeSection !== "review" && "hidden")}>
              <ReviewPanel
                name={name}
                type={type}
                required={required}
                placeholder={placeholder}
                defaultValue={defaultValue}
                helpText={helpText}
                min={min}
                max={max}
                options={options}
                branchDrafts={branchDrafts}
                validationIssues={validationIssues}
                onGoToSection={setActiveSection}
                serverSummary={isServerPagedMode ? summary.summary : null}
              />
            </div>
          </div>

          {/* ── Sticky footer ────────────────────────────────────────────── */}
          <DialogFooter className="border-t px-6 py-3 shrink-0 flex-col sm:flex-row gap-2">
            {(saving || progress.status !== "idle") && (
              <div className="flex-1 min-w-0 mr-2">
                <AsyncOperationProgress
                  status={progress.status === "idle" ? "running" : progress.status}
                  title={progress.phase}
                  description={progress.description}
                  value={
                    progress.currentStep && progress.totalSteps
                      ? Math.round((progress.currentStep / progress.totalSteps) * 100)
                      : undefined
                  }
                  compact
                />
              </div>
            )}
            <div className="flex gap-2 shrink-0 ml-auto">
              {!saving && validationIssues.some((i) => i.severity === "error") && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setActiveSection("review")}
                  className="text-destructive border-destructive/50"
                >
                  <AlertCircle className="h-4 w-4 mr-1" />
                  Review {validationIssues.filter((i) => i.severity === "error").length} issue
                  {validationIssues.filter((i) => i.severity === "error").length !== 1 ? "s" : ""}
                </Button>
              )}
              <Button variant="outline" onClick={handleClose} disabled={saving}>
                Cancel
              </Button>
              <Button
                onClick={handleSave}
                disabled={saveDisabled}
              >
                {savingLabel}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Discard confirmation */}
      <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>
              Your changes to this form field template have not been saved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Continue editing</AlertDialogCancel>
            <AlertDialogAction onClick={doClose}>Discard changes</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Shared bulk-import dialog — opened from either Parent Options or
          Dependent Fields; always folds its result into local draft state only. */}
      <DropdownBulkImportDialog
        open={bulkImportOpen}
        onOpenChange={setBulkImportOpen}
        existingOptions={options}
        existingBranchDrafts={branchDrafts}
        onApply={handleBulkImportApply}
      />

      {/* Legacy orphan groups inspector — read-only, admin-only. */}
      {isServerPagedMode && organizationId && selectedTemplate && (
        <LegacyOrphanGroupsDialog
          open={orphanDialogOpen}
          onOpenChange={setOrphanDialogOpen}
          organizationId={organizationId}
          templateId={selectedTemplate.id}
        />
      )}

      {/* Delete option confirmation */}
      {deleteConfirmOption && (
        <AlertDialog open onOpenChange={() => setDeleteConfirmOption(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove option?</AlertDialogTitle>
              <AlertDialogDescription>
                &quot;{deleteConfirmOption.value}&quot; has{" "}
                {deleteConfirmOption.branchCount} dependent field
                {deleteConfirmOption.branchCount !== 1 ? "s" : ""}. Removing it will also remove
                those unsaved dependent-field configurations.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep option</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleConfirmDeleteOption}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Remove option and fields
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  );
}

// ─── BasicsPanel ───────────────────────────────────────────────────────────────

function BasicsPanel({
  name, setName,
  type, setType,
  required, setRequired,
  placeholder, setPlaceholder,
  defaultValue, setDefaultValue,
  helpText, setHelpText,
  min, setMin,
  max, setMax,
  batchEntryMode, setBatchEntryMode,
}: {
  name: string; setName: (v: string) => void;
  type: string; setType: (v: string) => void;
  required: boolean; setRequired: (v: boolean) => void;
  placeholder: string; setPlaceholder: (v: string) => void;
  defaultValue: string; setDefaultValue: (v: string) => void;
  helpText: string; setHelpText: (v: string) => void;
  min: string; setMin: (v: string) => void;
  max: string; setMax: (v: string) => void;
  batchEntryMode: "once_per_batch" | "per_line" | null;
  setBatchEntryMode: (v: "once_per_batch" | "per_line" | null) => void;
}) {
  return (
    <div className="max-w-xl space-y-5">
      <div className="space-y-2">
        <Label htmlFor="tmpl-name">Field Name <span className="text-destructive">*</span></Label>
        <Input
          id="tmpl-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g., Odometer Reading"
          autoFocus
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="tmpl-type">Field Type <span className="text-destructive">*</span></Label>
        <Select value={type} onValueChange={setType}>
          <SelectTrigger id="tmpl-type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="text">Text</SelectItem>
            <SelectItem value="number">Number</SelectItem>
            <SelectItem value="date">Date</SelectItem>
            <SelectItem value="textarea">Textarea</SelectItem>
            <SelectItem value="select">Dropdown/Select</SelectItem>
            <SelectItem value="checkbox">Checkbox</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center justify-between">
        <Label htmlFor="tmpl-required">Required Field</Label>
        <Switch id="tmpl-required" checked={required} onCheckedChange={setRequired} />
      </div>

      <div className="flex items-start justify-between gap-3">
        <div className="space-y-0.5">
          <Label htmlFor="tmpl-batch-mode" className="text-sm font-medium">
            Ask once per batch
          </Label>
          <p className="text-xs text-muted-foreground leading-relaxed">
            When enabled, this field is shown once for the whole batch — not per expense line.
            If the same template is assigned to multiple categories, it is still asked only once.
          </p>
        </div>
        <Switch
          id="tmpl-batch-mode"
          checked={batchEntryMode === "once_per_batch"}
          onCheckedChange={(v) => setBatchEntryMode(v ? "once_per_batch" : "per_line")}
        />
      </div>

      {type !== "checkbox" && (
        <>
          <div className="space-y-2">
            <Label htmlFor="tmpl-placeholder">Placeholder</Label>
            <Input
              id="tmpl-placeholder"
              value={placeholder}
              onChange={(e) => setPlaceholder(e.target.value)}
              placeholder="e.g., Enter odometer reading"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="tmpl-default">Default Value</Label>
            <Input
              id="tmpl-default"
              value={defaultValue}
              onChange={(e) => setDefaultValue(e.target.value)}
              placeholder="Default value (optional)"
            />
          </div>
        </>
      )}

      {type === "number" && (
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="tmpl-min">Minimum Value</Label>
            <Input
              id="tmpl-min"
              type="number"
              value={min}
              onChange={(e) => setMin(e.target.value)}
              placeholder="Min"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="tmpl-max">Maximum Value</Label>
            <Input
              id="tmpl-max"
              type="number"
              value={max}
              onChange={(e) => setMax(e.target.value)}
              placeholder="Max"
            />
          </div>
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="tmpl-help">Help Text</Label>
        <Textarea
          id="tmpl-help"
          value={helpText}
          onChange={(e) => setHelpText(e.target.value)}
          placeholder="Helper text shown below the field (optional)"
          rows={2}
        />
      </div>
    </div>
  );
}

// ─── OptionsPanel ──────────────────────────────────────────────────────────────

type IndexedOption = { value: string; originalIndex: number };

function OptionsPanel({
  options,
  indexedOptions,
  pagedOptions,
  optionSearch,
  setOptionSearch,
  optionPage,
  setOptionPage,
  totalOptionPages,
  optionPageSize,
  setOptionPageSize,
  newOptionValue,
  setNewOptionValue,
  onAddOption,
  onRenameOption,
  onDeleteOption,
  onOpenBulkImport,
}: {
  options: string[];
  indexedOptions: IndexedOption[];
  pagedOptions: IndexedOption[];
  optionSearch: string;
  setOptionSearch: (v: string) => void;
  optionPage: number;
  setOptionPage: (v: number) => void;
  totalOptionPages: number;
  optionPageSize: number;
  setOptionPageSize: (v: number) => void;
  newOptionValue: string;
  setNewOptionValue: (v: string) => void;
  onAddOption: (v: string) => void;
  onRenameOption: (originalIndex: number, value: string) => void;
  onDeleteOption: (originalIndex: number) => void;
  onOpenBulkImport: () => void;
}) {
  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            value={optionSearch}
            onChange={(e) => setOptionSearch(e.target.value)}
            placeholder="Search parent options…"
            className="pl-9"
          />
        </div>
        <span className="text-sm text-muted-foreground whitespace-nowrap">
          {indexedOptions.length} of {options.length} option{options.length !== 1 ? "s" : ""}
        </span>
        {/* Page size selector */}
        <div className="flex items-center gap-1">
          {PAGE_SIZES.map((ps) => (
            <Button
              key={ps}
              variant={optionPageSize === ps ? "secondary" : "ghost"}
              size="sm"
              className="h-8 px-2 text-xs"
              onClick={() => setOptionPageSize(ps)}
            >
              {ps}
            </Button>
          ))}
        </div>
      </div>

      {/* Pagination bar */}
      {totalOptionPages > 1 && (
        <div className="flex items-center gap-2 text-sm">
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => setOptionPage(1)}
            disabled={optionPage <= 1}
            aria-label="First page"
          >
            «
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => setOptionPage(optionPage - 1)}
            disabled={optionPage <= 1}
            aria-label="Previous page"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-muted-foreground">
            Page {optionPage} of {totalOptionPages}
          </span>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => setOptionPage(optionPage + 1)}
            disabled={optionPage >= totalOptionPages}
            aria-label="Next page"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => setOptionPage(totalOptionPages)}
            disabled={optionPage >= totalOptionPages}
            aria-label="Last page"
          >
            »
          </Button>
        </div>
      )}

      {/* Option rows — only current page */}
      {pagedOptions.length > 0 ? (
        <ul className="space-y-1.5">
          {pagedOptions.map(({ value, originalIndex }) => (
            <li key={originalIndex} className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground w-10 text-right shrink-0">
                #{originalIndex + 1}
              </span>
              <Input
                value={value}
                onChange={(e) => onRenameOption(originalIndex, e.target.value)}
                className="h-9 flex-1"
                aria-label={`Option ${originalIndex + 1}`}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-9 w-9 shrink-0 text-muted-foreground hover:text-destructive"
                onClick={() => onDeleteOption(originalIndex)}
                aria-label={`Remove option ${value || originalIndex + 1}`}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground py-4 text-center">
          {optionSearch ? `No options matching "${optionSearch}"` : "No options yet. Add some below."}
        </p>
      )}

      {/* Add manually / bulk import */}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Input
          value={newOptionValue}
          onChange={(e) => setNewOptionValue(e.target.value)}
          placeholder="Type option and press Enter or Add"
          className="h-9 flex-1 min-w-40"
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); onAddOption(newOptionValue); }
            if (e.key === "Escape") setNewOptionValue("");
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-9 shrink-0"
          onClick={() => onAddOption(newOptionValue)}
          disabled={!newOptionValue.trim()}
        >
          <Plus className="h-4 w-4 mr-1" />
          Add option
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="h-9 shrink-0"
          onClick={onOpenBulkImport}
        >
          <Upload className="h-4 w-4 mr-1" />
          Paste / Import data
        </Button>
      </div>
    </div>
  );
}

// ─── DependentFieldsPanel ──────────────────────────────────────────────────────

function DependentFieldsPanel({
  allOptions,
  filteredParentOptions,
  branchDrafts,
  setBranchDrafts,
  branchIndexes,
  branchLoadState,
  selectedParentOption,
  setSelectedParentOption,
  parentSearch,
  setParentSearch,
  showConfiguredOnly,
  setShowConfiguredOnly,
  onRetryLoad,
  allowNested,
  savedPresets,
  presetSummaries,
  presetsLoadState,
  hasSavedTemplate,
  onSavePreset,
  onApplyPreset,
  dependentViewMode,
  setDependentViewMode,
  matrixPresetId,
  setMatrixPresetId,
  matrixPage,
  setMatrixPage,
  matrixSelectedOptions,
  setMatrixSelectedOptions,
  onOpenBulkImport,
}: {
  allOptions: string[];
  filteredParentOptions: string[];
  branchDrafts: DraftOptionBranch[];
  setBranchDrafts: (d: DraftOptionBranch[]) => void;
  branchIndexes: ReturnType<typeof buildBranchIndexes>;
  branchLoadState: "idle" | "loading" | "success" | "error";
  selectedParentOption: string | null;
  setSelectedParentOption: (v: string | null) => void;
  parentSearch: string;
  setParentSearch: (v: string) => void;
  showConfiguredOnly: boolean;
  setShowConfiguredOnly: (v: boolean) => void;
  onRetryLoad: () => void;
  allowNested: boolean;
  savedPresets: ReusableSubFieldSet[];
  presetSummaries: PresetSummary[];
  presetsLoadState: "idle" | "loading" | "success" | "error";
  hasSavedTemplate: boolean;
  onSavePreset: (name: string, description: string, includeOptions: boolean) => Promise<void>;
  onApplyPreset: (preset: ReusableSubFieldSet, targetOptions: string[], mode: ApplyPresetMode) => void;
  dependentViewMode: "list" | "matrix";
  setDependentViewMode: (m: "list" | "matrix") => void;
  matrixPresetId: string;
  setMatrixPresetId: (id: string) => void;
  matrixPage: number;
  setMatrixPage: (p: number) => void;
  matrixSelectedOptions: Set<string>;
  setMatrixSelectedOptions: (s: Set<string>) => void;
  onOpenBulkImport: () => void;
}) {
  const { t } = useTranslation("admin");
  if (branchLoadState === "loading") {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <AsyncOperationProgress
          status="running"
          title="Loading dependent fields…"
          description="Loading the saved dependent-field configuration for this template."
        />
      </div>
    );
  }

  if (branchLoadState === "error") {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <AsyncOperationProgress
          status="error"
          title="Dependent fields could not be loaded."
          description="The saved configuration could not be loaded. Save is disabled until loaded successfully."
          retryLabel="Retry"
          onRetry={onRetryLoad}
        />
      </div>
    );
  }

  if (allOptions.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="text-muted-foreground text-sm max-w-sm">
          Add parent options first (or import a dependent-dropdown table — it will create the parent
          options and dependent fields together).
        </p>
        <Button type="button" variant="secondary" size="sm" onClick={onOpenBulkImport}>
          <Upload className="h-4 w-4 mr-1.5" />
          Import data
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0 divide-x">
      {/* Left pane: parent option navigator */}
      <div className="w-64 shrink-0 flex flex-col overflow-hidden">
        <div className="p-3 space-y-2 border-b">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              value={parentSearch}
              onChange={(e) => setParentSearch(e.target.value)}
              placeholder="Search options…"
              className="h-8 pl-8 text-sm"
            />
          </div>
          <button
            type="button"
            onClick={() => setShowConfiguredOnly(!showConfiguredOnly)}
            className={cn(
              "flex items-center gap-1.5 text-xs px-2 py-1 rounded-md transition-colors w-full",
              showConfiguredOnly
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-muted",
            )}
          >
            <Filter className="h-3 w-3" />
            Configured only
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {filteredParentOptions.length === 0 ? (
            <p className="text-xs text-muted-foreground p-3">No options match</p>
          ) : (
            <ul>
              {filteredParentOptions.map((opt) => {
                const count = branchIndexes.branchCountByParentOption.get(opt) ?? 0;
                const isSelected = selectedParentOption === opt;
                return (
                  <li key={opt}>
                    <button
                      type="button"
                      onClick={() => setSelectedParentOption(opt)}
                      aria-current={isSelected ? "true" : undefined}
                      className={cn(
                        "w-full text-left px-3 py-2 text-sm flex items-center justify-between gap-2 hover:bg-muted/50 transition-colors",
                        isSelected && "bg-primary/10 text-primary font-medium",
                      )}
                    >
                      <span className="truncate min-w-0">{opt}</span>
                      {count > 0 && (
                        <Badge variant="secondary" className="text-xs shrink-0 h-5">
                          {count}
                        </Badge>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {/* Right pane: view toggle + content */}
      <div className="flex flex-col flex-1 min-h-0">
        {/* View mode toggle bar */}
        <div className="flex items-center gap-1 px-3 py-1.5 border-b shrink-0">
          <span className="text-xs text-muted-foreground mr-1">{t("matrix.view.label", { defaultValue: "View:" })}</span>
          <button
            type="button"
            onClick={() => setDependentViewMode("list")}
            className={cn(
              "flex items-center gap-1 text-xs px-2 py-1 rounded-md transition-colors",
              dependentViewMode === "list"
                ? "bg-primary/10 text-primary font-medium"
                : "text-muted-foreground hover:bg-muted",
            )}
          >
            <List className="h-3 w-3" />
            {t("matrix.view.list", { defaultValue: "List" })}
          </button>
          <button
            type="button"
            onClick={() => setDependentViewMode("matrix")}
            className={cn(
              "flex items-center gap-1 text-xs px-2 py-1 rounded-md transition-colors",
              dependentViewMode === "matrix"
                ? "bg-primary/10 text-primary font-medium"
                : "text-muted-foreground hover:bg-muted",
            )}
          >
            <LayoutGrid className="h-3 w-3" />
            {t("matrix.view.matrix", { defaultValue: "Matrix" })}
          </button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 ml-auto text-xs"
            onClick={onOpenBulkImport}
          >
            <Upload className="h-3.5 w-3.5 mr-1" />
            Import data
          </Button>
        </div>

        {dependentViewMode === "matrix" ? (
          <MatrixEditorPanel
            allOptions={allOptions}
            savedPresets={savedPresets}
            branchDrafts={branchDrafts}
            setBranchDrafts={setBranchDrafts}
            branchIndexes={branchIndexes}
            matrixPresetId={matrixPresetId}
            setMatrixPresetId={setMatrixPresetId}
            matrixPage={matrixPage}
            setMatrixPage={setMatrixPage}
            matrixSelectedOptions={matrixSelectedOptions}
            setMatrixSelectedOptions={setMatrixSelectedOptions}
          />
        ) : (
          /* List view */
          <div className="flex-1 overflow-y-auto p-4">
            {selectedParentOption === null ? (
              <div className="flex h-full items-center justify-center">
                <p className="text-muted-foreground text-sm">
                  Select a parent option from the left to configure its dependent fields.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="font-medium text-sm truncate min-w-0">
                    Dependent fields for &quot;{selectedParentOption}&quot;
                  </h3>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <span className="text-xs text-muted-foreground">
                      {branchIndexes.branchCountByParentOption.get(selectedParentOption) ?? 0} field
                      {(branchIndexes.branchCountByParentOption.get(selectedParentOption) ?? 0) !== 1
                        ? "s"
                        : ""}
                    </span>
                    <PresetToolbar
                      selectedParentOption={selectedParentOption}
                      allOptions={allOptions}
                      branchDrafts={branchDrafts}
                      savedPresets={savedPresets}
                      presetSummaries={presetSummaries}
                      presetsLoadState={presetsLoadState}
                      hasSavedTemplate={hasSavedTemplate}
                      onSavePreset={onSavePreset}
                      onApplyPreset={onApplyPreset}
                    />
                  </div>
                </div>
                {/* Pass only the selected option — renders ONE OptionSection instead of 400+ */}
                <OptionBranchEditor
                  options={[selectedParentOption]}
                  drafts={branchDrafts}
                  onChange={setBranchDrafts}
                  allowNested={allowNested}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── ReviewPanel ───────────────────────────────────────────────────────────────

function ReviewPanel({
  name,
  type,
  required,
  placeholder,
  defaultValue,
  helpText,
  min,
  max,
  options,
  branchDrafts,
  validationIssues,
  onGoToSection,
  serverSummary,
}: {
  name: string;
  type: string;
  required: boolean;
  placeholder: string;
  defaultValue: string;
  helpText: string;
  min: string;
  max: string;
  options: string[];
  branchDrafts: DraftOptionBranch[];
  validationIssues: ReturnType<typeof validateTemplate>;
  onGoToSection: (s: Section) => void;
  /** When set (server-paged mode), the "Configuration summary" section is
   *  sourced from this server aggregate instead of options/branchDrafts,
   *  which are never fully downloaded in that mode. */
  serverSummary?: TemplateEditorSummary | null;
}) {
  const namedBranches = branchDrafts.filter((d) => d.name.trim());
  const rootBranches = namedBranches.filter((d) => !d.parent_branch_local_id);
  const nestedBranches = namedBranches.filter((d) => d.parent_branch_local_id);
  const configuredParents = new Set(rootBranches.map((d) => d.parent_option_value));
  const errors = validationIssues.filter((i) => i.severity === "error");
  const warnings = validationIssues.filter((i) => i.severity === "warning");

  return (
    <div className="max-w-2xl space-y-6">
      {/* Summary */}
      <section className="space-y-3">
        <h3 className="font-semibold">Template details</h3>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Name</dt>
          <dd>{name || <span className="text-destructive italic">Required</span>}</dd>
          <dt className="text-muted-foreground">Type</dt>
          <dd className="capitalize">{type}</dd>
          <dt className="text-muted-foreground">Required</dt>
          <dd>{required ? "Yes" : "No"}</dd>
          {placeholder && <><dt className="text-muted-foreground">Placeholder</dt><dd>{placeholder}</dd></>}
          {defaultValue && <><dt className="text-muted-foreground">Default</dt><dd>{defaultValue}</dd></>}
          {(type === "number" && (min || max)) && (
            <><dt className="text-muted-foreground">Range</dt><dd>{min || "—"} to {max || "—"}</dd></>
          )}
        </dl>
      </section>

      {(type === "select" || type === "checkbox") && (
        <section className="space-y-2">
          <h3 className="font-semibold">Configuration summary</h3>
          {serverSummary ? (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-muted-foreground">Parent options</dt>
              <dd>{serverSummary.parentOptionCount}</dd>
              <dt className="text-muted-foreground">Configured options</dt>
              <dd>{serverSummary.configuredParentOptionCount}</dd>
              <dt className="text-muted-foreground">Root dependent fields</dt>
              <dd>{serverSummary.activeRootBranchCount}</dd>
              <dt className="text-muted-foreground">Nested dependent fields</dt>
              <dd>{serverSummary.activeNestedBranchCount}</dd>
              <dt className="text-muted-foreground">Total dependent fields</dt>
              <dd>{serverSummary.totalActiveBranchCount}</dd>
              {serverSummary.incompleteOptionCount > 0 && (
                <>
                  <dt className="text-destructive">Incomplete options</dt>
                  <dd className="text-destructive">{serverSummary.incompleteOptionCount}</dd>
                </>
              )}
              {serverSummary.legacyOrphanGroupCount > 0 && (
                <>
                  <dt className="text-amber-600">Legacy orphan groups</dt>
                  <dd className="text-amber-600">{serverSummary.legacyOrphanGroupCount}</dd>
                </>
              )}
            </dl>
          ) : (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-muted-foreground">Parent options</dt>
              <dd>{options.length}</dd>
              {type === "select" && (
                <>
                  <dt className="text-muted-foreground">Configured options</dt>
                  <dd>{configuredParents.size}</dd>
                  <dt className="text-muted-foreground">Root dependent fields</dt>
                  <dd>{rootBranches.length}</dd>
                  <dt className="text-muted-foreground">Nested dependent fields</dt>
                  <dd>{nestedBranches.length}</dd>
                  <dt className="text-muted-foreground">Total dependent fields</dt>
                  <dd>{namedBranches.length}</dd>
                </>
              )}
            </dl>
          )}
        </section>
      )}

      {/* Validation */}
      {errors.length > 0 && (
        <section className="space-y-2">
          <h3 className="font-semibold flex items-center gap-2 text-destructive">
            <AlertCircle className="h-4 w-4" />
            {errors.length} issue{errors.length !== 1 ? "s" : ""} must be fixed
          </h3>
          <ul className="space-y-1.5">
            {errors.map((issue, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
                <span className="flex-1">{issue.message}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-xs px-2 shrink-0"
                  onClick={() => onGoToSection(issue.section)}
                >
                  Go to {SECTION_LABELS[issue.section]}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {warnings.length > 0 && (
        <section className="space-y-2">
          <h3 className="font-semibold text-amber-600 dark:text-amber-400">
            {warnings.length} warning{warnings.length !== 1 ? "s" : ""}
          </h3>
          <ul className="space-y-1 text-sm text-muted-foreground">
            {warnings.map((issue, i) => (
              <li key={i}>{issue.message}</li>
            ))}
          </ul>
        </section>
      )}

      {errors.length === 0 && (
        <section className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
          <CheckCircle2 className="h-5 w-5" />
          Ready to save
        </section>
      )}
    </div>
  );
}
