/**
 * SystemAlertBanner — accessible top-of-page alert strip with CSS ticker.
 *
 * Shows for:
 *   - "upcoming" state (manually scheduled maintenance window in announcement period)
 *   - Any state when active_announcement is present (independent broadcast)
 *
 * Priority (highest first): upcoming scheduled notice > broadcast announcement.
 * Does NOT render during "maintenance" / "outage" — ProtectedRoute handles those.
 * Does NOT show for automatic outage/degraded — those states are no longer generated.
 *
 * Upcoming text format:
 *   Scheduled maintenance: {title} — Starts: {local} — Expected completion: {local} — {message}
 *
 * Ticker behaviour:
 * - Scrolls text horizontally using CSS animation
 * - Pauses on hover / keyboard focus / manual toggle
 * - prefers-reduced-motion: static wrapping text
 * - aria-live="polite" for upcoming alerts
 * - Maintenance-window alerts: dismiss per revision (sessionStorage)
 * - Broadcast announcements: dismiss per announcement id+published_at (sessionStorage)
 */

import { useSystemAvailability } from "@/contexts/SystemAvailabilityContext";
import { formatCountdown } from "@/lib/systemAvailability";
import { Info, Megaphone, X, PauseCircle, PlayCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useState, useRef, useCallback } from "react";

const KEYFRAME_ID = "system-banner-ticker-kf";
function ensureKeyframe() {
  if (typeof document === "undefined") return;
  if (document.getElementById(KEYFRAME_ID)) return;
  const style = document.createElement("style");
  style.id = KEYFRAME_ID;
  style.textContent = `
    @keyframes system-banner-scroll {
      0%   { transform: translateX(100%); }
      100% { transform: translateX(-100%); }
    }
    .system-banner-ticker {
      animation: system-banner-scroll 28s linear infinite;
      white-space: nowrap;
      will-change: transform;
    }
    .system-banner-ticker-paused {
      animation-play-state: paused;
    }
    .system-banner-ticker-wrap:hover .system-banner-ticker,
    .system-banner-ticker-wrap:focus-within .system-banner-ticker {
      animation-play-state: paused;
    }
  `;
  document.head.appendChild(style);
}

type BannerTheme = "info" | "announcement";

function BannerIcon({ theme }: { theme: BannerTheme }) {
  if (theme === "announcement") return <Megaphone className="h-4 w-4 shrink-0" aria-hidden="true" />;
  return <Info className="h-4 w-4 shrink-0" aria-hidden="true" />;
}

function formatLocalDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      weekday: "short", month: "short", day: "numeric",
      year: "numeric", hour: "numeric", minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function getSessionDismissed(key: string): boolean {
  try { return sessionStorage.getItem(key) === "1"; } catch { return false; }
}
function setSessionDismissed(key: string) {
  try { sessionStorage.setItem(key, "1"); } catch {}
}

