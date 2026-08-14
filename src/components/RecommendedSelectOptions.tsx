import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { RECENT_FORM_FIELD_OPTIONS_LIMIT } from "@/lib/recommendedFormFieldOptions";

type RecommendedSelectOptionsProps = {
  options: string[];
  selectedValue: string;
  onSelect: (value: string) => void;
  compact?: boolean;
};

/** Quick-pick chips below category select (expense form). */
export function RecommendedSelectOptions({
  options,
  selectedValue,
  onSelect,
  compact = false,
}: RecommendedSelectOptionsProps) {
  const { t } = useTranslation("expenses");
  const topRecent = options.slice(0, RECENT_FORM_FIELD_OPTIONS_LIMIT);

  if (topRecent.length === 0) return null;

  return (
    <div className="space-y-1">
      <p className={cn("text-muted-foreground", compact ? "text-[10px]" : "text-xs")}>
        {t("form.recommended.topPicks")}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {topRecent.map((option) => (
          <Button
            key={option}
            type="button"
            variant={selectedValue === option ? "default" : "outline"}
            size="sm"
            className={cn(
              compact ? "h-6 text-[10px] px-2" : "h-7 text-xs",
              selectedValue === option && "bg-blue-600 hover:bg-blue-700",
            )}
            onClick={() => onSelect(option)}
          >
            {option}
          </Button>
        ))}
      </div>
    </div>
  );
}
