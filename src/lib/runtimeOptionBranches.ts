import type { SupabaseClient } from "@supabase/supabase-js";
import type { OptionBranchDefinition } from "@/lib/conditionalFormFieldTypes";

export type RuntimeOptionBranchResult = {
  branches: OptionBranchDefinition[];
  /** True when the RPC call itself failed (network/server error) — distinct from a
   *  genuinely-empty (successful, zero-branch) result. Callers that require a
   *  conditional field to render correctly must treat `error: true` as "unknown",
   *  not "no branches exist", and fail submission safely rather than silently
   *  letting a required field disappear. */
  error: boolean;
};

/**
 * Fetch exactly one parent option's branch tree via the read-only,
 * employee-safe get_runtime_form_option_configuration RPC. Shared by
 * useOnDemandOptionBranches (React hook — single/batch submission) and
 * loadCorrectionCustomFields (plain loader — review/correction) so both
 * consumers share one RPC-mapping implementation instead of duplicating it.
 */
export async function fetchRuntimeOptionBranches(
  client: SupabaseClient,
  organizationId: string,
  templateId: string,
  optionValue: string,
): Promise<RuntimeOptionBranchResult> {
  if (!organizationId || !optionValue) return { branches: [], error: false };
  try {
    const { data, error } = await client.rpc("get_runtime_form_option_configuration" as never, {
      p_organization_id: organizationId,
      p_template_id: templateId,
      p_parent_option_value: optionValue,
    } as never);
    if (error) throw error;
    const raw = (data as { branches?: unknown[] } | null)?.branches ?? [];
    const branches: OptionBranchDefinition[] = (raw as Record<string, unknown>[]).map((row) => ({
      id: row.id as string,
      organization_id: organizationId,
      parent_template_id: templateId,
      parent_option_value: row.parent_option_value as string,
      parent_branch_id: (row.parent_branch_id as string | null) ?? null,
      field_key: row.field_key as string,
      name: row.name as string,
      field_type: row.field_type as OptionBranchDefinition["field_type"],
      required: Boolean(row.required),
      placeholder: (row.placeholder as string | null) ?? null,
      help_text: (row.help_text as string | null) ?? null,
      default_value: (row.default_value as string | null) ?? null,
      validation_rules: (row.validation_rules as Record<string, unknown> | null) ?? null,
      options: Array.isArray(row.options) ? (row.options as unknown[]).map(String) : null,
      display_order: Number(row.display_order ?? 0),
    }));
    return { branches, error: false };
  } catch (e) {
    console.error("fetchRuntimeOptionBranches: RPC failed", e);
    return { branches: [], error: true };
  }
}
