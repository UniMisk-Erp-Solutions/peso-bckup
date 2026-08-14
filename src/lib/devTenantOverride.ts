const STORAGE_KEY = "pesowise_dev_tenant_subdomain";

function normalizeLocalHost(host: string): string {
  return host.split(":")[0].trim().toLowerCase().replace(/^www\./, "");
}

export const DEV_TENANT_CHANGED_EVENT = "pesowise:dev-tenant-changed";

/** True when running the Vite dev server on localhost (not production or LAN IP unless env override). */
export function isLocalDevHost(): boolean {
  if (!import.meta.env.DEV) return false;
  if (typeof window === "undefined") return false;
  const host = normalizeLocalHost(window.location.hostname);
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/** Subdomain slug saved in localStorage on localhost (after env var). */
export function getStoredDevTenantSubdomain(): string | null {
  if (!isLocalDevHost()) return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const t = (raw || "").trim().toLowerCase();
    return t || null;
  } catch {
    return null;
  }
}

export function setStoredDevTenantSubdomain(subdomain: string | null): void {
  if (!isLocalDevHost()) return;
  try {
    if (subdomain?.trim()) {
      localStorage.setItem(STORAGE_KEY, subdomain.trim().toLowerCase());
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
    window.dispatchEvent(new CustomEvent(DEV_TENANT_CHANGED_EVENT));
  } catch {
    /* ignore */
  }
}

export type DevTenantOrgOption = {
  id: string;
  name: string;
  slug: string;
  subdomain: string;
};
