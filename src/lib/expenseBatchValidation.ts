import { z } from "zod";
import type { BaseFieldConfig } from "@/lib/expenseFormConfig";
import {
  BATCH_EXPENSE_MAX_LINES,
  BATCH_EXPENSE_MIN_LINES,
  type BatchExpenseAttachmentMode,
} from "@/lib/expenseBatchConstants";
import type { OptionBranchDefinition } from "@/lib/conditionalFormFieldTypes";
import { validateVisibleBranchFields } from "@/lib/conditionalFormFields";
import type { BatchFieldPlan } from "@/lib/batchFieldPlan";

export type BatchLineInput = {
  clientId: string;
  title: string;
  amount: number;
  category: string;
  destination?: string;
  purpose?: string;
  /** Temp storage filenames for per-line receipts (per_line mode). */
  tempReceiptFilenames?: string[];
  formFieldValues?: Record<string, string>;
  branchValues?: Record<string, string>;
};

export type BatchSharedContext = {
  expenseDate: Date;
  sharedDestination?: string;
  label?: string;
};

const lineSchema = z.object({
  title: z.string(),
  amount: z.number().positive("Amount must be greater than 0"),
  category: z.string().optional(),
  destination: z.string().optional(),
});

export function validateBatchLines(
  lines: BatchLineInput[],
  baseFields?: Record<string, BaseFieldConfig>,
): { ok: true } | { ok: false; message: string } {
  if (lines.length < BATCH_EXPENSE_MIN_LINES) {
    return {
      ok: false,
      message: `Add at least ${BATCH_EXPENSE_MIN_LINES} expense lines.`,
    };
  }
  if (lines.length > BATCH_EXPENSE_MAX_LINES) {
    return {
      ok: false,
      message: `Maximum ${BATCH_EXPENSE_MAX_LINES} lines per batch.`,
    };
  }
  const titleCfg = baseFields?.title;
  const titleRequired = titleCfg?.is_visible !== false && titleCfg?.is_required === true;
  const categoryCfg = baseFields?.category;
  // Category is always required for submission regardless of base-field config.
  const categoryRequired = true;
  const purposeCfg = baseFields?.purpose;
  const purposeRequired =
    purposeCfg?.is_visible !== false && purposeCfg?.is_required === true;

  for (let i = 0; i < lines.length; i++) {
    const parsed = lineSchema.safeParse(lines[i]);
    if (!parsed.success) {
      return {
        ok: false,
        message: `Line ${i + 1}: ${parsed.error.errors[0]?.message ?? "Invalid"}`,
      };
    }
    if (titleRequired && !String(lines[i].title || "").trim()) {
      return {
        ok: false,
        message: `Line ${i + 1}: ${titleCfg?.label || "Title"} is required`,
      };
    }
    if (categoryRequired && !String(lines[i].category || "").trim()) {
      return {
        ok: false,
        message: `Line ${i + 1}: ${categoryCfg?.label || "Category"} is required`,
      };
    }
    if (purposeRequired && !String(lines[i].purpose || "").trim()) {
      return {
        ok: false,
        message: `Line ${i + 1}: ${purposeCfg?.label || "Purpose"} is required`,
      };
    }
  }
  return { ok: true };
}

export function validateBatchSharedContext(
  ctx: BatchSharedContext,
  baseFields: Record<string, BaseFieldConfig>,
): { ok: true } | { ok: false; message: string } {
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  if (ctx.expenseDate > today) {
    return { ok: false, message: "Expense date cannot be in the future." };
  }

  const destCfg = baseFields.destination;
  if (
    destCfg?.is_visible &&
    destCfg.is_required &&
    !String(ctx.sharedDestination || "").trim()
  ) {
    return { ok: false, message: `${destCfg.label || "Destination"} is required` };
  }

  return { ok: true };
}

export function lineRequiresReceipt(
  amount: number,
  attachmentLimit: number,
): boolean {
  return amount > attachmentLimit;
}

