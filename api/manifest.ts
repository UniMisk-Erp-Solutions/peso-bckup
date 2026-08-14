/**
 * Dynamic Web App Manifest — tenant subdomains get org name/logo; apex uses PesoWise branding.
 * Served at /api/manifest (rewrite from /site.webmanifest in vercel.json).
 *
 * Origin rules (see DOC-075):
 *  - every URL in the response is same-origin with the requesting host;
 *  - `start_url` is a relative path, never an absolute apex URL;
 *  - `id` carries the tenant label so an ML install can never share PWA identity
 *    with the apex install;
 *  - the response is not shared between hosts (no-store + Vary), because a cached
 *    apex manifest served on a tenant host would brand the install "PesoWise" and
 *    start it at "/" instead of the tenant sign-in.
 */

type VercelReq = { method?: string; headers: Record<string, string | string[] | undefined> };
type VercelRes = {
  setHeader: (k: string, v: string) => void;
  status: (n: number) => { json: (body: unknown) => void; end: () => void };
};

function getHeader(req: VercelReq, name: string): string {
  const v = req.headers[name.toLowerCase()] ?? req.headers[name];
  if (Array.isArray(v)) return v[0] ?? "";
  return String(v ?? "");
}

export function getManifestBaseDomain(): string {
  return (
    process.env.VITE_APP_BASE_DOMAIN ||
    process.env.APP_BASE_DOMAIN ||
    "pesowise.unimisk.com"
  )
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");
}

/**
 * Normalizes a Host / X-Forwarded-Host value to a bare hostname.
 * A forwarded-host header can legitimately be a comma-separated proxy chain; the
 * FIRST entry is the client-facing host. Port, case and a leading "www." are
 * stripped so host comparison is exact.
 */
export function normalizeHostHeader(raw: string): string {
  const first = String(raw ?? "").split(",")[0] ?? "";
  const host = first.trim().toLowerCase();
  if (!host) return "";
  // Strip port. IPv6 literals ("[::1]:3000") keep their bracketed form.
  const withoutPort = host.startsWith("[")
    ? host.slice(0, host.indexOf("]") + 1)
    : host.split(":")[0];
  return withoutPort.replace(/^www\./, "");
}

/**
 * Resolves the effective client-facing host.
 * On Vercel, `x-forwarded-host` is set by the platform edge and reflects the
 * domain the user actually requested, so it wins over `host`.
 */
export function resolveEffectiveHost(req: VercelReq): string {
  return (
    normalizeHostHeader(getHeader(req, "x-forwarded-host")) ||
    normalizeHostHeader(getHeader(req, "host"))
  );
}

export function resolveTenantFromHost(hostname: string): {
  isTenantHost: boolean;
  subdomainLabel: string | null;
} {
  const base = getManifestBaseDomain();
  const host = normalizeHostHeader(hostname);
  if (!host || host === base) return { isTenantHost: false, subdomainLabel: null };
  const suffix = `.${base}`;
  if (host.endsWith(suffix) && host.length > suffix.length) {
    const label = host.slice(0, -suffix.length);
    if (label.length > 0 && !label.includes(".")) {
      return { isTenantHost: true, subdomainLabel: label };
    }
  }
  return { isTenantHost: false, subdomainLabel: null };
}

