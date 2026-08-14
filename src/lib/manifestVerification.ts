/**
 * Verifies that the manifest this origin is serving actually describes THIS host
 * before we offer to install it.
 *
 * Why: /site.webmanifest exists on the apex and on every tenant host. If an
 * apex-branded manifest is ever served on ml.pesowise.unimisk.com (stale CDN entry,
 * stale service-worker copy, a proxy that drops the tenant host), the install would
 * be named "PesoWise" and start at "/" instead of the tenant sign-in. Installing in
 * that state produces exactly the wrong-origin app we are fixing, so we refuse and
 * report a diagnostic instead.
 */

import { getCurrentAppOrigin } from "@/lib/appOrigin";
import {
  getAppBaseDomain,
  getDevTenantSubdomainOverride,
  resolveTenantLabelFromHostname,
} from "@/lib/tenantContext";

export const MANIFEST_TENANT_HEADER = "x-pesowise-manifest-tenant";
export const MANIFEST_URL_PATH = "/site.webmanifest";

export type ManifestVerdict =
  | { ok: true; marker: string; expectedMarker: string }
  | {
      ok: false;
      marker: string | null;
      expectedMarker: string;
      reason: "tenant_mismatch" | "cross_origin_start_url" | "cross_origin_scope" | "fetch_failed";
    };

/** Marker the manifest should report for a hostname: the subdomain label, or "apex". */
export function expectedManifestMarker(hostname: string, baseDomain?: string): string {
  const { isTenantHost, subdomainLabel } = resolveTenantLabelFromHostname(
    hostname,
    baseDomain ?? getAppBaseDomain(),
    getDevTenantSubdomainOverride(),
  );
  return isTenantHost && subdomainLabel ? subdomainLabel : "apex";
}

/** True when a manifest URL field resolves inside the given origin. */
export function isSameOriginManifestUrl(value: unknown, origin: string): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  if (!origin) return false;
  try {
    return new URL(value, origin).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

/** Pure verdict logic — exported so the rules are testable without a network. */
export function evaluateManifest(input: {
  marker: string | null;
  expectedMarker: string;
  startUrl: unknown;
  scope: unknown;
  origin: string;
}): ManifestVerdict {
  const marker = input.marker?.trim().toLowerCase() ?? null;
  const expected = input.expectedMarker.trim().toLowerCase();

  if (!marker || marker !== expected) {
    return { ok: false, marker, expectedMarker: expected, reason: "tenant_mismatch" };
  }
  if (!isSameOriginManifestUrl(input.startUrl, input.origin)) {
    return { ok: false, marker, expectedMarker: expected, reason: "cross_origin_start_url" };
  }
  if (!isSameOriginManifestUrl(input.scope, input.origin)) {
    return { ok: false, marker, expectedMarker: expected, reason: "cross_origin_scope" };
  }
  return { ok: true, marker, expectedMarker: expected };
}

/**
 * Fetches the live manifest for the current origin with caching disabled and
 * checks it against this host. Never throws.
 */
export async function verifyManifestForCurrentHost(): Promise<ManifestVerdict> {
  const origin = getCurrentAppOrigin();
  const expectedMarker = expectedManifestMarker(
    typeof window !== "undefined" ? window.location.hostname : "",
  );

  try {
    const url = new URL(MANIFEST_URL_PATH, origin).toString();
    const response = await fetch(url, { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) {
      return { ok: false, marker: null, expectedMarker, reason: "fetch_failed" };
    }
    const marker = response.headers.get(MANIFEST_TENANT_HEADER);
    const body = (await response.json()) as { start_url?: unknown; scope?: unknown };
    return evaluateManifest({
      marker,
      expectedMarker,
      startUrl: body?.start_url,
      scope: body?.scope,
      origin,
    });
  } catch {
    return { ok: false, marker: null, expectedMarker, reason: "fetch_failed" };
  }
}

/**
 * Re-points the manifest <link> at this origin's manifest with a cache-busting
 * query so the browser re-reads it. Same-origin only; does not delete any PWA data.
 */
export function refreshManifestLink(): void {
  if (typeof document === "undefined") return;
  const link = document.getElementById("pesowise-manifest-link") as HTMLLinkElement | null;
  if (!link) return;
  const origin = getCurrentAppOrigin();
  if (!origin) return;
  const url = new URL(MANIFEST_URL_PATH, origin);
  url.searchParams.set("r", String(Date.now()));
  link.href = url.toString();
}
