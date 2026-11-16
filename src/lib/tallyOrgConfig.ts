import { supabase } from "@/integrations/supabase/client";

export async function fetchTallyCompanyName(organizationId: string): Promise<string | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from("tally_org_connector_config")
    .select("tally_company_name")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const name = data?.tally_company_name;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

export async function saveTallyCompanyName(organizationId: string, tallyCompanyName: string): Promise<void> {
  const trimmed = tallyCompanyName.trim();
  if (!trimmed) throw new Error("Tally company name is required");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any).rpc("set_tally_org_company_v1", {
    p_organization_id: organizationId,
    p_tally_company_name: trimmed,
  });
  if (error) throw new Error(error.message);
}
