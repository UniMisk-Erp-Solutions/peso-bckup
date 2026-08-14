import { useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useCanSubmitOwnExpenses } from "@/hooks/useCanSubmitOwnExpenses";
import { useBatchExpenseEntry } from "@/hooks/useBatchExpenseEntry";
import { useTranslation } from "@/i18n";

type SubmitExpenseActionsProps = {
  className?: string;
  /** Outline style for primary "Add expense" (e.g. on admin panel). */
  addExpenseVariant?: "default" | "outline";
};

export function SubmitExpenseActions({
  className,
  addExpenseVariant = "default",
}: SubmitExpenseActionsProps) {
  const navigate = useNavigate();
  const { t } = useTranslation("dashboard");
  const { canSubmitExpenses, loading: canLoading } = useCanSubmitOwnExpenses();
  const { batchExpenseEntryEnabled, batchEntryLoading } = useBatchExpenseEntry();

  if (canLoading || !canSubmitExpenses) {
    return null;
  }

  const showBatch = batchExpenseEntryEnabled && !batchEntryLoading;

  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      {showBatch && (
        <Button variant="outline" onClick={() => navigate("/expenses/batch/new")}>
          <Plus className="mr-2 h-4 w-4" />
          {t("submitMultiple")}
        </Button>
      )}
      <Button
        variant={addExpenseVariant}
        onClick={() => navigate("/expenses/new")}
        className={
          addExpenseVariant === "default"
            ? undefined
            : "bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white border-0"
        }
      >
        <Plus className="mr-2 h-4 w-4" />
        {t("addExpense")}
      </Button>
    </div>
  );
}
