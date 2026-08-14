import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileUp, Download, Upload, AlertTriangle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
import { formatINR } from "@/lib/format";
import {
  downloadExpenseImportTemplate,
  getExpenseImportPreview,
  importExpensesFromJson,
  parseExpenseImportFile,
  type ExpenseImportPayload,
  type ExpenseImportPreview,
} from "@/lib/expenseImport";

type AdminExpenseImportPanelProps = {
  organizationId: string | null | undefined;
  onImported?: () => void;
};

function actionBadge(action: string, t: (key: string) => string) {
  switch (action) {
    case "import":
      return <Badge className="bg-emerald-600">{t("panel.expenseImport.actionImport")}</Badge>;
    case "skip_existing":
      return <Badge variant="secondary">{t("panel.expenseImport.actionSkipExisting")}</Badge>;
    case "skip_no_user":
      return <Badge variant="destructive">{t("panel.expenseImport.actionSkipNoUser")}</Badge>;
    default:
      return <Badge variant="outline">{t("panel.expenseImport.actionSkipInvalid")}</Badge>;
  }
}

export function AdminExpenseImportPanel({
  organizationId,
  onImported,
}: AdminExpenseImportPanelProps) {
  const { t } = useTranslation("admin");
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [payload, setPayload] = useState<ExpenseImportPayload | null>(null);
  const [preview, setPreview] = useState<ExpenseImportPreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [importing, setImporting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [showAllRows, setShowAllRows] = useState(false);

  const reset = () => {
    setImportFile(null);
    setPayload(null);
    setPreview(null);
    setShowAllRows(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleFileChange = async (file: File | null) => {
    reset();
    if (!file || !organizationId) return;

    setImportFile(file);
    setLoadingPreview(true);
    try {
      const parsed = await parseExpenseImportFile(file);
      setPayload(parsed);
      const p = await getExpenseImportPreview(supabase, organizationId, parsed);
      setPreview(p);
    } catch (err) {
      toast({
        title: t("panel.expenseImport.parseFailed"),
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
      reset();
    } finally {
      setLoadingPreview(false);
    }
  };

  const handleImport = async () => {
    if (!organizationId || !payload) return;
    setImporting(true);
    try {
      const result = await importExpensesFromJson(supabase, organizationId, payload);
      if (!result.success) {
        toast({
          title: t("panel.expenseImport.importFailed"),
          description: result.errors.join(" ") || t("panel.expenseImport.importFailedHint"),
          variant: "destructive",
        });
        return;
      }
      toast({
        title: t("panel.expenseImport.importSuccess"),
        description: t("panel.expenseImport.importSuccessHint", {
          imported: result.imported,
          skipped: result.skippedExisting,
          profiles: result.profilesImported,
          attachments: result.attachmentsImported,
        }),
      });
      reset();
      onImported?.();
    } catch (err) {
      toast({
        title: t("panel.expenseImport.importFailed"),
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setImporting(false);
      setConfirmOpen(false);
    }
  };

  const visibleRows = preview
    ? showAllRows
      ? preview.rows
      : preview.rows.slice(0, 25)
    : [];

  return (
    <>
      <Card className="shadow-lg border-0 bg-white/80 backdrop-blur-sm border-l-4 border-l-amber-500">
        <CardHeader className="p-4 sm:p-6">
          <CardTitle className="text-lg sm:text-xl font-bold flex items-center gap-2">
            <FileUp className="h-5 w-5 text-amber-600" />
            {t("panel.expenseImport.title")}
          </CardTitle>
          <CardDescription className="text-xs sm:text-sm">
            {t("panel.expenseImport.description")}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-4 sm:p-6 pt-0 space-y-4">
          <div className="flex flex-col sm:flex-row gap-2">
            <Button
              type="button"
              variant="outline"
              className="sm:flex-1"
              onClick={downloadExpenseImportTemplate}
            >
              <Download className="h-4 w-4 mr-2" />
              {t("panel.expenseImport.downloadTemplate")}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="sm:flex-1"
              disabled={!organizationId}
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload className="h-4 w-4 mr-2" />
              {importFile ? importFile.name : t("panel.expenseImport.chooseFile")}
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(e) => void handleFileChange(e.target.files?.[0] ?? null)}
            />
          </div>

          {loadingPreview && (
            <p className="text-sm text-muted-foreground">{t("panel.expenseImport.analyzing")}</p>
          )}

          {preview && !loadingPreview && (
            <div className="rounded-lg border bg-muted/40 p-4 text-sm space-y-3">
              <p className="font-medium">{t("panel.expenseImport.previewTitle")}</p>
              <ul className="list-disc pl-5 space-y-1 text-muted-foreground">
                <li>{t("panel.expenseImport.previewTotal", { count: preview.totalExpenses })}</li>
                <li className="text-foreground font-medium">
                  {t("panel.expenseImport.previewToImport", { count: preview.toImport })}
                </li>
                {preview.profilesToImport > 0 && (
                  <li>{t("panel.expenseImport.previewProfiles", { count: preview.profilesToImport })}</li>
                )}
                {preview.membershipsToImport > 0 && (
                  <li>
                    {t("panel.expenseImport.previewMemberships", { count: preview.membershipsToImport })}
                  </li>
                )}
                {preview.skippedExisting > 0 && (
                  <li>{t("panel.expenseImport.previewSkippedExisting", { count: preview.skippedExisting })}</li>
                )}
                {preview.skippedUnknownUser > 0 && (
                  <li className="text-amber-700">
                    {t("panel.expenseImport.previewUnknownUsers", { count: preview.skippedUnknownUser })}
                  </li>
                )}
                {preview.attachments > 0 && (
                  <li>{t("panel.expenseImport.previewAttachments", { count: preview.attachments })}</li>
                )}
                {preview.dataFrom && preview.dataTo && (
                  <li>
                    {t("panel.expenseImport.previewDateRange", {
                      from: preview.dataFrom,
                      to: preview.dataTo,
                    })}
                  </li>
                )}
              </ul>

              {preview.rows.length > 0 && (
                <div className="rounded-md border bg-background overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("panel.expenseImport.colEmployee")}</TableHead>
                        <TableHead>{t("panel.expenseImport.colEmpId")}</TableHead>
                        <TableHead>{t("panel.expenseImport.colDate")}</TableHead>
                        <TableHead>{t("panel.expenseImport.colTitle")}</TableHead>
                        <TableHead>{t("panel.expenseImport.colAmount")}</TableHead>
                        <TableHead>{t("panel.expenseImport.colAction")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {visibleRows.map((row) => (
                        <TableRow key={`${row.expenseId}-${row.tripStart}`}>
                          <TableCell>
                            <div className="font-medium">{row.employeeName || "—"}</div>
                            <div className="text-xs text-muted-foreground truncate max-w-[140px]">
                              {row.email || row.userId.slice(0, 8)}
                            </div>
                          </TableCell>
                          <TableCell className="text-xs font-mono">{row.employeeId || "—"}</TableCell>
                          <TableCell className="whitespace-nowrap text-xs">{row.tripStart}</TableCell>
                          <TableCell className="max-w-[160px] truncate text-xs">{row.title}</TableCell>
                          <TableCell className="whitespace-nowrap text-xs">{formatINR(row.amount)}</TableCell>
                          <TableCell>{actionBadge(row.action, t)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

              {preview.rows.length > 25 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowAllRows((v) => !v)}
                >
                  {showAllRows
                    ? t("panel.expenseImport.showLess")
                    : t("panel.expenseImport.showAll", { count: preview.rows.length })}
                </Button>
              )}

              {preview.sourceOrganizationId &&
                organizationId &&
                preview.sourceOrganizationId !== organizationId && (
                  <p className="flex items-start gap-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2">
                    <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                    {t("panel.expenseImport.differentOrgHint")}
                  </p>
                )}
              <p className="text-xs text-muted-foreground">{t("panel.expenseImport.receiptHint")}</p>
              <p className="text-xs text-muted-foreground">{t("panel.expenseImport.profileHint")}</p>
              <Button
                type="button"
                className="mt-1 bg-amber-600 hover:bg-amber-700"
                disabled={preview.toImport === 0 || importing}
                onClick={() => setConfirmOpen(true)}
              >
                {t("panel.expenseImport.importButton", { count: preview.toImport })}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("panel.expenseImport.confirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("panel.expenseImport.confirmDescription", { count: preview?.toImport ?? 0 })}
              {preview && preview.profilesToImport > 0
                ? ` ${t("panel.expenseImport.confirmProfiles", { count: preview.profilesToImport })}`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={importing}>{t("panel.expenseImport.cancel")}</AlertDialogCancel>
            <AlertDialogAction disabled={importing} onClick={() => void handleImport()}>
              {importing ? t("panel.expenseImport.importing") : t("panel.expenseImport.confirmAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
