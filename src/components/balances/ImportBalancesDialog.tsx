import { useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/auth-context";
import { ORGANIZATION_FEATURE_KEYS } from "@/lib/organizationFeatureKeys";
import { useBalanceHistoricalV2Capability } from "@/lib/balanceHistoricalV2Capability";
import { useBalanceAdditiveV3Capability } from "@/lib/balanceAdditiveV3Capability";
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
  applyImportBatchV3,
  getBalanceHistoricalAnchors,
  validateImportBatchV2,
  validateImportBatchV3,
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
  amountHeaderForMode,
  buildStagedRowsFromSheet,
  canonicalStarterHeaders,
  resolveStarterSheetSchema,
  type ParsedSheet,
  type StarterSheetSchema,
} from "@/lib/balanceImportStarterSheet";
import {
  computeTallyReconciliation,
  parseTallyGroupSummaryWorkbook,
  reconciles,
  resolveTallyEffectiveDate,
  type TallyParseResult,
  type TallyReconciliationSummary,
} from "@/lib/tallyBalanceImport";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import type { StagedImportRow } from "@/services/BalanceImportService";

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

// Tally Group Summary import (2026-08-25). A second file source alongside the
// PesoWise starter sheet -- selected explicitly in Step 1, never inferred
// from the uploaded file's shape. Tally only ever produces a point-in-time
// Closing Balance per employee, so it can only feed Opening Balance / Balance
// Update (never Allocation, which is a real additive transaction with no
// Tally equivalent).
type ImportSource = "template" | "tally";

type TallyUsage = "opening_balance" | "balance_update";

/** Tally is never a valid source for Allocation -- returns null rather than
 *  silently defaulting an unexpected mode to Opening Balance. The UI hides
 *  Allocation whenever importSource is "tally" (see the type step), but a
 *  hidden radio button is not financial authority: handleContinueToPreviewTally
 *  checks this return value explicitly before staging anything. */
export function tallyUsageForMode(mode: ImportMode): TallyUsage | null {
  if (mode === "balance_update" || mode === "balance_credit") return "balance_update";
  if (mode === "historical_opening" || mode === "opening_credit") return "opening_balance";
  return null;
}

const MODE_LABELS: Record<ImportMode, string> = {
  historical_opening: "Opening Balance",
  balance_update: "Balance Update",
  allocation: "Allocation",
  opening_credit: "Opening Balance Credit",
  balance_credit: "Balance Credit",
};

// Additive Credit V3 (2026-09-01): opening_credit/balance_credit are ALWAYS
// additive (current + amount), exactly like Allocation -- there is no
// target/reconstruction concept for them, so anchorKindForMode correctly
// returns null (the same "additive display" branch Allocation already uses).
// The OLD historical_opening/balance_update anchor modes are kept working
// here ONLY for any already-existing batch still reachable through
// ImportHistoryDialog; they are no longer offered in this dialog's mode
// selector (see the RadioGroup below) -- new imports always use the v3
// additive modes.
function anchorKindForMode(mode: ImportMode): AnchorKind | null {
  if (mode === "historical_opening") return "opening_balance";
  if (mode === "balance_update") return "balance_update";
  return null;
}

/** True for the modes whose validate/apply must go through the additive V3
 *  RPCs instead of the old anchor-engine v2 RPCs. */
