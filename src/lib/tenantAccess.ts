import { supabase } from "@/integrations/supabase/client";
import {
  navigateToTenantSignInDestination,
  redirectToUserTenantSignIn,
  resolveUserTenantSignInDestination,
  TenantRedirectingError,
} from "@/lib/tenantRedirect";

export { TenantRedirectingError };

export type TenantAccessResult = {
  allowed: boolean;
  reason?: string;
};

export function checkTenantHostAccess(params: {
  tenantHostOrgId: string | null;
  userOrganizationIds: string[];
  isMasterAdmin: boolean;
}): TenantAccessResult {
  if (!params.tenantHostOrgId) {
    return {
      allowed: false,
      reason: "This subdomain is not configured. Contact your administrator.",
    };
  }

  if (params.isMasterAdmin) {
    return { allowed: true };
  }

  if (params.userOrganizationIds.includes(params.tenantHostOrgId)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason:
      "This account is not registered for this organization. Use your organization's own sign-in link.",
  };
}

async function resolveTenantOrgId(
  tenantHostOrgId: string | null,
  tenantSubdomainLabel: string | null,
): Promise<string | null> {
  if (tenantHostOrgId) return tenantHostOrgId;
  if (!tenantSubdomainLabel?.trim()) return null;

  const { data, error } = await supabase.rpc("get_organization_by_subdomain", {
    p_subdomain: tenantSubdomainLabel.trim(),
  });

  if (error || !data?.length) return null;
  return (data[0] as { id: string }).id;
}

/** Loads org membership / master-admin status and validates tenant subdomain access. */
export async function verifyTenantSessionForUser(
  userId: string,
  tenantHostOrgId: string | null,
  isTenantHost: boolean,
  tenantSubdomainLabel?: string | null,
): Promise<TenantAccessResult> {
  if (!isTenantHost) {
    return { allowed: true };
  }

  const resolvedOrgId = await resolveTenantOrgId(tenantHostOrgId, tenantSubdomainLabel ?? null);
  if (!resolvedOrgId) {
    return {
      allowed: false,
      reason: "This subdomain is not configured. Contact your administrator.",
    };
  }

  const { data: profile, error: profileErr } = await (supabase as any)
    .from("profiles")
    .select("is_master_admin, organization_id")
    .eq("user_id", userId)
    .maybeSingle() as {
    data: { is_master_admin?: boolean; organization_id?: string | null } | null;
    error: Error | null;
  };

  if (profileErr) {
    console.error("tenantAccess profile:", profileErr);
    return { allowed: false, reason: "Could not verify your account. Try again." };
  }

  if (profile?.is_master_admin === true) {
    return { allowed: true };
  }

  const { data: masterMembership } = await (supabase as any)
    .from("master_admin_memberships")
    .select("id")
    .eq("user_id", userId)
    .eq("is_active", true)
    .maybeSingle() as { data: { id?: string } | null };

  if (masterMembership?.id) {
    return { allowed: true };
  }

  const { data: memberships, error: membershipErr } = await (supabase as any)
    .from("organization_memberships")
    .select("organization_id")
    .eq("user_id", userId)
    .eq("is_active", true) as {
    data: { organization_id: string }[] | null;
    error: Error | null;
  };

  if (membershipErr) {
    console.error("tenantAccess membership:", membershipErr);
    return { allowed: false, reason: "Could not verify your organization. Try again." };
  }

  const orgIds = new Set<string>();
  for (const row of memberships || []) {
    if (row.organization_id) orgIds.add(row.organization_id);
  }
  if (profile?.organization_id) {
    orgIds.add(profile.organization_id);
  }

  return checkTenantHostAccess({
    tenantHostOrgId: resolvedOrgId,
    userOrganizationIds: [...orgIds],
    isMasterAdmin: false,
  });
}

/** Before password sign-in on a tenant host: ensure email belongs to this org. */
export async function assertEmailAllowedOnTenant(
  email: string,
  tenantHostOrgId: string | null,
  tenantSubdomainLabel: string | null,
): Promise<TenantAccessResult> {
  const resolvedOrgId = await resolveTenantOrgId(tenantHostOrgId, tenantSubdomainLabel);
  if (!resolvedOrgId) {
    return {
      allowed: false,
      reason: "This subdomain is not configured. Contact your administrator.",
    };
  }

  const { data, error } = await supabase.rpc("email_can_sign_in_on_tenant", {
    p_email: email.trim(),
    p_organization_id: resolvedOrgId,
  });

  if (error) {
    console.error("email_can_sign_in_on_tenant:", error);
    return {
      allowed: false,
      reason:
        "Organization sign-in check is not available. Apply migration 20260516130000_tenant_email_sign_in_check.sql.",
    };
  }

  if (!data) {
    await redirectToUserTenantSignIn({ email });
    return {
      allowed: false,
      reason: "Redirecting to your organization sign-in…",
    };
  }

  return { allowed: true };
}

/**
 * Sign out and redirect when session is on the wrong tenant host.
 *
 * The destination is resolved WHILE STILL AUTHENTICATED — the resolving
 * RPCs (get_tenant_sign_in_subdomain_for_user/_email) are RLS-scoped and
 * return Unauthorized once signed out, which used to silently strand the
 * user on this tenant's own /auth instead of redirecting them to their real
 * one. signOut() only runs after the destination is already known, and no
 * authenticated call is made afterward.
 */
export async function rejectWrongTenantSession(params: {
  email?: string;
  userId?: string;
  signOut: () => Promise<void>;
}): Promise<never> {
  const destination = await resolveUserTenantSignInDestination({
    email: params.email,
    userId: params.userId,
  });
  await params.signOut();
  return navigateToTenantSignInDestination(destination);
}

export function looksLikeEmailIdentifier(value: string): boolean {
  return value.trim().includes("@");
}
