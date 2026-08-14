// @ts-nocheck
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type UpdateEmailBody = {
  target_user_id?: string;
  new_email?: string;
};
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
    const { target_user_id, new_email } = (await req.json()) as UpdateEmailBody;

    if (!target_user_id || !new_email) {
      return new Response(
        JSON.stringify({ success: false, error: "target_user_id and new_email are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const normalizedEmail = String(new_email).trim().toLowerCase();
    if (!UUID_REGEX.test(String(target_user_id))) {
      return new Response(
        JSON.stringify({ success: false, error: "Invalid target_user_id" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(normalizedEmail)) {
      return new Response(
        JSON.stringify({ success: false, error: "Invalid email address" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const serviceClient = createClient(supabaseUrl, serviceRoleKey);

    const { data: authUserData, error: authUserError } = await serviceClient.auth.getUser(jwt);
    if (authUserError || !authUserData.user) {
      return new Response(
        JSON.stringify({ success: false, error: "Invalid or expired token" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const callerId = authUserData.user.id;

    // Ensure caller is an active org admin.
    const { data: callerAdminMemberships, error: callerAdminError } = await serviceClient
      .from("organization_memberships")
      .select("organization_id")
      .eq("user_id", callerId)
      .eq("role", "admin")
      .eq("is_active", true);

    if (callerAdminError || !callerAdminMemberships?.length) {
      return new Response(
        JSON.stringify({ success: false, error: "Only administrators can update user email" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const adminOrgIds = new Set(callerAdminMemberships.map((m: { organization_id: string }) => m.organization_id));

    // Ensure target belongs to one of caller's admin orgs.
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

    const sameOrg = targetMemberships.some((m: { organization_id: string }) => adminOrgIds.has(m.organization_id));
    if (!sameOrg) {
      return new Response(
        JSON.stringify({ success: false, error: "You can only update users in your organization" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { error: updateError } = await serviceClient.auth.admin.updateUserById(target_user_id, {
      email: normalizedEmail,
      email_confirm: true,
    });

    if (updateError) {
      return new Response(
        JSON.stringify({ success: false, error: updateError.message || "Failed to update auth email" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({ success: true, message: "User email updated successfully", email: normalizedEmail }),
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

