import { supabase } from "@/integrations/supabase/client";
import type { BranchFieldType } from "@/lib/conditionalFormFieldTypes";
import { slugifyFieldKey } from "@/lib/conditionalFormFields";

export type DraftOptionBranch = {
  localId: string;
  /** DB primary key.  null for unsaved (newly created) branches. */
  dbId: string | null;
  parent_option_value: string;
  parent_branch_local_id: string | null;
  field_key: string;
  name: string;
  field_type: BranchFieldType;
  required: boolean;
  placeholder: string;
  help_text: string;
  options: string[];
  display_order: number;
};

export function createDraftBranch(
  parentOptionValue: string,
  parentBranchLocalId: string | null,
  displayOrder: number,
): DraftOptionBranch {
  const localId = crypto.randomUUID();
  return {
    localId,
    dbId: null,
    parent_option_value: parentOptionValue,
    parent_branch_local_id: parentBranchLocalId,
    field_key: `field_${localId.slice(0, 8)}`,
    name: "",
    field_type: "text",
    required: false,
    placeholder: "",
    help_text: "",
    options: [],
    display_order: displayOrder,
  };
}

export async function loadDraftBranchesForTemplate(
  organizationId: string,
  templateId: string,
): Promise<DraftOptionBranch[]> {
  // Try with retired_at filter (post-migration). Fall back without it when the
  // column does not yet exist (migration pending — avoids a PostgREST 400).
  let result = await supabase
    .from("expense_form_field_option_branches")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("parent_template_id", templateId)
    .is("retired_at", null)
    .order("display_order", { ascending: true });

  if (result.error) {
    result = await supabase
      .from("expense_form_field_option_branches")
      .select("*")
      .eq("organization_id", organizationId)
      .eq("parent_template_id", templateId)
      .order("display_order", { ascending: true });
  }

  const { data, error } = result;
  if (error || !data) return [];

  const idToLocal = new Map<string, string>();
  const drafts: DraftOptionBranch[] = [];

  for (const row of data) {
    const localId = crypto.randomUUID();
    idToLocal.set(row.id, localId);
    drafts.push({
      localId,
      dbId: row.id,
      parent_option_value: row.parent_option_value,
      parent_branch_local_id: null,
      field_key: row.field_key,
      name: row.name,
      field_type: row.field_type as BranchFieldType,
      required: row.required,
      placeholder: row.placeholder || "",
      help_text: row.help_text || "",
      options: Array.isArray(row.options) ? row.options.map(String) : [],
      display_order: row.display_order,
      _dbParentBranchId: row.parent_branch_id,
    } as DraftOptionBranch & { _dbParentBranchId: string | null });
  }

  return drafts.map((d) => {
    const ext = d as DraftOptionBranch & { _dbParentBranchId?: string | null };
    const parentLocal =
      ext._dbParentBranchId && idToLocal.has(ext._dbParentBranchId)
        ? idToLocal.get(ext._dbParentBranchId)!
        : null;
    const { _dbParentBranchId: _, ...rest } = ext;
    return { ...rest, parent_branch_local_id: parentLocal };
  });
}

/** Shape of one branch in the RPC payload. */
type BranchRpcItem = {
  local_id: string;
  db_id: string | null;
  parent_option_value: string;
  parent_local_id: string | null;
  field_key: string;
  name: string;
  field_type: BranchFieldType;
  required: boolean;
  placeholder: string | null;
  help_text: string | null;
  options: string[] | null;
  display_order: number;
};

export type AtomicSaveResult = {
  ok: true;
  revision_id: string;
  latest_updated_at: string;
  branches_inserted: number;
  branches_updated: number;
  branches_retired: number;
};

/**
 * Saves the branch configuration for a template atomically via the
 * save_option_branch_configuration_atomically database RPC.
 *
 * Replaces the old saveDraftBranchesForTemplate pattern (DELETE + INSERT)
 * that caused data loss when the browser interrupted mid-save.
 *
 * @param organizationId   - Active organisation UUID
 * @param templateId       - Template UUID to configure
 * @param expectedUpdatedAt - Template updated_at captured before this save;
 *   the RPC rejects the call when the DB value differs (stale-edit guard).
 *   Pass null for new templates (stale check skipped).
 * @param parentOptions    - Deduplicated list of parent option values
 * @param drafts           - Full branch draft state from the editor
 * @param source           - Caller identifier written to the audit log
 * @param reason           - Optional free-text note written to the audit log
 */
export async function saveOptionBranchConfigurationAtomically(
  organizationId: string,
  templateId: string,
  expectedUpdatedAt: string | null,
  parentOptions: string[],
  drafts: DraftOptionBranch[],
  source = "category_management",
  reason?: string,
): Promise<AtomicSaveResult> {
  const payload: BranchRpcItem[] = drafts
    .filter((d) => d.name.trim() !== "")
    .map((d) => ({
      local_id: d.localId,
      db_id: d.dbId ?? null,
      parent_option_value: d.parent_option_value.trim(),
      parent_local_id: d.parent_branch_local_id,
      field_key: d.field_key.trim() || slugifyFieldKey(d.name),
      name: d.name.trim(),
      field_type: d.field_type,
      required: d.required,
      placeholder: d.placeholder || null,
      help_text: d.help_text || null,
      options:
        d.field_type === "select" || d.field_type === "checkbox"
          ? d.options.filter((o) => o.trim() !== "")
          : null,
      display_order: d.display_order,
    }));

  const { data, error } = await supabase.rpc(
    "save_option_branch_configuration_atomically",
    {
      p_organization_id:     organizationId,
      p_template_id:         templateId,
      p_expected_updated_at: expectedUpdatedAt,
      p_parent_options:      parentOptions,
      p_branches:            payload,
      p_source:              source,
      p_reason:              reason ?? null,
    },
  );

  if (error) throw error;
  return data as AtomicSaveResult;
}
