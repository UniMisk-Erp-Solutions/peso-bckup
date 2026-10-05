// @ts-nocheck
/**
 * Deactivate/reactivate a user AND suspend/restore their Supabase Auth
 * account in one call -- this is the piece the existing
 * deactivate_organization_member (DB-only, confirmed by audit to never
 * touch auth.users) was missing: a deactivated user's OLD JWT can remain
 * valid until it naturally expires, so banning the Auth account is
 * necessary defence-in-depth alongside the backend `is_active` checks
 * (task item 35 -- this Edge Function is the "immediate" half; the DB-side
 * checks are the "even if the JWT is still technically valid" half).
 *
 * NOT EXECUTED OR DEPLOYED IN THIS SESSION -- written as a direct
 * structural mirror of admin-update-user-email/index.ts (this repo's own
 * established shape for a privileged, service-role-backed admin action:
 * verify caller is an active org admin of the SAME org as the target, then
 * make exactly one auth.admin.* call). `ban_duration` is a real
 * @supabase/supabase-js v2 GoTrueAdminApi option (`UserAttributes.ban_duration`,
 * a duration string like "876000h" to ban, or "none" to unban) -- this is
 * not a guessed method signature.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ~100 years -- effectively permanent until explicitly reactivated (there
// is no "ban forever" sentinel in the GoTrue API; a very long duration is
// its own documented convention for that).
const BAN_DURATION = "876000h";
const UNBAN = "none";

type Body = {
  organization_id?: string;
  target_user_id?: string;
  // retry_auth_sync (FINAL ZERO-GAP PASS): DB-side deactivate/reactivate
  // already succeeded on a prior call, but the Auth ban/unban call failed
  // -- retries ONLY the Auth call, deriving ban-vs-unban from the
  // CURRENT, authoritative organization_memberships.is_active state,
  // rather than re-running the whole deactivate/reactivate RPC (which
  // could error on an already-deactivated/-reactivated target, or apply
  // last-active-admin/self checks a second time unnecessarily).
  action?: "deactivate" | "reactivate" | "retry_auth_sync";
  reason?: string;
};
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ success: false, error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return jsonResponse({ success: false, error: "Server misconfiguration" }, 500);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonResponse({ success: false, error: "Missing authorization token" }, 401);
  }

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ success: false, error: "Invalid request body" }, 400);
  }
  const { organization_id, target_user_id, action, reason } = body;
  if (!organization_id || !target_user_id || (action !== "deactivate" && action !== "reactivate" && action !== "retry_auth_sync")) {
    return jsonResponse({ success: false, error: "organization_id, target_user_id, and action (deactivate|reactivate|retry_auth_sync) are required" }, 400);
  }
  if (!UUID_REGEX.test(organization_id) || !UUID_REGEX.test(target_user_id)) {
    return jsonResponse({ success: false, error: "Invalid id" }, 400);
  }

  // Caller-scoped client: the DB RPC's own auth.uid()-based authorization
  // (already-proven admin/last-admin/self checks) runs as the REAL caller,
  // never trusted from the request body.
  const callerClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
  const { data: userData, error: userError } = await callerClient.auth.getUser();
  if (userError || !userData?.user) {
    return jsonResponse({ success: false, error: "Not authenticated" }, 401);
  }

  const serviceClient = createClient(supabaseUrl, serviceRoleKey);
  let desiredBan: string;

  if (action === "retry_auth_sync") {
    // Skips the DB RPC entirely (it already succeeded on a prior call) --
    // but still requires the caller to be a currently-active admin of
    // this SAME organization, exactly like the DB RPCs' own authorization
    // (never trust the request body alone for a privileged Auth action).
    const { data: isAdmin, error: adminCheckError } = await callerClient.rpc("is_org_admin", { p_org_id: organization_id });
    if (adminCheckError || !isAdmin) {
      return jsonResponse({ success: false, error: "Only an active organization admin may retry this" }, 403);
    }
    const { data: isActive, error: stateError } = await serviceClient.rpc("get_member_active_state_v1", {
      p_organization_id: organization_id,
      p_user_id: target_user_id,
    });
    if (stateError || isActive === null || isActive === undefined) {
      return jsonResponse({ success: false, error: "Could not determine the member's current status" }, 400);
    }
    desiredBan = isActive ? UNBAN : BAN_DURATION;
  } else {
    try {
      if (action === "deactivate") {
        const { error: rpcError } = await callerClient.rpc("deactivate_organization_member_v2", {
          p_organization_id: organization_id,
          p_user_id: target_user_id,
          p_reason: reason ?? null,
        });
        if (rpcError) return jsonResponse({ success: false, error: rpcError.message }, 400);
      } else {
        const { error: rpcError } = await callerClient.rpc("reactivate_organization_member_v1", {
          p_organization_id: organization_id,
          p_user_id: target_user_id,
        });
        if (rpcError) return jsonResponse({ success: false, error: rpcError.message }, 400);
      }
    } catch (e) {
      return jsonResponse({ success: false, error: e instanceof Error ? e.message : "Database update failed" }, 400);
    }
    desiredBan = action === "deactivate" ? BAN_DURATION : UNBAN;
  }

  // Only AFTER the DB-side state change succeeded (so a failed Auth ban
  // never leaves the DB in a state that says "deactivated" while the old
  // session keeps working silently -- and conversely, the DB change is the
  // authorization-checked step, so this Auth call never runs on its own
  // authority) does the Auth account itself get suspended/restored.
  const { error: authError } = await serviceClient.auth.admin.updateUserById(target_user_id, {
    ban_duration: desiredBan,
  });
  if (authError) {
    // The DB state already changed correctly (is_active=false/true) and
    // backend RLS/RPC checks already enforce that -- the Auth ban is
    // defence-in-depth, not the sole gate, so this is reported but not
    // treated as a fatal failure of the whole operation. FIXED (FINAL
    // ZERO-GAP PASS): this used to be reported ONLY in this one HTTP
    // response, with no persistent record and no retry path -- now
    // recorded as a durable, queryable account_audit_events row so it
    // cannot silently vanish into Edge Function logs, and the caller can
    // retry via `action: "retry_auth_sync"` without re-running deactivate/
    // reactivate from scratch.
    const failureEventType = desiredBan === BAN_DURATION ? "auth_ban_failed" : "auth_unban_failed";
    await serviceClient.rpc("record_auth_sync_failure_v1", {
      p_organization_id: organization_id,
      p_target_user_id: target_user_id,
      p_actor_user_id: userData.user.id,
      p_event_type: failureEventType,
      p_error_message_safe: authError.message,
    });
    return jsonResponse({
      success: true,
      warning: `Database updated, but Auth ${desiredBan === BAN_DURATION ? "ban" : "unban"} failed: ${authError.message}. Retry with action "retry_auth_sync".`,
      recoverable: true,
    });
  }

  if (action === "retry_auth_sync") {
    await serviceClient.rpc("record_auth_sync_failure_v1", {
      p_organization_id: organization_id,
      p_target_user_id: target_user_id,
      p_actor_user_id: userData.user.id,
      p_event_type: "auth_sync_recovered",
      p_error_message_safe: null,
    });
  }

  return jsonResponse({ success: true });
});
