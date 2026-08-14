export type BranchFieldType = "text" | "number" | "date" | "textarea" | "select" | "checkbox";

export type OptionBranchDefinition = {
  id: string;
  organization_id: string;
  parent_template_id: string;
  parent_option_value: string;
  parent_branch_id: string | null;
  field_key: string;
  name: string;
  field_type: BranchFieldType;
  required: boolean;
  placeholder: string | null;
  help_text: string | null;
  default_value: string | null;
  validation_rules: Record<string, unknown> | null;
  options: string[] | null;
  display_order: number;
};

export type BranchFieldValueMap = Record<string, string>;

export const MAX_CONDITIONAL_BRANCH_DEPTH = 3;
