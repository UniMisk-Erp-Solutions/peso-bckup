import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type FieldType = "text" | "number" | "date" | "textarea" | "select" | "checkbox";
type FieldRow = {
  field_key?: string;
  name?: string;
  field_type?: FieldType;
  required?: boolean;
  placeholder?: string;
  help_text?: string;
  options?: string[];
  validation_rules?: Record<string, unknown>;
  display_order?: number;
  show_on_submit?: boolean;
  show_on_review?: boolean;
  show_on_detail?: boolean;
  category_names?: string[];
};
type Body = { organization_id?: string; dry_run?: boolean; rows?: FieldRow[] };
const MAX_ROWS = 500;

function slugifyFieldKey(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

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
    const results: Array<{ index: number; ok: boolean; field_key?: string; error?: string }> = [];

    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const name = (row.name || "").trim().slice(0, 120);
      const fieldType = row.field_type || "text";
      const fieldKey = (row.field_key || slugifyFieldKey(name)).trim();

      if (!name || !fieldKey || !["text", "number", "date", "textarea", "select", "checkbox"].includes(fieldType)) {
        results.push({ index: i, ok: false, error: "name or field_key missing" });
        continue;
      }

      if (dryRun) {
        results.push({ index: i, ok: true, field_key: fieldKey });
        continue;
      }

      const { data: templateData, error: templateError } = await serviceClient
        .from("expense_form_field_templates")
        .upsert(
          {
            organization_id: organizationId,
            field_key: fieldKey,
            name,
            field_type: fieldType,
            required: row.required ?? false,
            placeholder: row.placeholder ?? null,
            help_text: row.help_text ?? null,
            options: row.options ?? null,
            validation_rules: row.validation_rules ?? null,
            show_on_submit: row.show_on_submit ?? true,
            show_on_review: row.show_on_review ?? true,
            show_on_detail: row.show_on_detail ?? true,
          },
          { onConflict: "organization_id,field_key" }
        )
        .select("id")
        .single();

      if (templateError || !templateData?.id) {
        results.push({ index: i, ok: false, field_key: fieldKey, error: templateError?.message || "Template upsert failed" });
        continue;
      }

      if (row.category_names?.length) {
        const { data: cats } = await serviceClient
          .from("expense_categories")
          .select("id, name")
          .eq("organization_id", organizationId)
          .in("name", row.category_names);
        const categoryAssignments = (cats || []).map((cat: any) => ({
          organization_id: organizationId,
          category_id: cat.id,
          template_id: templateData.id,
          display_order: row.display_order ?? 0,
          show_on_submit: row.show_on_submit ?? true,
          show_on_review: row.show_on_review ?? true,
          show_on_detail: row.show_on_detail ?? true,
        }));
        if (categoryAssignments.length) {
          await serviceClient
            .from("expense_category_form_fields")
            .upsert(categoryAssignments, { onConflict: "category_id,template_id" });
        }
      }

      results.push({ index: i, ok: true, field_key: fieldKey });
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
