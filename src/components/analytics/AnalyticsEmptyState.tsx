import { BarChart3 } from "lucide-react";
import { Button } from "@/components/ui/button";

interface AnalyticsEmptyStateProps {
  title?: string;
  description?: string;
  onReset?: () => void;
  resetLabel?: string;
}

export function AnalyticsEmptyState({
  title = "No expense data available",
  description = "No expenses match the selected filters and date range.",
  onReset,
  resetLabel = "Reset filters",
}: AnalyticsEmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
      <BarChart3 className="h-12 w-12 text-muted-foreground/30" />
      <div>
        <p className="font-semibold text-foreground">{title}</p>
        <p className="text-sm text-muted-foreground mt-1 max-w-xs">{description}</p>
      </div>
      {onReset && (
        <Button variant="outline" size="sm" onClick={onReset}>
          {resetLabel}
        </Button>
      )}
    </div>
  );
}
