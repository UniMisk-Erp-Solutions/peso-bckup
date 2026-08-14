/**
 * Strict runtime schemas for every Debug Review RPC response (DOC-080 Phase 7).
 *
 * The RPCs return one JSONB document each and the generated Supabase types are
 * stale, so nothing upstream validates these shapes. Parsing here is the only
 * thing standing between a malformed server response and a page that renders
 * wrong numbers confidently. A parse failure becomes DebugReviewValidationError
 * and shows a controlled message — never a raw database error.
 */

import { z } from "zod";

/** Postgres numerics arrive as number or string depending on magnitude. */
const numeric = z.union([z.number(), z.string()]).transform((v) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
});
const nullableNumeric = z
  .union([z.number(), z.string(), z.null()])
  .transform((v) => {
    if (v === null) return null;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  });

const nullableString = z.string().nullable().catch(null);

export const DEBUG_REVIEW_SORTS = [
  "created_desc",
  "created_asc",
  "expense_date_desc",
  "expense_date_asc",
  "amount_desc",
  "amount_asc",
] as const;
export const debugReviewSortSchema = z.enum(DEBUG_REVIEW_SORTS);

export const debugReviewCapabilitiesSchema = z.object({
  contract: z.literal("debug-review-queue"),
  version: z.literal(1),
  /** Server-computed from to_regprocedure. A partial migration reports false. */
  ready: z.boolean(),
  functions: z.object({
    employee_search: z.boolean(),
    page: z.boolean(),
    filters: z.boolean(),
    detail: z.boolean(),
    // Added by the 20260801150000 correction migration; absent on 140000-only.
    actionability: z.boolean().optional().default(false),
    identity: z.boolean().optional().default(false),
    // Added by 20260802010000. Absent on older revisions, so the page-number
    // controls stay hidden rather than calling a function that does not exist.
    page_anchor: z.boolean().optional().default(false),
    keyed_scope: z.boolean().optional().default(false),
    // Added by 20260802020000.
    assigned_scope: z.boolean().optional().default(false),
    scope_audit: z.boolean().optional().default(false),
    // Added by 20260802030000. Whole-batch state needs this helper.
    batch_state: z.boolean().optional().default(false),
  }),
  /**
   * Response blocks the server promises to return. Deliberately defaults to
   * EMPTY, not to "everything": an older server that omits `filtered_summary`
   * must be reported as a contract mismatch, never rendered as zeros.
   */
  response_features: z.array(z.string()).optional().default([]),
  schema_revision: z.string(),
  server_time: z.string(),
});

export const debugEmployeeMatchSchema = z.object({
  user_id: z.string().min(1),
  employee_name: z.string(),
  employee_id: nullableString,
  employee_email: nullableString,
  identity_source: z.string(),
  identity_issue: nullableString.optional().default(null),
  visible_expense_count: numeric,
  actionable_expense_count: numeric,
  match_type: z.string(),
});

export const debugEmployeeSearchSchema = z.object({
  contract: z.literal("debug-review-employee-search"),
  version: z.literal(1),
  query: nullableString,
  matches: z.array(debugEmployeeMatchSchema),
});

/**
 * Opaque keyset cursor. `sk` is the single finite sort key the server derives;
 * `sort` pins the cursor to the sort that produced it so a sort change cannot
 * silently return the wrong slice.
 */
export const debugReviewCursorSchema = z.object({
  sk: z.union([z.number(), z.string()]).transform(String),
  id: z.string().min(1),
  sort: debugReviewSortSchema.optional(),
});

export const debugCustomFieldSchema = z.object({
  source: z.string(),
  field_id: z.string(),
  field_key: z.string(),
  label: nullableString,
  value: nullableString,
});

