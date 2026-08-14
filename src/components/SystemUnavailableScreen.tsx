/**
 * SystemUnavailableScreen — full-page blocking maintenance screen.
 * Shown by ProtectedRoute (and the /auth gate) when blocking === true
 * and the user is not a Master Admin on /master.
 *
 * Shows content from the manually entered title/message stored in Edge Config.
 * Does NOT contain automatic-outage copy — maintenance is always manual.
 *
 * Scenarios:
 * - Manual immediate maintenance (source === "manual")
 * - Active scheduled window (source === "scheduled")
 * - Browser offline
 * - Unknown/initializing state
 */

import { useSystemAvailability } from "@/contexts/SystemAvailabilityContext";
import { RefreshCw, WifiOff, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";

type Props = {
  /** Override title */
  title?: string;
  /** Override message */
  message?: string;
};

export function SystemUnavailableScreen({ title: titleProp, message: messageProp }: Props) {
  const { status, state, lastCheckedAt, browserOnline, refreshStatus } =
    useSystemAvailability();
  const { t } = useTranslation("common");

  const isOffline = !browserOnline;
  const isScheduled = state === "maintenance" && status?.source === "scheduled";
  const isManual = state === "maintenance" && status?.source === "manual";

  let icon: React.ReactNode;
  let defaultTitle: string;
  let defaultMessage: string;

  if (isOffline) {
    icon = <WifiOff className="h-10 w-10 text-slate-500 dark:text-slate-400" aria-hidden="true" />;
    defaultTitle = "You're offline";
    defaultMessage =
      "PesoWise is waiting for a network connection. Your data is safe — check your internet and try again.";
  } else if (isScheduled || isManual) {
    icon = (
      <Wrench className="h-10 w-10 text-amber-600 dark:text-amber-400" aria-hidden="true" />
    );
    defaultTitle = status?.title ?? t("systemStatus.maintenance.defaultTitle");
    defaultMessage = status?.message ?? t("systemStatus.maintenance.defaultMessage");
  } else {
    icon = (
      <Wrench className="h-10 w-10 text-amber-500 dark:text-amber-400" aria-hidden="true" />
    );
    defaultTitle = t("systemStatus.maintenance.defaultTitle");
    defaultMessage = t("systemStatus.maintenance.defaultMessage");
  }

  const title = titleProp ?? defaultTitle;
  const message = messageProp ?? defaultMessage;
  const estimatedEnd = status?.estimated_end_at ?? status?.ends_at;
  const publicStatusUrl = status?.public_status_url;
  const source = status?.source;

  const iconBg = isOffline
    ? "bg-slate-100 dark:bg-slate-800"
    : "bg-amber-100 dark:bg-amber-900/30";

  return (
    <div
      role="main"
      aria-live="polite"
      className="min-h-screen flex flex-col items-center justify-center bg-background px-4"
    >
      <div className="max-w-md w-full text-center space-y-6">
        {/* Branding */}
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          PesoWise
        </p>

        {/* Icon */}
        <div className="flex justify-center">
          <div className={`rounded-full p-5 ${iconBg}`}>{icon}</div>
        </div>

        {/* Heading */}
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            {title}
          </h1>
          <p className="text-muted-foreground text-base leading-relaxed">{message}</p>
        </div>

        {/* Source label — only for manual/scheduled, never for auto-health */}
        {source && (source === "manual" || source === "scheduled") && !isOffline && (
          <p className="text-xs text-muted-foreground capitalize">
            {source === "manual" ? "Immediate maintenance" : "Scheduled maintenance"}
          </p>
        )}

        {/* Scheduled window times */}
        {isScheduled && status?.starts_at && (
          <p className="text-sm text-muted-foreground">
            Started:{" "}
            <span className="font-medium text-foreground">
              {new Date(status.starts_at).toLocaleString()}
            </span>
          </p>
        )}

        {/* Estimated end */}
        {estimatedEnd && (
          <p className="text-sm text-muted-foreground">
            {t("systemStatus.estimatedRestoration")}{" "}
            <span className="font-medium text-foreground">
              {new Date(estimatedEnd).toLocaleString()}
            </span>
          </p>
        )}

        {/* No ETA indicator */}
        {!estimatedEnd && isManual && (
          <p className="text-sm text-muted-foreground">Estimated restoration time: not yet known</p>
        )}

        {/* Reassurance note */}
        <p className="text-xs text-muted-foreground">
          Your data and session are safe. PesoWise will be available again shortly.
        </p>

        {/* Status page link */}
        {publicStatusUrl && (
          <a
            href={publicStatusUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block text-sm underline underline-offset-2 text-primary hover:text-primary/80 transition-colors"
          >
            {t("systemStatus.viewLiveStatus")}
          </a>
        )}

        {/* Actions */}
        <div className="flex flex-col gap-2 items-center">
          <Button
            variant="outline"
            size="sm"
            onClick={refreshStatus}
            className="gap-2"
          >
            <RefreshCw className="h-4 w-4" />
            {t("systemStatus.checkAgain")}
          </Button>
          {lastCheckedAt && (
            <p className="text-xs text-muted-foreground">
              {t("systemStatus.lastChecked")} {new Date(lastCheckedAt).toLocaleTimeString()}
            </p>
          )}
        </div>

        {/* Footer */}
        <p className="text-xs text-muted-foreground pt-4 border-t">PesoWise by Unimisk</p>
      </div>
    </div>
  );
}
