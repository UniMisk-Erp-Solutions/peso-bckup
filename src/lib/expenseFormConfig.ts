export type BaseExpenseFieldKey =
  | "category"
  | "title"
  | "destination"
  | "expense_date"
  | "purpose"
  | "amount";

export type BaseFieldInputType = "default" | "text" | "number" | "dropdown";

export type BaseFieldConfig = {
  field_key: BaseExpenseFieldKey;
  label: string;
  help_text?: string | null;
  is_visible: boolean;
  is_required: boolean;
  display_order: number;
  show_on_submit: boolean;
  show_on_review: boolean;
  show_on_detail: boolean;
  /** Render-control override. "default" keeps the built-in control. */
  input_type: BaseFieldInputType;
  /** Static options used when input_type === "dropdown". */
  options: string[];
};

export const DEFAULT_BASE_FIELD_CONFIG: Record<BaseExpenseFieldKey, BaseFieldConfig> = {
  category: {
    field_key: "category",
    label: "Category",
    is_visible: true,
    is_required: true,
    display_order: 10,
    show_on_submit: true,
    show_on_review: true,
    show_on_detail: true,
    input_type: "default",
    options: [],
  },
  title: {
    field_key: "title",
    label: "Title",
    is_visible: true,
    is_required: true,
    display_order: 20,
    show_on_submit: true,
    show_on_review: true,
    show_on_detail: true,
    input_type: "default",
    options: [],
  },
  destination: {
    field_key: "destination",
    label: "Vendor / Location",
    is_visible: true,
    is_required: true,
    display_order: 30,
    show_on_submit: true,
    show_on_review: true,
    show_on_detail: true,
    input_type: "default",
    options: [],
  },
  expense_date: {
    field_key: "expense_date",
    label: "Expense Date",
    is_visible: true,
    is_required: true,
    display_order: 40,
    show_on_submit: true,
    show_on_review: true,
    show_on_detail: true,
    input_type: "default",
    options: [],
  },
  purpose: {
    field_key: "purpose",
    label: "Purpose",
    is_visible: true,
    is_required: false,
    display_order: 50,
    show_on_submit: true,
    show_on_review: true,
    show_on_detail: true,
    input_type: "default",
    options: [],
  },
  amount: {
    field_key: "amount",
    label: "Amount",
    is_visible: true,
    is_required: true,
    display_order: 60,
    show_on_submit: true,
    show_on_review: true,
    show_on_detail: true,
    input_type: "default",
    options: [],
  },
};

/** Coerce a raw options value (jsonb array, JSON string, or array) into string[]. */
export function normalizeBaseFieldOptions(raw: unknown): string[] {
  let arr: unknown = raw;
  if (typeof raw === "string") {
    try {
      arr = JSON.parse(raw);
    } catch {
      arr = raw
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .map((v) => (v == null ? "" : String(v).trim()))
    .filter((v) => v.length > 0);
}

export function resolveBaseFieldConfig(
  rows: Partial<BaseFieldConfig>[] | null | undefined
): Record<BaseExpenseFieldKey, BaseFieldConfig> {
  const resolved = { ...DEFAULT_BASE_FIELD_CONFIG };
  for (const row of rows || []) {
    const key = row.field_key as BaseExpenseFieldKey | undefined;
    if (!key || !(key in resolved)) continue;
    const inputType = (row.input_type as BaseFieldInputType | undefined) ?? resolved[key].input_type;
    resolved[key] = {
      ...resolved[key],
      ...row,
      field_key: key,
      input_type: ["default", "text", "number", "dropdown"].includes(inputType)
        ? inputType
        : "default",
      options:
        row.options !== undefined
          ? normalizeBaseFieldOptions(row.options)
          : resolved[key].options,
    };
  }
  return resolved;
}

export function slugifyFieldKey(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}
