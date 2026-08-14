import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, RefreshCw, XCircle } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { OperationStatus } from "@/hooks/useOperationProgress";

export interface AsyncOperationProgressProps {
  status: OperationStatus;
  title?: string;
  description?: string;
  /** Explicit 0–100 value. Takes priority over completed/total. */
  value?: number;
  /** Determinate: how many items done */
  completed?: number;
  /** Determinate: total items */
  total?: number;
  /** Optional label for current item, e.g. "receipt 2 of 5" */
  currentItemLabel?: string;
  errorMessage?: string;
  retryLabel?: string;
  onRetry?: () => void;
  /** Compact single-line variant (for background refreshes) */
  compact?: boolean;
  /** Add sticky positioning */
  sticky?: boolean;
  /** Show success state — caller can control when to unmount */
  showSuccess?: boolean;
  className?: string;
}

/** Asymptotic pseudo-progress for indeterminate fetches: 0 → 85 */
function usePseudoProgress(active: boolean) {
  const [pseudo, setPseudo] = useState(0);
  useEffect(() => {
    if (!active) { setPseudo(0); return; }
    setPseudo(12);
    const id = setInterval(() => {
      setPseudo((p) => {
        if (p >= 85) return 85;
        return p + (85 - p) * 0.07;
      });
    }, 250);
    return () => clearInterval(id);
  }, [active]);
  return pseudo;
}

export function AsyncOperationProgress({
  status,
  title,
  description,
  value,
  completed,
  total,
  currentItemLabel,
  errorMessage,
  retryLabel = "Retry",
  onRetry,
  compact = false,
  sticky = false,
  showSuccess,
  className,
}: AsyncOperationProgressProps) {
  const isRunning = status === "running";
  const isSuccess = status === "success";
  const isWarning = status === "warning";
  const isError = status === "error";

  // Determine if we have real progress numbers
  const hasCounts = typeof completed === "number" && typeof total === "number" && total > 0;
  const determinateValue =
    value !== undefined
      ? Math.min(100, Math.max(0, value))
      : hasCounts
        ? Math.min(100, Math.round((completed! / total!) * 100))
        : undefined;
  const isDeterminate = determinateValue !== undefined;

  const pseudo = usePseudoProgress(isRunning && !isDeterminate);
  const barValue = isDeterminate ? determinateValue : pseudo;

  // Ref for aria-live — only announce on meaningful changes, not every tick
  const lastAnnouncedRef = useRef("");
  const announceLabel = hasCounts
    ? `${completed} of ${total}`
    : title ?? "";
  const shouldAnnounce = announceLabel !== lastAnnouncedRef.current;
  if (shouldAnnounce) lastAnnouncedRef.current = announceLabel;

  if (status === "idle") return null;
  if (isSuccess && !showSuccess) return null;

  // ── Success ───────────────────────────────────────────────────────────────
  if (isSuccess) {
    return (
      <div
        role="status"
        aria-live="polite"
        className={cn(
          "flex items-center gap-2 text-xs text-muted-foreground py-1",
          sticky && "sticky top-0 z-10 bg-background/80 backdrop-blur-sm",
          className,
        )}
      >
        <CheckCircle2
          className="h-3.5 w-3.5 shrink-0 text-green-600 dark:text-green-400"
          aria-hidden
        />
        <span className="font-medium text-green-700 dark:text-green-400">
          {title ?? "Done"}
        </span>
        {description && <span className="text-muted-foreground">· {description}</span>}
      </div>
    );
  }

  // ── Warning ───────────────────────────────────────────────────────────────
  if (isWarning) {
    return (
      <div
        role="status"
        aria-live="polite"
        className={cn(
          "flex flex-wrap items-start gap-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm",
          "dark:border-amber-700 dark:bg-amber-950",
          sticky && "sticky top-0 z-10",
          className,
        )}
      >
        <AlertTriangle
          className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400"
          aria-hidden
        />
        <div className="flex-1 min-w-0">
          {title && (
            <p className="font-medium text-amber-900 dark:text-amber-200">{title}</p>
          )}
          {description && (
            <p className="text-amber-800 dark:text-amber-300 text-xs mt-0.5">{description}</p>
          )}
          {errorMessage && (
            <p className="text-amber-800 dark:text-amber-300 text-xs mt-0.5">{errorMessage}</p>
          )}
        </div>
        {onRetry && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 shrink-0 border-amber-400 text-amber-900 hover:bg-amber-100 dark:border-amber-600 dark:text-amber-200 dark:hover:bg-amber-900"
            onClick={onRetry}
          >
            {retryLabel}
          </Button>
        )}
      </div>
    );
  }

  // ── Error ─────────────────────────────────────────────────────────────────
  if (isError) {
    return (
      <div
        role="alert"
        aria-live="assertive"
        className={cn(
          "flex flex-wrap items-start gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm",
          sticky && "sticky top-0 z-10",
          className,
        )}
      >
        <XCircle
          className="mt-0.5 h-4 w-4 shrink-0 text-destructive"
          aria-hidden
        />
        <div className="flex-1 min-w-0">
          {title && <p className="font-medium text-destructive">{title}</p>}
          {(errorMessage || description) && (
            <p className="text-destructive/80 text-xs mt-0.5">
              {errorMessage ?? description}
            </p>
          )}
        </div>
        {onRetry && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 shrink-0"
            onClick={onRetry}
          >
            {retryLabel}
          </Button>
        )}
      </div>
    );
  }

  // ── Running (compact — background refresh style) ─────────────────────────
  if (compact) {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-label={title}
        className={cn(
          "w-full space-y-1 py-1",
          sticky && "sticky top-0 z-10 bg-background/80 backdrop-blur-sm",
          className,
        )}
      >
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <RefreshCw className="h-3 w-3 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />
          {title && <span className="font-medium truncate">{title}</span>}
          {hasCounts && (
            <span className="ml-auto shrink-0 tabular-nums">
              {completed!.toLocaleString()} / {total!.toLocaleString()}
            </span>
          )}
        </div>
        <Progress
          value={barValue}
          className="h-0.5 motion-reduce:transition-none"
          aria-hidden
        />
      </div>
    );
  }

  // ── Running (full — initial load / long operation) ────────────────────────
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={title}
      className={cn(
        "w-full space-y-2 py-2",
        sticky && "sticky top-0 z-10 bg-background/80 backdrop-blur-sm px-4",
        className,
      )}
    >
      <div className="flex items-center gap-2 text-sm">
        <RefreshCw className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none text-muted-foreground" aria-hidden />
        <span className="font-medium text-foreground truncate">{title}</span>
        {hasCounts && (
          <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
            {completed!.toLocaleString()} / {total!.toLocaleString()}
          </span>
        )}
      </div>
      {description && (
        <p className="text-xs text-muted-foreground">{description}</p>
      )}
      {currentItemLabel && (
        <p className="text-xs text-muted-foreground italic">{currentItemLabel}</p>
      )}
      <Progress
        value={barValue}
        className="h-1.5 motion-reduce:transition-none"
        aria-hidden
      />
      {isDeterminate && hasCounts && (
        <p className="text-xs text-muted-foreground tabular-nums">
          {completed!.toLocaleString()} of {total!.toLocaleString()}
          {currentItemLabel ? ` — ${currentItemLabel}` : ""}
        </p>
      )}
    </div>
  );
}