export const debugReviewQueueItemSchema = z.object({
  id: z.string().min(1),
  transaction_number: nullableString,
  batch_id: nullableString,
  user_id: z.string(),
  employee_name: z.string(),
  employee_id: nullableString,
  employee_email: nullableString,
  identity_source: z.string(),
  identity_issue: nullableString,
  current_balance: numeric,
  title: z.string().catch(""),
  purpose: nullableString,
  category: nullableString,
  destination: nullableString,
  total_amount: nullableNumeric,
  status: z.string(),
  approval_tier: nullableString,
  created_at: nullableString,
  trip_start: nullableString,
  is_resubmitted: z.boolean(),
  was_reviewer_corrected: z.boolean(),
  is_actionable: z.boolean(),
  actionable_stage: z.string().optional().default("engineer"),
  actionable_reason: z.string().optional().default("not_actionable"),
  available_actions: z.array(z.string()).optional().default([]),
  view_only: z.boolean().optional().default(true),
  /**
   * Whole-batch state, computed server-side across EVERY assigned line of the
   * batch - not the lines on this page. Null for non-batch rows, and null from
   * a server older than 20260802030000, which the client renders as the neutral
   * pending treatment rather than falsely claiming a batch is finished.
   */
  batch_total_lines: nullableNumeric.optional().default(null),
  batch_actionable_lines: nullableNumeric.optional().default(null),
  batch_non_actionable_lines: nullableNumeric.optional().default(null),
  batch_action_state: z
    .enum(["all_pending", "partial", "all_done"])
    .nullable()
    .optional()
    .default(null)
    .catch(null),
  custom_fields: z.array(debugCustomFieldSchema).catch([]),
});

export const debugSelectedEmployeeSchema = z.object({
  user_id: z.string(),
  employee_name: z.string(),
  employee_id: nullableString,
  identity_source: z.string().optional().default("current_profile"),
  identity_issue: nullableString.optional().default(null),
  visible_expense_count: numeric,
  actionable_expense_count: numeric,
});

export const debugReviewPageSchema = z.object({
  contract: z.literal("debug-review-queue"),
  version: z.literal(1),
  filtered_total: numeric,
  /** Server-computed from filtered_total and page size. Optional pre-20260802010000. */
  total_pages: numeric.optional().default(0),
  has_more: z.boolean(),
  next_cursor: debugReviewCursorSchema.nullable(),
  items: z.array(debugReviewQueueItemSchema),
  selected_employee: debugSelectedEmployeeSchema.nullable().optional().default(null),
  caller: z
    .object({
      role: nullableString,
      hierarchy_enabled: z.boolean(),
      team_leader_enabled: z.boolean(),
      executive_enabled: z.boolean(),
    })
    .optional()
    .default({
      role: null,
      hierarchy_enabled: false,
      team_leader_enabled: false,
      executive_enabled: false,
    }),
  scope_summary: z.object({
    /** Complete reviewer-assigned scope — the population the list pages through. */
    assigned_to_me: numeric,
    scope_total: numeric.optional().default(0),
    /** Every assigned row whose review workflow is NOT terminal. */
    pending_review: numeric,
    /** Every assigned row whose review workflow IS terminal. */
    completed_review: numeric.optional().default(0),
    verified: numeric,
    approved: numeric.optional().default(0),
    rejected: numeric.optional().default(0),
    paid: numeric.optional().default(0),
    other_terminal: numeric.optional().default(0),
    /** Subset of pending the caller can act on right now. Not the same as pending. */
    actionable_now: numeric.optional().default(0),
    active_not_actionable_now: numeric.optional().default(0),
    directly_assigned: numeric.optional().default(0),
    hierarchy_assigned: numeric.optional().default(0),
    team_assigned: numeric.optional().default(0),
    admin_scope_assigned: numeric.optional().default(0),
    /** Any status outside the known pending/terminal vocabulary. Must be 0. */
    unclassified: numeric.optional().default(0),
    /** A reviewer must never review their own expense. Must be 0. */
    self_owned_visible_expenses: numeric.optional().default(0),
    /** Rows the old predicate showed that carry no assignment reason. Must be 0. */
    visible_without_assignment_reason: numeric.optional().default(0),
    total_amount: numeric,
    /** Server-computed: both invariants hold AND unclassified is zero. */
    reconciliation_ok: z.boolean().optional().default(false),
  }),
  /**
   * The same reconciled shape over the FILTERED population - the exact rows the
   * table pages through, aggregated before the cursor and the page limit.
   *
   * Nullable on purpose. A server older than 20260802030000 omits it, and the
   * cards must then say so rather than render "Completed 0", which would read
   * as a real number.
   */
  filtered_summary: z
    .object({
      assigned_to_me: numeric,
      pending_review: numeric,
      completed_review: numeric,
      verified: numeric,
      approved: numeric,
      rejected: numeric,
      paid: numeric.optional().default(0),
      other_terminal: numeric.optional().default(0),
      actionable_now: numeric,
      active_not_actionable_now: numeric,
      unclassified: numeric.optional().default(0),
      total_amount: numeric,
      reconciliation_ok: z.boolean().optional().default(false),
    })
    .nullable()
    .optional()
    .default(null),
  diagnostics: z.object({
    page_returned: numeric,
    identity_resolved: numeric,
    identity_unresolved: numeric,
    batches_on_page: numeric.optional().default(0),
    schema_revision: z.string().optional().default(""),
  }),
});

