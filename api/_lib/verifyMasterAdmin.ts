/**
 * Verify a Supabase JWT and confirm the user is a Master Admin.
 * Server-only. Do NOT import into the Vite client bundle.
 *
 * Authorization rules (matches AuthContext canonical rules):
 *   1. profiles.user_id = userId AND profiles.is_master_admin = true
 *   OR
 *   2. master_admin_memberships.user_id = userId AND is_active = true
 *
 * Uses anon key + user bearer token for /auth/v1/user identity check.
 * Uses RLS (auth.uid() from JWT) for DB queries — no service role needed.
 *
 * Required env vars (resolved via supabaseServerConfig):
 *   SUPABASE_URL  (or VITE_SUPABASE_URL)
 *   SUPABASE_ANON_KEY  (or VITE_SUPABASE_ANON_KEY or VITE_SUPABASE_PUBLISHABLE_KEY)
 */

import { resolveSupabaseServerConfig } from "./supabaseServerConfig.js";

export type MasterAdminVerifyResult =
  | { ok: true; userId: string; email: string }
  | {
      ok: false;
      status: 401 | 403 | 500 | 503;
      code:
        | "missing_authorization"
        | "invalid_session"
        | "auth_unavailable"
        | "server_configuration_missing"
        | "master_admin_forbidden"
        | "authorization_failed";
      error: string;
      missingVariables?: string[];
    };

const AUTH_TIMEOUT_MS = 5_000;

export async function verifyMasterAdmin(
  authorizationHeader: string | undefined,
): Promise<MasterAdminVerifyResult> {
  if (!authorizationHeader?.startsWith("Bearer ")) {
    return {
      ok: false,
      status: 401,
      code: "missing_authorization",
      error: "Missing or malformed Authorization header",
    };
  }

  const token = authorizationHeader.slice(7);
  if (!token) {
    return {
      ok: false,
      status: 401,
      code: "missing_authorization",
      error: "Empty bearer token",
    };
  }

  const config = resolveSupabaseServerConfig();
  if (!config.ok) {
    console.error("[verifyMasterAdmin] Supabase server configuration missing:", config.missingVariables);
    return {
      ok: false,
      status: 503,
      code: "server_configuration_missing",
      error: "Server misconfiguration: Supabase credentials not available",
      missingVariables: config.missingVariables,
    };
  }

  const { url: supabaseUrl, anonKey } = config;

  // Headers for identity check — anon key + user's own token
  const identityHeaders = {
    apikey: anonKey,
    Authorization: `Bearer ${token}`,
  };

  // Headers for DB queries — anon key as apikey, user JWT in Authorization
  // Supabase evaluates RLS using auth.uid() from the JWT, no service role needed
  const userScopedHeaders = {
    apikey: anonKey,
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  try {
    // Step 1: Identify the user from their own bearer token
    let userId: string;
    let email: string;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), AUTH_TIMEOUT_MS);
      let userRes: Response;
      try {
        userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
          headers: identityHeaders,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (userRes.status === 401 || userRes.status === 403) {
        return { ok: false, status: 401, code: "invalid_session", error: "Invalid or expired token" };
      }
      if (!userRes.ok) {
        console.error("[verifyMasterAdmin] /auth/v1/user error:", userRes.status);
        return { ok: false, status: 503, code: "auth_unavailable", error: "Auth service error" };
      }

      const userData = (await userRes.json()) as { id?: string; email?: string };
      if (!userData?.id) {
        return { ok: false, status: 401, code: "invalid_session", error: "Could not identify user from token" };
      }
      userId = userData.id;
      email = userData.email ?? "";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("abort") || msg.includes("timed out") || msg.includes("signal")) {
        return { ok: false, status: 503, code: "auth_unavailable", error: "Auth service timeout" };
      }
      return { ok: false, status: 503, code: "auth_unavailable", error: "Auth service unreachable" };
    }

    // Step 2: Check profiles.is_master_admin = true using the user's own JWT
    // RLS policy `auth.uid() = user_id` allows this without service role
    let profileIsMasterAdmin = false;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), AUTH_TIMEOUT_MS);
      let profileRes: Response;
      try {
        profileRes = await fetch(
          `${supabaseUrl}/rest/v1/profiles?user_id=eq.${encodeURIComponent(userId)}&select=is_master_admin&limit=1`,
          { headers: userScopedHeaders, signal: controller.signal },
        );
      } finally {
        clearTimeout(timer);
      }

      if (profileRes.ok) {
        const profiles = (await profileRes.json()) as Array<{ is_master_admin?: boolean }>;
        profileIsMasterAdmin = profiles?.[0]?.is_master_admin === true;
      } else {
        console.warn("[verifyMasterAdmin] profiles lookup failed:", profileRes.status);
      }
    } catch (err) {
      console.warn("[verifyMasterAdmin] profiles lookup error:", err instanceof Error ? err.message : String(err));
    }

    if (profileIsMasterAdmin) {
      return { ok: true, userId, email };
    }

    // Step 3: Check master_admin_memberships.is_active = true using user's own JWT
    let membershipActive = false;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), AUTH_TIMEOUT_MS);
      let memberRes: Response;
      try {
        memberRes = await fetch(
          `${supabaseUrl}/rest/v1/master_admin_memberships?user_id=eq.${encodeURIComponent(userId)}&is_active=eq.true&select=id&limit=1`,
          { headers: userScopedHeaders, signal: controller.signal },
        );
      } finally {
        clearTimeout(timer);
      }

      if (memberRes.ok) {
        const memberships = (await memberRes.json()) as Array<{ id?: string }>;
        membershipActive = Array.isArray(memberships) && memberships.length > 0;
      } else {
        console.warn("[verifyMasterAdmin] master_admin_memberships lookup failed:", memberRes.status);
      }
    } catch (err) {
      console.warn("[verifyMasterAdmin] memberships lookup error:", err instanceof Error ? err.message : String(err));
    }

    if (membershipActive) {
      return { ok: true, userId, email };
    }

    return {
      ok: false,
      status: 403,
      code: "master_admin_forbidden",
      error: "Forbidden: Master Admin access only",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[verifyMasterAdmin] unexpected error:", msg);
    return {
      ok: false,
      status: 500,
      code: "authorization_failed",
      error: "Internal error during authorization",
    };
  }
}
