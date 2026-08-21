/**
 * Shared bulk-import dialog for Form Field Template dropdowns.
 *
 * Opened from BOTH the Parent Options panel and the Dependent Fields panel of
 * FormFieldTemplateEditorDialog.tsx — same dialog, same parser, same merge
 * logic either way. Supports paste (Excel/Sheets/CSV/plain list) and file
 * upload (.csv/.tsv/.txt/.xlsx/.xls).
 *
 * ARCHITECTURE: this dialog never writes to Supabase and never mutates the
 * caller's options[]/branchDrafts[] until the user presses "Apply to draft" —
 * at that point it calls onApply() ONCE with the fully-computed next state,
 * and the caller (the template editor) folds it into its own draft state the
 * same way any other edit would be. Persistence remains solely
 * saveOptionBranchConfigurationAtomically via the normal template Save button.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "@/i18n";
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
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AlertCircle, CheckCircle2, FileSpreadsheet, Upload, ClipboardPaste, AlertTriangle, Loader2 } from "lucide-react";
import type { DraftOptionBranch } from "@/lib/optionBranchPersistence";
import {
  parseTabularText,
  detectImportFormat,
  parseDependentTable,
  mapDependentHeaders,
  analyzeFlatImport,
  analyzeDependentImport,
  applyFlatImport,
  applyDependentImport,
  computeReplaceImpact,
  buildFlatSampleList,
  extractFlatList,
  type DetectedFormat,
  type ImportMode,
  type HeaderMapping,
  type ImportAnalysis,
} from "@/lib/formBuilder/dropdownBulkImport";
import {
  readWorkbookFromArrayBuffer,
  isSupportedSpreadsheetExtension,
  isExcelExtension,
  type WorkbookPreview,
} from "@/lib/formBuilder/dropdownBulkImportExcel";
import { buildCascadingSampleCsv } from "@/lib/cascadingOptionsCsv";
import { cn } from "@/lib/utils";

export type DropdownBulkImportApplyPayload = {
  options: string[];
  branchDrafts: DraftOptionBranch[];
  summaryText: string;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Every current option VALUE on the template — always the full list.
   *  Cheap: this is the same short-string array already sitting in
   *  selectedTemplate.options, never the scalability problem. */
  existingOptions: string[];
  /**
   * Either the full local branch-draft array (small/new-template flow,
   * unchanged from before), OR a resolver that fetches ONLY the branches
   * for the parent option values actually touched by whatever the user
   * pastes/uploads (server-paged/large-template flow — see
   * ServerPagedParentOptionsSection). Exactly one of the two must be given.
   *
   * KNOWN LIMITATION of the resolver path: header→existing-field matching
   * (mapDependentHeaders) only sees field_keys already present on the
   * TOUCHED option values, not the whole template's distinct field
   * catalog — a header that would have matched a manually-renamed
   * field_key existing only on an untouched option elsewhere in a large
   * template creates a fresh field_key instead of reusing it. In the
   * common case (field_key is the header text's own slug) this produces
   * an identical result either way.
   */
  existingBranchDrafts?: DraftOptionBranch[];
  resolveExistingBranchDrafts?: (touchedOptionValues: string[]) => Promise<DraftOptionBranch[]>;
  onApply: (payload: DropdownBulkImportApplyPayload) => void;
};

type SourceTab = "paste" | "upload";

// Bounds the raw upload before it's ever read into memory, ahead of the
// separate MAX_IMPORT_ROWS/MAX_IMPORT_COLUMNS checks inside the parser (which
// only apply after the whole file has already been decoded). Smaller than
// FileUpload.tsx's 50MB receipt-attachment limit — this feature only ever
// parses plain tabular text/spreadsheet data, not stored binary attachments,
// and MAX_IMPORT_ROWS=5000 / MAX_IMPORT_COLUMNS=100 comfortably fits well
// under 10MB for any legitimate import.
export const MAX_IMPORT_FILE_SIZE_BYTES = 10 * 1024 * 1024;

