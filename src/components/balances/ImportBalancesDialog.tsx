import { useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { formatINR } from "@/lib/format";
import {
  applyImportBatchV2,
  getBalanceHistoricalAnchors,
  validateImportBatchV2,
  type AnchorKind,
  type HistoricalAnchor,
  type ImportApplyResult,
  type ImportMode,
  type ImportValidateResultV2,
  type RowResolution,
} from "@/services/BalanceLedgerService";
import {
  attachSourceStoragePath,
  attachSourceSha256,
  createImportBatch,
  findDuplicateAppliedBatch,
  getImportRows,
  insertImportRows,
  uploadImportSourceFile,
  type ImportRowDetail,
} from "@/services/BalanceImportService";
import {
  buildStagedRowsFromSheet,
  canonicalStarterHeaders,
  resolveStarterSheetSchema,
  type ParsedSheet,
  type StarterSheetSchema,
} from "@/lib/balanceImportStarterSheet";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";

// Historical Balance Anchors V2 (2026-08-24). Bulk balance import wizard.
// Upload/preview never touch money -- only the explicit Apply step calls
// applyImportBatchV2.
//
// Three distinct financial concepts, kept structurally separate:
//   Opening Balance / Balance Update -- HISTORICAL BALANCE ANCHORS. The
//     server reconstructs the employee's balance immediately before the
//     anchor's timeline position and applies only the MISSING historical
//     effect (target - reconstructed position) -- never a direct balance
//     overwrite. See src/lib/historicalBalanceReplay.ts for the accounting
//     model and supabase/migrations/20260824110000_historical_balance_anchors_engine.sql
//     for the server engine that actually mutates money.
//   Allocation -- unchanged: a real additive transaction, current + amount.
//
// This wizard deliberately has NO column-mapping step: the uploaded file
// must match the PesoWise starter sheet's exact column headers for the
// selected mode (see balanceImportStarterSheet.ts). Employee ID is carried
// as an opaque string end-to-end: never parsed as a number, never stripped
// of leading zeros.

type WizardStep = "type" | "starter" | "upload" | "preview" | "confirm" | "result";

const MODE_LABELS: Record<ImportMode, string> = {
  historical_opening: "Opening Balance",
  balance_update: "Balance Update",
  allocation: "Allocation",
};

function anchorKindForMode(mode: ImportMode): AnchorKind | null {
  if (mode === "historical_opening") return "opening_balance";
  if (mode === "balance_update") return "balance_update";
  return null;
}

/** A conflict is resolved once it has an action, and (for replace/edit) a
 * non-blank reason. "create"/"skip" need nothing further. */
function isResolutionComplete(resolution: RowResolution | undefined): boolean {
  if (!resolution) return false;
  if (resolution.action === "replace" || resolution.action === "edit") {
    return Boolean(resolution.target_anchor_id) && Boolean(resolution.reason && resolution.reason.trim() !== "");
  }
  return resolution.action === "create" || resolution.action === "skip";
}

// V1 row cap -- keeps a single Apply well inside one DB transaction. No
// evidence yet of a legitimate org needing more in one file; raise this
// deliberately later if Production scale proves otherwise.
const MAX_IMPORT_ROWS = 5000;

async function sha256Hex(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

interface ActiveEmployee {
  employee_id: string | null;
  name: string | null;
  email: string | null;
  balance: number | null;
}

interface StatusBadgeProps {
  status: ImportRowDetail["validation_status"];
}

function ValidationStatusBadge({ status }: StatusBadgeProps) {
  switch (status) {
    case "valid":
      return <Badge variant="success">Valid</Badge>;
    case "no_op":
      return <Badge variant="secondary">No change</Badge>;
    case "unknown":
      return <Badge variant="destructive">Unknown employee</Badge>;
    case "ambiguous":
      return <Badge variant="destructive">Ambiguous match</Badge>;
    case "invalid_amount":
      return <Badge variant="destructive">Invalid amount</Badge>;
    case "invalid_date":
      return <Badge variant="destructive">Invalid date</Badge>;
    case "duplicate":
      return <Badge variant="destructive">Duplicate</Badge>;
    default:
      return <Badge variant="outline">Pending</Badge>;
  }
}

function ConflictBadge({ status }: { status: ImportRowDetail["conflict_status"] }) {
  switch (status) {
    case "conflict":
      return <Badge variant="destructive">Needs decision</Badge>;
    case "resolved":
      return <Badge variant="secondary">Resolved</Badge>;
    case "skipped":
      return <Badge variant="outline">Skipped</Badge>;
    default:
      return null;
  }
}

interface ConflictCardProps {
  row: ImportRowDetail;
  existingAnchor: HistoricalAnchor | null;
  resolution: RowResolution | undefined;
  onChange: (next: RowResolution | undefined) => void;
  amountLabel: string;
}

function ConflictCard({ row, existingAnchor, resolution, onChange, amountLabel }: ConflictCardProps) {
  const action = resolution?.action;
  const setAction = (nextAction: RowResolution["action"]) => {
    if (nextAction === "create" || nextAction === "skip") {
      onChange({ action: nextAction });
      return;
    }
    onChange({
      action: nextAction,
      target_anchor_id: existingAnchor?.id,
      reason: resolution?.reason ?? "",
      override_balance: nextAction === "edit" ? (resolution?.override_balance ?? row.input_amount ?? undefined) : undefined,
      override_effective_date: nextAction === "edit" ? (resolution?.override_effective_date ?? row.effective_date ?? undefined) : undefined,
      override_note: nextAction === "edit" ? (resolution?.override_note ?? row.note ?? undefined) : undefined,
    });
  };

  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium">
          Row {row.row_number} -- {row.raw_employee_id || row.raw_email || "employee"}
        </div>
        <Badge variant="destructive">
          {row.conflict_type === "opening_balance_exists" ? "Opening Balance already exists" : "Same-day anchor already exists"}
        </Badge>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
        <div className="rounded-md border bg-white p-2 space-y-1">
          <div className="font-medium text-muted-foreground">Existing</div>
          <div>Effective: {existingAnchor?.effective_date ?? "-"}</div>
          <div>Stated balance: {existingAnchor ? formatINR(existingAnchor.stated_balance) : "-"}</div>
          <div>Note: {existingAnchor?.note || "-"}</div>
          <div>Recorded by: {existingAnchor?.created_by_name || "-"}</div>
          <div>Recorded at: {existingAnchor ? new Date(existingAnchor.created_at).toLocaleString() : "-"}</div>
        </div>
        <div className="rounded-md border bg-white p-2 space-y-1">
          <div className="font-medium text-muted-foreground">Incoming (from file)</div>
          <div>Effective: {row.effective_date ?? "-"}</div>
          <div>Stated balance: {row.input_amount !== null ? formatINR(row.input_amount) : "-"}</div>
          <div>Note: {row.note || "-"}</div>
        </div>
      </div>

      <div className="space-y-2">
        <RadioGroup value={action ?? ""} onValueChange={(v) => setAction(v as RowResolution["action"])}>
          <div className="flex items-center gap-2">
            <RadioGroupItem value="create" id={`row-${row.row_number}-create`} />
            <Label htmlFor={`row-${row.row_number}-create`} className="font-normal cursor-pointer text-sm">
              Add as new update -- keep the existing record, add this as another intentional update
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem value="replace" id={`row-${row.row_number}-replace`} />
            <Label htmlFor={`row-${row.row_number}-replace`} className="font-normal cursor-pointer text-sm">
              Replace -- use the file's row as the corrected version of the existing record
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem value="edit" id={`row-${row.row_number}-edit`} />
            <Label htmlFor={`row-${row.row_number}-edit`} className="font-normal cursor-pointer text-sm">
              Edit -- review and adjust the values before replacing the existing record
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem value="skip" id={`row-${row.row_number}-skip`} />
            <Label htmlFor={`row-${row.row_number}-skip`} className="font-normal cursor-pointer text-sm">
              Skip -- do nothing for this employee
            </Label>
          </div>
        </RadioGroup>

        {action === "edit" && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pl-6">
            <div>
              <Label className="text-xs">{amountLabel}</Label>
              <Input
                type="number"
                step="0.01"
                value={resolution?.override_balance ?? ""}
                onChange={(e) =>
                  onChange({ ...(resolution as RowResolution), override_balance: e.target.value === "" ? undefined : Number(e.target.value) })
                }
              />
            </div>
            <div>
              <Label className="text-xs">Effective date</Label>
              <Input
                type="date"
                value={resolution?.override_effective_date ?? ""}
                onChange={(e) => onChange({ ...(resolution as RowResolution), override_effective_date: e.target.value || undefined })}
              />
            </div>
            <div>
              <Label className="text-xs">Note</Label>
              <Input
                value={resolution?.override_note ?? ""}
                onChange={(e) => onChange({ ...(resolution as RowResolution), override_note: e.target.value })}
              />
            </div>
          </div>
        )}

        {(action === "replace" || action === "edit") && (
          <div className="pl-6">
            <Label className="text-xs">Reason (required)</Label>
            <Textarea
              value={resolution?.reason ?? ""}
              onChange={(e) => onChange({ ...(resolution as RowResolution), reason: e.target.value })}
              placeholder="e.g. Opening balance received incorrectly from previous accounting system."
              className="text-sm"
              rows={2}
            />
          </div>
        )}
      </div>
    </div>
  );
}