export function buildWebManifest(input: {
  id: string;
  name: string;
  shortName: string;
  description?: string;
  startUrl: string;
  origin?: string;
}): Record<string, unknown> {
  const origin = input.origin?.replace(/\/$/, "");
  // Icons are absolute against the REQUESTING origin (Chrome install reliability)
  // or relative when the origin is unknown — either way, same-origin.
  const abs = (path: string) => (origin ? `${origin}${path}` : path);

  return {
    id: input.id,
    name: input.name,
    short_name: input.shortName,
    description:
      input.description ||
      "Expense management — claims, approvals, and reimbursements.",
    start_url: input.startUrl,
    scope: "/",
    display: "standalone",
    display_override: ["standalone", "browser"],
    orientation: "any",
    background_color: "#ffffff",
    theme_color: "#1e40af",
    categories: ["finance", "business", "productivity"],
    prefer_related_applications: false,
    icons: [
      { src: abs("/icons/icon-192.png"), sizes: "192x192", type: "image/png", purpose: "any" },
      { src: abs("/icons/icon-512.png"), sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: abs("/icons/icon-maskable-512.png"),
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}

/** Pure manifest body builder — exported so the origin rules are directly testable. */
export function buildManifestForHost(
  hostname: string,
  origin: string,
  org?: { name: string } | null,
): Record<string, unknown> {
  const { isTenantHost, subdomainLabel } = resolveTenantFromHost(hostname);

  if (isTenantHost && subdomainLabel) {
    const orgName = org?.name?.trim();
    return buildWebManifest({
      // Stable, tenant-specific, same-origin identity. Distinct from the apex "/"
      // so the two installs can never be treated as the same app.
      id: `/?tenant=${subdomainLabel}`,
      name: orgName ? `${orgName} — PesoWise` : `PesoWise — ${subdomainLabel}`,
      shortName: orgName ? orgName.slice(0, 12) : subdomainLabel.slice(0, 12),
      description: orgName
        ? `Sign in to ${orgName} on PesoWise`
        : `Sign in to your organization on PesoWise`,
      startUrl: `/auth?source=pwa&tenant=${subdomainLabel}`,
      origin,
    });
  }

  return buildWebManifest({
    id: "/",
    name: "PesoWise",
    shortName: "PesoWise",
    description:
      "PesoWise by Unimisk — expense management, approvals, and reimbursements.",
    startUrl: "/",
    origin,
  });
}

/** Marker returned in X-PesoWise-Manifest-Tenant — public subdomain label or "apex". */
export function manifestTenantMarker(hostname: string): string {
  const { isTenantHost, subdomainLabel } = resolveTenantFromHost(hostname);
  return isTenantHost && subdomainLabel ? subdomainLabel : "apex";
}

async function fetchOrgBySubdomain(
  subdomain: string,
): Promise<{ name: string; logo_url: string | null } | null> {
  const supabaseUrl = (
    process.env.VITE_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    ""
  ).replace(/\/$/, "");
  const supabaseKey =
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    "";

  if (!supabaseUrl || !supabaseKey) return null;

  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/get_organization_by_subdomain`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
      },
      body: JSON.stringify({ p_subdomain: subdomain }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.name) return null;
    return { name: String(row.name), logo_url: row.logo_url ?? null };
  } catch {
    return null;
  }
}

export default async function handler(req: VercelReq, res: VercelRes) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    return res.status(200).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const host = resolveEffectiveHost(req);
  const proto = getHeader(req, "x-forwarded-proto").split(",")[0].trim() || "https";
  const origin = host ? `${proto}://${host}` : "";
  const { isTenantHost, subdomainLabel } = resolveTenantFromHost(host);

  const org =
    isTenantHost && subdomainLabel ? await fetchOrgBySubdomain(subdomainLabel) : null;
  const manifest = buildManifestForHost(host, origin, org);

  res.setHeader("Content-Type", "application/manifest+json; charset=utf-8");
  // Host-scoped response: never let one host's manifest be reused for another.
  // Revisit only once host-aware CDN cache isolation is proven end to end.
  res.setHeader("Cache-Control", "private, no-cache, no-store, must-revalidate");
  res.setHeader("Vary", "Host, X-Forwarded-Host");
  // Debug-safe marker — the install flow compares this against the current hostname.
  // Contains only the public subdomain label, never organization secrets.
  res.setHeader("X-PesoWise-Manifest-Tenant", manifestTenantMarker(host));
  res.setHeader("Access-Control-Allow-Origin", "*");
  return res.status(200).json(manifest);
}
