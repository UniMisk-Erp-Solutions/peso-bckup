/**
 * Cloud Auth for maintenance admins. Entirely separate from local PesoWise
 * auth (src/contexts/AuthContext.tsx, src/lib/authSession.ts) — this module
 * must never import the local Supabase client, and nothing under
 * src/integrations/supabase/ may import this module.
 *
 * There is deliberately no sign-up here: maintenance-admin accounts are
 * created out-of-band by the Cloud project owner (see
 * infra/maintenance-cloud/README.md §6, "public sign-up policy").
 */
import { getMaintenanceSupabase } from "./client";
import type { MaintenanceAdminRow } from "./types";

export type MaintenanceAdminSignInResult =
  | { ok: true; userId: string; email: string | null }
  | { ok: false; code: "not_configured" | "invalid_credentials" | "network_error" | "unknown"; error: string };

export async function signInMaintenanceAdmin(
  email: string,
  password: string,
): Promise<MaintenanceAdminSignInResult> {
  const client = getMaintenanceSupabase();
  if (!client) {
    return { ok: false, code: "not_configured", error: "Maintenance Cloud is not configured." };
  }

  try {
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) {
      return { ok: false, code: "invalid_credentials", error: error.message };
    }
    if (!data.user) {
      return { ok: false, code: "unknown", error: "Sign-in returned no user." };
    }
    return { ok: true, userId: data.user.id, email: data.user.email ?? null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, code: "network_error", error: msg };
  }
}

export async function signOutMaintenanceAdmin(): Promise<void> {
  const client = getMaintenanceSupabase();
  if (!client) return;
  try {
    await client.auth.signOut();
  } catch {
    // best-effort; nothing more to do if the sign-out call itself fails
  }
}

export type MaintenanceAdminAuthorizationResult =
  | { ok: true; admin: MaintenanceAdminRow }
  | { ok: false; code: "not_configured" | "not_signed_in" | "no_admin_row" | "inactive" | "network_error"; error: string };

/**
 * Confirms the CURRENTLY SIGNED-IN Cloud Auth user has an active row in
 * maintenance_admins. Relies on RLS ("self can read own admin row", §8) to
 * enforce that this can only ever return the caller's own row — there is no
 * way to query another user's authorization through this client.
 */
export async function getOwnMaintenanceAdminAuthorization(): Promise<MaintenanceAdminAuthorizationResult> {
  const client = getMaintenanceSupabase();
  if (!client) {
    return { ok: false, code: "not_configured", error: "Maintenance Cloud is not configured." };
  }

  const { data: userData, error: userError } = await client.auth.getUser();
  if (userError || !userData.user) {
    return { ok: false, code: "not_signed_in", error: userError?.message ?? "No active session." };
  }

  try {
    const { data, error } = await client
      .from("maintenance_admins")
      .select("user_id,is_active,can_manage_preview,can_manage_production,can_view_history,created_at,updated_at")
      .eq("user_id", userData.user.id)
      .maybeSingle();

    if (error) {
      return { ok: false, code: "network_error", error: error.message };
    }
    if (!data) {
      return { ok: false, code: "no_admin_row", error: "Not authorized for maintenance control." };
    }
    const admin = data as MaintenanceAdminRow;
    if (!admin.is_active) {
      return { ok: false, code: "inactive", error: "Maintenance admin access has been deactivated." };
    }
    return { ok: true, admin };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, code: "network_error", error: msg };
  }
}
