import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type CategoryRow = { name?: string; active?: boolean };
type Body = { organization_id?: string; dry_run?: boolean; rows?: CategoryRow[] };
const MAX_ROWS = 1000;

async function resolveAdminOrg(client: any, callerId: string, requestedOrgId?: string) {
  const { data, error } = await client
    .from("organization_memberships")
    .select("organization_id")
    .eq("user_id", callerId)
    .eq("role", "admin")
    .eq("is_active", true);

  if (error || !data?.length) throw new Error("Only organization admins can run bulk imports.");
  if (requestedOrgId) {
    const allowed = data.some((m: any) => m.organization_id === requestedOrgId);
    if (!allowed) throw new Error("You are not an admin of the requested organization.");
    return requestedOrgId;
  }
  return data[0].organization_id as string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ success: false, error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) throw new Error("Server misconfiguration");

    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) throw new Error("Missing authorization token");
    const jwt = authHeader.replace("Bearer ", "");

    const body = (await req.json()) as Body;
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (rows.length === 0) throw new Error("rows[] is required");
    if (rows.length > MAX_ROWS) throw new Error(`rows[] exceeds max allowed size (${MAX_ROWS})`);

    const serviceClient = createClient(supabaseUrl, serviceRoleKey);
    const { data: authUserData, error: authUserError } = await serviceClient.auth.getUser(jwt);
    if (authUserError || !authUserData.user) throw new Error("Invalid or expired token");

    const organizationId = await resolveAdminOrg(serviceClient, authUserData.user.id, body.organization_id);
    const dryRun = body.dry_run === true;
    const results: Array<{ index: number; ok: boolean; action?: string; name?: string; error?: string }> = [];

    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const name = (row.name || "").trim().slice(0, 100);
      if (!name) {
        results.push({ index: i, ok: false, error: "name is required" });
        continue;
      }
      if (dryRun) {
        results.push({ index: i, ok: true, action: "validate", name });
        continue;
      }

      const { error } = await serviceClient
        .from("expense_categories")
        .upsert(
          {
            organization_id: organizationId,
            name,
            active: row.active ?? true,
          },
          { onConflict: "organization_id,name" }
        );

      if (error) {
        results.push({ index: i, ok: false, name, error: error.message });
      } else {
        results.push({ index: i, ok: true, action: "upsert", name });
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        organization_id: organizationId,
        dry_run: dryRun,
        total: rows.length,
        ok: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
        results,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return new Response(JSON.stringify({ success: false, error: message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
