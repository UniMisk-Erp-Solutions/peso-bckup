/**
 * CloudMaintenanceScreen — full-page blocking UI driven by the Cloud
 * maintenance control plane.
 *
 * Deliberately NOT coupled to SystemAvailabilityContext (the old Vercel/Edge
 * Config system, kept only as rollback reference — see
 * docs/maintenance/CLOUD_MAINTENANCE_CONTROL_PLANE.md §19/§24). This
 * component takes its data as plain props from MaintenanceBootstrap, which
 * itself never touches Local Supabase while this screen is shown.
 *
 * "Check Again" performs a fresh CLOUD status check only — it must never
 * contact local Supabase. There is no "you're offline" branch here: if this
 * screen is rendering at all, the Cloud read that produced it SUCCEEDED, or
 * a previously-established trusted lease is still within its bounded
 * window (see maintenanceLeaseState.ts) — see maintenanceResolver.ts.
 *
 * §29/§30: `checking` reflects ONLY a manual "Check again" click — automatic
 * background polling never toggles it, so a silent poll produces no visual
 * flicker and no error/offline UI, even if that poll itself failed (the
 * lease is still trusted).
 */
import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MaintenanceIllustration } from "./MaintenanceIllustration";
import {
  formatMaintenanceDateTime,
  formatMaintenanceCountdown,
  calculateMaintenanceDuration,
} from "@/lib/maintenanceDateTime";
import type { MaintenanceResolution } from "./maintenanceResolver";

type Props = {
  resolution: Extract<MaintenanceResolution, { state: "maintenance" }>;
  onCheckAgain: () => void;
  checking?: boolean;
  lastCheckedAt?: string | null;
};

export function CloudMaintenanceScreen({ resolution, onCheckAgain, checking, lastCheckedAt }: Props) {
  const { row, source } = resolution;
  const title = row.title?.trim() || "PesoWise is under maintenance";
  const message =
    row.message?.trim() ||
    "We're performing scheduled maintenance. Please check back shortly.";

  const hasWindow = source === "scheduled" && Boolean(row.starts_at) && Boolean(row.ends_at);

  // Live-updating countdown for a scheduled window — display-only; the
  // actual transition is driven by maintenanceLeaseState's exact timers,
  // never by this component's own clock.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasWindow) return;
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [hasWindow]);

  const remainingMs = hasWindow && row.ends_at ? new Date(row.ends_at).getTime() - now : null;

  return (
    <div
      role="main"
      aria-live="polite"
      className="min-h-screen flex flex-col items-center justify-center bg-background px-4 py-10"
    >
      <div className="max-w-md w-full text-center space-y-6">
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          PesoWise
        </p>

        <div className="flex justify-center">
          <MaintenanceIllustration />
        </div>

        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-wide text-amber-600 dark:text-amber-400">
            {source === "forced" ? "Quick maintenance break" : "Scheduled maintenance"}
          </p>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
          <p className="text-muted-foreground text-base leading-relaxed">{message}</p>
        </div>

        {remainingMs !== null && remainingMs > 0 && (
          <p className="text-sm font-medium text-foreground">
            Expected back in {formatMaintenanceCountdown(remainingMs)}
          </p>
        )}

        <div className="rounded-lg border bg-card p-4 text-sm space-y-2">
          {source === "scheduled" && row.starts_at && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Started</span>
              <span className="font-medium text-foreground text-right">
                {formatMaintenanceDateTime(row.starts_at, { withTimezone: true })}
              </span>
            </div>
          )}

          {row.ends_at ? (
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Expected back</span>
              <span className="font-medium text-foreground text-right">
                {formatMaintenanceDateTime(row.ends_at, { withTimezone: true })}
              </span>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Estimated return</span>
              <span className="font-medium text-foreground">not set</span>
            </div>
          )}

          {row.starts_at && row.ends_at && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Duration</span>
              <span className="font-medium text-foreground">
                {calculateMaintenanceDuration(row.starts_at, row.ends_at) || "—"}
              </span>
            </div>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          Your data and session are safe. PesoWise will be available again shortly.
        </p>

        <div className="flex flex-col gap-2 items-center pt-1">
          <Button variant="ghost" size="sm" onClick={onCheckAgain} disabled={checking} className="gap-2 text-xs">
            <RefreshCw className={`h-3.5 w-3.5 ${checking ? "animate-spin" : ""}`} />
            Check again
          </Button>
          {lastCheckedAt && (
            <p className="text-xs text-muted-foreground">
              Last checked {formatMaintenanceDateTime(lastCheckedAt)}
            </p>
          )}
        </div>

        <p className="text-xs text-muted-foreground pt-4 border-t">PesoWise by Unimisk</p>
      </div>
    </div>
  );
}
