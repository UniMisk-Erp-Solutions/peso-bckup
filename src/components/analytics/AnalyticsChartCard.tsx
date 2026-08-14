import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Info } from "lucide-react";
import { cn } from "@/lib/utils";

interface AnalyticsChartCardProps {
  title: string;
  description?: string;
  tooltipText?: string;
  loading?: boolean;
  empty?: boolean;
  emptyLabel?: string;
  children: React.ReactNode;
  /** Collapsible accessible data table */
  dataTable?: React.ReactNode;
  className?: string;
  contentClassName?: string;
  noPadding?: boolean;
}

export function AnalyticsChartCard({
  title,
  description,
  tooltipText,
  loading = false,
  empty = false,
  emptyLabel = "No data for this period.",
  children,
  dataTable,
  className,
  contentClassName,
  noPadding = false,
}: AnalyticsChartCardProps) {
  const [tableOpen, setTableOpen] = useState(false);

  return (
    <Card className={cn("overflow-hidden", className)}>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="text-sm font-semibold">{title}</CardTitle>
            {description && (
              <CardDescription className="mt-0.5 text-xs">
                {description}
              </CardDescription>
            )}
          </div>
          {tooltipText && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="h-4 w-4 text-muted-foreground/60 cursor-help shrink-0 mt-0.5" />
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-xs text-xs">
                  {tooltipText}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
      </CardHeader>

      <CardContent className={cn(noPadding && "px-0 pb-0", contentClassName)}>
        {loading ? (
          <div className="flex items-center justify-center h-48">
            <div className="space-y-2 w-full px-4">
              {[80, 60, 90, 50, 70].map((w, i) => (
                <div
                  key={i}
                  className="h-4 rounded bg-muted animate-pulse"
                  style={{ width: `${w}%` }}
                />
              ))}
            </div>
          </div>
        ) : empty ? (
          <div className="flex items-center justify-center h-40 text-sm text-muted-foreground">
            {emptyLabel}
          </div>
        ) : (
          <>
            {children}
            {dataTable && (
              <div className="mt-2 border-t">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-full text-xs text-muted-foreground gap-1 rounded-none"
                  onClick={() => setTableOpen((o) => !o)}
                  aria-expanded={tableOpen}
                >
                  {tableOpen ? (
                    <>
                      <ChevronUp className="h-3 w-3" /> Hide data
                    </>
                  ) : (
                    <>
                      <ChevronDown className="h-3 w-3" /> View data
                    </>
                  )}
                </Button>
                {tableOpen && (
                  <div className="overflow-x-auto p-2" role="region" aria-label={`${title} data table`}>
                    {dataTable}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
