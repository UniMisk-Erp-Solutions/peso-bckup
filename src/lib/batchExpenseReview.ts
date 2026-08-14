import { ADMIN_APPROVABLE_STATUSES } from "@/lib/approvalHierarchy";
import { supabase } from "@/integrations/supabase/client";
import { chunkArray } from "@/lib/supabaseInQuery";

/**
 * expense_form_field_values carries 3 overlapping permissive RLS SELECT
 * policies, each with a correlated subquery against the (also RLS-protected)
 * expenses table. A single unchunked `.in("expense_id", ids)` fetch caused a
 * 43-minute, 1,378-request production incident (2026-08-13) once retried
 * without backoff: every attempt raced the 8s authenticated statement_timeout
 * and consumed enough DB CPU that other reviewers' Search/Approve requests
 * degraded too. Chunk size of 10 is proven safe via EXPLAIN ANALYZE on
 * Production (~25ms for 10 ids under normal load) — not an arbitrary choice.
 */
const CUSTOM_FIELD_FETCH_CHUNK_SIZE = 10;

export type BatchReviewExpenseRow = {
  id: string;
  title: string;
  category: string | null;
  purpose: string | null;
  destination: string;
  trip_start: string;
  total_amount: number;
  status: string;
  transaction_number?: string | null;
  user_id: string;
  user_name: string;
  user_email: string;
  wasReviewerCorrected?: boolean;
  /** Org-specific custom form field values: display label → display value. */
  customFields?: Record<string, string>;
};

export type BatchCustomFieldResult =
  | { status: "ok"; columns: string[]; valuesByExpenseId: Map<string, Record<string, string>> }
  | { status: "error"; error: string }
  | { status: "aborted" };

export type OrderColumnsInput = {
  tplRows: ReadonlyArray<{ id: string; name: string; field_key?: string | null }>;
  branchRows: ReadonlyArray<{
    id: string;
    name: string;
    display_order?: number | null;
    parent_template_id?: string | null;
  }>;
  /** Rows from expense_category_form_fields — may have duplicates per template (one per category). */
  formOrderRows: ReadonlyArray<{ template_id: string; display_order?: number | null }>;
  /** Only labels present in this set are included in the output. */
  columnSet: ReadonlySet<string>;
};

/**
 * Orders custom-field column labels for Batch Review:
 *  1. Parent templates (those referenced as parent_template_id by any branch) + their branches,
 *     sorted by configured display_order from expense_category_form_fields.
 *  2. Leaf templates (no branches — typically route/location fields), sorted by display_order.
 *  3. Any remaining labels not yet placed (safety fallback for orphan branches).
 *
 * Pure function — no side effects, no I/O.
 */
