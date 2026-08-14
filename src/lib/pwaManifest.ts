/**
 * Shared Web App Manifest builder for apex + tenant hosts.
 */

export type WebManifestInput = {
  name: string;
  shortName: string;
  description?: string;
  startUrl: string;
  scope?: string;
  themeColor?: string;
  backgroundColor?: string;
  iconUrl?: string | null;
  /** Origin for absolute icon URLs (required for reliable Chrome install). */
  origin?: string;
};

/** Standard install icons — must be real 192×192 and 512×512 PNGs (see public/icons/). */
export const PWA_INSTALL_ICONS = {
  icon192: "/icons/icon-192.png",
  icon512: "/icons/icon-512.png",
  maskable512: "/icons/icon-maskable-512.png",
} as const;

export function inferIconMimeType(url: string): string {
  const lower = url.split("?")[0].toLowerCase();
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  return "image/png";
}

export type TenantHostResolution = {
  isTenantHost: boolean;
  subdomainLabel: string | null;
};

export function getManifestBaseDomain(): string {
  const raw =
    (typeof process !== "undefined" && process.env?.VITE_APP_BASE_DOMAIN) ||
    (typeof import.meta !== "undefined" &&
      (import.meta.env?.VITE_APP_BASE_DOMAIN as string | undefined)) ||
    "";
  const trimmed = String(raw || "pesowise.unimisk.com").trim().toLowerCase();
  return trimmed.replace(/^www\./, "");
}

export function resolveTenantFromHost(hostname: string, baseDomain?: string): TenantHostResolution {
  const base = (baseDomain || getManifestBaseDomain()).replace(/^www\./, "");
  const host = hostname.split(":")[0].trim().toLowerCase().replace(/^www\./, "");

  if (host === base) {
    return { isTenantHost: false, subdomainLabel: null };
  }

  const suffix = `.${base}`;
  if (host.endsWith(suffix) && host.length > suffix.length) {
    const label = host.slice(0, -suffix.length);
    if (label.length > 0 && !label.includes(".")) {
      return { isTenantHost: true, subdomainLabel: label };
    }
  }

  return { isTenantHost: false, subdomainLabel: null };
}

export function buildWebManifest(input: WebManifestInput): Record<string, unknown> {
  const origin = input.origin?.replace(/\/$/, "");
  const abs = (path: string) => (origin ? `${origin}${path}` : path);
  const icon192 = abs(PWA_INSTALL_ICONS.icon192);
  const icon512 = abs(PWA_INSTALL_ICONS.icon512);
  const maskable = abs(PWA_INSTALL_ICONS.maskable512);

  return {
    id: input.startUrl === "/" ? "/" : input.startUrl,
    name: input.name,
    short_name: input.shortName,
    description:
      input.description ||
      "Expense management — claims, approvals, and reimbursements.",
    start_url: input.startUrl,
    scope: input.scope ?? "/",
    display: "standalone",
    display_override: ["standalone", "browser"],
    orientation: "any",
    background_color: input.backgroundColor ?? "#ffffff",
    theme_color: input.themeColor ?? "#1e40af",
    categories: ["finance", "business", "productivity"],
    prefer_related_applications: false,
    icons: [
      {
        src: icon192,
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: icon512,
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: maskable,
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}

export function defaultManifestForHost(
  hostname: string,
  org?: { name: string; logo_url?: string | null } | null,
): Record<string, unknown> {
  const { isTenantHost, subdomainLabel } = resolveTenantFromHost(hostname);

  if (isTenantHost && subdomainLabel) {
    const orgName = org?.name?.trim();
    return buildWebManifest({
      name: orgName ? `${orgName} — PesoWise` : `PesoWise — ${subdomainLabel}`,
      shortName: orgName ? orgName.slice(0, 12) : subdomainLabel.slice(0, 12),
      description: orgName
        ? `Sign in to ${orgName} on PesoWise`
        : `Sign in to your organization on PesoWise`,
      startUrl: "/auth",
      iconUrl: org?.logo_url ?? "/HERO.png",
    });
  }

  return buildWebManifest({
    name: "PesoWise",
    shortName: "PesoWise",
    description:
      "PesoWise by Unimisk — expense management, approvals, and reimbursements.",
    startUrl: "/",
    iconUrl: "/HERO.png",
  });
}
