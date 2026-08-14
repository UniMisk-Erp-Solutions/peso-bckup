import { formatINR } from "@/lib/format";

interface TooltipPayloadItem {
  name?: string;
  value?: number | string;
  color?: string;
  dataKey?: string;
  payload?: Record<string, unknown>;
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: TooltipPayloadItem[];
  label?: string;
  /** Format values as INR currency */
  currency?: boolean;
  /** Show count from payload.count */
  showCount?: boolean;
  /** Show percentage from payload.pct */
  showPct?: boolean;
  /** Extra row label → key pairs to render from payload */
  extraKeys?: Array<{ label: string; key: string; currency?: boolean }>;
}

export function AnalyticsTooltip({
  active,
  payload,
  label,
  currency = true,
  showCount = false,
  showPct = false,
  extraKeys = [],
}: CustomTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;

  const firstPayload = payload[0]?.payload as Record<string, unknown> | undefined;

  return (
    <div className="rounded-lg border bg-background/95 backdrop-blur-sm shadow-lg px-3 py-2 text-xs min-w-[140px] max-w-[240px]">
      {label && (
        <p className="font-semibold text-foreground mb-1.5 border-b pb-1">{label}</p>
      )}
      {payload.map((item, i) => {
        const val = item.value;
        const displayVal =
          currency && typeof val === "number"
            ? formatINR(val)
            : String(val ?? "—");
        return (
          <div key={i} className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-1.5 min-w-0">
              {item.color && (
                <span
                  className="h-2 w-2 rounded-full shrink-0"
                  style={{ backgroundColor: item.color }}
                />
              )}
              <span className="text-muted-foreground truncate">
                {item.name ?? item.dataKey}
              </span>
            </div>
            <span className="font-medium tabular-nums shrink-0">{displayVal}</span>
          </div>
        );
      })}

      {showCount && firstPayload && typeof firstPayload.count === "number" && (
        <div className="flex items-center justify-between gap-3 mt-0.5">
          <span className="text-muted-foreground">Count</span>
          <span className="font-medium tabular-nums">{firstPayload.count}</span>
        </div>
      )}

      {showPct && firstPayload && typeof firstPayload.pct === "number" && (
        <div className="flex items-center justify-between gap-3 mt-0.5">
          <span className="text-muted-foreground">Share</span>
          <span className="font-medium tabular-nums">
            {(firstPayload.pct as number).toFixed(1)}%
          </span>
        </div>
      )}

      {extraKeys.map(({ label: extraLabel, key, currency: isCurrency }) => {
        if (!firstPayload) return null;
        const val = firstPayload[key];
        if (val === undefined || val === null) return null;
        return (
          <div key={key} className="flex items-center justify-between gap-3 mt-0.5">
            <span className="text-muted-foreground">{extraLabel}</span>
            <span className="font-medium tabular-nums">
              {isCurrency && typeof val === "number"
                ? formatINR(val)
                : String(val)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Simple INR axis tick formatter */
export function formatAxisINR(value: number): string {
  if (value >= 10_000_000) return `₹${(value / 10_000_000).toFixed(1)}Cr`;
  if (value >= 100_000) return `₹${(value / 100_000).toFixed(1)}L`;
  if (value >= 1_000) return `₹${(value / 1_000).toFixed(0)}K`;
  return `₹${value}`;
}
