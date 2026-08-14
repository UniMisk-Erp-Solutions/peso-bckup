import { Link } from "react-router-dom";
import { useTranslation } from "@/i18n";
import { format } from "date-fns";
import { formatINR } from "@/lib/format";
import { canOwnerEditExpenseStatus } from "@/lib/expenseEditRules";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ExpenseStatusWithCorrectionBadge } from "@/components/ExpenseStatusWithCorrectionBadge";

export type BatchExpenseContextInfo = {
  id: string;
  label: string | null;
  line_count: number;
  total_amount: number;
  created_at: string;
};

export type BatchExpenseSibling = {
  id: string;
  title: string;
  total_amount: number;
  status: string;
  transaction_number?: string | null;
};

interface BatchExpenseContextCardProps {
  batchInfo: BatchExpenseContextInfo;
  siblings: BatchExpenseSibling[];
  currentExpenseId: string;
  userId?: string | null;
  userRole?: string | null;
  /** On the edit form, emphasize that saving updates this line and batch totals. */
  variant?: "view" | "edit";
}

export function BatchExpenseContextCard({
  batchInfo,
  siblings,
  currentExpenseId,
  userId,
  userRole,
  variant = "view",
}: BatchExpenseContextCardProps) {
  const { t } = useTranslation("expenses");
  const otherSiblings = siblings.filter((s) => s.id !== currentExpenseId);

  return (
    <Card className="border-blue-200 bg-blue-50/40">
      <CardHeader>
        <CardTitle className="text-lg">{t("batchSubmission")}</CardTitle>
        <CardDescription>
          {variant === "edit" && (
            <span className="block mb-1">{t("form.batchEditDescription")}</span>
          )}
          {t("batchSubmittedOn", {
            date: format(new Date(batchInfo.created_at), "MMM d, yyyy 'at' h:mm a"),
            label: batchInfo.label ? ` — ${batchInfo.label}` : "",
            summary:
              batchInfo.line_count > 0
                ? ` (${batchInfo.line_count} expenses, ${formatINR(Number(batchInfo.total_amount))} total)`
                : "",
          })}
        </CardDescription>
      </CardHeader>
      {variant === "view" &&
        (userRole === "admin" ||
          userRole === "engineer" ||
          userRole === "employee" ||
          userRole === "team_leader" ||
          userRole === "executive") && (
        <CardContent className="pt-0">
          <Button asChild variant={userRole === "employee" ? "outline" : "default"} size="sm">
            <Link
              to={`/expenses/batch/${batchInfo.id}/review?from=${userRole === "admin" ? "admin" : "review"}&expense=${currentExpenseId}`}
            >
              {userRole === "employee" ? t("viewEntireBatch") : t("reviewEntireBatch")}
            </Link>
          </Button>
        </CardContent>
      )}
      {otherSiblings.length > 0 && (
        <CardContent className={userRole === "admin" || userRole === "engineer" ? "pt-2" : ""}>
          <p className="text-sm font-medium mb-2">{t("otherInBatch")}</p>
          <ul className="space-y-2">
            {otherSiblings.map((sibling) => (
              <li key={sibling.id} className="flex flex-wrap items-center justify-between gap-2">
                <Link
                  to={`/expenses/${sibling.id}`}
                  className="text-sm text-blue-700 hover:underline flex flex-wrap items-center gap-2"
                >
                  <span className="font-medium">{sibling.title}</span>
                  <span className="text-muted-foreground">{formatINR(sibling.total_amount)}</span>
                  {sibling.transaction_number && (
                    <span className="font-mono text-xs">#{sibling.transaction_number}</span>
                  )}
                  <ExpenseStatusWithCorrectionBadge status={sibling.status} />
                </Link>
                {userId &&
                  canOwnerEditExpenseStatus(sibling.status) && (
                    <Button asChild variant="outline" size="sm" className="h-7 text-xs">
                      <Link to={`/expenses/${sibling.id}/edit`}>{t("actions.edit")}</Link>
                    </Button>
                  )}
              </li>
            ))}
          </ul>
        </CardContent>
      )}
    </Card>
  );
}
