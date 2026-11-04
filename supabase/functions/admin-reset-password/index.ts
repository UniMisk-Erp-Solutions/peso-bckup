import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { failureReason, newRequestId, recordAuditEvent, registerAuditContext } from "../_shared/accountAudit.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type ResetBody = {
  target_user_id?: string;
  new_password?: string;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (req.method !== "POST") {
      return new Response(
        JSON.stringify({ success: false, error: "Method not allowed" }),
        { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      return new Response(
        JSON.stringify({ success: false, error: "Server misconfiguration" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ success: false, error: "Missing authorization token" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const jwt = authHeader.replace("Bearer ", "");
    const { target_user_id, new_password } = (await req.json()) as ResetBody;

    if (!target_user_id || !new_password) {
      return new Response(
        JSON.stringify({ success: false, error: "target_user_id and new_password are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (new_password.length < 8) {
      return new Response(
        JSON.stringify({ success: false, error: "Password must be at least 8 characters" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const serviceClient = createClient(supabaseUrl, serviceRoleKey);

    // Verify caller from JWT
    const { data: authUserData, error: authUserError } = await serviceClient.auth.getUser(jwt);
    if (authUserError || !authUserData.user) {
      return new Response(
        JSON.stringify({ success: false, error: "Invalid or expired token" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // The actor is the authenticated caller, never a body field (DOC-158). The password is never logged or audited.
    const callerId = authUserData.user.id;
    const requestId = newRequestId(req);

    // Ensure caller is an active admin in at least one org.
    const { data: adminMemberships, error: adminCheckError } = await serviceClient
      .from("organization_memberships")
      .select("organization_id")
      .eq("user_id", callerId)
      .eq("role", "admin")
      .eq("is_active", true);

    if (adminCheckError || !adminMemberships?.length) {
      return new Response(
        JSON.stringify({ success: false, error: "Only administrators can reset passwords" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const adminOrgIds = new Set(adminMemberships.map((m: { organization_id: string }) => m.organization_id));

    // Ensure target user belongs to one of caller admin organizations.
    const { data: targetMemberships, error: targetMembershipError } = await serviceClient
      .from("organization_memberships")
      .select("organization_id")
      .eq("user_id", target_user_id)
      .eq("is_active", true);

    if (targetMembershipError || !targetMemberships?.length) {
      return new Response(
        JSON.stringify({ success: false, error: "Target user not found in any active organization" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const sharedMembership = targetMemberships.find((m: { organization_id: string }) => adminOrgIds.has(m.organization_id));
    const sameOrg = Boolean(sharedMembership);
    if (!sameOrg) {
      await recordAuditEvent(serviceClient, {
        organizationId: [...adminOrgIds][0] as string,
        targetUserId: target_user_id,
        actorUserId: callerId,
        eventType: "account_change_denied",
        source: "password_reset",
        requestId,
        metadata: { requested_action: "admin_password_reset", reason: "different_organization" },
      });
      return new Response(
        JSON.stringify({ success: false, error: "You can only reset passwords for users in your organization" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Optional safety: block resetting admin passwords via this UI path.
    const { data: targetAdminMembership } = await serviceClient
      .from("organization_memberships")
      .select("user_id")
      .eq("user_id", target_user_id)
      .eq("role", "admin")
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();

    if (targetAdminMembership) {
      await recordAuditEvent(serviceClient, {
        organizationId: sharedMembership.organization_id as string,
        targetUserId: target_user_id,
        actorUserId: callerId,
        eventType: "account_change_denied",
        source: "password_reset",
        requestId,
        metadata: { requested_action: "admin_password_reset", reason: "target_is_administrator" },
      });
      return new Response(
        JSON.stringify({ success: false, error: "Admin passwords cannot be reset through this interface" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const orgId = sharedMembership.organization_id as string;
    await registerAuditContext(serviceClient, {
      actorUserId: callerId,
      organizationId: orgId,
      requestId,
      source: "password_reset",
      targetUserIds: [target_user_id],
      method: "admin_reset",
    });

    const { error: updateError } = await serviceClient.auth.admin.updateUserById(target_user_id, {
      password: new_password,
    });

    if (updateError) {
      await recordAuditEvent(serviceClient, {
        organizationId: orgId,
        targetUserId: target_user_id,
        actorUserId: callerId,
        eventType: "password_reset_failed",
        source: "password_reset",
        requestId,
        metadata: { reason: failureReason(updateError.message) },
      });
      return new Response(
        JSON.stringify({ success: false, error: updateError.message || "Failed to reset password" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Event only: no password, hash or token is ever part of an audit row.
    await recordAuditEvent(serviceClient, {
      organizationId: orgId,
      targetUserId: target_user_id,
      actorUserId: callerId,
      eventType: "admin_password_reset",
      source: "password_reset",
      requestId,
      metadata: { method: "admin_reset" },
    });

    return new Response(
      JSON.stringify({ success: true, message: "Password reset successful", request_id: requestId }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return new Response(
      JSON.stringify({ success: false, error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});