export function orderBatchCustomFieldColumns({
  tplRows,
  branchRows,
  formOrderRows,
  columnSet,
}: OrderColumnsInput): string[] {
  const tplName = new Map(tplRows.map((t) => [t.id, t.name]));
  const branchNameMap = new Map(branchRows.map((b) => [b.id, b.name]));

  // Minimum display_order per template across all category assignments
  const templateDisplayOrder = new Map<string, number>();
  for (const r of formOrderRows) {
    const cur = templateDisplayOrder.get(r.template_id);
    const val = r.display_order ?? Number.MAX_SAFE_INTEGER;
    if (cur === undefined || val < cur) templateDisplayOrder.set(r.template_id, val);
  }

  // Templates referenced as parent_template_id in any fetched branch
  const parentTemplateIdSet = new Set<string>(
    branchRows
      .filter((b) => b.parent_template_id != null)
      .map((b) => b.parent_template_id as string),
  );

  // Branches grouped by parent, sorted by branch display_order asc
  const branchesPerParent = new Map<
    string,
    Array<{ id: string; display_order?: number | null }>
  >();
  for (const b of branchRows) {
    if (!b.parent_template_id) continue;
    const list = branchesPerParent.get(b.parent_template_id) ?? [];
    list.push(b);
    branchesPerParent.set(b.parent_template_id, list);
  }
  for (const [pid, branches] of branchesPerParent) {
    branchesPerParent.set(
      pid,
      [...branches].sort(
        (a, b) =>
          (a.display_order ?? Number.MAX_SAFE_INTEGER) -
          (b.display_order ?? Number.MAX_SAFE_INTEGER),
      ),
    );
  }

  const byDisplayOrder = <T extends { id: string }>(rows: ReadonlyArray<T>) =>
    [...rows].sort(
      (a, b) =>
        (templateDisplayOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
        (templateDisplayOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER),
    );

  const parentTplRows = tplRows.filter((t) => parentTemplateIdSet.has(t.id));
  const leafTplRows = tplRows.filter((t) => !parentTemplateIdSet.has(t.id));

  const ordered: string[] = [];

  for (const tpl of byDisplayOrder(parentTplRows)) {
    const label = tplName.get(tpl.id);
    if (label && columnSet.has(label)) ordered.push(label);
    for (const branch of branchesPerParent.get(tpl.id) ?? []) {
      const bLabel = branchNameMap.get(branch.id);
      if (bLabel && columnSet.has(bLabel)) ordered.push(bLabel);
    }
  }

  for (const tpl of byDisplayOrder(leafTplRows)) {
    const label = tplName.get(tpl.id);
    if (label && columnSet.has(label)) ordered.push(label);
  }

  const placedSet = new Set(ordered);
  for (const col of columnSet) {
    if (!placedSet.has(col)) ordered.push(col);
  }

  return ordered;
}

type CustomFieldValueRow = {
  expense_id: string;
  field_value: string | null;
  template_id: string | null;
  branch_field_id: string | null;
};

/** One in-flight fetch per organizationId+batchId — concurrent callers share it instead of duplicating requests. */
const inFlightByKey = new Map<string, Promise<BatchCustomFieldResult>>();

/**
 * Fetches expense_form_field_values for a batch in small sequential chunks
 * (never Promise.all — see CUSTOM_FIELD_FETCH_CHUNK_SIZE). Stops and surfaces
 * an explicit error on the first failed/aborted chunk rather than returning
 * partial data as if it were complete.
 */
async function fetchValueRowsChunked(
  expenseIds: string[],
  organizationId: string,
  signal?: AbortSignal,
): Promise<{ status: "ok"; rows: CustomFieldValueRow[] } | { status: "error"; error: string } | { status: "aborted" }> {
  const rows: CustomFieldValueRow[] = [];

  for (const chunk of chunkArray(expenseIds, CUSTOM_FIELD_FETCH_CHUNK_SIZE)) {
    if (signal?.aborted) return { status: "aborted" };

    const { data, error } = await supabase
      .from("expense_form_field_values")
      .select("expense_id, field_value, template_id, branch_field_id")
      .in("expense_id", chunk)
      .eq("organization_id", organizationId);

    if (signal?.aborted) return { status: "aborted" };

    if (error) {
      // Never silently treat a failed chunk as "no custom fields" — the caller must
      // know this batch's custom-field data is incomplete/untrustworthy, not empty.
      return { status: "error", error: error.message || "Failed to load custom fields" };
    }

    rows.push(...((data || []) as CustomFieldValueRow[]));
  }

  return { status: "ok", rows };
}

/**
 * Bulk-fetch custom form field values for all expenses in a batch.
 * Returns the sorted unique column names and a per-expense value map.
 *
 * The expense_form_field_values fetch is chunked and run strictly sequentially
 * (max concurrency 1) — this table's RLS policies are expensive enough that an
 * unbounded/parallel fetch pattern previously caused a Production outage
 * (see CUSTOM_FIELD_FETCH_CHUNK_SIZE comment). This function never retries
 * automatically; a caller wanting a retry must invoke it again explicitly
 * (e.g. from a user-facing Retry action).
 *
 * Concurrent calls for the same organizationId+batchId share one in-flight
 * request (single-flight) instead of issuing duplicate DB traffic.
 */
export async function fetchBatchExpenseCustomFields(
  expenseIds: string[],
  organizationId: string,
  batchId: string,
  signal?: AbortSignal,
): Promise<BatchCustomFieldResult> {
  const uniqueIds = [...new Set(expenseIds.filter((id) => Boolean(id)))];
  if (!uniqueIds.length) return { status: "ok", columns: [], valuesByExpenseId: new Map() };

  const key = `${organizationId}:${batchId}`;
  const existing = inFlightByKey.get(key);
  if (existing) return existing;

  const promise = (async (): Promise<BatchCustomFieldResult> => {
    const valueResult = await fetchValueRowsChunked(uniqueIds, organizationId, signal);
    if (valueResult.status !== "ok") return valueResult;

    const rows = valueResult.rows;
    const templateIds = [...new Set(rows.flatMap((r) => (r.template_id ? [r.template_id] : [])))];
    const branchIds = [...new Set(rows.flatMap((r) => (r.branch_field_id ? [r.branch_field_id] : [])))];

    if (signal?.aborted) return { status: "aborted" };

    const [{ data: tplRows }, { data: branchRows }, { data: formOrderRows }] = await Promise.all([
      templateIds.length
        ? supabase.from("expense_form_field_templates").select("id, name, field_key").in("id", templateIds)
        : Promise.resolve({ data: [] as { id: string; name: string; field_key: string | null }[] }),
      branchIds.length
        ? supabase
            .from("expense_form_field_option_branches")
            .select("id, name, display_order, parent_template_id")
            .in("id", branchIds)
        : Promise.resolve(
            { data: [] as { id: string; name: string; display_order: number | null; parent_template_id: string | null }[] },
          ),
      templateIds.length
        ? supabase
            .from("expense_category_form_fields")
            .select("template_id, display_order")
            .eq("organization_id", organizationId)
            .in("template_id", templateIds)
        : Promise.resolve({ data: [] as { template_id: string; display_order: number | null }[] }),
    ]);

    if (signal?.aborted) return { status: "aborted" };

    const tplName = new Map((tplRows || []).map((t) => [t.id, t.name as string]));
    const branchName = new Map((branchRows || []).map((b) => [b.id, b.name as string]));

    const valuesByExpenseId = new Map<string, Record<string, string>>();
    const columnSet = new Set<string>();

    for (const row of rows) {
      const raw = String(row.field_value ?? "").trim();
      // Only skip truly empty values. "false" is a valid checkbox-unchecked value
      // and must be preserved so reviewers can see the field was explicitly unchecked.
      if (!raw) continue;

      const label =
        (row.template_id ? tplName.get(row.template_id) : undefined) ||
        (row.branch_field_id ? branchName.get(row.branch_field_id) : undefined) ||
        "";
      if (!label) continue;

      columnSet.add(label);
      const entry = valuesByExpenseId.get(row.expense_id) ?? {};
      entry[label] = raw === "true" ? "Yes" : raw === "false" ? "No" : raw;
      valuesByExpenseId.set(row.expense_id, entry);
    }

    const columns = orderBatchCustomFieldColumns({
      tplRows: tplRows ?? [],
      branchRows: branchRows ?? [],
      formOrderRows: formOrderRows ?? [],
      columnSet,
    });

    return { status: "ok", columns, valuesByExpenseId };
  })();

  inFlightByKey.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlightByKey.delete(key);
  }
}