export interface ImportBalancesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  onImportApplied?: () => void;
}

export function ImportBalancesDialog({
  open,
  onOpenChange,
  organizationId,
  onImportApplied,
}: ImportBalancesDialogProps) {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<WizardStep>("type");
  const [mode, setMode] = useState<ImportMode>("historical_opening");
  const [downloadingStarter, setDownloadingStarter] = useState(false);

  const [file, setFile] = useState<File | null>(null);
  const [parsedSheet, setParsedSheet] = useState<ParsedSheet | null>(null);
  const [sheetSchema, setSheetSchema] = useState<StarterSheetSchema | null>(null);
  const [headerError, setHeaderError] = useState<string[] | null>(null);
  const [parsing, setParsing] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [validateResult, setValidateResult] = useState<ImportValidateResultV2 | null>(null);
  const [previewRows, setPreviewRows] = useState<ImportRowDetail[]>([]);
  // Keyed by row_number. Only relevant for rows with conflict_status='conflict'.
  const [rowResolutions, setRowResolutions] = useState<Record<number, RowResolution>>({});
  // Keyed by user_id. Read-only display data fetched after validate, so a
  // conflict card can show what the EXISTING anchor actually says --
  // resolution choices are still validated/applied entirely server-side.
  const [conflictAnchorsByUser, setConflictAnchorsByUser] = useState<Record<string, HistoricalAnchor[]>>({});

  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<ImportApplyResult | null>(null);
  const [showApplyDetails, setShowApplyDetails] = useState(false);

  const resetAll = () => {
    setStep("type");
    setMode("historical_opening");
    setFile(null);
    setParsedSheet(null);
    setSheetSchema(null);
    setHeaderError(null);
    setSubmitting(false);
    setBatchId(null);
    setValidateResult(null);
    setPreviewRows([]);
    setRowResolutions({});
    setConflictAnchorsByUser({});
    setApplying(false);
    setApplyResult(null);
    setShowApplyDetails(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleClose = (nextOpen: boolean) => {
    if (!nextOpen) {
      resetAll();
    }
    onOpenChange(nextOpen);
  };

  // ---- Step 2: starter sheet ----
  const handleDownloadStarter = async () => {
    setDownloadingStarter(true);
    try {
      const { data, error } = await supabase
        .from("profiles")
        .select("employee_id, name, email, balance")
        .eq("organization_id", organizationId)
        .eq("is_active", true)
        .order("name", { ascending: true });
      if (error) {
        throw new Error(error.message);
      }
      const employees = (data ?? []) as ActiveEmployee[];

      const headerRow = canonicalStarterHeaders(mode);
      const dataRows = employees.map((emp) => [
        emp.employee_id ?? "",
        emp.name ?? "",
        emp.email ?? "",
        emp.balance ?? 0,
        "",
        "",
        "",
      ]);

      const worksheet = XLSX.utils.aoa_to_sheet([headerRow, ...dataRows]);
      // Force the Employee ID column to text so Excel never strips leading zeros.
      const range = XLSX.utils.decode_range(worksheet["!ref"] || "A1");
      for (let r = 1; r <= range.e.r; r++) {
        const cellRef = XLSX.utils.encode_cell({ r, c: 0 });
        const cell = worksheet[cellRef];
        if (cell) {
          cell.t = "s";
          cell.v = String(cell.v ?? "");
        }
      }
      worksheet["!cols"] = [
        { wch: 14 },
        { wch: 24 },
        { wch: 28 },
        { wch: 16 },
        { wch: 18 },
        { wch: 16 },
        { wch: 24 },
      ];

      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, "Import");
      const fileName = mode === "historical_opening" ? "opening-balances-starter.xlsx" : "allocation-starter.xlsx";
      XLSX.writeFile(workbook, fileName, { bookType: "xlsx", compression: true });
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Could not build starter sheet",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setDownloadingStarter(false);
    }
  };

  // ---- Step 3: upload + parse ----
  // No mapping step: the file must match the PesoWise starter sheet's exact
  // column headers for the selected mode (balanceImportStarterSheet.ts).
  const handleFileSelected = async (selected: File | null) => {
    setFile(null);
    setParsedSheet(null);
    setSheetSchema(null);
    setHeaderError(null);
    if (!selected) return;

    setParsing(true);
    try {
      const buffer = await selected.arrayBuffer();
      // cellDates lets SheetJS hand back JS Date objects for date-formatted
      // cells directly, but the schema-builder's date normalizer still
      // handles a raw numeric serial itself -- CSV, other workbook
      // producers, and some SheetJS code paths can hand back either shape
      // regardless of this option.
      const workbook = XLSX.read(buffer, { type: "array", cellFormula: false, cellDates: true });
      const firstSheetName = workbook.SheetNames[0];
      if (!firstSheetName) {
        throw new Error("The file has no sheets.");
      }
      const sheet = workbook.Sheets[firstSheetName];
      const aoa = XLSX.utils.sheet_to_json<(string | number | Date | null)[]>(sheet, {
        header: 1,
        raw: true,
        defval: null,
      });
      if (aoa.length === 0) {
        throw new Error("The file appears to be empty.");
      }
      const [headerRow, ...dataRows] = aoa;
      const headers = headerRow.map((h) => (h === null ? "" : String(h).trim()));
      const nonEmptyRows = dataRows.filter((row) => row.some((cell) => cell !== null && String(cell).trim() !== ""));

      if (nonEmptyRows.length > MAX_IMPORT_ROWS) {
        throw new Error(
          `The file contains ${nonEmptyRows.length} rows. The maximum per import is ${MAX_IMPORT_ROWS}.`,
        );
      }

      const resolution = resolveStarterSheetSchema(headers, mode);
      if (!resolution.ok) {
        setHeaderError(resolution.missing);
        setFile(selected);
        return;
      }

      setFile(selected);
      setParsedSheet({ headers, rows: nonEmptyRows });
      setSheetSchema(resolution.schema);
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Could not read file",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setParsing(false);
    }
  };

  // ---- Step 4: create batch, upload, stage rows, validate ----
  const handleContinueToPreview = async () => {
    if (!file || !parsedSheet || !sheetSchema) return;

    const { rows: stagedRows, invalidDateRows } = buildStagedRowsFromSheet(parsedSheet, sheetSchema);
    if (invalidDateRows.length > 0) {
      const shown = invalidDateRows.slice(0, 5).join(", ");
      const more = invalidDateRows.length > 5 ? ` and ${invalidDateRows.length - 5} more` : "";
      toast({
        variant: "destructive",
        title: "Invalid Effective Date",
        description: `Row${invalidDateRows.length > 1 ? "s" : ""} ${shown}${more} ${
          invalidDateRows.length > 1 ? "have" : "has"
        } an invalid Effective Date. Fix the date and upload again.`,
      });
      return;
    }

    setSubmitting(true);
    try {
      const sha256 = await sha256Hex(file);

      // Early, client-side duplicate warning -- balance_apply_import_v1 is
      // the authoritative gate and re-checks this itself at Apply time, but
      // catching it here avoids the admin staging/previewing a file that can
      // never be applied.
      const duplicate = await findDuplicateAppliedBatch({ organizationId, mode, sha256 });
      if (duplicate) {
        toast({
          variant: "destructive",
          title: "Already applied",
          description: `This exact file was already applied on ${
            duplicate.applied_at ? new Date(duplicate.applied_at).toLocaleString() : "an earlier date"
          } (batch ${duplicate.id}).`,
        });
        setSubmitting(false);
        return;
      }

      const batch = await createImportBatch({
        organizationId,
        mode,
        originalFilename: file.name,
      });
      setBatchId(batch.id);

      // Archiving the original source is REQUIRED, not best-effort: an
      // import cannot be applied without a durable private copy of what was
      // uploaded (balance_apply_import_v1 also fails closed on this
      // server-side). A failure here stops the wizard on this step so the
      // admin can just click Continue again to retry -- no partial batch
      // ever reaches Preview/Apply without its archive.
      const path = await uploadImportSourceFile({ organizationId, batchId: batch.id, file });
      await attachSourceStoragePath(batch.id, path);
      await attachSourceSha256(batch.id, sha256);

      await insertImportRows(batch.id, stagedRows);

      const validation = await validateImportBatchV2(batch.id);
      setValidateResult(validation);
      setRowResolutions({});

      const rows = await getImportRows(batch.id);
      setPreviewRows(rows);

      const conflictingUserIds = Array.from(
        new Set(
          rows
            .filter((r) => r.conflict_status === "conflict" && r.matched_user_id)
            .map((r) => r.matched_user_id as string),
        ),
      );
      if (conflictingUserIds.length > 0) {
        const entries = await Promise.all(
          conflictingUserIds.map(async (userId) => {
            const anchors = await getBalanceHistoricalAnchors({ organizationId, userId });
            return [userId, anchors] as const;
          }),
        );
        setConflictAnchorsByUser(Object.fromEntries(entries));
      } else {
        setConflictAnchorsByUser({});
      }

      setStep("preview");
    } catch (err) {
      // Diagnostics stay in the console; the admin sees a spreadsheet-shaped
      // explanation, never a raw Postgres error string.
      console.error("Balance import staging/validation failed:", err);
      const rawMessage = err instanceof Error ? err.message : String(err);
      const friendly = /invalid input syntax/i.test(rawMessage)
        ? "One or more rows have a value PesoWise could not read (check the Effective Date and amount columns) and could not be staged."
        : rawMessage;
      toast({
        variant: "destructive",
        title: "Could not validate import",
        description: friendly,
      });
    } finally {
      setSubmitting(false);
    }
  };

  // ---- Step 7: apply ----
  const handleApply = async () => {
    if (!batchId) return;
    setApplying(true);
    try {
      const result = await applyImportBatchV2(batchId, rowResolutions);
      setApplyResult(result);
      setStep("result");
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Apply failed",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setApplying(false);
    }
  };

  const handleDone = () => {
    onImportApplied?.();
    handleClose(false);
  };

  const summaryCounts = useMemo(() => {
    const counts = {
      valid: 0,
      unknown: 0,
      ambiguous: 0,
      duplicate: 0,
      invalid_amount: 0,
      invalid_date: 0,
      no_op: 0,
    };
    for (const row of previewRows) {
      if (row.validation_status in counts) {
        counts[row.validation_status as keyof typeof counts] += 1;
      }
    }
    return counts;
  }, [previewRows]);

  const anchorKind = anchorKindForMode(mode);
  const amountLabel = amountHeaderForMode(mode);

  const conflictRows = useMemo(
    () => previewRows.filter((r) => r.conflict_status === "conflict"),
    [previewRows],
  );
  const unresolvedConflictCount = useMemo(
    () => conflictRows.filter((r) => !isResolutionComplete(rowResolutions[r.row_number])).length,
    [conflictRows, rowResolutions],
  );

  /** The existing active anchor a conflicting row would collide with, for display only. */
  const findExistingAnchorForRow = (row: ImportRowDetail): HistoricalAnchor | null => {
    if (!row.matched_user_id) return null;
    const anchors = conflictAnchorsByUser[row.matched_user_id] ?? [];
    if (row.conflict_type === "opening_balance_exists") {
      return anchors.find((a) => a.anchor_kind === "opening_balance" && a.status === "active") ?? null;
    }
    if (row.conflict_type === "same_day_anchor_exists") {
      return (
        anchors.find(
          (a) => a.status === "active" && a.effective_date === row.effective_date && a.anchor_kind === anchorKind,
        ) ?? null
      );
    }
    return null;
  };

  const setRowResolution = (rowNumber: number, next: RowResolution | undefined) => {
    setRowResolutions((prev) => {
      const copy = { ...prev };
      if (!next) {
        delete copy[rowNumber];
      } else {
        copy[rowNumber] = next;
      }
      return copy;
    });
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import Balances</DialogTitle>
          <DialogDescription>
            {step === "type" && "Choose how the amounts in your spreadsheet should be applied."}
            {step === "starter" && "Download a starter sheet prefilled with your active employees."}
            {step === "upload" && "Upload your completed starter sheet (.xlsx or .csv)."}
            {step === "preview" && "Review matched employees and fix any issues before applying."}
            {step === "confirm" && "Confirm before this import moves any money."}
            {step === "result" && "Import complete."}
          </DialogDescription>
        </DialogHeader>

        {step === "type" && (
          <div className="space-y-4 py-2">
            <RadioGroup value={mode} onValueChange={(v) => setMode(v as ImportMode)}>
              <div className="flex items-start gap-3 rounded-lg border p-3">
                <RadioGroupItem value="historical_opening" id="mode-historical" className="mt-1" />
                <Label htmlFor="mode-historical" className="font-normal cursor-pointer">
                  <span className="font-medium block">Opening Balance</span>
                  <span className="text-sm text-muted-foreground">
                    Set the balance employees had when you started tracking them in PesoWise. This is recorded
                    historically and adjusts today's balance by the missing historical effect -- it does not
                    overwrite today's balance.
                  </span>
                </Label>
              </div>
              <div className="flex items-start gap-3 rounded-lg border p-3">
                <RadioGroupItem value="balance_update" id="mode-balance-update" className="mt-1" />
                <Label htmlFor="mode-balance-update" className="font-normal cursor-pointer">
                  <span className="font-medium block">Balance Update</span>
                  <span className="text-sm text-muted-foreground">
                    Record the balance an employee was known to have on a later date. PesoWise calculates the
                    reconciliation adjustment required at that point in the timeline -- not a credit of the full
                    amount.
                  </span>
                </Label>
              </div>
              <div className="flex items-start gap-3 rounded-lg border p-3">
                <RadioGroupItem value="allocation" id="mode-allocation" className="mt-1" />
                <Label htmlFor="mode-allocation" className="font-normal cursor-pointer">
                  <span className="font-medium block">Allocation</span>
                  <span className="text-sm text-muted-foreground">
                    Add money to employee balances as an actual allocation, on top of their current balance.
                  </span>
                </Label>
              </div>
            </RadioGroup>
            <DialogFooter>
              <Button variant="outline" onClick={() => handleClose(false)}>
                Cancel
              </Button>
              <Button onClick={() => setStep("starter")}>Next</Button>
            </DialogFooter>
          </div>
        )}

        {step === "starter" && (
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              The starter sheet lists your active employees with their current balance, so you can fill in the{" "}
              {amountLabel} column for each. Upload it
              with the same column headers -- PesoWise reads this exact layout and does not offer column mapping
              right now.
            </p>
            <Button onClick={handleDownloadStarter} disabled={downloadingStarter} className="gap-2">
              {downloadingStarter ? "Building..." : "Download starter sheet"}
            </Button>
            <DialogFooter>
              <Button variant="outline" onClick={() => setStep("type")}>
                Back
              </Button>
              <Button onClick={() => setStep("upload")}>Next</Button>
            </DialogFooter>
          </div>
        )}

        {step === "upload" && (
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Upload spreadsheet</Label>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.csv"
                className="block w-full text-sm"
                onChange={(e) => void handleFileSelected(e.target.files?.[0] ?? null)}
              />
              {parsing && <p className="text-sm text-muted-foreground">Reading file...</p>}
            </div>

            {headerError && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 space-y-1">
                <p className="font-medium">This file does not match the PesoWise starter sheet.</p>
                <p>Missing column(s):</p>
                <ul className="list-disc pl-5">
                  {headerError.map((col) => (
                    <li key={col}>{col}</li>
                  ))}
                </ul>
                <p>
                  Please use the starter sheet from the previous step and only fill in the{" "}
                  {amountLabel} column -- do not rename or remove any columns.
                </p>
              </div>
            )}

            {parsedSheet && sheetSchema && !headerError && (
              <p className="text-sm text-muted-foreground">
                Detected {parsedSheet.rows.length} row(s) in <span className="font-medium">{file?.name}</span>. Column
                headers match the PesoWise starter sheet.
              </p>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={() => setStep("starter")}>
                Back
              </Button>
              <Button
                onClick={() => void handleContinueToPreview()}
                disabled={!parsedSheet || !sheetSchema || !!headerError || submitting}
              >
                {submitting ? "Validating..." : "Continue"}
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === "preview" && validateResult && (
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
              <div className="rounded-lg border p-2">
                <div className="text-muted-foreground text-xs">Total rows</div>
                <div className="font-medium">{validateResult.row_count}</div>
              </div>
              <div className="rounded-lg border p-2">
                <div className="text-muted-foreground text-xs">Matched</div>
                <div className="font-medium text-green-700">{validateResult.valid_row_count}</div>
              </div>
              <div className="rounded-lg border p-2">
                <div className="text-muted-foreground text-xs">Needs fixing</div>
                <div className="font-medium text-red-600">{validateResult.invalid_row_count}</div>
              </div>
              <div className="rounded-lg border p-2">
                <div className="text-muted-foreground text-xs">Total delta</div>
                <div className="font-medium">{formatINR(validateResult.total_delta)}</div>
              </div>
              <div className="rounded-lg border p-2">
                <div className="text-muted-foreground text-xs">Unknown</div>
                <div className="font-medium">{summaryCounts.unknown}</div>
              </div>
              <div className="rounded-lg border p-2">
                <div className="text-muted-foreground text-xs">Ambiguous</div>
                <div className="font-medium">{summaryCounts.ambiguous}</div>
              </div>
              <div className="rounded-lg border p-2">
                <div className="text-muted-foreground text-xs">Duplicate</div>
                <div className="font-medium">{summaryCounts.duplicate}</div>
              </div>
              <div className="rounded-lg border p-2">
                <div className="text-muted-foreground text-xs">No-op</div>
                <div className="font-medium">{summaryCounts.no_op}</div>
              </div>
              {anchorKind && (
                <div className="rounded-lg border p-2">
                  <div className="text-muted-foreground text-xs">Conflicts</div>
                  <div className={`font-medium ${conflictRows.length > 0 ? "text-amber-700" : ""}`}>
                    {conflictRows.length}
                  </div>
                </div>
              )}
            </div>

            {conflictRows.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium">
                  {unresolvedConflictCount} of {conflictRows.length} conflict(s) still need a decision
                </p>
                <div className="space-y-3 max-h-[35vh] overflow-y-auto pr-1">
                  {conflictRows.map((row) => (
                    <ConflictCard
                      key={row.id}
                      row={row}
                      existingAnchor={findExistingAnchorForRow(row)}
                      resolution={rowResolutions[row.row_number]}
                      onChange={(next) => setRowResolution(row.row_number, next)}
                      amountLabel={amountLabel}
                    />
                  ))}
                </div>
              </div>
            )}

            <div className="rounded-md border overflow-x-auto max-h-[40vh] overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Row</TableHead>
                    <TableHead>Employee ID</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Status</TableHead>
                    {anchorKind && <TableHead>Conflict</TableHead>}
                    {anchorKind && <TableHead className="text-right">Position before</TableHead>}
                    <TableHead className="text-right">{anchorKind ? "Target" : "Current"}</TableHead>
                    <TableHead className="text-right">{anchorKind ? "Adjustment" : "Input"}</TableHead>
                    <TableHead className="text-right">{anchorKind ? "Current today" : "Resulting"}</TableHead>
                    {anchorKind && <TableHead className="text-right">Projected</TableHead>}
                    <TableHead>Effective date</TableHead>
                    <TableHead>Note</TableHead>
                    <TableHead>Message</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {previewRows.map((row) => {
                    const adjustment =
                      row.input_amount !== null && row.historical_position_before !== null
                        ? row.input_amount - row.historical_position_before
                        : null;
                    return (
                      <TableRow key={row.id}>
                        <TableCell>{row.row_number}</TableCell>
                        <TableCell className="font-mono text-xs">{row.raw_employee_id || "-"}</TableCell>
                        <TableCell className="text-xs">{row.matched_user_id ? "Matched" : "-"}</TableCell>
                        <TableCell className="text-xs">{row.raw_email || "-"}</TableCell>
                        <TableCell>
                          <ValidationStatusBadge status={row.validation_status} />
                        </TableCell>
                        {anchorKind && (
                          <TableCell>
                            <ConflictBadge status={row.conflict_status} />
                          </TableCell>
                        )}
                        {anchorKind && (
                          <TableCell className="text-right text-xs">
                            {row.historical_position_before !== null ? formatINR(row.historical_position_before) : "-"}
                          </TableCell>
                        )}
                        <TableCell className="text-right text-xs">
                          {anchorKind
                            ? row.input_amount !== null
                              ? formatINR(row.input_amount)
                              : "-"
                            : row.current_balance_snapshot !== null
                              ? formatINR(row.current_balance_snapshot)
                              : "-"}
                        </TableCell>
                        <TableCell className="text-right text-xs">
                          {anchorKind
                            ? adjustment !== null
                              ? formatINR(adjustment)
                              : "-"
                            : row.input_amount !== null
                              ? formatINR(row.input_amount)
                              : "-"}
                        </TableCell>
                        <TableCell className="text-right text-xs">
                          {anchorKind
                            ? row.current_balance_snapshot !== null
                              ? formatINR(row.current_balance_snapshot)
                              : "-"
                            : row.calculated_new_balance !== null
                              ? formatINR(row.calculated_new_balance)
                              : "-"}
                        </TableCell>
                        {anchorKind && (
                          <TableCell className="text-right text-xs">
                            {row.calculated_new_balance !== null ? formatINR(row.calculated_new_balance) : "-"}
                          </TableCell>
                        )}
                        <TableCell className="text-xs whitespace-nowrap">{row.effective_date || "-"}</TableCell>
                        <TableCell className="text-xs max-w-[140px] truncate">{row.note || "-"}</TableCell>
                        <TableCell className="text-xs max-w-[200px] truncate text-muted-foreground">
                          {row.validation_message || "-"}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setStep("upload")}>
                Back
              </Button>
              <Button onClick={() => setStep("confirm")} disabled={unresolvedConflictCount > 0}>
                Continue
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === "confirm" && validateResult && (
          <div className="space-y-4 py-2">
            <div className="rounded-lg border p-4 text-sm space-y-2">
              <p className="font-medium">
                {mode === "historical_opening" &&
                  `Record Opening Balance anchors for ${validateResult.valid_row_count} employee(s)? Today's balance changes only by the missing historical effect.`}
                {mode === "balance_update" &&
                  `Record Balance Update anchors for ${validateResult.valid_row_count} employee(s)? Today's balance changes only by the reconciliation adjustment required, not the full target.`}
                {mode === "allocation" &&
                  `Add ${formatINR(validateResult.total_delta)} across ${validateResult.valid_row_count} employee(s)?`}
              </p>
              {validateResult.apply_disabled && (
                <p className="text-red-600 text-sm">
                  {validateResult.invalid_row_count} row(s) need fixing before you can apply this import.
                </p>
              )}
              {unresolvedConflictCount > 0 && (
                <p className="text-red-600 text-sm">
                  {unresolvedConflictCount} conflict(s) still need a decision -- go back to Preview to resolve them.
                </p>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setStep("preview")}>
                Back
              </Button>
              <Button
                onClick={() => void handleApply()}
                disabled={validateResult.apply_disabled || unresolvedConflictCount > 0 || applying}
              >
                {applying ? "Applying..." : `Apply ${MODE_LABELS[mode]} Import`}
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === "result" && applyResult && (
          <div className="space-y-4 py-2">
            <div className="rounded-lg border p-4 text-sm space-y-1">
              <p className="font-medium text-green-700">Import Applied</p>
              <p>Employees changed: {applyResult.changed_count}</p>
              <p>Total delta: {formatINR(applyResult.total_delta)}</p>
              <p className="text-muted-foreground text-xs">Batch ID: {applyResult.batch_id}</p>
              <p className="text-muted-foreground text-xs">{new Date().toLocaleString()}</p>
            </div>

            {applyResult.rows && applyResult.rows.length > 0 && (
              <div className="space-y-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowApplyDetails((v) => !v)}
                >
                  {showApplyDetails ? "Hide Details" : "View Details"}
                </Button>
                {showApplyDetails && (
                  <div className="rounded-md border overflow-x-auto max-h-[35vh] overflow-y-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Row</TableHead>
                          <TableHead>Employee ID</TableHead>
                          <TableHead>Name</TableHead>
                          <TableHead className="text-right">Before</TableHead>
                          <TableHead className="text-right">Input</TableHead>
                          <TableHead className="text-right">After</TableHead>
                          <TableHead>No-op</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {applyResult.rows.map((row) => (
                          <TableRow key={row.row_number}>
                            <TableCell>{row.row_number}</TableCell>
                            <TableCell className="font-mono text-xs">{row.employee_id || "-"}</TableCell>
                            <TableCell className="text-xs">{row.employee_name || "-"}</TableCell>
                            <TableCell className="text-right text-xs">{formatINR(row.before)}</TableCell>
                            <TableCell className="text-right text-xs">{formatINR(row.input_amount)}</TableCell>
                            <TableCell className="text-right text-xs">{formatINR(row.after)}</TableCell>
                            <TableCell className="text-xs">{row.no_op ? "Yes" : "No"}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>
            )}

            <DialogFooter>
              <Button onClick={handleDone}>Done</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
