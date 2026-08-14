import { useTranslation } from "@/i18n";
import { cn } from "@/lib/utils";
import type { ExpenseFormDraftNotice } from "@/hooks/useExpenseFormDraft";
import { AlertCircle, CheckCircle2, RotateCcw } from "lucide-react";

type ExpenseFormDraftBannerProps = {
  notice: ExpenseFormDraftNotice;
  className?: string;
};

export function ExpenseFormDraftBanner({ notice, className }: ExpenseFormDraftBannerProps) {
  const { t } = useTranslation("expenses");

  if (notice === "none") return null;

  const config =
    notice === "restored"
      ? {
          icon: RotateCcw,
          title: t("form.draft.restoredTitle"),
          description: t("form.draft.restoredHint"),
          className: "bg-amber-50 border-amber-200 text-amber-950",
        }
      : notice === "save_failed"
        ? {
            icon: AlertCircle,
            title: t("form.draft.failedTitle"),
            description: t("form.draft.failedHint"),
            className: "bg-red-50 border-red-200 text-red-950",
          }
        : {
            icon: CheckCircle2,
            title: t("form.draft.savedTitle"),
            description: t("form.draft.savedHint"),
            className: "bg-emerald-50 border-emerald-200 text-emerald-950",
          };

  const Icon = config.icon;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex gap-3 rounded-lg border px-3 py-2.5 text-sm",
        config.className,
        className,
      )}
    >
      <Icon className="h-5 w-5 shrink-0 mt-0.5" aria-hidden />
      <div>
        <p className="font-medium">{config.title}</p>
        <p className="text-xs opacity-90 mt-0.5">{config.description}</p>
      </div>
    </div>
  );
}
