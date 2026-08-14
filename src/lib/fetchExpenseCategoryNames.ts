import { supabase } from "@/integrations/supabase/client";

function isSchemaMismatchError(error: unknown): boolean {
  const code = (error as { code?: string })?.code;
  return code === "42703" || code === "PGRST204";
}

/** Active expense category names for an organization (handles active vs is_active columns). */
export async function fetchExpenseCategoryNames(organizationId: string): Promise<string[]> {
  if (!organizationId) return [];

  const attempts = [
    () =>
      supabase
        .from("expense_categories")
        .select("name")
        .eq("organization_id", organizationId)
        .eq("active", true)
        .order("name", { ascending: true }),
    () =>
      supabase
        .from("expense_categories")
        .select("name")
        .eq("organization_id", organizationId)
        .eq("is_active", true)
        .order("name", { ascending: true }),
    () =>
      supabase
        .from("expense_categories")
        .select("name")
        .eq("organization_id", organizationId)
        .order("name", { ascending: true }),
  ];

  for (const run of attempts) {
    const result = await run();
    if (!result.error) {
      return (result.data || []).map((r) => r.name).filter(Boolean);
    }
    if (!isSchemaMismatchError(result.error)) break;
  }

  return [];
}
