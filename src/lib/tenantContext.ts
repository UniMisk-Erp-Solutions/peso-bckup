/**
 * Derives tenant subdomain label from the browser hostname vs configured apex domain.
 * Example: ml.pesowise.unimisk.com + base pesowise.unimisk.com → label "ml".
 */

import { getStoredDevTenantSubdomain, isLocalDevHost } from "@/lib/devTenantOverride";

export function getAppBaseDomain(): string {
  const raw = import.meta.env.VITE_APP_BASE_DOMAIN as string | undefined;
  const trimmed = (raw || "").trim().toLowerCase();
  if (!trimmed) return "pesowise.unimisk.com";
  return trimmed.replace(/^www\./, "");
}

export function getDevTenantSubdomainOverride(): string | null {
  const raw = import.meta.env.VITE_DEV_TENANT_SUBDOMAIN as string | undefined;
  const fromEnv = (raw || "").trim().toLowerCase();
  if (fromEnv) return fromEnv;
  if (isLocalDevHost()) return getStoredDevTenantSubdomain();
  return null;
}

export function normalizeHostname(host: string): string {
  return host.split(":")[0].trim().toLowerCase().replace(/^www\./, "");
}

export type TenantLabelResolution = {
  subdomainLabel: string | null;
  isTenantHost: boolean;
};

export function resolveTenantLabelFromHostname(
  hostname: string,
  baseDomain: string,
  devOverride?: string | null,
): TenantLabelResolution {
  if (devOverride) {
    return { subdomainLabel: devOverride, isTenantHost: true };
  }

  const host = normalizeHostname(hostname);
  const base = baseDomain.replace(/^www\./, "");

  if (host === base) {
    return { subdomainLabel: null, isTenantHost: false };
  }

  const suffix = `.${base}`;
  if (host.endsWith(suffix) && host.length > suffix.length) {
    const label = host.slice(0, -suffix.length);
    // single-label tenant only (e.g. ml.pesowise.unimisk.com)
    if (label.length > 0 && !label.includes(".")) {
      return { subdomainLabel: label, isTenantHost: true };
    }
  }

  return { subdomainLabel: null, isTenantHost: false };
}