export const debugFilterOptionsSchema = z.object({
  contract: z.literal("debug-review-filter-options"),
  version: z.literal(1),
  statuses: z.array(z.string()),
  sorts: z.array(z.string()),
  time_periods: z.array(z.string()),
  categories: z.array(z.string().nullable()).transform((a) =>
    a.filter((c): c is string => typeof c === "string" && c.length > 0),
  ),
  employees: z.array(
    z.object({
      user_id: z.string(),
      employee_name: z.string(),
      employee_id: nullableString,
    }),
  ),
  custom_fields: z.array(
    z.object({
      source: z.string(),
      field_id: z.string(),
      field_key: z.string(),
      label: nullableString,
      options: z.unknown().nullable().catch(null),
      // Tree metadata (20260802010000). Without it every branch renders as its
      // own dropdown, which is what produced ten-plus identical controls.
      parent_template_id: nullableString.optional().default(null),
      parent_branch_id: nullableString.optional().default(null),
      parent_option_value: nullableString.optional().default(null),
      display_order: numeric.optional().default(0),
      depth: numeric.optional().default(0),
      is_root: z.boolean().optional().default(true),
    }),
  ),
});

/** Cursor anchor for an explicit page jump (20260802010000). */
export const debugPageAnchorSchema = z.object({
  contract: z.literal("debug-review-page-anchor"),
  version: z.literal(1),
  target_page: numeric,
  page_size: numeric,
  filtered_total: numeric,
  total_pages: numeric,
  cursor: debugReviewCursorSchema.nullable(),
});

export const debugExpenseDetailSchema = z.object({
  contract: z.literal("debug-review-expense-detail"),
  version: z.literal(1),
  expense: z.record(z.unknown()),
  employee: z.object({
    user_id: nullableString.optional().default(null),
    employee_name: z.string(),
    employee_id: nullableString.optional().default(null),
    employee_email: nullableString.optional().default(null),
    current_balance: numeric.optional().default(0),
    identity_source: z.string(),
    identity_issue: nullableString.optional().default(null),
  }),
  custom_fields: z.array(debugCustomFieldSchema).catch([]),
  attachments: z
    .array(
      z.object({
        id: z.string(),
        filename: nullableString,
        content_type: nullableString,
        file_url: nullableString,
        storage_path: nullableString.optional().default(null),
        durability_status: nullableString.optional().default(null),
      }),
    )
    .catch([]),
  deleted_attachment_count: numeric.optional().default(0),
  timeline: z
    .array(
      z.object({
        id: z.string(),
        action: z.string(),
        comment: nullableString,
        user_id: nullableString,
        created_at: nullableString,
      }),
    )
    .catch([]),
  corrections: z
    .array(
      z.object({
        id: z.string(),
        edited_by: nullableString,
        reason: nullableString,
        created_at: nullableString,
      }),
    )
    .catch([]),
  actionability: z
    .object({
      is_actionable: z.boolean(),
      actionable_stage: z.string(),
      actionable_reason: z.string(),
      available_actions: z.array(z.string()),
      view_only: z.boolean(),
    })
    .optional()
    .default({
      is_actionable: false,
      actionable_stage: "engineer",
      actionable_reason: "unknown",
      available_actions: [],
      view_only: true,
    }),
});
