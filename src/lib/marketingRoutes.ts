/**
 * The public marketing surface — the ONLY pages analytics may observe.
 *
 * Kept as an explicit allow-list rather than a "not an app route" heuristic. A denylist
 * fails open: every future authenticated route would be tracked until someone remembered
 * to exclude it. This fails closed, so a new page is invisible to analytics until it is
 * deliberately added here.
 *
 * These mirror the marketing group in `App.tsx` exactly (the routes nested under
 * `TenantHostRedirect`). `/auth` is deliberately absent — it is the sign-in surface, not
 * marketing.
 */
export const MARKETING_ROUTES = [
  "/",
  "/features",
  "/how-it-works",
  "/security",
  "/pricing",
  "/contact",
  "/privacy",
  "/cookies",
  "/toc",
  "/disclaimer",
  "/legal/data-processing",
  "/legal/activity-insights",
  "/legal/data-rights",
] as const;

/**
 * Exact match only, with a trailing slash tolerated.
 *
 * Prefix matching would be wrong here: `/` is a marketing route, and any prefix rule
 * anchored on it would match every authenticated page in the application.
 *
 * The 404 route (`*`) is excluded on purpose. A mistyped URL is as likely to be a fumbled
 * app link — `/dashbord`, a stale bookmark to `/expenses/<id>` — as a marketing visitor,
 * and a path that was never meant to be public should not become an analytics record.
 */
export function isMarketingPath(pathname: string): boolean {
  if (typeof pathname !== "string" || !pathname) return false;
  const normalized =
    pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return (MARKETING_ROUTES as readonly string[]).includes(normalized);
}
