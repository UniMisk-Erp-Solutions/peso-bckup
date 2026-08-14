import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { ExternalLink, Eye } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatINR } from "@/lib/format";
import type { DailyProjectExpenseReportBuildResult } from "@/lib/buildDailyProjectExpenseReport";
import { DAILY_REPORT_COST_COLUMNS } from "@/lib/dailyExpenseReportConfig";

function formatTripDate(value: string | null): string {
  const raw = String(value ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return "—";
  const [y, m, d] = raw.split("-");
  return `${d}-${m}-${y}`;
}

type DailyReportSourceExpensesSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  result: DailyProjectExpenseReportBuildResult | null;
};

export function DailyReportSourceExpensesSheet({
  open,
  onOpenChange,
  result,
}: DailyReportSourceExpensesSheetProps) {
  const { t } = useTranslation("reports");
  const navigate = useNavigate();

  const row = result?.row ?? null;
  const sourceExpenses = result?.sourceExpenses ?? [];

  const totalAmount = useMemo(
    () => sourceExpenses.reduce((sum, exp) => sum + exp.total_amount, 0),
    [sourceExpenses],
  );

  const costSummary = useMemo(() => {
    if (!row) return [];
    return DAILY_REPORT_COST_COLUMNS.map(({ label }) => {
      const value = row[label];
      if (typeof value !== "number" || value <= 0) return null;
      return { label, amount: value };
    }).filter(Boolean) as { label: string; amount: number }[];
  }, [row]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{t("daily.sourceSheetTitle")}</SheetTitle>
          <SheetDescription>{t("daily.sourceSheetDescription")}</SheetDescription>
        </SheetHeader>

        {row ? (
          <div className="mt-6 space-y-6">
            <div className="rounded-lg border bg-slate-50 p-4 space-y-2 text-sm">
              <div className="flex flex-wrap gap-x-6 gap-y-1">
                <span>
                  <span className="text-muted-foreground">{t("daily.sourceEmployee")}: </span>
                  <span className="font-medium">{String(row.Employee || "—")}</span>
                </span>
                <span>
                  <span className="text-muted-foreground">{t("daily.sourceTrackDate")}: </span>
                  <span className="font-medium">{String(row["Track Date"] || "—")}</span>
                </span>
              </div>
              <div className="flex flex-wrap gap-x-6 gap-y-1">
                <span>
                  <span className="text-muted-foreground">{t("columns.projectId")}: </span>
                  <span className="font-medium">{String(row["project id"] || "—")}</span>
                </span>
                <span>
                  <span className="text-muted-foreground">{t("columns.projectName")}: </span>
                  <span className="font-medium">{String(row["project name"] || "—")}</span>
                </span>
              </div>
              {costSummary.length > 0 ? (
                <div className="flex flex-wrap gap-2 pt-1">
                  {costSummary.map(({ label, amount }) => (
                    <Badge key={label} variant="secondary" className="font-normal">
                      {label}: {formatINR(amount)}
                    </Badge>
                  ))}
                </div>
              ) : null}
            </div>

            <p className="text-sm text-muted-foreground">
              {t("daily.sourceExpenseCount", { count: sourceExpenses.length })}
              {" · "}
              {t("daily.sourceTotal")}: <span className="font-medium text-foreground">{formatINR(totalAmount)}</span>
            </p>

            <div className="overflow-x-auto border rounded-lg">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-100 border-b">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold">{t("daily.sourceColVoucher")}</th>
                    <th className="px-3 py-2 text-left font-semibold">{t("columns.category")}</th>
                    <th className="px-3 py-2 text-left font-semibold">{t("daily.sourceColReportColumn")}</th>
                    <th className="px-3 py-2 text-right font-semibold">{t("columns.amount")}</th>
                    <th className="px-3 py-2 text-left font-semibold">{t("daily.sourceColProject")}</th>
                    <th className="px-3 py-2 text-center font-semibold">{t("daily.sourceColView")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {sourceExpenses.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                        {t("daily.sourceNoExpenses")}
                      </td>
                    </tr>
                  ) : (
                    sourceExpenses.map((exp) => (
                      <tr key={exp.id} className="hover:bg-slate-50">
                        <td className="px-3 py-2 whitespace-nowrap">
                          <div className="font-medium">{exp.voucherNo || "—"}</div>
                          <div className="text-xs text-muted-foreground">{formatTripDate(exp.trip_start)}</div>
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">{exp.category || "—"}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{exp.costColumnLabel}</td>
                        <td className="px-3 py-2 text-right whitespace-nowrap font-medium">
                          {formatINR(exp.total_amount)}
                        </td>
                        <td className="px-3 py-2">
                          <div className="text-xs">
                            {exp.projectId ? (
                              <span className="block">ID: {exp.projectId}</span>
                            ) : null}
                            {exp.projectName ? (
                              <span className="block text-muted-foreground">{exp.projectName}</span>
                            ) : null}
                            {exp.location ? (
                              <span className="block text-muted-foreground">{exp.location}</span>
                            ) : null}
                            {!exp.projectId && !exp.projectName && !exp.location ? "—" : null}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-center">
                          <Button
                            variant="ghost"
                            size="sm"
                            title={t("daily.sourceOpenExpense")}
                            onClick={() => {
                              onOpenChange(false);
                              navigate(`/expenses/${exp.id}`);
                            }}
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
                {sourceExpenses.length > 0 ? (
                  <tfoot className="border-t bg-slate-50">
                    <tr>
                      <td colSpan={3} className="px-3 py-2 text-right font-semibold">
                        {t("daily.sourceTotal")}
                      </td>
                      <td className="px-3 py-2 text-right font-semibold">{formatINR(totalAmount)}</td>
                      <td colSpan={2} />
                    </tr>
                  </tfoot>
                ) : null}
              </table>
            </div>

            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <ExternalLink className="h-3 w-3" />
              {t("daily.sourceOpenExpenseHint")}
            </p>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
