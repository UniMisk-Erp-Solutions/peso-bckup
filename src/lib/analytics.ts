/**
 * Google Analytics 4 (optional) — page views on SPA route changes.
 *
 * Setup:
 * 1. Create a GA4 property and copy the Measurement ID (format G-XXXXXXXXXX).
 * 2. Set VITE_GA_MEASUREMENT_ID in your environment (e.g. Vercel env vars).
 *    Do not commit real IDs to the repo.
 *
 * Google Tag Manager:
 * - For GTM, you can remove the GA4 block below and inject GTM’s snippet in index.html,
 *   or load GTM via a second script tag after consent. Cookie banner integration is
 *   project-specific; this module only loads gtag when the user has set VITE_GA_MEASUREMENT_ID.
 */

declare global {
  interface Window {
    dataLayer: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

const GA_ID = import.meta.env.VITE_GA_MEASUREMENT_ID as string | undefined;

let gaInitialized = false;

export function isAnalyticsEnabled(): boolean {
  return Boolean(GA_ID && GA_ID.startsWith("G-"));
}

/**
 * Injects gtag.js once. Safe to call multiple times.
 * Respects “no ID” in dev: no network calls.
 */
export function initGoogleAnalytics(): void {
  if (!isAnalyticsEnabled() || typeof document === "undefined" || gaInitialized) {
    return;
  }
  gaInitialized = true;

  window.dataLayer = window.dataLayer || [];
  window.gtag = function gtag(...args: unknown[]) {
    window.dataLayer.push(args);
  };
  window.gtag("js", new Date());
  window.gtag("config", GA_ID!, {
    send_page_view: false,
    anonymize_ip: true,
  });

  const s = document.createElement("script");
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(GA_ID!)}`;
  document.head.appendChild(s);
}

/** Fire virtual page_view on React Router navigations */
export function trackPageView(pathWithSearch: string, title?: string): void {
  if (!isAnalyticsEnabled() || !window.gtag) return;
  window.gtag("event", "page_view", {
    page_path: pathWithSearch,
    page_title: title || document.title,
    send_to: GA_ID,
  });
}
