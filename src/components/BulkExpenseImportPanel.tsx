/**
 * DOC-108 — bulk CSV/Excel import of admin-submitted expenses.
 *
 * Upload a spreadsheet where each row is one expense for one employee. The
 * file is parsed and validated entirely client-side first (no server round
 * trip for obviously-bad rows), then valid rows are sent in chunks of
 * BULK_SUBMIT_CHUNK_SIZE to admin_bulk_submit_expenses_v1 — the same RPC
 * chain the single-employee tab uses per row, so every imported expense gets
 * identical hierarchy routing, audit trail and live-dashboard notification.
 *
 * A bad row never blocks the rest of the file: the server isolates each row
 * in its own exception block, so a batch of 1,000 with a handful of bad rows
 * still submits the other 990+ and reports exactly which ones failed and why.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, FileSpreadsheet, Loader2, Upload, AlertCircle, CheckCircle2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import {
  parseBulkExpenseFile,
  isSupportedBulkImportExtension,
  BULK_SUBMIT_CHUNK_SIZE,
  type BulkExpenseRow,
} from "@/lib/bulkExpenseImportParse";
import {
  submitBulkExpensesForEmployees,
  saveExpenseCustomFields,
  applyAdminSubmitStatusChoice,
  type BulkExpenseRowResult,
  type AdminSubmitStatusChoice,
} from "@/lib/adminSubmitExpense";
import { SubmitStatusChoiceDialog } from "@/components/SubmitStatusChoiceDialog";
import { generateBulkExpenseExcelTemplate, downloadBlob } from "@/lib/generateBulkExpenseExcelTemplate";
import type { OrganizationUserRow } from "@/lib/orgUsers";
import { fetchOrganizationExpenseFieldConfig, type OrganizationExpenseFieldConfig } from "@/lib/orgExpenseFieldConfig";
import { ORGANIZATION_FEATURE_KEYS } from "@/lib/organizationFeatureKeys";
import { runWithConcurrencyLimit, MAX_CUSTOM_FIELD_CONCURRENCY } from "@/lib/expenseCustomFieldFilters";
import { useOperationProgress } from "@/hooks/useOperationProgress";
import { AsyncOperationProgress } from "@/components/AsyncOperationProgress";

const PREVIEW_LIMIT = 25;

interface BulkExpenseImportPanelProps {
  organizationId: string | null;
  /**
   * Same employees/categories state AdminSubmitExpense.tsx already loaded
   * for the single-employee tab's picker — passed down rather than
   * re-fetched, so there is exactly one org-scoped source of truth on this
   * page and no risk of this panel independently querying (and possibly
   * mismatching) a different organization's data.
   */
  employees: OrganizationUserRow[];
  categories: string[];
}