export function SystemAlertBanner() {
  const { state, status } = useSystemAvailability();
  const { t } = useTranslation("common");
  const [manualPaused, setManualPaused] = useState(false);
  const [dismissedKeys, setDismissedKeys] = useState<Set<string>>(new Set());
  const wrapRef = useRef<HTMLDivElement>(null);

  ensureKeyframe();

  const ann = status?.active_announcement ?? null;

  // Derive banner content (empty strings when not applicable)
  let bannerTheme: BannerTheme | null = null;
  let dismissKey = "";
  let fullText = "";
  let isLive = false;
  let showStatusPageLink = false;

  if (status && state === "upcoming") {
    const title = status.title ?? "";
    const message = status.message ?? "";
    const countdown = status.starts_at
      ? formatCountdown(status.starts_at, status.server_now)
      : null;
    const startLocal = status.starts_at ? formatLocalDateTime(status.starts_at) : null;
    const endLocal = status.ends_at ? formatLocalDateTime(status.ends_at) : null;

    const parts: string[] = [];
    if (title) parts.push(`Scheduled maintenance: ${title}`);
    if (startLocal) parts.push(`Starts: ${startLocal}${countdown ? ` (${countdown})` : ""}`);
    if (endLocal) parts.push(`Expected completion: ${endLocal}`);
    if (message) parts.push(message);
    fullText = parts.join(" — ");

    bannerTheme = "info";
    dismissKey = `sw-revision:${status.revision}`;
    isLive = true;
    showStatusPageLink = true;
  } else if (ann) {
    fullText = [ann.title, ann.message].filter(Boolean).join(" — ");
    bannerTheme = "announcement";
    dismissKey = `sw-ann:${ann.id}:${ann.published_at}`;
    isLive = false;
    showStatusPageLink = false;
  }

  // All hooks must be called before any conditional return
  const handleDismiss = useCallback(() => {
    if (!dismissKey) return;
    setSessionDismissed(dismissKey);
    setDismissedKeys((prev) => new Set(prev).add(dismissKey));
  }, [dismissKey]);

  if (!status) return null;
  if (state === "maintenance" || state === "outage") return null;
  if (!bannerTheme || !fullText) return null;

  // Check dismiss (in-memory set first, then sessionStorage)
  if (dismissKey && (dismissedKeys.has(dismissKey) || getSessionDismissed(dismissKey))) return null;

  const bgClass =
    bannerTheme === "announcement"
      ? "bg-violet-50 border-violet-200 text-violet-800 dark:bg-violet-950/30 dark:border-violet-800 dark:text-violet-300"
      : "bg-blue-50 border-blue-200 text-blue-800 dark:bg-blue-950/30 dark:border-blue-800 dark:text-blue-300";

  const tickerPauseClass = manualPaused ? "system-banner-ticker-paused" : "";

  return (
    <div
      role="alert"
      aria-live={isLive ? "polite" : "off"}
      aria-atomic="false"
      className={`w-full border-b text-sm ${bgClass}`}
      style={{ overflow: "hidden" }}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <BannerIcon theme={bannerTheme} />

        <div
          ref={wrapRef}
          className="system-banner-ticker-wrap flex-1 min-w-0 overflow-hidden relative"
          style={{ height: "1.4em" }}
        >
          {/* prefers-reduced-motion: static */}
          <span className="hidden motion-reduce:block truncate text-sm">
            {fullText}
            {showStatusPageLink && status.public_status_url && (
              <a
                href={status.public_status_url}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-2 underline underline-offset-2 opacity-80 hover:opacity-100"
              >
                {t("systemStatus.statusPage")}
              </a>
            )}
          </span>

          {/* Animated ticker */}
          <span
            className={`motion-reduce:hidden absolute top-0 left-0 system-banner-ticker ${tickerPauseClass}`}
            aria-hidden="true"
          >
            {fullText}
            {showStatusPageLink && status.public_status_url && (
              <>
                {" · "}
                <a
                  href={status.public_status_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-2 opacity-80 hover:opacity-100"
                  tabIndex={-1}
                >
                  {t("systemStatus.statusPage")}
                </a>
              </>
            )}
          </span>

          <span className="sr-only">{fullText}</span>
        </div>

        <button
          type="button"
          aria-label={manualPaused ? t("systemStatus.resumeTicker") : t("systemStatus.pauseTicker")}
          title={manualPaused ? "Resume ticker" : "Pause ticker"}
          onClick={() => setManualPaused((p) => !p)}
          className="shrink-0 opacity-60 hover:opacity-100 transition-opacity motion-reduce:hidden"
        >
          {manualPaused ? <PlayCircle className="h-4 w-4" /> : <PauseCircle className="h-4 w-4" />}
        </button>

        <button
          type="button"
          aria-label={t("systemStatus.dismissNotification")}
          onClick={handleDismiss}
          className="shrink-0 opacity-60 hover:opacity-100 transition-opacity"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