/** Same rules as single expense: required above org attachment threshold. */
export function validateBatchAttachments(params: {
  lines: BatchLineInput[];
  attachmentLimit: number;
  mode: BatchExpenseAttachmentMode;
  sharedTempFilenames: string[];
}): { ok: true } | { ok: false; message: string } {
  const { lines, attachmentLimit, mode, sharedTempFilenames } = params;

  const needsAny = lines.some((l) => lineRequiresReceipt(l.amount, attachmentLimit));
  if (!needsAny) return { ok: true };

  if (mode === "shared") {
    if (sharedTempFilenames.length === 0) {
      return {
        ok: false,
        message: `Upload at least one receipt for this batch (required for amounts above ${attachmentLimit}).`,
      };
    }
    return { ok: true };
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!lineRequiresReceipt(line.amount, attachmentLimit)) continue;
    const count = line.tempReceiptFilenames?.length ?? 0;
    if (count === 0) {
      return {
        ok: false,
        message: `Line ${i + 1} requires a bill photo (amount above ₹${attachmentLimit}).`,
      };
    }
  }
  return { ok: true };
}

export function formatExpenseDateString(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function batchLineTotal(lines: BatchLineInput[]): number {
  return lines.reduce((sum, l) => sum + (Number(l.amount) || 0), 0);
}

// ── Custom template-field validation ─────────────────────────────────────────

export type TemplateFieldAssignment = {
  required?: boolean | null;
  show_on_submit?: boolean | null;
  ask_once_per_batch?: boolean | null;
  template?: {
    id: string;
    name: string;
    required?: boolean | null;
  } | null;
};

/** Pre-split and pre-fetched field data for one expense category. */
export type BatchCategoryFieldSpec = {
  /** Fields answered once for the whole batch (ask_once_per_batch=true). */
  batchOnce: TemplateFieldAssignment[];
  /** Fields answered separately on each line. */
  perLine: TemplateFieldAssignment[];
  /** Branch definitions for conditional dropdown validation (empty if feature disabled). */
  branches: OptionBranchDefinition[];
};

/** Per-line input for the pure custom-field validator. */
export type LineCustomFieldInput = {
  lineIndex: number;
  lineLabel: string;
  category: string;
  formFieldValues: Record<string, string>;
  branchValues: Record<string, string>;
};

/**
 * Pure validator for required custom template fields and branch fields.
 *
 * Caller must pre-fetch assignments and branches per category and pass them in
 * via `categoryFieldSpecs`. This keeps the function side-effect-free and testable.
 *
 * Fixes: branch field validation no longer skips when branchValues is empty — a
 * parent select can have a required visible branch even when no branch value has
 * been entered yet.
 */
export function validateBatchCustomFields(params: {
  lines: LineCustomFieldInput[];
  categoryFieldSpecs: Map<string, BatchCategoryFieldSpec>;
  batchFormFieldsByCategory: Record<string, Record<string, string>>;
  allowConditionalDropdown: boolean;
  allowNestedConditional: boolean;
  configLoaded: boolean;
}): { ok: true } | { ok: false; message: string } {
  const {
    lines,
    categoryFieldSpecs,
    batchFormFieldsByCategory,
    allowConditionalDropdown,
    allowNestedConditional,
    configLoaded,
  } = params;

  if (!configLoaded) {
    return { ok: false, message: "Form configuration is still loading. Please wait." };
  }

  const checkedSharedCategories = new Set<string>();

  for (const { lineLabel, category, formFieldValues, branchValues } of lines) {
    const spec = categoryFieldSpecs.get(category);
    if (!spec) continue;

    // Branch field validation — fixed: no longer guarded by branchValues being non-empty.
    // validateVisibleBranchFields internally checks which branches are visible given the
    // current template selections, so it correctly handles the case where branchValues is
    // empty but a visible branch is required.
    if (allowConditionalDropdown && spec.branches.length > 0) {
      const validation = validateVisibleBranchFields(
        spec.branches,
        formFieldValues,
        branchValues,
        allowNestedConditional,
      );
      if (!validation.valid) {
        return {
          ok: false,
          message: `Line "${lineLabel}": complete ${validation.missing.join(", ")}`,
        };
      }
    }

    // Shared (batch-level) field validation — checked once per category.
    if (!checkedSharedCategories.has(category)) {
      checkedSharedCategories.add(category);
      const sharedVals = batchFormFieldsByCategory[category] ?? {};
      for (const field of spec.batchOnce) {
        const tmpl = field.template;
        if (!tmpl?.id) continue;
        const isRequired =
          field.required != null ? Boolean(field.required) : Boolean(tmpl.required);
        if (isRequired && !(sharedVals[tmpl.id] ?? "").trim()) {
          return {
            ok: false,
            message: `"${tmpl.name}" is required for all "${category}" lines`,
          };
        }
      }
    }

    // Per-line field validation.
    for (const field of spec.perLine) {
      const tmpl = field.template;
      if (!tmpl?.id) continue;
      const isRequired =
        field.required != null ? Boolean(field.required) : Boolean(tmpl.required);
      if (isRequired && !(formFieldValues[tmpl.id] ?? "").trim()) {
        return {
          ok: false,
          message: `Line "${lineLabel}": "${tmpl.name}" is required`,
        };
      }
    }
  }

  return { ok: true };
}

// ── Plan-based validation (uses BatchFieldPlan instead of per-category specs) ──

/** Template-ID → collected field + branch values from the shared UI */
export type BatchSharedFormValues = Record<
  string,
  { fields: Record<string, string>; branches: Record<string, string> }
>;

/**
 * Validates required custom template fields and branch fields using a pre-built
 * BatchFieldPlan. Replaces `validateBatchCustomFields` for callers that use
 * `useBatchFieldPlan` (eliminates N+1 assignment fetches).
 *
 * Branch validation requires `categoryBranches`; pass an empty Map to skip it.
 */
export function validateBatchCustomFieldsFromPlan(params: {
  lines: LineCustomFieldInput[];
  plan: BatchFieldPlan;
  batchSharedFormValues: BatchSharedFormValues;
  categoryIdByName: Record<string, string>;
  categoryBranches: Map<string, OptionBranchDefinition[]>;
  allowConditionalDropdown: boolean;
  allowNestedConditional: boolean;
  configLoaded: boolean;
}): { ok: true } | { ok: false; message: string } {
  const {
    lines,
    plan,
    batchSharedFormValues,
    categoryIdByName,
    categoryBranches,
    allowConditionalDropdown,
    allowNestedConditional,
    configLoaded,
  } = params;

  if (!configLoaded) {
    return { ok: false, message: "Form configuration is still loading. Please wait." };
  }

  // Shared (batch-level) field validation — checked once per template, not per line.
  for (const sf of plan.shared) {
    const tmpl = sf.assignment.template;
    if (!tmpl?.id) continue;
    // Use assignment-level required override first, fall back to template.required.
    // NOTE: the DB column is `required` — not `is_required`.
    const isRequired = Boolean(sf.assignment.required ?? tmpl.required);
    if (isRequired) {
      const val = (batchSharedFormValues[sf.templateId]?.fields?.[tmpl.id] ?? "").trim();
      if (!val) {
        const catLabel = sf.categoryNames.join(" / ") || "batch";
        return {
          ok: false,
          message: `"${tmpl.name || sf.templateId}" is required for this batch`,
        };
      }
    }
  }

  // Per-line and branch validation.
  for (const { lineLabel, category, formFieldValues, branchValues } of lines) {
    const catId = categoryIdByName[category];

    // Branch field validation.
    if (allowConditionalDropdown) {
      const branchDefs = categoryBranches.get(category) ?? [];
      if (branchDefs.length > 0) {
        const validation = validateVisibleBranchFields(
          branchDefs,
          formFieldValues,
          branchValues,
          allowNestedConditional,
        );
        if (!validation.valid) {
          return {
            ok: false,
            message: `Line "${lineLabel}": complete ${validation.missing.join(", ")}`,
          };
        }
      }
    }

    // Per-line required field validation.
    if (catId) {
      for (const plf of plan.perLine) {
        if (plf.categoryId !== catId) continue;
        const tmpl = plf.assignment.template;
        if (!tmpl?.id) continue;
        // Use assignment-level required override first, fall back to template.required.
        // NOTE: the DB column is `required` — not `is_required`.
        const isRequired = Boolean(plf.assignment.required ?? tmpl.required);
        if (isRequired && !(formFieldValues[tmpl.id] ?? "").trim()) {
          return {
            ok: false,
            message: `Line "${lineLabel}": "${tmpl.name}" is required`,
          };
        }
      }
    }
  }

  return { ok: true };
}
