/**
 * The Matrix (spreadsheet-style) dependent-field editor — one row per
 * parent option, one column per dependent field. Extracted to its own
 * module (not defined inline in FormFieldTemplateEditorDialog.tsx) so both
 * the create-mode local-draft flow (DependentFieldsPanel) and the
 * server-paged flow (ServerPagedParentOptionsSection, DOC-099) can import
 * it without a circular dependency between those two component files —
 * only the SCOPE of `allOptions`/`branchDrafts` fed in differs between the
 * two callers; this component itself never changes.
 */
import { useMemo, useState } from "react";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Search, ChevronLeft, ChevronRight, Check, AlertCircle, X, CheckSquare, Square, Minus } from "lucide-react";
import { cn } from "@/lib/utils";
import { paginateItems, buildBranchIndexes } from "@/lib/formBuilder/templateEditor";
import { dedupePreservingFirst } from "@/lib/formBuilder/dropdownBulkImport";
import {
  applyPresetToParentOptions,
  deserializePresetSchema,
  buildPresetMatrix,
  inferMatrixColumnsFromDrafts,
  type ReusableSubFieldSet,
  type MatrixRow,
} from "@/lib/formBuilder/subFieldPresets";
import type { DraftOptionBranch } from "@/lib/optionBranchPersistence";

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
    const lines = text.split("\n");
    const { unique } = dedupePreservingFirst(lines);
    onSave(unique);
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

export function MatrixEditorPanel({
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
  const [matrixSearch, setMatrixSearch] = useState("");
  const [matrixFilter, setMatrixFilter] = useState<"all" | "configured" | "incomplete">("all");

  const selectedPreset = savedPresets.find((p) => p.id === matrixPresetId) ?? null;
  // Columns come from a saved preset when one is selected; otherwise the
  // matrix infers columns directly from whatever root dependent fields
  // already exist in the draft (e.g. right after a bulk import), so it never
  // requires a saved preset to be usable.
  const inferredColumns = useMemo(() => inferMatrixColumnsFromDrafts(branchDrafts), [branchDrafts]);
  const schema = selectedPreset ? deserializePresetSchema(selectedPreset.fieldSchema) : inferredColumns;
  const usingInferredColumns = !selectedPreset && inferredColumns.length > 0;

  const matrixRows: MatrixRow[] = useMemo(
    () => (schema.length > 0 ? buildPresetMatrix(allOptions, schema, branchDrafts) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allOptions, matrixPresetId, branchDrafts, usingInferredColumns],
  );

  const searchedOptions = useMemo(() => {
    const term = matrixSearch.trim().toLowerCase();
    let opts = term ? allOptions.filter((o) => o.toLowerCase().includes(term)) : allOptions;
    if (matrixFilter !== "all") {
      const rowByOption = new Map(matrixRows.map((r) => [r.parentOptionValue, r]));
      opts = opts.filter((o) => {
        const row = rowByOption.get(o);
        if (!row) return matrixFilter === "incomplete";
        return matrixFilter === "configured" ? row.isConfigured : !row.isComplete;
      });
    }
    return opts;
  }, [allOptions, matrixSearch, matrixFilter, matrixRows]);

  const totalPages = Math.max(1, Math.ceil(searchedOptions.length / MATRIX_PAGE_SIZE));
  const pageOptions = paginateItems(searchedOptions, matrixPage, MATRIX_PAGE_SIZE);
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

  if (savedPresets.length === 0 && inferredColumns.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-8 text-center">
        <p className="text-muted-foreground text-sm max-w-sm">
          {t("matrix.noColumns", {
            defaultValue:
              "No dependent fields configured yet. Import a dependent-dropdown table, add fields from the list view, or save a preset to define matrix columns.",
          })}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b shrink-0">
        <span className="text-xs text-muted-foreground shrink-0">{t("matrix.presetColumnsLabel", { defaultValue: "Columns:" })}</span>
        <Select value={matrixPresetId || "__inferred__"} onValueChange={(v) => setMatrixPresetId(v === "__inferred__" ? "" : v)}>
          <SelectTrigger className="h-7 text-xs flex-1 max-w-[220px]">
            <SelectValue placeholder={t("matrix.selectPresetPlaceholder", { defaultValue: "Select a preset…" })} />
          </SelectTrigger>
          <SelectContent>
            {inferredColumns.length > 0 && (
              <SelectItem value="__inferred__" className="text-xs">
                {t("matrix.currentFields", { defaultValue: "Current dependent fields" })} ({inferredColumns.length})
              </SelectItem>
            )}
            {savedPresets.map((p) => (
              <SelectItem key={p.id} value={p.id} className="text-xs">
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="relative w-40">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground pointer-events-none" />
          <Input
            value={matrixSearch}
            onChange={(e) => { setMatrixSearch(e.target.value); setMatrixPage(1); }}
            placeholder="Search options…"
            className="h-7 pl-6 text-xs"
          />
        </div>

        <Select value={matrixFilter} onValueChange={(v) => { setMatrixFilter(v as typeof matrixFilter); setMatrixPage(1); }}>
          <SelectTrigger className="h-7 text-xs w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="text-xs">All rows</SelectItem>
            <SelectItem value="configured" className="text-xs">Configured only</SelectItem>
            <SelectItem value="incomplete" className="text-xs">Incomplete only</SelectItem>
          </SelectContent>
        </Select>

        {matrixSelectedOptions.size > 0 && selectedPreset && (
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
      {schema.length === 0 ? (
        <div className="flex-1 flex items-center justify-center p-8 text-center">
          <p className="text-muted-foreground text-sm">
            {t("matrix.selectPresetPrompt", { defaultValue: "Select a preset to define matrix columns." })}
          </p>
        </div>
      ) : pageRows.length === 0 ? (
        <div className="flex-1 flex items-center justify-center p-8 text-center">
          <p className="text-muted-foreground text-sm">No options match your search/filter.</p>
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
