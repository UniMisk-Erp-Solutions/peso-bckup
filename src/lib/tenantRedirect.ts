import { supabase } from "@/integrations/supabase/client";
import { buildSameOriginPath } from "@/lib/appOrigin";
import {
  getAppBaseDomain,
  getDevTenantSubdomainOverride,
  resolveTenantLabelFromHostname,
} from "@/lib/tenantContext";

/** Thrown when navigating away to the user's correct sign-in host. */
export class TenantRedirectingError extends Error {
  constructor() {
    super("Redirecting to your organization sign-in");
    this.name = "TenantRedirectingError";
  }
}

export function getCurrentTenantSubdomainLabel(): string | null {
  if (typeof window === "undefined") return null;
  const { subdomainLabel } = resolveTenantLabelFromHostname(
    window.location.hostname,
    getAppBaseDomain(),
    getDevTenantSubdomainOverride(),
  );
  return subdomainLabel;
}

/** Builds https://{subdomain}.base/auth or https://base/auth when subdomain is null. */
export function buildTenantAuthUrl(subdomain: string | null): string {
  const base = getAppBaseDomain();
  const protocol =
    typeof window !== "undefined" && window.location.protocol === "http:" ? "http:" : "https:";
  const host = subdomain?.trim() ? `${subdomain.trim().toLowerCase()}.${base}` : base;
  return `${protocol}//${host}/auth`;
}

export async function lookupTenantSignInSubdomainForEmail(email: string): Promise<string | null> {
  const { data, error } = await supabase.rpc("get_tenant_sign_in_subdomain_for_email", {
    p_email: email.trim(),
  });
  if (error) {
    console.error("get_tenant_sign_in_subdomain_for_email:", error);
    return null;
  }
  const value = typeof data === "string" ? data.trim() : "";
  return value || null;
}

export async function lookupTenantSignInSubdomainForUser(userId: string): Promise<string | null> {
  const { data, error } = await supabase.rpc("get_tenant_sign_in_subdomain_for_user", {
    p_user_id: userId,
  });
  if (error) {
    console.error("get_tenant_sign_in_subdomain_for_user:", error);
    return null;
  }
  const value = typeof data === "string" ? data.trim() : "";
  return value || null;
}

export type TenantSignInDestination =
  | { kind: "stay" }
  | { kind: "redirect"; url: string };

/**
 * Resolves where the user's tenant /auth is — WITHOUT navigating. Call this
 * while the caller is still authenticated: `get_tenant_sign_in_subdomain_for_*`
 * are RLS-scoped RPCs that return Unauthorized once signed out. Splitting
 * resolution from navigation lets a signout-then-redirect flow resolve first,
 * sign out, then navigate using the already-resolved destination — no
 * authenticated RPC call is ever made after signOut().
 *
 * Origin policy (deliberate, see DOC-075):
 *   - resolved tenant differs from current host → cross-origin handoff to that tenant.
 *   - resolved tenant equals the current host   → stay here, show the message.
 *   - tenant could NOT be resolved (RPC error,
 *     signed-out RLS, unknown email)            → stay here, show the message.
 *
 * The apex is never used as a fallback. Previously an unresolved lookup produced
 * buildTenantAuthUrl(null) === "https://<apex>/auth", which silently threw tenant
 * users onto the apex origin where employee-ID login does not exist.
 */
export async function resolveUserTenantSignInDestination(params: {
  email?: string;
  userId?: string;
}): Promise<TenantSignInDestination> {
  const current = getCurrentTenantSubdomainLabel()?.toLowerCase() ?? null;

  let subdomain: string | null = null;
  if (params.email) {
    subdomain = await lookupTenantSignInSubdomainForEmail(params.email);
  } else if (params.userId) {
    subdomain = await lookupTenantSignInSubdomainForUser(params.userId);
  }

  const target = subdomain?.trim().toLowerCase() || null;

  // Unresolved, or already the right host → keep the user on this origin.
  if (!target || target === current) {
    return { kind: "stay" };
  }

  const url = `${buildTenantAuthUrl(target)}?from_wrong_tenant=1`;

  if (typeof window !== "undefined") {
    const currentAuthPrefix = `${window.location.protocol}//${window.location.host}/auth`;
    if (url.startsWith(currentAuthPrefix) || window.location.href === url) {
      return { kind: "stay" };
    }
  }

  return { kind: "redirect", url };
}

/** Performs the navigation for an already-resolved destination. Never returns. */
export function navigateToTenantSignInDestination(destination: TenantSignInDestination): never {
  if (destination.kind === "redirect" && typeof window !== "undefined") {
    window.location.replace(destination.url);
  } else {
    stayOnSameOriginAuth();
  }
  throw new TenantRedirectingError();
}

/**
 * Sends the browser to the user's own tenant /auth — but ONLY when that tenant is
 * positively resolved and is a different host than the one we are on.
 *
 * Never returns (always throws TenantRedirectingError); the caller shows the
 * wrong-organization message from the ?from_wrong_tenant=1 marker.
 */
export async function redirectToUserTenantSignIn(params: {
  email?: string;
  userId?: string;
}): Promise<never> {
  const destination = await resolveUserTenantSignInDestination(params);
  return navigateToTenantSignInDestination(destination);
}

/** Same-origin /auth navigation — preserves protocol, hostname and port. */
function stayOnSameOriginAuth(): void {
  if (typeof window === "undefined") return;
  const target = buildSameOriginPath("/auth?from_wrong_tenant=1");
  if (window.location.href === target) return;
  window.location.replace(target);
}
