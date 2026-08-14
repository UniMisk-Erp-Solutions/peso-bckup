import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { type Change, computeChange } from "@/lib/analytics/expenseAnalytics";

interface AnalyticsMetricCardProps {
  title: string;
  value: string;
  subtitle?: string;
  tooltipText?: string;
  currentRaw?: number;
  prevRaw?: number;
  /** If provided, overrides auto-computed change */
  change?: Change;
  loading?: boolean;
  className?: string;
  large?: boolean;
}

function ChangeIndicator({ change }: { change: Change }) {
  if (change.type === "none" || change.type === "zero") {
    return (
      <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground">
        <Minus className="h-3 w-3" />
        No change
      </span>
    );
  }
  if (change.type === "new") {
    return (
      <span className="inline-flex items-center gap-0.5 text-xs text-emerald-600 dark:text-emerald-400 font-medium">
        New
      </span>
    );
  }
  const pct = change.value;
  const up = pct >= 0;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-xs font-medium",
        up
          ? "text-emerald-600 dark:text-emerald-400"
          : "text-destructive",
      )}
    >
      {up ? (
        <TrendingUp className="h-3 w-3" />
      ) : (
        <TrendingDown className="h-3 w-3" />
      )}
      {Math.abs(pct).toFixed(1)}%
    </span>
  );
}

export function AnalyticsMetricCard({
  title,
  value,
  subtitle,
  tooltipText,
  currentRaw,
  prevRaw,
  change: changeProp,
  loading = false,
  className,
  large = false,
}: AnalyticsMetricCardProps) {
  const change: Change =
    changeProp ??
    (currentRaw !== undefined && prevRaw !== undefined
      ? computeChange(currentRaw, prevRaw)
      : { type: "none" });

  const showComparison = change.type !== "none";

  return (
    <Card className={cn("relative", className)}>
      <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-1 pt-3 px-4">
        <CardTitle
          className={cn(
            "font-medium text-muted-foreground",
            large ? "text-sm" : "text-xs",
          )}
        >
          {title}
        </CardTitle>
        {tooltipText && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help shrink-0 mt-0.5" />
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-xs text-xs">
                {tooltipText}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </CardHeader>
      <CardContent className="px-4 pb-3">
        {loading ? (
          <div className="space-y-1.5">
            <div className="h-7 w-28 rounded bg-muted animate-pulse" />
            <div className="h-3 w-20 rounded bg-muted animate-pulse" />
          </div>
        ) : (
          <>
            <div
              className={cn(
                "font-bold tabular-nums leading-none",
                large ? "text-2xl sm:text-3xl" : "text-xl",
              )}
            >
              {value}
            </div>
            {subtitle && (
              <p className="text-xs text-muted-foreground mt-0.5 truncate">
                {subtitle}
              </p>
            )}
            {showComparison && (
              <div className="mt-1">
                <ChangeIndicator change={change} />
                <span className="text-xs text-muted-foreground ml-1">
                  vs prev period
                </span>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
