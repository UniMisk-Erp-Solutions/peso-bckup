import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

    const callerId = authUserData.user.id;

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

    const sameOrg = targetMemberships.some((m: { organization_id: string }) => adminOrgIds.has(m.organization_id));
    if (!sameOrg) {
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
      return new Response(
        JSON.stringify({ success: false, error: "Admin passwords cannot be reset through this interface" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { error: updateError } = await serviceClient.auth.admin.updateUserById(target_user_id, {
      password: new_password,
    });

    if (updateError) {
      return new Response(
        JSON.stringify({ success: false, error: updateError.message || "Failed to reset password" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({ success: true, message: "Password reset successful" }),
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

