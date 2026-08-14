import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Row = { expense_id?: string; field_key?: string; field_value?: string };
type Body = { organization_id?: string; dry_run?: boolean; rows?: Row[] };
const MAX_ROWS = 2000;

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
    const results: Array<{ index: number; ok: boolean; expense_id?: string; field_key?: string; error?: string }> = [];

    const { data: templates } = await serviceClient
      .from("expense_form_field_templates")
      .select("id, field_key")
      .eq("organization_id", organizationId);
    const templateMap = new Map((templates || []).map((t: any) => [t.field_key, t.id]));

    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const expenseId = (row.expense_id || "").trim();
      const fieldKey = (row.field_key || "").trim();
      const fieldValue = String(row.field_value ?? "").slice(0, 5000);
      const templateId = templateMap.get(fieldKey);

      if (!expenseId || !fieldKey || !templateId) {
        results.push({ index: i, ok: false, expense_id: expenseId, field_key: fieldKey, error: "expense_id + valid field_key required" });
        continue;
      }

      const { data: expense } = await serviceClient
        .from("expenses")
        .select("id")
        .eq("id", expenseId)
        .eq("organization_id", organizationId)
        .maybeSingle();
      if (!expense) {
        results.push({ index: i, ok: false, expense_id: expenseId, field_key: fieldKey, error: "Expense not found in organization" });
        continue;
      }

      if (dryRun) {
        results.push({ index: i, ok: true, expense_id: expenseId, field_key: fieldKey });
        continue;
      }

      const { error } = await serviceClient
        .from("expense_form_field_values")
        .upsert(
          {
            organization_id: organizationId,
            expense_id: expenseId,
            template_id: templateId,
            field_value: String(fieldValue),
          },
          { onConflict: "expense_id,template_id" }
        );

      if (error) {
        results.push({ index: i, ok: false, expense_id: expenseId, field_key: fieldKey, error: error.message });
      } else {
        results.push({ index: i, ok: true, expense_id: expenseId, field_key: fieldKey });
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