export function BulkExpenseImportPanel({ organizationId, employees, categories }: BulkExpenseImportPanelProps) {
  const { t } = useTranslation(["admin", "common"]);
  const { toast } = useToast();
  const { organizationFeatureFlags, user } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { progress, startOperation, updateOperation, completeOperation, failOperation, resetOperation } =
    useOperationProgress();
  const [generatingTemplate, setGeneratingTemplate] = useState(false);

  const [fileName, setFileName] = useState<string | null>(null);
  const [rows, setRows] = useState<BulkExpenseRow[]>([]);
  const [unmappedHeaders, setUnmappedHeaders] = useState<string[]>([]);
  const [missingColumns, setMissingColumns] = useState<string[]>([]);
  const [parsing, setParsing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [results, setResults] = useState<BulkExpenseRowResult[] | null>(null);
  /** row_index -> error, only for rows whose expense WAS created but the
   *  follow-up custom-field save failed — a distinct state from ok/fail, per
   *  the two-RPC-call risk documented in adminSubmitExpense.ts. */
  const [customFieldFailures, setCustomFieldFailures] = useState<Map<number, string>>(new Map());
  const [retryingCustomFields, setRetryingCustomFields] = useState(false);
  /** row_index -> error, only for rows whose custom fields (if any) saved
   *  fine but the chosen verify/approve transition itself failed — separate
   *  from customFieldFailures since retrying this one only re-runs the
   *  status step, never re-saves fields that already succeeded. */
  const [statusTransitionFailures, setStatusTransitionFailures] = useState<Map<number, string>>(new Map());
  const [retryingStatusTransitions, setRetryingStatusTransitions] = useState(false);

  const [statusDialogOpen, setStatusDialogOpen] = useState(false);
  /** The batch-wide status choice, remembered for the duration of this
   *  import so a retry (of either failure bucket above) knows which
   *  transition to (re-)apply — one choice for the whole batch, not per row. */
  const [importStatusChoice, setImportStatusChoice] = useState<{ status: AdminSubmitStatusChoice; comment: string }>({
    status: "submitted", comment: "",
  });

  const [fieldConfig, setFieldConfig] = useState<OrganizationExpenseFieldConfig | null>(null);
  const [loadingFieldConfig, setLoadingFieldConfig] = useState(true);
  useEffect(() => {
    if (!organizationId) return;
    let cancelled = false;
    setLoadingFieldConfig(true);
    fetchOrganizationExpenseFieldConfig(organizationId)
      .then((cfg) => { if (!cancelled) setFieldConfig(cfg); })
      .catch(() => { if (!cancelled) setFieldConfig(null); })
      .finally(() => { if (!cancelled) setLoadingFieldConfig(false); });
    return () => { cancelled = true; };
  }, [organizationId]);

  const baseFieldCustomizationEnabled =
    organizationFeatureFlags[ORGANIZATION_FEATURE_KEYS.allow_base_field_input_customization] === true;

  const validRows = useMemo(() => rows.filter((r) => r.issues.length === 0), [rows]);
  const invalidRows = useMemo(() => rows.filter((r) => r.issues.length > 0), [rows]);

  const resetAll = () => {
    setFileName(null);
    setRows([]);
    setUnmappedHeaders([]);
    setMissingColumns([]);
    setResults(null);
    setCustomFieldFailures(new Map());
    setStatusTransitionFailures(new Map());
    setImportStatusChoice({ status: "submitted", comment: "" });
    resetOperation();
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleDownloadRoster = async () => {
    if (employees.length === 0 || !fieldConfig) return;
    setGeneratingTemplate(true);
    try {
      const blob = await generateBulkExpenseExcelTemplate(employees, categories, {
        baseFieldConfig: fieldConfig.baseFieldConfig,
        baseFieldCustomizationEnabled,
        categoryAssignments: fieldConfig.categoryAssignments,
        branchGroups: fieldConfig.branchGroups,
      });
      const stamp = new Date().toISOString().slice(0, 10);
      downloadBlob(blob, `expense-import-roster_${stamp}.xlsx`);
    } catch (err) {
      toast({
        title: t("submitForEmployee.bulk.errors.rosterFailed", { ns: "admin" }),
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    } finally {
      setGeneratingTemplate(false);
    }
  };

  const handleFile = async (file: File) => {
    if (!isSupportedBulkImportExtension(file.name)) {
      toast({
        title: t("submitForEmployee.bulk.errors.unsupportedFile", { ns: "admin" }),
        variant: "destructive",
      });
      return;
    }
    setResults(null);
    setCustomFieldFailures(new Map());
    setParsing(true);
    try {
      const parsed = await parseBulkExpenseFile(file, fieldConfig);
      setFileName(file.name);
      setRows(parsed.rows);
      setUnmappedHeaders(parsed.unmappedHeaders);
      setMissingColumns(parsed.missingColumns);
      if (parsed.rows.length === 0 && parsed.missingColumns.length > 0) {
        toast({
          title: t("submitForEmployee.bulk.errors.missingColumns", { ns: "admin" }),
          description: parsed.missingColumns.join(", "),
          variant: "destructive",
        });
      }
    } catch (err) {
      toast({
        title: t("submitForEmployee.bulk.errors.parseFailed", { ns: "admin" }),
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    } finally {
      setParsing(false);
    }
  };

  /** Opens the status-choice popup instead of importing directly — the admin
   *  picks the batch-wide Submitted/Verified/Approved choice there, and
   *  performImport() runs only after that confirmation. */
  const handleImportClick = () => {
    if (!organizationId || validRows.length === 0) return;
    setStatusDialogOpen(true);
  };

  const performImport = async (status: AdminSubmitStatusChoice, comment: string) => {
    if (!organizationId || validRows.length === 0 || !user?.id) return;
    setImportStatusChoice({ status, comment });
    setImporting(true);
    setResults(null);
    const total = validRows.length;
    startOperation(t("submitForEmployee.bulk.progress.submitting", { ns: "admin" }), {
      completed: 0,
      total,
    });
    try {
      const submitRows = validRows.map((r) => ({
        rowIndex: r.rowIndex,
        employeeId: r.employeeId || null,
        email: r.email || null,
        title: r.title,
        destination: r.destination,
        tripStart: r.expenseDate,
        tripEnd: r.expenseDate,
        category: r.category,
        amount: Number(r.amount),
        purpose: r.purpose || null,
      }));

      const rowResults = await submitBulkExpensesForEmployees(
        organizationId,
        submitRows,
        BULK_SUBMIT_CHUNK_SIZE,
        (completed, chunkTotal) => {
          updateOperation(t("submitForEmployee.bulk.progress.submitting", { ns: "admin" }), {
            completed,
            total: chunkTotal,
          });
        },
      );
      setResults(rowResults);
      setStatusDialogOpen(false);

      // Post-creation pipeline: per successfully-created row, save custom
      // fields (if any) then, ONLY if that step succeeded (or had nothing to
      // save), apply the chosen status transition — see
      // runPostCreationPipeline's own doc comment for why these two steps
      // must never run out of order or concurrently against each other.
      const createdRows = validRows.filter((r) => {
        const res = rowResults.find((x) => x.row_index === r.rowIndex);
        return res?.ok && res.expense_id;
      });
      const { customFieldFailed, statusFailed } = await runPostCreationPipeline(
        createdRows, rowResults, status, comment,
      );

      const okCount = rowResults.filter((r) => r.ok).length;
      const failCount = rowResults.length - okCount;
      const followUpFailures = customFieldFailed.size + statusFailed.size;
      if (failCount === 0 && followUpFailures === 0) {
        completeOperation(t("submitForEmployee.bulk.progress.done", { ns: "admin" }));
      } else {
        failOperation(
          t("submitForEmployee.bulk.progress.done", { ns: "admin" }),
          t("submitForEmployee.bulk.progress.partialFailure", { ns: "admin", ok: okCount, failed: failCount + followUpFailures }),
        );
      }
    } catch (err) {
      failOperation(
        t("submitForEmployee.bulk.progress.done", { ns: "admin" }),
        err instanceof Error ? err.message : t("submitForEmployee.errors.generic", { ns: "admin" }),
      );
    } finally {
      setImporting(false);
    }
  };

  /**
   * Runs the two-step per-row follow-up for a set of already-created rows,
   * with bounded concurrency so a slow/failing row never blocks the rest.
   * Step 1 (custom-field save) and step 2 (status transition) run INSIDE
   * THE SAME per-row task, step 2 strictly gated on step 1's outcome — not
   * two passes, not one concurrent wave. A row whose custom-field save
   * fails never reaches its status transition (approving/verifying data
   * known to be incomplete would still trigger the atomic balance
   * deduction on "Approved" — see applyAdminSubmitStatusChoice).
   *
   * Shared by performImport and both retry buttons, so a retry re-runs only
   * what's still outstanding for a row: a customFieldFailures retry re-runs
   * both steps (nothing was saved yet); a statusTransitionFailures retry
   * re-runs only step 2 (its custom fields already saved successfully).
   */
  const runPostCreationPipeline = async (
    rowsToRun: BulkExpenseRow[],
    rowResults: BulkExpenseRowResult[],
    status: AdminSubmitStatusChoice,
    comment: string,
    options?: { skipCustomFieldSave?: boolean },
  ): Promise<{ customFieldFailed: Map<number, string>; statusFailed: Map<number, string> }> => {
    const customFieldFailed = new Map<number, string>();
    const statusFailed = new Map<number, string>();
    if (!organizationId || !user?.id || rowsToRun.length === 0) {
      return { customFieldFailed, statusFailed };
    }

    const tasks = rowsToRun.map((r) => async () => {
      const res = rowResults.find((x) => x.row_index === r.rowIndex);
      if (!res?.expense_id) return { rowIndex: r.rowIndex };
      const expenseId = res.expense_id;

      if (!options?.skipCustomFieldSave && r.customFieldPayload.length > 0) {
        try {
          await saveExpenseCustomFields(organizationId, expenseId, r.customFieldPayload);
        } catch (err) {
          return {
            rowIndex: r.rowIndex,
            customFieldError: err instanceof Error ? err.message : "Failed to save extra fields",
          };
        }
      }

      if (status !== "submitted") {
        try {
          await applyAdminSubmitStatusChoice(status, expenseId, user.id, organizationId, comment);
        } catch (err) {
          return {
            rowIndex: r.rowIndex,
            statusError: err instanceof Error ? err.message : `Failed to set status to ${status}`,
          };
        }
      }
      return { rowIndex: r.rowIndex };
    });

    const outcomes = await runWithConcurrencyLimit(tasks, MAX_CUSTOM_FIELD_CONCURRENCY);
    for (const o of outcomes) {
      if (!o) continue;
      if (o.customFieldError) customFieldFailed.set(o.rowIndex, o.customFieldError);
      else if (o.statusError) statusFailed.set(o.rowIndex, o.statusError);
    }

    setCustomFieldFailures((prev) => {
      const next = new Map(prev);
      for (const r of rowsToRun) next.delete(r.rowIndex);
      for (const [idx, err] of customFieldFailed) next.set(idx, err);
      return next;
    });
    setStatusTransitionFailures((prev) => {
      const next = new Map(prev);
      for (const r of rowsToRun) if (!customFieldFailed.has(r.rowIndex)) next.delete(r.rowIndex);
      for (const [idx, err] of statusFailed) next.set(idx, err);
      return next;
    });

    return { customFieldFailed, statusFailed };
  };

  const handleRetryCustomFieldFailures = async () => {
    if (!results || customFieldFailures.size === 0) return;
    setRetryingCustomFields(true);
    try {
      const rowsToRetry = rows.filter((r) => customFieldFailures.has(r.rowIndex));
      const { customFieldFailed, statusFailed } = await runPostCreationPipeline(
        rowsToRetry, results, importStatusChoice.status, importStatusChoice.comment,
      );
      const stillFailing = customFieldFailed.size + statusFailed.size;
      if (stillFailing === 0) {
        toast({ title: t("submitForEmployee.bulk.results.title", { ns: "admin" }), description: "Extra fields saved for all retried rows." });
      } else {
        toast({
          title: t("submitForEmployee.errors.title", { ns: "admin" }),
          description: `${stillFailing} row(s) still failed.`,
          variant: "destructive",
        });
      }
    } finally {
      setRetryingCustomFields(false);
    }
  };

  const handleRetryStatusTransitionFailures = async () => {
    if (!results || statusTransitionFailures.size === 0) return;
    setRetryingStatusTransitions(true);
    try {
      const rowsToRetry = rows.filter((r) => statusTransitionFailures.has(r.rowIndex));
      // These rows' custom fields already saved successfully — re-running
      // that step would be redundant (and, for a row with none, a no-op);
      // skip it and re-run only the status transition.
      const { statusFailed } = await runPostCreationPipeline(
        rowsToRetry, results, importStatusChoice.status, importStatusChoice.comment,
        { skipCustomFieldSave: true },
      );
      if (statusFailed.size === 0) {
        toast({ title: t("submitForEmployee.bulk.results.title", { ns: "admin" }), description: "Status applied for all retried rows." });
      } else {
        toast({
          title: t("submitForEmployee.errors.title", { ns: "admin" }),
          description: `${statusFailed.size} row(s) still failed to change status.`,
          variant: "destructive",
        });
      }
    } finally {
      setRetryingStatusTransitions(false);
    }
  };

  const resultsById = useMemo(() => {
    const m = new Map<number, BulkExpenseRowResult>();
    for (const r of results ?? []) m.set(r.row_index, r);
    return m;
  }, [results]);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t("submitForEmployee.bulk.title", { ns: "admin" })}
          </CardTitle>
          <CardDescription>
            {t("submitForEmployee.bulk.description", { ns: "admin" })}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="outline" asChild>
              <a href="/templates/bulk-expense-import-template.csv" download>
                <Download className="mr-2 h-4 w-4" />
                {t("submitForEmployee.bulk.downloadTemplate", { ns: "admin" })}
              </a>
            </Button>

            {/* DOC-108 — pre-filled with THIS organization's employees only
                (employees prop, see the component-level comment) and a real
                Excel dropdown on Category. */}
            <Button
              variant="outline"
              onClick={() => void handleDownloadRoster()}
              disabled={generatingTemplate || loadingFieldConfig || employees.length === 0 || !fieldConfig}
            >
              {generatingTemplate || loadingFieldConfig
                ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                : <FileSpreadsheet className="mr-2 h-4 w-4" />}
              {t("submitForEmployee.bulk.downloadRoster", { ns: "admin" })}
            </Button>

            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.txt,.xlsx,.xls"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFile(f);
              }}
            />
            <Button onClick={() => fileInputRef.current?.click()} disabled={parsing || importing}>
              {parsing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
              {t("submitForEmployee.bulk.chooseFile", { ns: "admin" })}
            </Button>

            {fileName && (
              <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <FileSpreadsheet className="h-4 w-4" />
                {fileName}
              </span>
            )}
          </div>

          {missingColumns.length > 0 && (
            <div className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {t("submitForEmployee.bulk.errors.missingColumns", { ns: "admin" })}: {missingColumns.join(", ")}
              </span>
            </div>
          )}

          {unmappedHeaders.length > 0 && rows.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {t("submitForEmployee.bulk.unmappedHeaders", { ns: "admin" })}: {unmappedHeaders.join(", ")}
            </p>
          )}
        </CardContent>
      </Card>

      {rows.length > 0 && !results && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t("submitForEmployee.bulk.preview.title", { ns: "admin" })}
            </CardTitle>
            <CardDescription>
              {t("submitForEmployee.bulk.preview.summary", {
                ns: "admin",
                valid: validRows.length,
                total: rows.length,
              })}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {invalidRows.length > 0 && (
              <div className="rounded-md border overflow-x-auto max-h-72 overflow-y-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-16">{t("submitForEmployee.bulk.preview.row", { ns: "admin" })}</TableHead>
                      <TableHead>{t("submitForEmployee.bulk.preview.employee", { ns: "admin" })}</TableHead>
                      <TableHead>{t("submitForEmployee.bulk.preview.issue", { ns: "admin" })}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {invalidRows.slice(0, PREVIEW_LIMIT).map((r) => (
                      <TableRow key={r.rowIndex}>
                        <TableCell className="tabular-nums">{r.rowIndex}</TableCell>
                        <TableCell className="truncate max-w-[180px]">{r.referenceName || r.employeeId || r.email || "—"}</TableCell>
                        <TableCell>
                          <span className="text-destructive text-sm">{r.issues.join("; ")}</span>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {invalidRows.length > PREVIEW_LIMIT && (
                  <p className="px-3 py-2 text-xs text-muted-foreground border-t">
                    {t("submitForEmployee.bulk.preview.moreIssues", { ns: "admin", count: invalidRows.length - PREVIEW_LIMIT })}
                  </p>
                )}
              </div>
            )}

            <div className="flex items-center gap-3">
              <Button onClick={handleImportClick} disabled={validRows.length === 0 || importing}>
                {importing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
                {t("submitForEmployee.bulk.importButton", { ns: "admin", count: validRows.length })}
              </Button>
              <Button variant="outline" onClick={resetAll} disabled={importing}>
                {t("cancel", { ns: "common" })}
              </Button>
            </div>

            {progress.status !== "idle" && (
              <AsyncOperationProgress
                status={progress.status}
                title={progress.phase}
                description={progress.description}
                completed={progress.completed}
                total={progress.total}
                errorMessage={progress.errorMessage}
              />
            )}
          </CardContent>
        </Card>
      )}

      {results && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              {results.every((r) => r.ok) ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              ) : (
                <AlertCircle className="h-4 w-4 text-amber-600" />
              )}
              {t("submitForEmployee.bulk.results.title", { ns: "admin" })}
            </CardTitle>
            <CardDescription>
              {t("submitForEmployee.bulk.results.summary", {
                ns: "admin",
                ok: results.filter((r) => r.ok).length,
                total: results.length,
              })}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {results.some((r) => !r.ok) && (
              <div className="rounded-md border overflow-x-auto max-h-96 overflow-y-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-16">{t("submitForEmployee.bulk.preview.row", { ns: "admin" })}</TableHead>
                      <TableHead>{t("submitForEmployee.bulk.preview.employee", { ns: "admin" })}</TableHead>
                      <TableHead>{t("submitForEmployee.bulk.results.error", { ns: "admin" })}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows
                      .filter((r) => {
                        const res = resultsById.get(r.rowIndex);
                        return res && !res.ok;
                      })
                      .map((r) => (
                        <TableRow key={r.rowIndex}>
                          <TableCell className="tabular-nums">{r.rowIndex}</TableCell>
                          <TableCell className="truncate max-w-[180px]">{r.referenceName || r.employeeId || r.email || "—"}</TableCell>
                          <TableCell>
                            <span className="text-destructive text-sm">{resultsById.get(r.rowIndex)?.error}</span>
                          </TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              </div>
            )}

            {customFieldFailures.size > 0 && (
              <div className="space-y-2">
                <div className="rounded-md border border-destructive/50 overflow-x-auto max-h-72 overflow-y-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-16">{t("submitForEmployee.bulk.preview.row", { ns: "admin" })}</TableHead>
                        <TableHead>{t("submitForEmployee.bulk.preview.employee", { ns: "admin" })}</TableHead>
                        <TableHead>Extra-fields error</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows
                        .filter((r) => customFieldFailures.has(r.rowIndex))
                        .map((r) => (
                          <TableRow key={r.rowIndex}>
                            <TableCell className="tabular-nums">{r.rowIndex}</TableCell>
                            <TableCell className="truncate max-w-[180px]">{r.referenceName || r.employeeId || r.email || "—"}</TableCell>
                            <TableCell>
                              <span className="text-destructive text-sm">
                                Expense created, but extra fields failed to save: {customFieldFailures.get(r.rowIndex)}
                              </span>
                            </TableCell>
                          </TableRow>
                        ))}
                    </TableBody>
                  </Table>
                </div>
                <Button variant="outline" onClick={() => void handleRetryCustomFieldFailures()} disabled={retryingCustomFields}>
                  {retryingCustomFields ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-2 h-4 w-4" />}
                  Retry extra fields for {customFieldFailures.size} row(s)
                </Button>
              </div>
            )}

            {statusTransitionFailures.size > 0 && (
              <div className="space-y-2">
                <div className="rounded-md border border-destructive/50 overflow-x-auto max-h-72 overflow-y-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-16">{t("submitForEmployee.bulk.preview.row", { ns: "admin" })}</TableHead>
                        <TableHead>{t("submitForEmployee.bulk.preview.employee", { ns: "admin" })}</TableHead>
                        <TableHead>Status change error</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows
                        .filter((r) => statusTransitionFailures.has(r.rowIndex))
                        .map((r) => (
                          <TableRow key={r.rowIndex}>
                            <TableCell className="tabular-nums">{r.rowIndex}</TableCell>
                            <TableCell className="truncate max-w-[180px]">{r.referenceName || r.employeeId || r.email || "—"}</TableCell>
                            <TableCell>
                              <span className="text-destructive text-sm">
                                Expense created (extra fields saved fine), but could not be set to {importStatusChoice.status}: {statusTransitionFailures.get(r.rowIndex)}
                              </span>
                            </TableCell>
                          </TableRow>
                        ))}
                    </TableBody>
                  </Table>
                </div>
                <Button variant="outline" onClick={() => void handleRetryStatusTransitionFailures()} disabled={retryingStatusTransitions}>
                  {retryingStatusTransitions ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-2 h-4 w-4" />}
                  Retry setting {statusTransitionFailures.size} row(s) to {importStatusChoice.status}
                </Button>
              </div>
            )}

            <div className="flex items-center gap-2">
              <Badge variant="secondary">
                {t("submitForEmployee.bulk.results.succeededBadge", {
                  ns: "admin",
                  count: results.filter((r) => r.ok).length - customFieldFailures.size - statusTransitionFailures.size,
                })}
              </Badge>
              {customFieldFailures.size > 0 && (
                <Badge variant="destructive">
                  Extra fields failed: {customFieldFailures.size}
                </Badge>
              )}
              {statusTransitionFailures.size > 0 && (
                <Badge variant="destructive">
                  Status change failed: {statusTransitionFailures.size}
                </Badge>
              )}
              {results.some((r) => !r.ok) && (
                <Badge variant="destructive">
                  {t("submitForEmployee.bulk.results.failedBadge", {
                    ns: "admin",
                    count: results.filter((r) => !r.ok).length,
                  })}
                </Badge>
              )}
            </div>

            <Button variant="outline" onClick={resetAll} disabled={customFieldFailures.size > 0 || statusTransitionFailures.size > 0}>
              {t("submitForEmployee.bulk.importAnother", { ns: "admin" })}
            </Button>
            {(customFieldFailures.size > 0 || statusTransitionFailures.size > 0) && (
              <p className="text-xs text-muted-foreground">
                Resolve the failures above before starting another import.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <SubmitStatusChoiceDialog
        open={statusDialogOpen}
        onOpenChange={setStatusDialogOpen}
        subjectLabel={`these ${validRows.length} expense${validRows.length === 1 ? "" : "s"}`}
        confirming={importing}
        onConfirm={(status, comment) => void performImport(status, comment)}
      />
    </div>
  );
}