export type BatchReviewAction = "verify" | "approve" | "reject";

export function adminActionsForExpense(status: string): BatchReviewAction[] {
  if (status === "approved" || status === "rejected") return [];
  if (status === "submitted" || status === "edited") return ["reject", "verify", "approve"];
  if ((ADMIN_APPROVABLE_STATUSES as readonly string[]).includes(status)) {
    return ["reject", "approve"];
  }
  return ["reject"];
}

export function engineerActionsForExpense(
  status: string,
  amount: number,
  approvalLimit: number,
): BatchReviewAction[] {
  if (status === "approved" || status === "rejected") return [];
  if (status === "level_2_verified") return ["reject", "approve"];
  if (status === "submitted" || status === "edited") {
    if (amount <= approvalLimit) return ["reject", "approve"];
    return ["reject", "verify"];
  }
  return [];
}

export function hierarchyReviewerActionsForExpense(
  status: string,
  role: "team_leader" | "executive",
): BatchReviewAction[] {
  if (status === "approved" || status === "rejected") return [];
  // Mirrors engineerActionsForExpense's level_2_verified case one tier earlier:
  // an executive verifying Level 2 acts on rows already at level_1_verified,
  // not on freshly submitted/edited rows (those belong to the team_leader).
  if (role === "executive" && status === "level_1_verified") return ["reject", "verify"];
  if (status === "submitted" || status === "edited") return ["reject", "verify"];
  return [];
}

export type BatchReviewRole =
  | "admin"
  | "engineer"
  | "team_leader"
  | "executive"
  | "employee";

export function actionsForExpenseByRole(
  status: string,
  amount: number,
  role: BatchReviewRole,
  engineerApprovalLimit: number,
): BatchReviewAction[] {
  if (role === "employee") return [];
  if (role === "admin") return adminActionsForExpense(status);
  if (role === "team_leader" || role === "executive") {
    return hierarchyReviewerActionsForExpense(status, role);
  }
  return engineerActionsForExpense(status, amount, engineerApprovalLimit);
}

export function expensesEligibleForBatchAction(
  expenses: BatchReviewExpenseRow[],
  action: BatchReviewAction,
  role: BatchReviewRole,
  engineerApprovalLimit: number,
): BatchReviewExpenseRow[] {
  return expenses.filter((e) => {
    const actions = actionsForExpenseByRole(
      e.status,
      Number(e.total_amount),
      role,
      engineerApprovalLimit,
    );
    return actions.includes(action);
  });
}

export function batchReviewActionLabel(action: BatchReviewAction, count: number): string {
  const verb =
    action === "verify" ? "Verify" : action === "approve" ? "Approve" : "Reject";
  return `${verb} ${count} expense${count === 1 ? "" : "s"}`;
}