const RESET_STATE = {
  pasteText: "",
  fileName: null as string | null,
  workbook: null as WorkbookPreview | null,
  selectedSheet: null as string | null,
  firstRowIsHeader: false,
  fileError: null as string | null,
  headerOverrides: {} as Record<number, string>, // header index -> "new" | an existing field_key
};

export function DropdownBulkImportDialog({
  open,
  onOpenChange,
  existingOptions,
  existingBranchDrafts: staticExistingBranchDrafts,
  resolveExistingBranchDrafts,
  onApply,
}: Props) {
  const { t } = useTranslation(["admin"]);
  const [sourceTab, setSourceTab] = useState<SourceTab>("paste");
  const [mode, setMode] = useState<ImportMode>("merge");
  const [replaceConfirmOpen, setReplaceConfirmOpen] = useState(false);
  const [state, setState] = useState(RESET_STATE);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const resetAll = useCallback(() => {
    setState(RESET_STATE);
    setSourceTab("paste");
    setMode("merge");
    setReplaceConfirmOpen(false);
    if (!staticExistingBranchDrafts) {
      setResolvedDrafts([]);
      setResolveState("idle");
      setResolveError(null);
      setResolveRetryTick(0);
    }
  }, [staticExistingBranchDrafts]);

  const handleClose = useCallback(
    (next: boolean) => {
      if (!next) resetAll();
      onOpenChange(next);
    },
    [onOpenChange, resetAll],
  );

  // ─── Resolve the active raw rows from whichever source is active ─────────

  const rawRows = useMemo<string[][]>(() => {
    if (sourceTab === "paste") {
      if (!state.pasteText.trim()) return [];
      return parseTabularText(state.pasteText);
    }
    if (state.workbook && state.selectedSheet) {
      return state.workbook.getSheetRows(state.selectedSheet);
    }
    return [];
  }, [sourceTab, state.pasteText, state.workbook, state.selectedSheet]);

  const detectedFormat: DetectedFormat = useMemo(() => detectImportFormat(rawRows), [rawRows]);

  // ─── Scalable branch-draft resolution (server-paged/large-template flow) ──
  //
  // Flat imports never touch branches at all (they only add option VALUES),
  // so they never need any existing branch data. Dependent-table imports
  // only need the CURRENT branches for the parent option values that appear
  // in the first column — never the whole template. Determined from the
  // same pure parse the analysis step already runs (extractFlatList /
  // parseDependentTable), so no parsing logic is duplicated here.
  const touchedOptionValues = useMemo<string[]>(() => {
    if (!resolveExistingBranchDrafts || rawRows.length === 0) return [];
    if (detectedFormat === "flat") return [];
    const parsed = parseDependentTable(rawRows);
    if (!parsed.ok) return [];
    const values = parsed.table.dataRows.map((r) => r.parent.trim()).filter(Boolean);
    return Array.from(new Set(values));
  }, [resolveExistingBranchDrafts, rawRows, detectedFormat]);

  const [resolvedDrafts, setResolvedDrafts] = useState<DraftOptionBranch[]>(staticExistingBranchDrafts ?? []);
  const [resolveState, setResolveState] = useState<"idle" | "resolving" | "ready" | "error">(
    staticExistingBranchDrafts ? "ready" : touchedOptionValues.length === 0 ? "ready" : "idle",
  );
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [resolveRetryTick, setResolveRetryTick] = useState(0);
  const resolveGeneration = useRef(0);
  const retryResolve = useCallback(() => setResolveRetryTick((n) => n + 1), []);

  useEffect(() => {
    if (staticExistingBranchDrafts) return; // static-array caller — nothing to resolve
    if (touchedOptionValues.length === 0) {
      setResolvedDrafts([]);
      setResolveState("ready");
      return;
    }
    const generation = ++resolveGeneration.current;
    setResolveState("resolving");
    setResolveError(null);
    resolveExistingBranchDrafts!(touchedOptionValues)
      .then((drafts) => {
        if (resolveGeneration.current !== generation) return; // superseded by a newer paste/upload
        setResolvedDrafts(drafts);
        setResolveState("ready");
      })
      .catch((e: unknown) => {
        if (resolveGeneration.current !== generation) return;
        setResolveError(e instanceof Error ? e.message : "Could not load the existing data for these options.");
        setResolveState("error");
      });
    // resolveRetryTick has no effect of its own — incrementing it is how the
    // Retry button re-runs this exact fetch without requiring the user to
    // re-paste/re-upload.
  }, [staticExistingBranchDrafts, resolveExistingBranchDrafts, touchedOptionValues, resolveRetryTick]);

  const existingBranchDrafts = staticExistingBranchDrafts ?? resolvedDrafts;
  const isResolvingExisting = resolveState === "resolving";

  const dependentHeaders = useMemo(() => {
    if (detectedFormat !== "dependent" || rawRows.length === 0) return [];
    return rawRows[0].slice(1);
  }, [detectedFormat, rawRows]);

  const rawMappings: HeaderMapping[] = useMemo(
    () => mapDependentHeaders(dependentHeaders, existingBranchDrafts),
    [dependentHeaders, existingBranchDrafts],
  );

  /** Apply the user's manual resolutions for ambiguous headers. */
  const resolvedMappings: HeaderMapping[] = useMemo(() => {
    return rawMappings.map((m, i) => {
      const override = state.headerOverrides[i];
      if (!override) return m;
      if (override === "new") {
        return { ...m, status: "new", matchedFieldKey: null };
      }
      return { ...m, status: "matched", matchedFieldKey: override };
    });
  }, [rawMappings, state.headerOverrides]);

  const stillAmbiguous = resolvedMappings.some((m) => m.status === "ambiguous");

  const analysis: ImportAnalysis | null = useMemo(() => {
    if (rawRows.length === 0) return null;
    if (detectedFormat === "flat") {
      return analyzeFlatImport(rawRows, state.firstRowIsHeader, existingOptions);
    }
    const parsed = parseDependentTable(rawRows);
    if (!parsed.ok) {
      return {
        format: "dependent",
        rowsRead: rawRows.length,
        usableRows: 0,
        blankRowsSkipped: 0,
        parentHeader: "",
        parentOptions: { existingMatched: 0, new: 0, duplicatesInImport: 0 },
        dependentFields: { matched: 0, new: 0, ambiguous: 0, mappings: [] },
        choices: { existing: 0, new: 0, duplicates: 0, blankSkipped: 0 },
        conflicts: [{ blocking: true, code: "parse_error", message: parsed.error }],
        hasBlockingConflicts: true,
        table: { parentHeader: "", dependentHeaders: [], dataRows: [] },
        preview: [],
      };
    }
    const base = analyzeDependentImport(parsed.table, existingOptions, existingBranchDrafts);
    // Fold the user's manual ambiguity resolutions back into the analysis.
    return {
      ...base,
      dependentFields: {
        matched: resolvedMappings.filter((m) => m.status === "matched").length,
        new: resolvedMappings.filter((m) => m.status === "new").length,
        ambiguous: resolvedMappings.filter((m) => m.status === "ambiguous").length,
        mappings: resolvedMappings,
      },
      hasBlockingConflicts:
        base.conflicts.some((c) => c.blocking && c.code !== "ambiguous_mapping") || stillAmbiguous,
    };
  }, [rawRows, detectedFormat, state.firstRowIsHeader, existingOptions, existingBranchDrafts, resolvedMappings, stillAmbiguous]);

  const replaceImpact = useMemo(() => {
    if (mode !== "replace" || !analysis || analysis.format !== "dependent" || analysis.table.dataRows.length === 0) {
      return null;
    }
    return computeReplaceImpact(existingBranchDrafts, analysis.table, resolvedMappings);
  }, [mode, analysis, existingBranchDrafts, resolvedMappings]);

  // ─── File handling ─────────────────────────────────────────────────────

  const handleFile = useCallback(async (file: File) => {
    setState((s) => ({ ...s, fileName: file.name, fileError: null, workbook: null, selectedSheet: null }));
    if (file.size > MAX_IMPORT_FILE_SIZE_BYTES) {
      const maxMB = (MAX_IMPORT_FILE_SIZE_BYTES / (1024 * 1024)).toFixed(0);
      setState((s) => ({
        ...s,
        fileError: t("dropdownImport.fileTooLarge", {
          sizeMB: (file.size / (1024 * 1024)).toFixed(1),
          maxMB,
          defaultValue: `File too large (${(file.size / (1024 * 1024)).toFixed(1)} MB). Max is ${maxMB} MB.`,
        }),
      }));
      return;
    }
    if (!isSupportedSpreadsheetExtension(file.name)) {
      setState((s) => ({
        ...s,
        fileError: t("dropdownImport.unsupportedFileType", {
          defaultValue: "Unsupported file type. Supported formats: CSV, TSV, TXT, XLSX, XLS.",
        }),
      }));
      return;
    }
    if (isExcelExtension(file.name)) {
      try {
        const buffer = await file.arrayBuffer();
        const workbook = await readWorkbookFromArrayBuffer(buffer);
        if (workbook.sheetNames.length === 0) {
          setState((s) => ({
            ...s,
            fileError: t("dropdownImport.noSheets", { defaultValue: "This workbook has no sheets." }),
          }));
          return;
        }
        setState((s) => ({ ...s, workbook, selectedSheet: workbook.sheetNames[0] }));
      } catch {
        setState((s) => ({
          ...s,
          fileError: t("dropdownImport.excelReadError", {
            defaultValue: "Could not read this Excel file. It may be corrupt or password-protected.",
          }),
        }));
      }
      return;
    }
    try {
      const text = await file.text();
      const rows = parseTabularText(text);
      // Reuse the same code path as paste by faking a single-sheet "workbook".
      setState((s) => ({
        ...s,
        workbook: { sheetNames: ["1"], getSheetRows: () => rows },
        selectedSheet: "1",
      }));
    } catch {
      setState((s) => ({
        ...s,
        fileError: t("dropdownImport.genericReadError", { defaultValue: "Could not read this file." }),
      }));
    }
  }, [t]);

  const onFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) void handleFile(file);
      e.target.value = "";
    },
    [handleFile],
  );

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const file = e.dataTransfer.files?.[0];
      if (file) void handleFile(file);
    },
    [handleFile],
  );

  // ─── Apply ─────────────────────────────────────────────────────────────

  const performApply = useCallback(() => {
    if (!analysis) return;
    if (analysis.format === "flat") {
      const result = applyFlatImport(existingOptions, analysis.incomingValues);
      onApply({
        options: result.options,
        branchDrafts: existingBranchDrafts,
        summaryText: `${result.added} option${result.added === 1 ? "" : "s"} added${result.skipped ? `, ${result.skipped} duplicate${result.skipped === 1 ? "" : "s"} skipped` : ""}.`,
      });
    } else {
      const result = applyDependentImport(
        existingOptions,
        existingBranchDrafts,
        analysis.table,
        resolvedMappings,
        mode,
      );
      const s = result.summary;
      const parts = [
        `${s.parentOptionsAdded} parent option${s.parentOptionsAdded === 1 ? "" : "s"} added`,
        `${s.fieldsCreated} field${s.fieldsCreated === 1 ? "" : "s"} created`,
        `${s.choicesAdded} choice${s.choicesAdded === 1 ? "" : "s"} added`,
      ];
      if (mode === "replace" && s.branchesRemoved > 0) {
        parts.push(`${s.branchesRemoved} branch${s.branchesRemoved === 1 ? "" : "es"} replaced`);
      }
      onApply({ options: result.options, branchDrafts: result.branchDrafts, summaryText: parts.join(", ") + "." });
    }
    handleClose(false);
  }, [analysis, existingOptions, existingBranchDrafts, resolvedMappings, mode, onApply, handleClose]);

  const handleApplyClick = useCallback(() => {
    if (!analysis || analysis.hasBlockingConflicts) return;
    if (mode === "replace") {
      setReplaceConfirmOpen(true);
      return;
    }
    performApply();
  }, [analysis, mode, performApply]);

  const canApply =
    !!analysis && !analysis.hasBlockingConflicts && rawRows.length > 0 && resolveState !== "resolving" && resolveState !== "error";

  // ─── Sample download ────────────────────────────────────────────────────

  const downloadSample = useCallback((kind: "flat" | "dependent") => {
    const text = kind === "flat" ? buildFlatSampleList() : buildCascadingSampleCsv("Project Unique ID");
    const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = kind === "flat" ? "sample-options.csv" : "sample-dependent-dropdown.csv";
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  return (
    <>
      <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("dropdownImport.dialogTitle", { defaultValue: "Import dropdown data" })}</DialogTitle>
            <DialogDescription>
              {t("dropdownImport.dialogDescription", {
                defaultValue: "Paste from Excel, Google Sheets, CSV, or a simple list — or upload a file.",
              })}
            </DialogDescription>
          </DialogHeader>

          <Tabs value={sourceTab} onValueChange={(v) => setSourceTab(v as SourceTab)}>
            <TabsList className="grid grid-cols-2 w-full">
              <TabsTrigger value="paste">
                <ClipboardPaste className="h-4 w-4 mr-1.5" /> {t("dropdownImport.tabPaste", { defaultValue: "Paste data" })}
              </TabsTrigger>
              <TabsTrigger value="upload">
                <Upload className="h-4 w-4 mr-1.5" /> {t("dropdownImport.tabUpload", { defaultValue: "Upload file" })}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="paste" className="space-y-2 pt-3">
              <Textarea
                value={state.pasteText}
                onChange={(e) => setState((s) => ({ ...s, pasteText: e.target.value }))}
                placeholder={t("dropdownImport.pastePlaceholder", {
                  defaultValue:
                    "Paste values here...\n\nEither a simple list (one per line) or a table with dependent columns copied straight from Excel or Google Sheets.",
                })}
                rows={8}
                className="font-mono text-sm"
              />
              <div className="flex gap-3 text-xs">
                <button type="button" className="text-primary underline" onClick={() => downloadSample("flat")}>
                  {t("dropdownImport.downloadSimpleSample", { defaultValue: "Download simple-list sample" })}
                </button>
                <button type="button" className="text-primary underline" onClick={() => downloadSample("dependent")}>
                  {t("dropdownImport.downloadDependentSample", { defaultValue: "Download dependent-table sample" })}
                </button>
              </div>
            </TabsContent>

            <TabsContent value="upload" className="space-y-3 pt-3">
              <div
                className="border-2 border-dashed rounded-md p-8 text-center cursor-pointer hover:bg-muted/40 transition-colors"
                onDragOver={(e) => e.preventDefault()}
                onDrop={onDrop}
                onClick={() => fileInputRef.current?.click()}
              >
                <FileSpreadsheet className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
                <p className="text-sm font-medium">
                  {t("dropdownImport.dropzoneTitle", { defaultValue: "Drop a file here or click to choose" })}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {t("dropdownImport.dropzoneSupported", { defaultValue: "Supported: CSV, TSV, TXT, XLSX, XLS" })}
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,.tsv,.txt,.xlsx,.xls"
                  className="hidden"
                  onChange={onFileInputChange}
                />
              </div>
              {state.fileName && !state.fileError && (
                <p className="text-xs text-muted-foreground">
                  {t("dropdownImport.loaded", { fileName: state.fileName, defaultValue: `Loaded: ${state.fileName}` })}
                </p>
              )}
              {state.fileError && (
                <p className="text-xs text-destructive flex items-center gap-1">
                  <AlertCircle className="h-3.5 w-3.5" /> {state.fileError}
                </p>
              )}
              {state.workbook && state.workbook.sheetNames.length > 1 && (
                <div className="flex items-center gap-2">
                  <Label className="text-xs shrink-0">{t("dropdownImport.sheetLabel", { defaultValue: "Sheet:" })}</Label>
                  <Select
                    value={state.selectedSheet ?? undefined}
                    onValueChange={(v) => setState((s) => ({ ...s, selectedSheet: v }))}
                  >
                    <SelectTrigger className="h-8 w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {state.workbook.sheetNames.map((name) => (
                        <SelectItem key={name} value={name}>
                          {name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </TabsContent>
          </Tabs>

          {rawRows.length > 0 && (
            <div className="space-y-4 border-t pt-4 mt-2">
              {/* Detected format */}
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div>
                  <p className="text-sm font-medium">
                    {t("dropdownImport.detectedFormat", { defaultValue: "Detected format:" })}{" "}
                    <span className="text-primary">
                      {detectedFormat === "flat"
                        ? t("dropdownImport.formatFlat", { defaultValue: "Simple list" })
                        : t("dropdownImport.formatDependent", { defaultValue: "Dependent dropdown table" })}
                    </span>
                  </p>
                  {detectedFormat === "dependent" && analysis?.format === "dependent" && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {t("dropdownImport.parentColumnLabel", { defaultValue: "Parent column:" })}{" "}
                      <span className="font-medium">{analysis.parentHeader}</span> ·{" "}
                      {t("dropdownImport.dependentColumnsLabel", { defaultValue: "Dependent columns:" })}{" "}
                      <span className="font-medium">{analysis.dependentFields.mappings.map((m) => m.header).join(", ") || "—"}</span>
                    </p>
                  )}
                </div>
                {detectedFormat === "flat" && (
                  <label className="flex items-center gap-1.5 text-xs">
                    <input
                      type="checkbox"
                      checked={state.firstRowIsHeader}
                      onChange={(e) => setState((s) => ({ ...s, firstRowIsHeader: e.target.checked }))}
                    />
                    {t("dropdownImport.firstRowIsHeader", { defaultValue: "First row is a header" })}
                  </label>
                )}
              </div>

              {isResolvingExisting && (
                <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t("dropdownImport.resolvingExisting", {
                    count: touchedOptionValues.length,
                    defaultValue: `Loading existing data for ${touchedOptionValues.length} option(s)…`,
                  })}
                </div>
              )}
              {resolveState === "error" && (
                <div className="flex items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                  <span>{resolveError}</span>
                  <Button type="button" size="sm" variant="outline" onClick={retryResolve}>
                    {t("dropdownImport.retry", { defaultValue: "Retry" })}
                  </Button>
                </div>
              )}

              {/* Ambiguous header resolution */}
              {analysis?.format === "dependent" &&
                analysis.dependentFields.mappings.some((m) => m.status === "ambiguous") && (
                  <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/20 p-3">
                    <p className="text-xs font-medium flex items-center gap-1.5">
                      <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />{" "}
                      {t("dropdownImport.ambiguousHeadersTitle", {
                        defaultValue: "Some columns match more than one existing field — choose how to map them:",
                      })}
                    </p>
                    {analysis.dependentFields.mappings.map((m, i) =>
                      m.status === "ambiguous" ? (
                        <div key={i} className="flex items-center gap-2">
                          <span className="text-xs w-40 truncate">{m.header}</span>
                          <Select
                            value={state.headerOverrides[i] ?? ""}
                            onValueChange={(v) =>
                              setState((s) => ({ ...s, headerOverrides: { ...s.headerOverrides, [i]: v } }))
                            }
                          >
                            <SelectTrigger className="h-7 flex-1" aria-label={m.header}>
                              <SelectValue placeholder={t("dropdownImport.chooseField", { defaultValue: "Choose a field" })} />
                            </SelectTrigger>
                            <SelectContent>
                              {m.candidates.map((c) => (
                                <SelectItem key={c} value={c}>
                                  {t("dropdownImport.useExisting", { name: c, defaultValue: `Use existing: ${c}` })}
                                </SelectItem>
                              ))}
                              <SelectItem value="new">
                                {t("dropdownImport.createNewField", { defaultValue: "Create new field" })}
                              </SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      ) : null,
                    )}
                  </div>
                )}

              {/* Summary chips */}
              <SummaryChips analysis={analysis} />

              {/* Conflicts / warnings */}
              {analysis && analysis.conflicts.length > 0 && (
                <div className="space-y-1">
                  {analysis.conflicts.map((c, i) => (
                    <p
                      key={i}
                      className={cn(
                        "text-xs flex items-start gap-1.5",
                        c.blocking ? "text-destructive" : "text-amber-600",
                      )}
                    >
                      {c.blocking ? <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" /> : <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />}
                      {c.message}
                    </p>
                  ))}
                </div>
              )}

              {/* Preview */}
              <Preview analysis={analysis} />

              {/* Import mode */}
              <div className="space-y-2">
                <p className="text-sm font-medium">{t("dropdownImport.importModeLabel", { defaultValue: "Import mode" })}</p>
                <RadioGroup value={mode} onValueChange={(v) => setMode(v as ImportMode)} className="space-y-1.5">
                  <div className="flex items-start gap-2">
                    <RadioGroupItem value="merge" id="import-mode-merge" className="mt-0.5" />
                    <Label htmlFor="import-mode-merge" className="font-normal text-sm cursor-pointer">
                      <span className="font-medium">{t("dropdownImport.mergeTitle", { defaultValue: "Merge with existing data" })}</span>
                      <span className="block text-xs text-muted-foreground">
                        {t("dropdownImport.mergeDescription", {
                          defaultValue:
                            "Keeps everything you already have; adds missing options/choices and preserves existing field settings and nested dependent branches.",
                        })}
                      </span>
                    </Label>
                  </div>
                  <div className="flex items-start gap-2">
                    <RadioGroupItem value="replace" id="import-mode-replace" className="mt-0.5" />
                    <Label htmlFor="import-mode-replace" className="font-normal text-sm cursor-pointer">
                      <span className="font-medium">{t("dropdownImport.replaceTitle", { defaultValue: "Replace imported scope" })}</span>
                      <span className="block text-xs text-muted-foreground">
                        {t("dropdownImport.replaceDescription", {
                          defaultValue:
                            "Replaces choices only for the parent options and dependent fields that are actually part of this import. Everything else in the template is left untouched. Requires confirmation.",
                        })}
                      </span>
                    </Label>
                  </div>
                </RadioGroup>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => handleClose(false)}>
              {t("dropdownImport.cancel", { defaultValue: "Cancel" })}
            </Button>
            <Button onClick={handleApplyClick} disabled={!canApply}>
              {t("dropdownImport.applyToDraft", { defaultValue: "Apply to draft" })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={replaceConfirmOpen} onOpenChange={setReplaceConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("dropdownImport.replaceConfirmTitle", { defaultValue: "Replace imported scope?" })}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-left">
                <p>
                  {t("dropdownImport.replaceConfirmIntro", {
                    defaultValue:
                      "This will replace dependent-field choices only for the parent options and columns present in this import. Nothing outside that scope is affected.",
                  })}
                </p>
                {replaceImpact && (
                  <ul className="list-disc pl-5 space-y-1">
                    <li>
                      {t("dropdownImport.replaceConfirmParentOptions", {
                        count: replaceImpact.parentOptionsTouched.length,
                        list:
                          replaceImpact.parentOptionsTouched.slice(0, 10).join(", ") +
                          (replaceImpact.parentOptionsTouched.length > 10 ? "…" : "") || t("dropdownImport.none", { defaultValue: "none" }),
                        defaultValue: `Parent options affected (${replaceImpact.parentOptionsTouched.length}): ${
                          replaceImpact.parentOptionsTouched.slice(0, 10).join(", ") || "none"
                        }${replaceImpact.parentOptionsTouched.length > 10 ? "…" : ""}`,
                      })}
                    </li>
                    <li>
                      {t("dropdownImport.replaceConfirmFields", {
                        count: replaceImpact.fieldsTouched.length,
                        list: replaceImpact.fieldsTouched.join(", ") || t("dropdownImport.none", { defaultValue: "none" }),
                        defaultValue: `Dependent fields affected (${replaceImpact.fieldsTouched.length}): ${
                          replaceImpact.fieldsTouched.join(", ") || "none"
                        }`,
                      })}
                    </li>
                    <li>
                      {t("dropdownImport.replaceConfirmBranchesRemoved", {
                        count: replaceImpact.branchesRemoved,
                        defaultValue: `Existing branches that will be replaced: ${replaceImpact.branchesRemoved}`,
                      })}
                    </li>
                    {replaceImpact.nestedBranchesRemoved > 0 && (
                      <li className="text-destructive font-medium">
                        {t("dropdownImport.replaceConfirmNestedRemoved", {
                          count: replaceImpact.nestedBranchesRemoved,
                          defaultValue: `${replaceImpact.nestedBranchesRemoved} nested dependent branch${
                            replaceImpact.nestedBranchesRemoved === 1 ? "" : "es"
                          } configured under those fields will also be removed.`,
                        })}
                      </li>
                    )}
                  </ul>
                )}
                <p className="font-medium">
                  {t("dropdownImport.replaceConfirmFinal", { defaultValue: "This cannot be undone once you save the template." })}
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("dropdownImport.cancel", { defaultValue: "Cancel" })}</AlertDialogCancel>
            <AlertDialogAction onClick={performApply}>
              {t("dropdownImport.replaceConfirmAction", { defaultValue: "Replace and apply to draft" })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function SummaryChips({ analysis }: { analysis: ImportAnalysis | null }) {
  const { t } = useTranslation(["admin"]);
  if (!analysis) return null;
  const chips: { label: string; value: number }[] = [
    { label: "Rows", value: analysis.rowsRead },
    { label: "Usable rows", value: analysis.usableRows },
    { label: "Blank rows skipped", value: analysis.blankRowsSkipped },
    { label: analysis.format === "flat" ? "Options" : "Parent options", value: analysis.parentOptions.new + analysis.parentOptions.existingMatched },
    { label: "New parent options", value: analysis.parentOptions.new },
  ];
  if (analysis.format === "dependent") {
    chips.push(
      { label: "Dependent fields matched", value: analysis.dependentFields.matched },
      { label: "Dependent fields new", value: analysis.dependentFields.new },
      { label: "Choices new", value: analysis.choices.new },
      { label: "Choices duplicate", value: analysis.choices.duplicates },
    );
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {chips.map((c) => (
        <Badge key={c.label} variant="secondary" className="font-normal">
          {c.label}: {c.value}
        </Badge>
      ))}
      {analysis.hasBlockingConflicts ? (
        <Badge variant="destructive" className="font-normal">
          <AlertCircle className="h-3 w-3 mr-1" /> {t("dropdownImport.cannotApply", { defaultValue: "Cannot apply" })}
        </Badge>
      ) : (
        <Badge className="font-normal bg-green-600 hover:bg-green-600">
          <CheckCircle2 className="h-3 w-3 mr-1" /> {t("dropdownImport.readyToApply", { defaultValue: "Ready to apply" })}
        </Badge>
      )}
    </div>
  );
}

function Preview({ analysis }: { analysis: ImportAnalysis | null }) {
  const { t } = useTranslation(["admin"]);
  if (!analysis) return null;
  if (analysis.format === "flat") {
    if (analysis.preview.length === 0) return null;
    return (
      <div>
        <p className="text-xs font-medium mb-1">
          {t("dropdownImport.previewFlat", {
            shown: analysis.preview.length,
            total: analysis.incomingValues.length,
            defaultValue: `Preview (first ${analysis.preview.length} of ${analysis.incomingValues.length})`,
          })}
        </p>
        <ScrollArea className="h-32 rounded-md border p-2">
          <div className="flex flex-wrap gap-1">
            {analysis.preview.map((v, i) => (
              <Badge key={`${v}-${i}`} variant="outline" className="font-normal">
                {v}
              </Badge>
            ))}
          </div>
        </ScrollArea>
      </div>
    );
  }

  if (analysis.preview.length <= 1) return null;
  const [header, ...dataRows] = analysis.preview;
  return (
    <div>
      <p className="text-xs font-medium mb-1">
        {t("dropdownImport.previewDependent", {
          shown: dataRows.length,
          total: analysis.table.dataRows.length,
          defaultValue: `Preview (first ${dataRows.length} of ${analysis.table.dataRows.length} rows)`,
        })}
      </p>
      <ScrollArea className="h-56 rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              {header.map((h, i) => (
                <TableHead key={i} className="whitespace-nowrap">
                  {h}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {dataRows.map((row, ri) => (
              <TableRow key={ri}>
                {row.map((cell, ci) => (
                  <TableCell key={ci} className="whitespace-nowrap text-xs">
                    {cell || <span className="text-muted-foreground">—</span>}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ScrollArea>
    </div>
  );
}
