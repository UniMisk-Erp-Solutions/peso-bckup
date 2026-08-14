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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  ChevronDown,
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
  type ReusableSubFieldDefinition,
  type ReusableSubFieldSet,
  type PresetSummary,
  type ApplyPresetMode,
  type MatrixRow,
} from "@/lib/formBuilder/subFieldPresets";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { useOperationProgress } from "@/hooks/useOperationProgress";
import { AsyncOperationProgress } from "@/components/AsyncOperationProgress";
import { OptionBranchEditor } from "@/components/OptionBranchEditor";
import {
  loadDraftBranchesForTemplate,
  saveOptionBranchConfigurationAtomically,
  type DraftOptionBranch,
} from "@/lib/optionBranchPersistence";
import {
  buildIndexedOptions,
  buildBranchIndexes,
  buildCleanedOptions,
  buildTemplateData,
  countBranchesForOption,
  deleteParentOption,
  isSnapshotDirty,
  makeSnapshot,
  mergeBulkOptions,
  pageCount,
  paginateItems,
  parseBulkOptionValues,
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
  const [bulkInput, setBulkInput] = useState("");
  const [bulkFileName, setBulkFileName] = useState("");
  const [bulkOpen, setBulkOpen] = useState(false);
  const [lastBulkSummary, setLastBulkSummary] = useState("");
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

  // ── UI state ──────────────────────────────────────────────────────────────────
  const [activeSection, setActiveSection] = useState<Section>("basics");
  const [saving, setSaving] = useState(false);
  const [templateUpdatedAt, setTemplateUpdatedAt] = useState<string | null>(null);

  // ── Dirty-state tracking ──────────────────────────────────────────────────────
  const openingSnapshot = useRef<string>("");
  const [discardOpen, setDiscardOpen] = useState(false);

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
  const validationIssues = useMemo(
    () =>
      validateTemplate({
        name,
        type,
        options,
        branchDrafts,
      }),
    [name, type, options, branchDrafts],
  );

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
    setBulkInput("");
    setBulkFileName("");
    setLastBulkSummary("");
    setBulkOpen(false);
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

    // Load branch drafts for existing select templates
    if (tmpl && allowConditionalDropdown && tp === "select" && organizationId) {
      setBranchLoadState("loading");
      loadDraftBranchesForTemplate(organizationId, tmpl.id)
        .then((drafts) => {
          setBranchDrafts(drafts);
          setBranchLoadState("success");
          // Update baseline to include loaded drafts
          setTimeout(() => {
            openingSnapshot.current = makeSnapshot({
              name: n, type: tp, required: req, placeholder: ph,
              defaultValue: dv, helpText: ht, min: mn, max: mx,
              options: opts, branchDrafts: drafts,
            });
          }, 0);
        })
        .catch(() => {
          setBranchLoadState("error");
        });
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

  const handleBulkAdd = useCallback(() => {
    const incoming = parseBulkOptionValues(bulkInput);
    const { next, added, skipped } = mergeBulkOptions(options, incoming);
    setOptions(next);
    setBulkInput("");
    setLastBulkSummary(`${added} added, ${skipped} duplicate${skipped !== 1 ? "s" : ""} skipped`);
    if (added > 0) {
      toast({ description: `${added} option${added !== 1 ? "s" : ""} added (${skipped} skipped)` });
    }
  }, [bulkInput, options, toast]);

  const handleFileUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      setBulkFileName(file.name);
      const reader = new FileReader();
      reader.onload = (ev) => {
        const text = ev.target?.result as string;
        const incoming = parseBulkOptionValues(text);
        const { next, added, skipped } = mergeBulkOptions(options, incoming);
        setOptions(next);
        setLastBulkSummary(`${added} added, ${skipped} duplicate${skipped !== 1 ? "s" : ""} skipped`);
        toast({ description: `Imported ${file.name}: ${added} added, ${skipped} skipped` });
      };
      reader.readAsText(file);
      e.target.value = "";
    },
    [options, toast],
  );

  // ── Save handler ──────────────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (!organizationId) return;
    const totalSteps = selectedTemplate ? 5 : 4;

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
        description: `Checking ${options.length} parent options and ${branchDrafts.length} dependent fields.`,
        currentStep: 1,
        totalSteps,
      });
      await new Promise((r) => setTimeout(r, 50)); // allow UI to paint

      if (selectedTemplate) {
        // ── Existing template save order ────────────────────────────────────────
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

      } else {
        // ── New template save order ─────────────────────────────────────────────
        // Step 2: Insert template metadata (branches need the ID)
        updateOperation("Creating template…", {
          description: "Saving the field name, type and validation settings.",
          currentStep: 2,
          totalSteps,
        });
        const { data: inserted, error: insertError } = await supabase
          .from("expense_form_field_templates")
          .insert(templateData)
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
          await saveOptionBranchConfigurationAtomically(
            organizationId,
            inserted.id,
            inserted.updated_at ?? null,
            cleanedOptions,
            branchDrafts,
          );
        }
      }

      // Step 4 (new: 3 | existing: 4): Refresh templates
      const refreshStep = selectedTemplate ? 4 : (allowConditionalDropdown && type === "select" ? 4 : 3);
      updateOperation("Refreshing form templates…", {
        description: "Loading the latest saved template configuration.",
        currentStep: refreshStep,
        totalSteps,
      });
      onSaved();

      // Success
      completeOperation(
        selectedTemplate
          ? `Template updated — ${cleanedOptions.length} options saved`
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
      const err = e as { message?: string };
      const msg = err?.message ?? "";

      if (msg.startsWith("stale_edit:")) {
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
  ]);

  // ── Section tab label helpers ─────────────────────────────────────────────────
  const sectionBadge = (s: Section) => {
    const errs = errorsBySection[s];
    if (s === "options" && (type === "select" || type === "checkbox")) {
      const count = options.length;
      return (
        <span className="ml-1 text-xs text-muted-foreground">
          {errs > 0 ? <span className="text-destructive">({errs} issue{errs !== 1 ? "s" : ""})</span> : `(${count})`}
        </span>
      );
    }
    if (s === "dependent" && type === "select") {
      const count = branchDrafts.filter((d) => d.name.trim()).length;
      return (
        <span className="ml-1 text-xs text-muted-foreground">
          {errs > 0 ? <span className="text-destructive">({errs})</span> : count > 0 ? `(${count})` : null}
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
      if (!organizationId || !selectedTemplate?.id || !selectedParentOption) return;
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
    (isSelectType && options.length === 0) ||
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
                    setBulkInput("");
                    setBulkFileName("");
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

            {/* PARENT OPTIONS */}
            {isSelectType && (
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
                  bulkOpen={bulkOpen}
                  setBulkOpen={setBulkOpen}
                  bulkInput={bulkInput}
                  setBulkInput={setBulkInput}
                  bulkFileName={bulkFileName}
                  lastBulkSummary={lastBulkSummary}
                  onBulkAdd={handleBulkAdd}
                  onFileUpload={handleFileUpload}
                />
              </div>
            )}

            {/* DEPENDENT FIELDS */}
            {showDependentTab && (
              <div className={cn("flex h-full min-h-0", activeSection !== "dependent" && "hidden")}>
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
  bulkOpen,
  setBulkOpen,
  bulkInput,
  setBulkInput,
  bulkFileName,
  lastBulkSummary,
  onBulkAdd,
  onFileUpload,
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
  bulkOpen: boolean;
  setBulkOpen: (v: boolean) => void;
  bulkInput: string;
  setBulkInput: (v: string) => void;
  bulkFileName: string;
  lastBulkSummary: string;
  onBulkAdd: () => void;
  onFileUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);

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

      {/* Add single option */}
      <div className="flex items-center gap-2 pt-1">
        <Input
          value={newOptionValue}
          onChange={(e) => setNewOptionValue(e.target.value)}
          placeholder="Type option and press Enter or Add"
          className="h-9 flex-1"
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
      </div>

      {/* Bulk add collapsible */}
      <Collapsible open={bulkOpen} onOpenChange={setBulkOpen} className="border rounded-md">
        <CollapsibleTrigger className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium hover:bg-muted/50">
          Bulk add parent options
          <ChevronDown className={cn("h-4 w-4 transition-transform", bulkOpen && "rotate-180")} />
        </CollapsibleTrigger>
        <CollapsibleContent className="px-4 pb-4 space-y-3">
          <Textarea
            value={bulkInput}
            onChange={(e) => setBulkInput(e.target.value)}
            placeholder="Paste option values, one per line or comma-separated"
            rows={4}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onBulkAdd} disabled={!bulkInput.trim()}>
              Add pasted options
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
              Upload CSV/TXT
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.txt"
              className="hidden"
              onChange={onFileUpload}
            />
          </div>
          {bulkFileName && (
            <p className="text-xs text-muted-foreground">Last uploaded: {bulkFileName}</p>
          )}
          {lastBulkSummary && (
            <p className="text-xs text-green-600 dark:text-green-400">{lastBulkSummary}</p>
          )}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

// ─── MatrixCellEditor ─────────────────────────────────────────────────────────

const MATRIX_PAGE_SIZE = 20;

function MatrixCellEditor({
  fieldKey,
  fieldName,
  fieldType,
  currentOptions,
  onSave,
  children,
}: {
  fieldKey: string;
  fieldName: string;
  fieldType: string;
  currentOptions: string[];
  onSave: (options: string[]) => void;
  children: React.ReactNode;
}) {
  const { t } = useTranslation("admin");
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(currentOptions.join("\n"));

  const needsChoices = fieldType === "select" || fieldType === "checkbox_group" || fieldType === "radio";

  function handleSave() {
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    onSave(lines);
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-64 p-3 space-y-2" side="right" align="start">
        <p className="text-xs font-medium">{fieldName}</p>
        {needsChoices ? (
          <>
            <p className="text-xs text-muted-foreground">{t("matrix.cellOnePerLine", { defaultValue: "One choice per line" })}</p>
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={5}
              className="text-xs font-mono resize-none"
              placeholder={t("matrix.choicesPlaceholder", { defaultValue: "Option A\nOption B\nOption C" })}
            />
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            {t("matrix.noChoicesHint", { fieldType, defaultValue: `This field type (${fieldType}) has no configurable choices. Tick its presence by clicking Save.` })}
          </p>
        )}
        <div className="flex justify-end gap-1.5">
          <Button size="sm" variant="outline" onClick={() => setOpen(false)}>
            {t("matrix.cancel", { defaultValue: "Cancel" })}
          </Button>
          <Button size="sm" onClick={handleSave}>
            {t("matrix.save", { defaultValue: "Save" })}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ─── MatrixEditorPanel ────────────────────────────────────────────────────────

function MatrixEditorPanel({
  allOptions,
  savedPresets,
  branchDrafts,
  setBranchDrafts,
  branchIndexes,
  matrixPresetId,
  setMatrixPresetId,
  matrixPage,
  setMatrixPage,
  matrixSelectedOptions,
  setMatrixSelectedOptions,
}: {
  allOptions: string[];
  savedPresets: ReusableSubFieldSet[];
  branchDrafts: DraftOptionBranch[];
  setBranchDrafts: (d: DraftOptionBranch[]) => void;
  branchIndexes: ReturnType<typeof buildBranchIndexes>;
  matrixPresetId: string;
  setMatrixPresetId: (id: string) => void;
  matrixPage: number;
  setMatrixPage: (p: number) => void;
  matrixSelectedOptions: Set<string>;
  setMatrixSelectedOptions: (s: Set<string>) => void;
}) {
  const { t } = useTranslation("admin");
  const selectedPreset = savedPresets.find((p) => p.id === matrixPresetId) ?? null;
  const schema = selectedPreset ? deserializePresetSchema(selectedPreset.fieldSchema) : [];

  const matrixRows: MatrixRow[] = useMemo(
    () => (schema.length > 0 ? buildPresetMatrix(allOptions, schema, branchDrafts) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allOptions, matrixPresetId, branchDrafts],
  );

  const totalPages = Math.max(1, Math.ceil(allOptions.length / MATRIX_PAGE_SIZE));
  const pageOptions = paginateItems(allOptions, matrixPage, MATRIX_PAGE_SIZE);
  const pageRows = matrixRows.filter((r) => pageOptions.includes(r.parentOptionValue));

  const allPageSelected =
    pageOptions.length > 0 && pageOptions.every((o) => matrixSelectedOptions.has(o));
  const somePageSelected = pageOptions.some((o) => matrixSelectedOptions.has(o));

  function togglePageAll() {
    const next = new Set(matrixSelectedOptions);
    if (allPageSelected) {
      pageOptions.forEach((o) => next.delete(o));
    } else {
      pageOptions.forEach((o) => next.add(o));
    }
    setMatrixSelectedOptions(next);
  }

  function toggleRow(opt: string) {
    const next = new Set(matrixSelectedOptions);
    if (next.has(opt)) {
      next.delete(opt);
    } else {
      next.add(opt);
    }
    setMatrixSelectedOptions(next);
  }

  function handleCellSave(
    parentOptionValue: string,
    fieldKey: string,
    options: string[],
  ) {
    const rootsForOption = branchIndexes.rootsByParentOption.get(parentOptionValue) ?? [];
    const existing = rootsForOption.find((b) => b.field_key === fieldKey);
    if (existing) {
      setBranchDrafts(
        branchDrafts.map((b) =>
          b.localId === existing.localId ? { ...b, options } : b,
        ),
      );
    } else {
      // Create a new draft for this option+field
      const newDraft: DraftOptionBranch = {
        localId: `local-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        dbId: null,
        parent_option_value: parentOptionValue,
        parent_branch_local_id: null,
        field_key: fieldKey,
        name: schema.find((s) => s.fieldKey === fieldKey)?.name ?? fieldKey,
        field_type: schema.find((s) => s.fieldKey === fieldKey)?.fieldType ?? "text",
        required: schema.find((s) => s.fieldKey === fieldKey)?.required ?? false,
        placeholder: schema.find((s) => s.fieldKey === fieldKey)?.placeholder ?? "",
        help_text: schema.find((s) => s.fieldKey === fieldKey)?.helpText ?? "",
        options,
        display_order: schema.findIndex((s) => s.fieldKey === fieldKey),
      };
      setBranchDrafts([...branchDrafts, newDraft]);
    }
  }

  function applyPresetToSelected() {
    if (!selectedPreset) return;
    const targets = Array.from(matrixSelectedOptions);
    const result = applyPresetToParentOptions(branchDrafts, schema, targets, "merge");
    setBranchDrafts(result.drafts);
    setMatrixSelectedOptions(new Set());
  }

  if (savedPresets.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-8 text-center">
        <p className="text-muted-foreground text-sm">
          {t("matrix.noPresets", { defaultValue: "No saved presets. Save a preset from the list view first to use the matrix editor." })}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b shrink-0">
        <span className="text-xs text-muted-foreground shrink-0">{t("matrix.presetColumnsLabel", { defaultValue: "Preset columns:" })}</span>
        <Select value={matrixPresetId} onValueChange={setMatrixPresetId}>
          <SelectTrigger className="h-7 text-xs flex-1 max-w-[220px]">
            <SelectValue placeholder={t("matrix.selectPresetPlaceholder", { defaultValue: "Select a preset…" })} />
          </SelectTrigger>
          <SelectContent>
            {savedPresets.map((p) => (
              <SelectItem key={p.id} value={p.id} className="text-xs">
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {matrixSelectedOptions.size > 0 && (
          <Button size="sm" variant="secondary" className="h-7 text-xs" onClick={applyPresetToSelected}>
            {t("matrix.applyToSelected", { count: matrixSelectedOptions.size, defaultValue: `Apply preset to selected (${matrixSelectedOptions.size})` })}
          </Button>
        )}

        <div className="flex items-center gap-1 ml-auto">
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            disabled={matrixPage <= 1}
            onClick={() => setMatrixPage(matrixPage - 1)}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            {matrixPage} / {totalPages}
          </span>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            disabled={matrixPage >= totalPages}
            onClick={() => setMatrixPage(matrixPage + 1)}
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Matrix table */}
      {!selectedPreset || schema.length === 0 ? (
        <div className="flex-1 flex items-center justify-center p-8 text-center">
          <p className="text-muted-foreground text-sm">
            {t("matrix.selectPresetPrompt", { defaultValue: "Select a preset to define matrix columns." })}
          </p>
        </div>
      ) : (
        <div className="flex-1 overflow-auto">
          <table className="text-xs border-collapse w-full">
            <thead className="sticky top-0 z-10 bg-background">
              <tr>
                {/* Sticky checkbox header cell */}
                <th className="sticky left-0 z-20 bg-background border-b border-r px-2 py-1.5 w-6">
                  <button
                    type="button"
                    aria-label={allPageSelected ? t("matrix.deselectAllPage", { defaultValue: "Deselect all on page" }) : t("matrix.selectAllPage", { defaultValue: "Select all on page" })}
                    onClick={togglePageAll}
                    className="flex items-center justify-center"
                  >
                    {allPageSelected ? (
                      <CheckSquare className="h-3.5 w-3.5 text-primary" />
                    ) : somePageSelected ? (
                      <Minus className="h-3.5 w-3.5 text-muted-foreground" />
                    ) : (
                      <Square className="h-3.5 w-3.5 text-muted-foreground" />
                    )}
                  </button>
                </th>
                {/* Sticky option-name header */}
                <th className="sticky left-7 z-20 bg-background border-b border-r px-3 py-1.5 text-left font-medium text-muted-foreground min-w-[140px]">
                  {t("matrix.columnOption", { defaultValue: "Option" })}
                </th>
                {/* Field columns */}
                {schema.map((col) => (
                  <th
                    key={col.fieldKey}
                    className="border-b border-r px-3 py-1.5 text-left font-medium text-muted-foreground whitespace-nowrap min-w-[100px]"
                  >
                    {col.name}
                    {col.required && <span className="text-destructive ml-0.5">*</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pageRows.map((row) => (
                <tr
                  key={row.parentOptionValue}
                  className={cn(
                    "hover:bg-muted/30 transition-colors",
                    matrixSelectedOptions.has(row.parentOptionValue) && "bg-primary/5",
                  )}
                >
                  {/* Checkbox */}
                  <td className="sticky left-0 z-10 bg-inherit border-b border-r px-2 py-1.5 w-6">
                    <button
                      type="button"
                      aria-label={t("matrix.toggleRow", { option: row.parentOptionValue, defaultValue: `Toggle ${row.parentOptionValue}` })}
                      onClick={() => toggleRow(row.parentOptionValue)}
                      className="flex items-center justify-center"
                    >
                      {matrixSelectedOptions.has(row.parentOptionValue) ? (
                        <CheckSquare className="h-3.5 w-3.5 text-primary" />
                      ) : (
                        <Square className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                    </button>
                  </td>
                  {/* Option name */}
                  <td className="sticky left-7 z-10 bg-inherit border-b border-r px-3 py-1.5 font-medium truncate max-w-[160px]">
                    {row.parentOptionValue}
                  </td>
                  {/* Cells */}
                  {row.cells.map((cell) => {
                    const fieldDef = schema.find((s) => s.fieldKey === cell.fieldKey);
                    const needsChoices =
                      fieldDef?.fieldType === "select" ||
                      fieldDef?.fieldType === "checkbox_group" ||
                      fieldDef?.fieldType === "radio";

                    let cellIcon: React.ReactNode;
                    if (cell.isComplete) {
                      cellIcon = <Check className="h-3.5 w-3.5 text-green-600" />;
                    } else if (cell.draft !== null) {
                      cellIcon = <AlertCircle className="h-3.5 w-3.5 text-amber-500" />;
                    } else {
                      cellIcon = <X className="h-3.5 w-3.5 text-muted-foreground/40" />;
                    }

                    return (
                      <td key={cell.fieldKey} className="border-b border-r px-3 py-1.5">
                        <MatrixCellEditor
                          fieldKey={cell.fieldKey}
                          fieldName={fieldDef?.name ?? cell.fieldKey}
                          fieldType={fieldDef?.fieldType ?? "text"}
                          currentOptions={cell.draft?.options ?? []}
                          onSave={(opts) =>
                            handleCellSave(row.parentOptionValue, cell.fieldKey, opts)
                          }
                        >
                          <button
                            type="button"
                            className={cn(
                              "flex items-center gap-1 rounded px-1 py-0.5 transition-colors text-xs",
                              "hover:bg-muted cursor-pointer",
                            )}
                            title={
                              cell.isComplete
                                ? t(cell.choiceCount !== 1 ? "matrix.cellConfiguredPlural" : "matrix.cellConfigured", { count: cell.choiceCount, defaultValue: `Configured (${cell.choiceCount} choice${cell.choiceCount !== 1 ? "s" : ""})` })
                                : cell.draft !== null
                                ? t("matrix.cellDraftNoChoices", { defaultValue: "Draft exists but no choices" })
                                : needsChoices
                                ? t("matrix.cellNotConfigured", { defaultValue: "Not configured — click to add choices" })
                                : t("matrix.cellMarkPresent", { defaultValue: "Click to mark as present" })
                            }
                          >
                            {cellIcon}
                            {needsChoices && cell.choiceCount > 0 && (
                              <span className="text-muted-foreground">{cell.choiceCount}</span>
                            )}
                          </button>
                        </MatrixCellEditor>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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
      <div className="flex-1 flex items-center justify-center p-8 text-center">
        <p className="text-muted-foreground text-sm">
          Add parent options first, then configure dependent fields here.
        </p>
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

// ─── PresetToolbar (Phase 2) ───────────────────────────────────────────────────

function PresetToolbar({
  selectedParentOption,
  allOptions,
  branchDrafts,
  savedPresets,
  presetSummaries,
  presetsLoadState,
  onSavePreset,
  onApplyPreset,
}: {
  selectedParentOption: string;
  allOptions: string[];
  branchDrafts: DraftOptionBranch[];
  savedPresets: ReusableSubFieldSet[];
  presetSummaries: PresetSummary[];
  presetsLoadState: "idle" | "loading" | "success" | "error";
  onSavePreset: (name: string, description: string, includeOptions: boolean) => Promise<void>;
  onApplyPreset: (preset: ReusableSubFieldSet, targetOptions: string[], mode: ApplyPresetMode) => void;
}) {
  const { t } = useTranslation("admin");
  const [saveOpen, setSaveOpen] = useState(false);
  const [applyOpen, setApplyOpen] = useState(false);

  const rootDraftCount = branchDrafts.filter(
    (d) => d.parent_branch_local_id === null && d.parent_option_value === selectedParentOption && d.name.trim(),
  ).length;

  return (
    <div className="flex items-center gap-1">
      {/* Save current structure as preset */}
      <Popover open={saveOpen} onOpenChange={setSaveOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs gap-1"
            disabled={rootDraftCount === 0}
            title={rootDraftCount === 0
              ? t("presets.saveAsSetDisabled", { defaultValue: "Configure at least one field first" })
              : t("presets.saveAsSetEnabled", { defaultValue: "Save current structure as a reusable set" })}
          >
            <Save className="h-3 w-3" />
            {t("presets.saveAsSet", { defaultValue: "Save as set" })}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72 p-0">
          <SavePresetForm
            onSave={async (name, description, includeOptions) => {
              await onSavePreset(name, description, includeOptions);
              setSaveOpen(false);
            }}
            onCancel={() => setSaveOpen(false)}
          />
        </PopoverContent>
      </Popover>

      {/* Apply a saved preset */}
      <Popover open={applyOpen} onOpenChange={setApplyOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs gap-1"
            title={t("presets.applySetTitle", { defaultValue: "Apply a saved set to options" })}
          >
            <BookOpen className="h-3 w-3" />
            {t("presets.applySet", { defaultValue: "Apply set" })}
            {presetSummaries.length > 0 && (
              <Badge variant="secondary" className="h-4 text-xs ml-0.5 px-1">
                {presetSummaries.length}
              </Badge>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80 p-0">
          <ApplyPresetPanel
            savedPresets={savedPresets}
            presetSummaries={presetSummaries}
            presetsLoadState={presetsLoadState}
            selectedParentOption={selectedParentOption}
            allOptions={allOptions}
            branchDrafts={branchDrafts}
            onApply={(preset, targetOptions, mode) => {
              onApplyPreset(preset, targetOptions, mode);
              setApplyOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}

// ─── SavePresetForm (inline in popover) ───────────────────────────────────────

function SavePresetForm({
  onSave,
  onCancel,
}: {
  onSave: (name: string, description: string, includeOptions: boolean) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation("admin");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [includeOptions, setIncludeOptions] = useState(false);
  const [saving, setSaving] = useState(false);

  return (
    <div className="p-3 space-y-3">
      <p className="text-sm font-medium">{t("presets.saveForm.heading", { defaultValue: "Save structure as reusable set" })}</p>
      <div className="space-y-1.5">
        <Label htmlFor="preset-name" className="text-xs">{t("presets.saveForm.nameLabel", { defaultValue: "Set name" })} <span className="text-destructive">*</span></Label>
        <Input
          id="preset-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("presets.saveForm.namePlaceholder", { defaultValue: "e.g., Project Details" })}
          className="h-8 text-sm"
          autoFocus
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="preset-desc" className="text-xs">{t("presets.saveForm.descriptionLabel", { defaultValue: "Description (optional)" })}</Label>
        <Input
          id="preset-desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t("presets.saveForm.descriptionPlaceholder", { defaultValue: "What fields does this set contain?" })}
          className="h-8 text-sm"
        />
      </div>
      <div className="flex items-center justify-between">
        <Label htmlFor="preset-opts" className="text-xs">{t("presets.saveForm.includeChoicesLabel", { defaultValue: "Include dropdown choices" })}</Label>
        <Switch
          id="preset-opts"
          checked={includeOptions}
          onCheckedChange={setIncludeOptions}
          className="scale-75"
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {includeOptions
          ? t("presets.saveForm.includeChoicesOnHint", { defaultValue: "Choices will be copied to options that don't already have choices." })
          : t("presets.saveForm.includeChoicesOffHint", { defaultValue: "Only field structure is saved — each option keeps its own choices." })}
      </p>
      <div className="flex gap-2 justify-end pt-1">
        <Button variant="outline" size="sm" onClick={onCancel} disabled={saving}>{t("presets.saveForm.cancel", { defaultValue: "Cancel" })}</Button>
        <Button
          size="sm"
          disabled={!name.trim() || saving}
          onClick={async () => {
            setSaving(true);
            try { await onSave(name, description, includeOptions); }
            finally { setSaving(false); }
          }}
        >
          {saving ? <RefreshCw className="h-3 w-3 animate-spin mr-1" /> : null}
          {t("presets.saveForm.save", { defaultValue: "Save set" })}
        </Button>
      </div>
    </div>
  );
}

// ─── ApplyPresetPanel (inline in popover) ────────────────────────────────────

function ApplyPresetPanel({
  savedPresets,
  presetSummaries,
  presetsLoadState,
  selectedParentOption,
  allOptions,
  branchDrafts,
  onApply,
}: {
  savedPresets: ReusableSubFieldSet[];
  presetSummaries: PresetSummary[];
  presetsLoadState: "idle" | "loading" | "success" | "error";
  selectedParentOption: string;
  allOptions: string[];
  branchDrafts: DraftOptionBranch[];
  onApply: (preset: ReusableSubFieldSet, targetOptions: string[], mode: ApplyPresetMode) => void;
}) {
  const { t } = useTranslation("admin");
  const [selectedPresetId, setSelectedPresetId] = useState<string>("");
  const [mode, setMode] = useState<ApplyPresetMode>("merge");
  const [applyTo, setApplyTo] = useState<"current" | "unconfigured" | "all">("current");

  const unconfiguredCount = useMemo(
    () => getUnconfiguredOptions(allOptions, branchDrafts).length,
    [allOptions, branchDrafts],
  );

  const selectedPreset = savedPresets.find((p) => p.id === selectedPresetId) ?? null;

  if (presetsLoadState === "loading") {
    return (
      <div className="p-4 text-xs text-muted-foreground text-center">
        <RefreshCw className="h-3.5 w-3.5 animate-spin mx-auto mb-1.5" />
        {t("presets.applyPanel.loading", { defaultValue: "Loading saved sets…" })}
      </div>
    );
  }

  if (presetsLoadState === "error") {
    return (
      <div className="p-4 text-xs text-muted-foreground text-center">
        {t("presets.applyPanel.unavailable", { defaultValue: "Preset storage unavailable." })}
        <br />{t("presets.applyPanel.unavailableHint", { defaultValue: "Run the pending database migration to enable this feature." })}
      </div>
    );
  }

  if (presetSummaries.length === 0) {
    return (
      <div className="p-4 text-xs text-muted-foreground text-center">
        {t("presets.applyPanel.empty", { defaultValue: "No saved sets yet." })}
        <br />{t("presets.applyPanel.emptyHint", { defaultValue: "Configure some fields and click \"Save as set\"." })}
      </div>
    );
  }

  return (
    <div className="p-3 space-y-3">
      <p className="text-sm font-medium">{t("presets.applyPanel.heading", { defaultValue: "Apply a saved set" })}</p>

      {/* Preset selector */}
      <div className="space-y-1.5">
        <Label className="text-xs">{t("presets.applyPanel.selectSetLabel", { defaultValue: "Select set" })}</Label>
        <Select value={selectedPresetId} onValueChange={setSelectedPresetId}>
          <SelectTrigger className="h-8 text-sm">
            <SelectValue placeholder={t("presets.applyPanel.selectSetPlaceholder", { defaultValue: "Choose a set…" })} />
          </SelectTrigger>
          <SelectContent>
            {presetSummaries.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
                <span className="ml-1 text-xs text-muted-foreground">({p.fieldCount} fields)</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Apply scope */}
      <div className="space-y-1.5">
        <Label className="text-xs">{t("presets.applyPanel.applyToLabel", { defaultValue: "Apply to" })}</Label>
        <Select value={applyTo} onValueChange={(v) => setApplyTo(v as typeof applyTo)}>
          <SelectTrigger className="h-8 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="current">{t("presets.applyPanel.currentOnly", { defaultValue: "Current option only" })}</SelectItem>
            <SelectItem value="unconfigured">
              {t("presets.applyPanel.unconfigured", { count: unconfiguredCount, defaultValue: `Unconfigured options (${unconfiguredCount})` })}
            </SelectItem>
            <SelectItem value="all">{t("presets.applyPanel.allOptions", { count: allOptions.length, defaultValue: `All options (${allOptions.length})` })}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Apply mode */}
      <div className="space-y-1.5">
        <Label className="text-xs">{t("presets.applyPanel.whenExistLabel", { defaultValue: "When fields already exist" })}</Label>
        <Select value={mode} onValueChange={(v) => setMode(v as ApplyPresetMode)}>
          <SelectTrigger className="h-8 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="merge">{t("presets.applyPanel.modeMerge", { defaultValue: "Merge — add missing fields only" })}</SelectItem>
            <SelectItem value="sync">{t("presets.applyPanel.modeSync", { defaultValue: "Sync — update names, types, and order" })}</SelectItem>
            <SelectItem value="replace">{t("presets.applyPanel.modeReplace", { defaultValue: "Replace — remove existing, apply set" })}</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {mode === "merge" && t("presets.applyPanel.mergeHint", { defaultValue: "Skips options that already have all fields from this set." })}
          {mode === "sync" && t("presets.applyPanel.syncHint", { defaultValue: "Updates field names and types from the set; keeps each option's own dropdown choices." })}
          {mode === "replace" && t("presets.applyPanel.replaceHint", { defaultValue: "Removes all existing dependent fields for affected options, then applies the set. Cannot be undone." })}
        </p>
      </div>

      <Button
        size="sm"
        className="w-full"
        disabled={!selectedPreset}
        onClick={() => {
          if (!selectedPreset) return;
          const targets =
            applyTo === "current"
              ? [selectedParentOption]
              : applyTo === "unconfigured"
                ? getUnconfiguredOptions(allOptions, branchDrafts)
                : allOptions;
          onApply(selectedPreset, targets, mode);
        }}
      >
        {t("presets.applyPanel.apply", { defaultValue: "Apply set" })}
      </Button>
    </div>
  );
}
