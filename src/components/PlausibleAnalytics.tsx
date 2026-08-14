import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { isMarketingPath } from "@/lib/marketingRoutes";

/**
 * Plausible analytics, scoped to the public marketing pages only.
 *
 * WHY THIS IS NOT IN `index.html`
 * The documented install is a `<script>` in `<head>`, which would load on every route —
 * including `/auth` and every authenticated page. Signed-in activity is not marketing
 * analytics, so the tag is injected lazily and only once a marketing route is actually
 * being viewed.
 *
 * WHY AUTO-CAPTURE IS TURNED OFF
 * Lazy injection alone is NOT sufficient. Plausible's current script auto-captures
 * pageviews and follows SPA history changes, so a visitor who reads `/pricing` and then
 * signs in would have `/dashboard`, `/review` and every later route reported — the script
 * stays in the document once loaded. `autoCapturePageviews: false` makes the allow-list
 * below the single decision point: nothing is ever sent that this file did not send.
 *
 * The script is loaded at most once per document and never removed; removing it would not
 * help, because what matters is whether a pageview is dispatched, not whether the tag is
 * present.
 */

/** Self-hosted Plausible. A public analytics endpoint, not a secret. */
const PLAUSIBLE_SRC = "https://open-analytics.unimisk.com/js/pa-TLkWZldjgKc3mC178SJ73.js";

type PlausibleFn = ((...args: unknown[]) => void) & {
  q?: unknown[];
  init?: (config?: Record<string, unknown>) => void;
  o?: Record<string, unknown>;
};

declare global {
  interface Window {
    plausible?: PlausibleFn;
  }
}

/**
 * Install the queue stub and the tag. Mirrors the vendor snippet, with auto-capture
 * disabled, so calls made before the script finishes downloading are queued rather than
 * lost.
 */
function loadPlausible(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (document.querySelector(`script[src="${PLAUSIBLE_SRC}"]`)) return;

  const queued: PlausibleFn = function (...args: unknown[]) {
    (queued.q = queued.q || []).push(args);
  } as PlausibleFn;
  queued.init = function (config?: Record<string, unknown>) {
    queued.o = config || {};
  };
  window.plausible = window.plausible || queued;

  const script = document.createElement("script");
  script.async = true;
  script.src = PLAUSIBLE_SRC;
  document.head.appendChild(script);

  // The allow-list in this file is the only thing that may report a pageview.
  window.plausible.init?.({ autoCapturePageviews: false });
}

/**
 * Mount once inside the router. Renders nothing.
 *
 * Sits at application level rather than inside the marketing route group so a single
 * allow-list governs every navigation, including moving from a marketing page into the
 * app — which must stop reporting, not continue.
 */
export function PlausibleAnalytics() {
  const location = useLocation();
  /** Guards React 18 StrictMode's double effect from double-counting a pageview. */
  const lastReported = useRef<string | null>(null);

  useEffect(() => {
    if (!isMarketingPath(location.pathname)) return;

    loadPlausible();

    // Deliberately excludes location.search: query strings on marketing pages carry
    // campaign and referral parameters, and sending them verbatim would put arbitrary
    // caller-supplied values into analytics.
    const path = location.pathname;
    if (lastReported.current === path) return;
    lastReported.current = path;

    window.plausible?.("pageview");
  }, [location.pathname]);

  return null;
}
