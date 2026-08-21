/**
 * CloudUpcomingBanner — small, non-blocking notice for a future scheduled
 * maintenance window. Deliberately NOT built on the old SystemAlertBanner /
 * SystemAvailabilityContext (that pair is Edge-Config-specific and kept only
 * as rollback reference, docs/maintenance/CLOUD_MAINTENANCE_CONTROL_PLANE.md
 * §19/§24). This is a small, purpose-built Cloud-only equivalent.
 *
 * Never blocks — the app underneath renders normally. §28: compact, uses
 * DD/MM/YYYY + local time, and an optional "starts in Xm" countdown label
 * (display-only; the actual transition to maintenance is driven by
 * maintenanceLeaseState's exact starts_at timer, never by this countdown).
 */
import { useEffect, useState } from "react";
import { Info } from "lucide-react";
import { formatMaintenanceDateTime, formatMaintenanceCountdown } from "@/lib/maintenanceDateTime";
import type { MaintenanceResolution } from "./maintenanceResolver";

type Props = {
  resolution: Extract<MaintenanceResolution, { state: "upcoming" }>;
};

export function CloudUpcomingBanner({ resolution }: Props) {
  const { row } = resolution;
  const title = row.title?.trim() || "Scheduled maintenance";
  const startLocal = formatMaintenanceDateTime(row.starts_at, { withTimezone: true });
  const endTimeOnly = row.ends_at ? formatMaintenanceDateTime(row.ends_at) : null;

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const startsInMs = row.starts_at ? new Date(row.starts_at).getTime() - now : null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="w-full border-b text-sm bg-blue-50 border-blue-200 text-blue-800 dark:bg-blue-950/30 dark:border-blue-800 dark:text-blue-300"
    >
      <div className="flex items-center gap-2 px-3 py-2 flex-wrap">
        <Info className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="font-medium">Scheduled maintenance:</span>
        <span className="min-w-0">
          {title} — {startLocal}
          {endTimeOnly ? ` – ${endTimeOnly.split(" • ")[1] ?? endTimeOnly}` : ""}
        </span>
        {startsInMs !== null && startsInMs > 0 && (
          <span className="text-xs opacity-80">Starts in {formatMaintenanceCountdown(startsInMs)}</span>
        )}
      </div>
    </div>
  );
}
