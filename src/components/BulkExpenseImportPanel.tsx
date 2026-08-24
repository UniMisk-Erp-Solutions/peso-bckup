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
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, FileSpreadsheet, Loader2, Upload, AlertCircle, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import {
  parseBulkExpenseFile,
  isSupportedBulkImportExtension,
  BULK_SUBMIT_CHUNK_SIZE,
  type BulkExpenseRow,
} from "@/lib/bulkExpenseImportParse";
import {
  submitBulkExpensesForEmployees,
  type BulkExpenseRowResult,
} from "@/lib/adminSubmitExpense";
import { generateBulkExpenseExcelTemplate, downloadBlob } from "@/lib/generateBulkExpenseExcelTemplate";
import type { OrganizationUserRow } from "@/lib/orgUsers";
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

  const validRows = useMemo(() => rows.filter((r) => r.issues.length === 0), [rows]);
  const invalidRows = useMemo(() => rows.filter((r) => r.issues.length > 0), [rows]);

  const resetAll = () => {
    setFileName(null);
    setRows([]);
    setUnmappedHeaders([]);
    setMissingColumns([]);
    setResults(null);
    resetOperation();
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleDownloadRoster = async () => {
    if (employees.length === 0) return;
    setGeneratingTemplate(true);
    try {
      const blob = await generateBulkExpenseExcelTemplate(employees, categories);
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
    setParsing(true);
    try {
      const parsed = await parseBulkExpenseFile(file);
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

  const handleImport = async () => {
    if (!organizationId || validRows.length === 0) return;
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

      const okCount = rowResults.filter((r) => r.ok).length;
      const failCount = rowResults.length - okCount;
      if (failCount === 0) {
        completeOperation(t("submitForEmployee.bulk.progress.done", { ns: "admin" }));
      } else {
        failOperation(
          t("submitForEmployee.bulk.progress.done", { ns: "admin" }),
          t("submitForEmployee.bulk.progress.partialFailure", { ns: "admin", ok: okCount, failed: failCount }),
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
              disabled={generatingTemplate || employees.length === 0}
            >
              {generatingTemplate
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
              <Button onClick={() => void handleImport()} disabled={validRows.length === 0 || importing}>
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

            <div className="flex items-center gap-2">
              <Badge variant="secondary">
                {t("submitForEmployee.bulk.results.succeededBadge", {
                  ns: "admin",
                  count: results.filter((r) => r.ok).length,
                })}
              </Badge>
              {results.some((r) => !r.ok) && (
                <Badge variant="destructive">
                  {t("submitForEmployee.bulk.results.failedBadge", {
                    ns: "admin",
                    count: results.filter((r) => !r.ok).length,
                  })}
                </Badge>
              )}
            </div>

            <Button variant="outline" onClick={resetAll}>
              {t("submitForEmployee.bulk.importAnother", { ns: "admin" })}
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