function isAdditiveCreditMode(mode: ImportMode): boolean {
  return mode === "opening_credit" || mode === "balance_credit";
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

interface TallyPreviewPanelProps {
  result: Extract<TallyParseResult, { ok: true }>;
  mode: ImportMode;
  employeesById: Record<string, ActiveEmployee>;
}

function TallyPreviewPanel({ result, mode, employeesById }: TallyPreviewPanelProps) {
  // This panel only ever renders while importSource === "tally", and the
  // type step hides Allocation whenever that's true -- usage should never
  // actually be null here, but this is a read-only display, not the
  // financial-authority check (that lives in handleContinueToPreviewTally),
  // so it degrades to a placeholder rather than throwing if it ever is.
  const usage = tallyUsageForMode(mode);
  const effectiveDate = usage ? resolveTallyEffectiveDate(result.periodEnd, usage) : null;
  const drCount = result.rows.filter((r) => r.tallyClosingSide === "dr").length;
  const crCount = result.rows.filter((r) => r.tallyClosingSide === "cr").length;
  const zeroCount = result.rows.filter((r) => r.tallyClosingSide === "zero").length;
  const summary = computeTallyReconciliation(result, employeesById);
  const ok = summary.sheetReconciles;
  const skippedCount = summary.unknownEmployeeCount + summary.identityFailureCount;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
        <div className="rounded-lg border p-2">
          <div className="text-muted-foreground text-xs">Report period</div>
          <div className="font-medium">
            {result.periodStart} to {result.periodEnd}
          </div>
        </div>
        <div className="rounded-lg border p-2">
          <div className="text-muted-foreground text-xs">Employees</div>
          <div className="font-medium">{result.rows.length}</div>
        </div>
        <div className="rounded-lg border p-2">
          <div className="text-muted-foreground text-xs">Cr / Dr / Zero</div>
          <div className="font-medium">
            {crCount} / {drCount} / {zeroCount}
          </div>
        </div>
        <div className="rounded-lg border p-2">
          <div className="text-muted-foreground text-xs">Effective date</div>
          <div className="font-medium">{effectiveDate ?? "—"}</div>
        </div>
      </div>

      {/* Sheet-level financial reconciliation -- NEVER affected by employee
          identity. A row that will be skipped from staging still counts
          here; only a genuine, unexplained arithmetic gap fails this. */}
      <div
        className={`rounded-lg border p-3 text-sm space-y-1 ${
          ok ? "border-green-200 bg-green-50 text-green-800" : "border-red-200 bg-red-50 text-red-800"
        }`}
      >
        <div className="font-medium">Reconciliation {ok ? "OK" : "FAILED"}</div>
        <div>Tally Grand Total: {result.reportGrandTotal !== null ? formatINR(result.reportGrandTotal) : "—"}</div>
        <div>All Tally rows: {formatINR(result.sheetFinancialTotal)}</div>
        {ok && (
          <>
            <div>Importable: {formatINR(summary.importableTotal)}</div>
            {skippedCount > 0 && <div>Skipped: {formatINR(summary.skippedKnownTotal)}</div>}
            {skippedCount > 0 ? (
              <div>
                {skippedCount} row{skippedCount === 1 ? "" : "s"} will be skipped. The complete Tally report still
                reconciles.
              </div>
            ) : (
              <div>Every row will be imported.</div>
            )}
          </>
        )}
        {!ok && result.amountFailures.length > 0 && (
          <div>
            {result.amountFailures.length} row(s) have a Closing Balance PesoWise could not read at all -- their
            amount is unknown and cannot be accounted for. This is a genuine reconciliation problem, not an identity
            one.
          </div>
        )}
        {!ok && result.amountFailures.length === 0 && result.reportGrandTotal === null && (
          <div>
            The Tally Group Summary must include a valid Grand Total Closing Balance so PesoWise can reconcile the
            import before applying it.
          </div>
        )}
        {!ok && result.amountFailures.length === 0 && result.reportGrandTotal !== null && (
          <div>
            The sheet's own rows do not add up to its Grand Total (difference{" "}
            {formatINR(result.sheetReconciliationDifference ?? 0)}). Continue is blocked until this is fixed in
            Tally.
          </div>
        )}
      </div>

      {result.amountFailures.length > 0 && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 space-y-1">
          <p className="font-medium">
            {result.amountFailures.length} row(s) have an unreadable Closing Balance and must be fixed in Tally:
          </p>
          <ul className="list-disc pl-5">
            {result.amountFailures.slice(0, 10).map((f) => (
              <li key={f.sourceRowNumber}>
                Row {f.sourceRowNumber} ("{f.rawParticulars}"): {f.reason}
              </li>
            ))}
          </ul>
          {result.amountFailures.length > 10 && <p>...and {result.amountFailures.length - 10} more.</p>}
        </div>
      )}

      {result.unidentifiedRows.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 space-y-1">
          <p className="font-medium">
            {result.unidentifiedRows.length} row(s) could not be matched to an employee and will be skipped:
          </p>
          <ul className="list-disc pl-5">
            {result.unidentifiedRows.slice(0, 10).map((f) => (
              <li key={f.sourceRowNumber}>
                Row {f.sourceRowNumber} — "{f.rawParticulars}" ({formatINR(f.signedClosingBalance)}): This row could
                not be matched to an employee and will be skipped.
              </li>
            ))}
          </ul>
          {result.unidentifiedRows.length > 10 && <p>...and {result.unidentifiedRows.length - 10} more.</p>}
        </div>
      )}

      <div className="max-h-64 overflow-y-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Employee</TableHead>
              <TableHead>Employee ID</TableHead>
              <TableHead>Tally Closing</TableHead>
              {usage === "balance_update" ? (
                <>
                  <TableHead>Debit (Amount to Add)</TableHead>
                  <TableHead>Current PesoWise Balance</TableHead>
                  <TableHead>New PesoWise Balance</TableHead>
                </>
              ) : (
                <TableHead>PesoWise Signed Balance</TableHead>
              )}
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {summary.importableRows.concat(summary.unknownEmployeeRows).map(({ row, status, pesoWiseName }) => {
              const currentBalance = employeesById[row.employeeId]?.balance ?? null;
              const newBalance =
                usage === "balance_update" && currentBalance !== null && !Number.isNaN(row.tallyDebitAmount)
                  ? Math.round((currentBalance + row.tallyDebitAmount + Number.EPSILON) * 100) / 100
                  : null;
              return (
              <TableRow key={row.sourceRowNumber}>
                <TableCell>
                  {row.employeeName}
                  {row.flags.includes("hold") && (
                    <Badge variant="outline" className="ml-2">
                      Hold
                    </Badge>
                  )}
                </TableCell>
                <TableCell>{row.employeeId}</TableCell>
                <TableCell>
                  {row.tallyClosingSide === "zero" ? "-" : `${row.tallyClosingMagnitude.toFixed(2)} ${row.tallyClosingSide.toUpperCase()}`}
                </TableCell>
                {usage === "balance_update" ? (
                  <>
                    <TableCell>
                      {Number.isNaN(row.tallyDebitAmount) ? (
                        <Badge variant="outline" className="border-red-400 text-red-700">
                          UNREADABLE
                        </Badge>
                      ) : (
                        formatINR(row.tallyDebitAmount)
                      )}
                    </TableCell>
                    <TableCell>{currentBalance !== null ? formatINR(currentBalance) : "—"}</TableCell>
                    <TableCell>{newBalance !== null ? formatINR(newBalance) : "—"}</TableCell>
                  </>
                ) : (
                  <TableCell>{formatINR(row.signedClosingBalance)}</TableCell>
                )}
                <TableCell>
                  {status === "unknown_employee" && (
                    <div>
                      <Badge variant="outline" className="border-amber-400 text-amber-700">
                        WARNING — WILL SKIP
                      </Badge>
                      <p className="text-xs text-amber-800 mt-1">
                        Employee ID {row.employeeId} was not found in PesoWise and will be skipped.
                      </p>
                    </div>
                  )}
                  {status === "name_mismatch" && (
                    <div>
                      <Badge variant="outline" className="border-amber-400 text-amber-700">
                        WARNING — WILL IMPORT
                      </Badge>
                      <p className="text-xs text-amber-800 mt-1">
                        Name differs — Employee ID {row.employeeId} matched PesoWise employee "
                        {pesoWiseName ?? "(no name on file)"}". Tally name: "{row.employeeName}". Employee ID will be
                        used.
                      </p>
                    </div>
                  )}
                  {status === "matched" && <Badge variant="success">Matched</Badge>}
                </TableCell>
              </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

export interface ImportBalancesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  onImportApplied?: () => void;
  /** Opens the dialog straight into the Tally source, skipping past the
   *  "type" step's source choice -- the "Import from Tally" quick-action
   *  button on the Balances page uses this. Both entry points render this
   *  exact same component and share the same parser/services/backend --
   *  there is no separate Tally implementation. */
  initialSource?: ImportSource;
}

export function ImportBalancesDialog({
  open,
  onOpenChange,
  organizationId,
  onImportApplied,
  initialSource = "template",
}: ImportBalancesDialogProps) {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<WizardStep>(initialSource === "tally" ? "upload" : "type");
  const [mode, setMode] = useState<ImportMode>("opening_credit");
  const [importSource, setImportSource] = useState<ImportSource>(initialSource);
  const [downloadingStarter, setDownloadingStarter] = useState(false);

  const [file, setFile] = useState<File | null>(null);
  const [parsedSheet, setParsedSheet] = useState<ParsedSheet | null>(null);
  const [sheetSchema, setSheetSchema] = useState<StarterSheetSchema | null>(null);
  const [headerError, setHeaderError] = useState<string[] | null>(null);
  const [parsing, setParsing] = useState(false);

  const [tallyResult, setTallyResult] = useState<TallyParseResult | null>(null);
  const [tallyEmployeesById, setTallyEmployeesById] = useState<Record<string, ActiveEmployee>>({});

  // ── Historical Balance readiness -- three INDEPENDENT concepts ──────────
  // historicalFlagOn: the org admin has enabled the feature in Master Admin.
  // historicalBackendReady: the server has the engine THIS mode needs
  //   installed -- the additive V3 engine (balance_additive_v3_capabilities_v1)
  //   for opening_credit/balance_credit (the only modes this dialog's mode
  //   selector offers going forward), or the old V2 anchor engine
  //   (balance_historical_v2_capabilities_v1) for the two legacy mode values,
  //   kept working here only for any already-existing batch that somehow
  //   still carries them -- never offered as a new selection.
  // historicalMutationReady: BOTH of the above -- required before ANY RPC
  //   that actually writes to the database is called for a historical mode
  //   (stageAndValidate/validateImportBatchV2|V3/applyImportBatchV2|V3/reverse).
  //
  // CRITICAL: none of these control whether Tally, or Opening Balance
  // Credit/Balance Credit, are OFFERED in the UI. An earlier version of this
  // gate combined "is this feature ready" and "is this an admin allowed to
  // even SEE this import format" into one flag -- the practical effect was
  // that a missing backend migration made the Tally import option (and
  // Opening Balance/Balance Update) disappear from the screen entirely,
  // which is never correct: Tally is a FILE FORMAT, not a financial
  // capability, and must stay discoverable/previewable regardless of the
  // accounting engine's rollout status. Only the actual money-moving RPC
  // calls are gated on historicalMutationReady; visibility is gated on
  // nothing here.
  const { hasOrganizationFeature } = useAuth();
  const historicalFlagOn = hasOrganizationFeature(ORGANIZATION_FEATURE_KEYS.historical_balance_v2);
  const historicalCapability = useBalanceHistoricalV2Capability();
  const additiveCapability = useBalanceAdditiveV3Capability();
  const capabilityLoading = historicalCapability.loading || additiveCapability.loading;
  const historicalBackendReady = isAdditiveCreditMode(mode) ? additiveCapability.ready : historicalCapability.ready;
  const historicalMutationReady = historicalFlagOn && historicalBackendReady;

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
    setStep(initialSource === "tally" ? "upload" : "type");
    // Opening Balance Credit is always a safe DEFAULT selection regardless
    // of backend readiness -- selecting it only previews locally; readiness
    // is enforced at the point of actually staging something
    // (stageAndValidate), not at selection time.
    setMode("opening_credit");
    setImportSource(initialSource);
    setFile(null);
    setParsedSheet(null);
    setSheetSchema(null);
    setHeaderError(null);
    setTallyResult(null);
    setTallyEmployeesById({});
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
      const fileName =
        mode === "historical_opening" || mode === "opening_credit"
          ? "opening-balances-starter.xlsx"
          : mode === "balance_update" || mode === "balance_credit"
            ? "balance-credit-starter.xlsx"
            : "allocation-starter.xlsx";
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
      if (resolution.ok === false) {
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
  // Shared by both import sources: a PesoWise starter-sheet row and a parsed
  // Tally Group Summary row both resolve to the same source-agnostic
  // StagedImportRow, so everything from here on (archive, insert,
  // validateImportBatchV2, conflict UI, applyImportBatchV2) is identical
  // regardless of where the row came from.
  const stageAndValidate = async (stagedRows: StagedImportRow[]) => {
    if (!file) return;

    // The single choke point for both import sources: a historical mode
    // (Opening Balance/Balance Update, from either the starter sheet or
    // Tally) must never reach createImportBatch/insertImportRows/
    // validateImportBatchV2 unless the backend actually has the V2 anchor
    // engine installed AND the org has the feature enabled. Selecting the
    // mode and previewing a file is always allowed (see the "type"/"upload"
    // steps); this is what actually stops a database write from being
    // attempted against a 404 backend. Allocation is never gated here.
    if (mode !== "allocation" && !historicalMutationReady) {
      toast({
        variant: "destructive",
        title: "Historical balance import is not available yet",
        description: historicalFlagOn
          ? "The PesoWise backend update for Historical Balance has not been installed on this environment yet. Validation and Apply will unlock once it is."
          : "Ask an organization admin to enable Historical Balance in Master Admin first.",
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

      // Fail-closed Tally routing guarantee (2026-10-01 financial hotfix
      // audit): a NEW Tally Balance Update batch must never be created with
      // the legacy target-anchor mode (`balance_update`), and a new Tally
      // Opening Balance batch must never be created with the legacy
      // `historical_opening` mode -- that is exactly the engine whose
      // `adjustment = input_amount - historical_position_before` math is
      // what produced the owner's observed Current=7000/Debit=0 -> -7000
      // result on an old, pre-this-fix batch (see
      // Documentations MD/tally-group-summary-balance-import.md). The
      // RadioGroup above cannot emit a legacy mode today (it only ever
      // offers opening_credit/balance_credit/allocation), so this can only
      // fire if a future change reintroduces a legacy option or a caller
      // bypasses the RadioGroup entirely -- this is the actual
      // database-write choke point, not a UI nicety, and it fails closed
      // (throws, no batch created) rather than silently routing Tally money
      // through target-anchor math.
      if (importSource === "tally") {
        const usage = tallyUsageForMode(mode);
        if (usage === "balance_update" && mode !== "balance_credit") {
          throw new Error(
            `Internal contract error: Tally Balance Update must use mode="balance_credit" (additive V3), got "${mode}". Refusing to create this batch.`,
          );
        }
        if (usage === "opening_balance" && mode !== "opening_credit") {
          throw new Error(
            `Internal contract error: Tally Opening Balance must use mode="opening_credit" (additive V3), got "${mode}". Refusing to create this batch.`,
          );
        }
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

      // Additive V3 modes (opening_credit/balance_credit) validate through
      // the new engine -- no conflict detection exists or is needed (an
      // additive credit cannot "conflict" with anything). The old anchor
      // modes keep using v2, unreachable via this dialog's mode selector
      // but preserved for any already-existing batch.
      let validation: ImportValidateResultV2;
      if (isAdditiveCreditMode(mode)) {
        const v3Result = await validateImportBatchV3(batch.id);
        validation = { ...v3Result, conflict_count: 0, apply_disabled: v3Result.valid_row_count === 0 };
      } else {
        validation = await validateImportBatchV2(batch.id);
      }
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

  const handleContinueToPreview = async () => {
    if (!parsedSheet || !sheetSchema) return;
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
    await stageAndValidate(stagedRows);
  };

  // ---- Step 3b: Tally Group Summary upload + parse ----
  const handleTallyFileSelected = async (selected: File | null) => {
    setFile(null);
    setTallyResult(null);
    if (!selected) return;

    setParsing(true);
    try {
      const buffer = await selected.arrayBuffer();
      // cellNF + cellText are load-bearing: Tally's Cr/Dr sign lives only in
      // the cell's display format, never in the raw numeric value. See the
      // header comment in tallyBalanceImport.ts.
      const workbook = XLSX.read(buffer, { type: "array", cellNF: true, cellText: true });
      const result = parseTallyGroupSummaryWorkbook(workbook);

      // Same client-side hygiene guard as the starter-sheet path, applied
      // BEFORE anything is staged: the server's row cap remains the
      // authoritative gate (validateImportBatchV2/insertImportRows), but an
      // oversized Tally file must never even reach createImportBatch/
      // uploadImportSourceFile with a misleading "looks fine so far" preview.
      if (result.ok === true && result.rows.length > MAX_IMPORT_ROWS) {
        throw new Error(
          `The file contains ${result.rows.length} employee rows. The maximum per import is ${MAX_IMPORT_ROWS}.`,
        );
      }

      setFile(selected);
      setTallyResult(result);

      if (result.ok === true && result.rows.length > 0) {
        const ids = Array.from(new Set(result.rows.map((r) => r.employeeId)));
        const { data, error } = await supabase
          .from("profiles")
          .select("employee_id, name, email, balance")
          .eq("organization_id", organizationId)
          .eq("is_active", true)
          .in("employee_id", ids);
        if (error) throw new Error(error.message);
        const byId: Record<string, ActiveEmployee> = {};
        for (const emp of (data ?? []) as ActiveEmployee[]) {
          if (emp.employee_id) byId[emp.employee_id] = emp;
        }
        setTallyEmployeesById(byId);
      } else {
        setTallyEmployeesById({});
      }
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

  const handleContinueToPreviewTally = async () => {
    if (!tallyResult || tallyResult.ok === false) return;
    // Sheet-level financial reconciliation is the ONLY thing that can block
    // Continue here. Unknown employees, name mismatches, and unparseable
    // identity are warnings, not blockers -- they are resolved into
    // importable vs skipped rows below, never gate this check.
    if (!reconciles(tallyResult)) return;
    const summary = computeTallyReconciliation(tallyResult, tallyEmployeesById);
    if (summary.importableRows.length === 0) return;

    // Structural guard: this handler must never run for anything other than
    // the Tally source, regardless of which UI state happens to be
    // rendered. Historical Balance backend readiness is NOT checked here --
    // stageAndValidate is the single choke point for that (see its own
    // comment); this lets the friendly "backend not installed yet" message
    // surface consistently for both import sources instead of this handler
    // silently doing nothing.
    if (importSource !== "tally") return;
    const usage = tallyUsageForMode(mode);
    if (!usage) {
      toast({
        variant: "destructive",
        title: "Tally import is only valid for Opening Balance or Balance Update",
        description: "Select one of those two modes before continuing.",
      });
      return;
    }
    // Balance Update MUST add only the Debit amount (how much NEW money was
    // added this period) -- never Closing Balance, never Closing-minus-
    // Opening. Opening Balance import is UNCHANGED: it still uses the full
    // Closing Balance as the initial credit amount. See
    // src/lib/tallyBalanceImport.ts's own TallyBalanceRow.tallyDebitAmount
    // doc comment for why these are deliberately different amounts.
    if (usage === "balance_update") {
      const unreadableDebitRows = summary.importableRows.filter(({ row }) => Number.isNaN(row.tallyDebitAmount));
      if (unreadableDebitRows.length > 0) {
        toast({
          variant: "destructive",
          title: "Some Debit amounts could not be read",
          description: `Row(s) ${unreadableDebitRows.map(({ row }) => row.sourceRowNumber).join(", ")}: the Debit column was not blank/zero but also not a valid amount. Fix the source file before continuing a Balance Update import.`,
        });
        return;
      }
    }
    const effectiveDate = resolveTallyEffectiveDate(tallyResult.periodEnd, usage);
    // ONLY importable rows (matched + name-mismatch) are staged. Unknown
    // employees and unparseable identity rows never reach
    // insertImportRows/balance_import_rows -- there is no placeholder ID,
    // no name-based fallback, and no employee is ever created here.
    const stagedRows: StagedImportRow[] = summary.importableRows.map(({ row }, idx) => ({
      rowNumber: idx + 1,
      rawEmployeeId: row.employeeId,
      rawEmail: null,
      inputAmount: usage === "balance_update" ? row.tallyDebitAmount : row.signedClosingBalance,
      effectiveDate,
      note: row.flags.includes("hold")
        ? `Tally import (${tallyResult.periodStart} to ${tallyResult.periodEnd}) -- Hold`
        : `Tally import (${tallyResult.periodStart} to ${tallyResult.periodEnd})`,
    }));
    await stageAndValidate(stagedRows);
  };

  // ---- Step 7: apply ----
  const handleApply = async () => {
    if (!batchId) return;

    // Defense-in-depth server-response sanity check (2026-10-01 financial
    // audit): for additive V3 rows the server's own contract is
    // calculated_new_balance = current_balance_snapshot + input_amount (see
    // the live balance_validate_import_v3 definition). The client does not
    // trust that contract blindly -- if a validated row's numbers are ever
    // inconsistent with it (rounding bugs, a future server regression, a
    // row from a stale/mixed session), Apply is blocked entirely rather than
    // moving money against numbers that don't add up.
    if (isAdditiveCreditMode(mode)) {
      const inconsistentRow = previewRows.find((row) => {
        if (row.validation_status !== "valid") return false;
        if (row.current_balance_snapshot == null || row.input_amount == null || row.calculated_new_balance == null) {
          return false;
        }
        const expected = row.current_balance_snapshot + row.input_amount;
        return Math.abs(expected - row.calculated_new_balance) > 0.01;
      });
      if (inconsistentRow) {
        console.error("Additive V3 server-response sanity check failed for row:", inconsistentRow);
        toast({
          variant: "destructive",
          title: "Balance validation returned an inconsistent result. Nothing has been applied.",
          description: `Row ${inconsistentRow.row_number}: expected ${(
            (inconsistentRow.current_balance_snapshot ?? 0) + (inconsistentRow.input_amount ?? 0)
          ).toFixed(2)} but the server returned ${(inconsistentRow.calculated_new_balance ?? 0).toFixed(2)}.`,
        });
        return;
      }
    }

    setApplying(true);
    try {
      let result: ImportApplyResult;
      if (isAdditiveCreditMode(mode)) {
        const v3Result = await applyImportBatchV3(batchId);
        // Re-fetch the applied rows for full display detail (employee
        // name/before/after) -- balance_apply_import_v3's own return only
        // carries user_id, not the display fields this result screen needs.
        const appliedRows = await getImportRows(batchId);
        result = {
          ok: true,
          already_applied: v3Result.already_applied,
          batch_id: v3Result.batch_id,
          mode,
          row_count: appliedRows.length,
          changed_count: v3Result.applied_count ?? appliedRows.filter((r) => r.ledger_entry_id).length,
          total_delta: appliedRows.reduce((sum, r) => sum + (r.input_amount ?? 0), 0),
          rows: appliedRows.map((r) => ({
            row_number: r.row_number,
            employee_id: r.raw_employee_id,
            employee_name: null,
            before: r.current_balance_snapshot ?? 0,
            input_amount: r.input_amount ?? 0,
            after: r.calculated_new_balance ?? 0,
            no_op: false,
            ledger_entry_id: r.ledger_entry_id,
          })),
        };
      } else {
        result = await applyImportBatchV2(batchId, rowResolutions);
      }
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
            {step === "type" && "Choose your file source and how the amounts should be applied."}
            {step === "starter" && "Download a starter sheet prefilled with your active employees."}
            {step === "upload" && importSource === "tally" && "Upload your Tally Group Summary export (.xlsx)."}
            {step === "upload" && importSource === "template" && "Upload your completed starter sheet (.xlsx or .csv)."}
            {step === "preview" && "Review matched employees and fix any issues before applying."}
            {step === "confirm" && "Confirm before this import moves any money."}
            {step === "result" && "Import complete."}
          </DialogDescription>
        </DialogHeader>

        {step === "type" && (
          <div className="space-y-4 py-2">
            {!capabilityLoading && !historicalMutationReady && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                Historical balance mutations (Opening Balance, Balance Update, Tally Apply) require the latest
                PesoWise backend update{!historicalFlagOn ? " and the Historical Balance feature to be enabled" : ""}.
                You can still select any option below and preview a file -- only Continue past that point is
                affected. Allocation is unaffected either way.
              </div>
            )}

            <div className="space-y-2">
                <Label className="text-sm font-medium">File source</Label>
                <RadioGroup
                  value={importSource}
                  onValueChange={(v) => {
                    const nextSource = v as ImportSource;
                    setImportSource(nextSource);
                    // Allocation has no Tally equivalent -- a Tally Group
                    // Summary is only ever a point-in-time Closing Balance.
                    if (nextSource === "tally" && mode === "allocation") {
                      setMode("opening_credit");
                    }
                    // Switching source invalidates whatever was already
                    // uploaded/parsed for the other source.
                    setFile(null);
                    setParsedSheet(null);
                    setSheetSchema(null);
                    setHeaderError(null);
                    setTallyResult(null);
                    setTallyEmployeesById({});
                    if (fileInputRef.current) fileInputRef.current.value = "";
                  }}
                >
                  <div className="flex items-start gap-3 rounded-lg border p-3">
                    <RadioGroupItem value="template" id="source-template" className="mt-1" />
                    <Label htmlFor="source-template" className="font-normal cursor-pointer">
                      <span className="font-medium block">PesoWise starter sheet</span>
                      <span className="text-sm text-muted-foreground">
                        Download a template, fill in the amount column, upload it back.
                      </span>
                    </Label>
                  </div>
                  <div className="flex items-start gap-3 rounded-lg border p-3">
                    <RadioGroupItem value="tally" id="source-tally" className="mt-1" />
                    <Label htmlFor="source-tally" className="font-normal cursor-pointer">
                      <span className="font-medium block">Tally Group Summary export</span>
                      <span className="text-sm text-muted-foreground">
                        Upload the .xlsx exported from Tally directly -- PesoWise reads employee name, employee ID
                        and Closing Balance (Cr/Dr) from it automatically. No manual mapping.
                      </span>
                    </Label>
                  </div>
                </RadioGroup>
            </div>

            <div className="space-y-2">
              <Label className="text-sm font-medium">How should the amounts be applied?</Label>
              <RadioGroup value={mode} onValueChange={(v) => setMode(v as ImportMode)}>
                {/* Tally has no Allocation meaning, so its two modes are ALWAYS
                    offered regardless of the flag/backend -- selecting/previewing
                    is always safe, only actually staging is gated (see
                    stageAndValidate). The starter-sheet path keeps its existing,
                    narrower gate: historical modes appear once the org admin has
                    enabled the feature, independent of backend readiness. */}
                {(importSource === "tally" || historicalFlagOn) && (
                  <div className="flex items-start gap-3 rounded-lg border p-3">
                    <RadioGroupItem value="opening_credit" id="mode-opening-credit" className="mt-1" />
                    <Label htmlFor="mode-opening-credit" className="font-normal cursor-pointer">
                      <span className="font-medium block">Opening Balance Credit</span>
                      <span className="text-sm text-muted-foreground">
                        Add the entered amount to each employee's balance, positioned at the start of the effective
                        date (before that day's other events). This is an additive credit, not a target -- ₹45,000
                        entered always means +₹45,000, regardless of the employee's current balance.
                        {importSource === "tally" &&
                          " For a Tally file, the effective date is the day AFTER the report's closing date (this becomes next period's opening position)."}
                      </span>
                    </Label>
                  </div>
                )}
                {(importSource === "tally" || historicalFlagOn) && (
                  <div className="flex items-start gap-3 rounded-lg border p-3">
                    <RadioGroupItem value="balance_credit" id="mode-balance-credit" className="mt-1" />
                    <Label htmlFor="mode-balance-credit" className="font-normal cursor-pointer">
                      <span className="font-medium block">Balance Credit</span>
                      <span className="text-sm text-muted-foreground">
                        Add the entered amount to each employee's balance, positioned at the end of the effective
                        date (after that day's other events). This is an additive credit, not a target -- the
                        entered amount is always the exact delta applied, never a balance to reconcile toward.
                        {importSource === "tally" &&
                          " For a Tally file, the effective date is the report's own closing date, end of day."}
                      </span>
                    </Label>
                  </div>
                )}
                {importSource === "template" && (
                  <div className="flex items-start gap-3 rounded-lg border p-3">
                    <RadioGroupItem value="allocation" id="mode-allocation" className="mt-1" />
                    <Label htmlFor="mode-allocation" className="font-normal cursor-pointer">
                      <span className="font-medium block">Allocation</span>
                      <span className="text-sm text-muted-foreground">
                        Add money to employee balances as an actual allocation, on top of their current balance.
                      </span>
                    </Label>
                  </div>
                )}
              </RadioGroup>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => handleClose(false)}>
                Cancel
              </Button>
              <Button onClick={() => setStep(importSource === "tally" ? "upload" : "starter")}>Next</Button>
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

        {step === "upload" && importSource === "template" && (
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

            {parsedSheet && sheetSchema && !headerError && mode !== "allocation" && !historicalMutationReady && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                <span className="font-medium">Preview only</span> -- the Historical Balance backend has not been
                installed yet. Continue will unlock once it is.
              </div>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={() => setStep("starter")}>
                Back
              </Button>
              <Button
                onClick={() => void handleContinueToPreview()}
                disabled={
                  !parsedSheet ||
                  !sheetSchema ||
                  !!headerError ||
                  (mode !== "allocation" && !historicalMutationReady) ||
                  submitting
                }
              >
                {submitting ? "Validating..." : "Continue"}
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === "upload" && importSource === "tally" && (
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Upload Tally Group Summary (.xlsx)</Label>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx"
                className="block w-full text-sm"
                onChange={(e) => void handleTallyFileSelected(e.target.files?.[0] ?? null)}
              />
              {parsing && <p className="text-sm text-muted-foreground">Reading file...</p>}
            </div>

            {tallyResult && tallyResult.ok === false && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 space-y-1">
                <p className="font-medium">This doesn't look like a supported Tally Group Summary export.</p>
                <p>{tallyResult.reason}</p>
              </div>
            )}

            {tallyResult && tallyResult.ok === true && (
              <TallyPreviewPanel
                result={tallyResult}
                mode={mode}
                employeesById={tallyEmployeesById}
              />
            )}

            {tallyResult && tallyResult.ok === true && !historicalMutationReady && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                <span className="font-medium">Preview only</span> -- the Historical Balance backend has not been
                installed yet. You can inspect this Tally file, but Validation and Apply will unlock once it is.
              </div>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={() => setStep("type")}>
                Back
              </Button>
              <Button
                onClick={() => void handleContinueToPreviewTally()}
                disabled={
                  !tallyResult ||
                  tallyResult.ok === false ||
                  !reconciles(tallyResult) ||
                  computeTallyReconciliation(tallyResult, tallyEmployeesById).importableRows.length === 0 ||
                  !historicalMutationReady ||
                  submitting
                }
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
                <div className="text-muted-foreground text-xs">
                  {isAdditiveCreditMode(mode) ? "Will apply" : "Matched"}
                </div>
                <div className="font-medium text-green-700">{validateResult.valid_row_count}</div>
              </div>
              <div className="rounded-lg border p-2">
                <div className="text-muted-foreground text-xs">
                  {isAdditiveCreditMode(mode) ? "Needs attention" : "Needs fixing"}
                </div>
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
                <div className="text-muted-foreground text-xs">No change</div>
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
                {mode === "opening_credit" &&
                  `Add ${formatINR(validateResult.total_delta)} as Opening Balance Credit across ${validateResult.valid_row_count} employee(s)? Each employee's entered amount is added exactly as-is.`}
                {mode === "balance_credit" &&
                  `Add ${formatINR(validateResult.total_delta)} as Balance Credit across ${validateResult.valid_row_count} employee(s)? Each employee's entered amount is added exactly as-is.`}
                {mode === "allocation" &&
                  `Add ${formatINR(validateResult.total_delta)} across ${validateResult.valid_row_count} employee(s)?`}
              </p>
              {validateResult.apply_disabled && (
                <p className="text-red-600 text-sm">
                  {validateResult.invalid_row_count > 0
                    ? `${validateResult.invalid_row_count} row(s) need fixing before you can apply this import.`
                    : "Nothing to apply -- every row is a zero-amount no-op (no balance change)."}
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
