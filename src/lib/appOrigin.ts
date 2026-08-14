/**
 * Canonical same-origin helpers.
 *
 * Application-internal navigation (auth, logout, session recovery, PWA start,
 * post-login) must NEVER hardcode the apex domain. A user who starts on
 * https://ml.pesowise.unimisk.com must stay on that origin; jumping to the apex
 * loses the tenant context, which turns off employee-ID login.
 *
 * The apex may only be used for an explicit, intentional cross-tenant handoff
 * (see src/lib/tenantRedirect.ts) — never as a fallback for a failed lookup.
 */

import {
  getAppBaseDomain,
  getDevTenantSubdomainOverride,
  resolveTenantLabelFromHostname,
} from "@/lib/tenantContext";

/** Current browser origin (protocol + hostname + port), or "" outside the browser. */
export function getCurrentAppOrigin(): string {
  if (typeof window === "undefined") return "";
  return window.location.origin;
}

/** True when the current browser host resolves to a tenant subdomain. */
export function isRunningOnTenantOrigin(): boolean {
  if (typeof window === "undefined") return false;
  const { isTenantHost } = resolveTenantLabelFromHostname(
    window.location.hostname,
    getAppBaseDomain(),
    getDevTenantSubdomainOverride(),
  );
  return isTenantHost;
}

/**
 * Current origin when it is a tenant origin, otherwise null.
 * Callers use this to assert "we are on a tenant and must stay here".
 */
export function getCurrentTenantOrigin(): string | null {
  if (!isRunningOnTenantOrigin()) return null;
  return getCurrentAppOrigin();
}

/**
 * Normalizes an app-internal path and resolves it against the CURRENT origin.
 *
 * Absolute URLs, protocol-relative URLs ("//evil.com") and anything that would
 * escape the current origin are rejected and collapsed to a same-origin path —
 * this function must never be a redirect gadget for user-supplied input.
 */
export function buildSameOriginPath(path: string): string {
  const raw = String(path ?? "").trim();
  const safePath = normalizeInternalPath(raw);
  const origin = getCurrentAppOrigin();
  if (!origin) return safePath;
  return new URL(safePath, origin).toString();
}

/**
 * Returns a leading-slash, same-origin-only path. Exported for tests and for
 * callers that want a router path rather than a full URL.
 */
export function normalizeInternalPath(path: string): string {
  const raw = String(path ?? "").trim();
  if (!raw) return "/";

  // Reject anything with a scheme ("https://…", "javascript:…") or a
  // protocol-relative prefix ("//host") — both can leave the current origin.
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return "/";
  if (raw.startsWith("//")) return "/";

  const withSlash = raw.startsWith("/") ? raw : `/${raw}`;

  // Resolve "." / ".." segments against a throwaway base so the result can
  // never climb above the origin root.
  try {
    const resolved = new URL(withSlash, "https://internal.invalid");
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return "/";
  }
}
