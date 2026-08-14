import type { SupabaseClient } from "@supabase/supabase-js";
import type { ApprovalTier } from "@/lib/approvalHierarchy";
import { chunkArray } from "@/lib/supabaseInQuery";

const REVIEW_EXPENSE_STATUSES = [
  "submitted",
  "verified",
  "approved",
  "rejected",
  "edited",
  "under_review",
  "level_1_verified",
  "level_2_verified",
] as const;

/** Audit actions that mean this reviewer already acted on the expense. */
export const REVIEWER_HISTORY_AUDIT_ACTIONS = [
  "expense_verified",
  "expense_approved",
  "tier_advanced",
  "expense_rejected",
] as const;

export type HierarchyReviewerExpenseRow = Record<string, unknown>;

/**
 * Page size for the legacy (cursor-less) RPC and its table fallback.
 * Kept below PostgREST's 1000-row default cap so a full page is always an
 * explicit choice rather than a silent server-side truncation.
 */
export const LEGACY_RPC_PAGE_SIZE = 500;
/** 6,088 rows / 500 = ~13 pages. 200 bounds a runaway loop with wide headroom. */
export const LEGACY_RPC_MAX_PAGES = 200;

/**
 * PostgREST .or() filter — any expense assigned to this reviewer (with or without approval_tier).
 * Notifications use assigned_reviewer_id or legacy assigned_engineer_id; do not require tier in the query.
 */
export function buildHierarchyReviewerExpenseOrFilter(userId: string): string {
  return [
    `assigned_reviewer_id.eq.${userId}`,
    `assigned_engineer_id.eq.${userId}`,
  ].join(",");
}

/** @deprecated Tier-specific filter excluded legacy-assigned expenses; use buildHierarchyReviewerExpenseOrFilter. */
export function buildHierarchyReviewerExpenseOrFilterWithTier(
  userId: string,
  _tier: ApprovalTier,
): string {
  return buildHierarchyReviewerExpenseOrFilter(userId);
}

/** Fallback when approval_hierarchy feature is off but user is team_leader / executive. */
export function buildHierarchyReviewerLegacyOrFilter(userId: string): string {
  return buildHierarchyReviewerExpenseOrFilter(userId);
}

export type FetchHierarchyReviewerExpensesParams = {
  organizationId: string;
  userId: string;
  dateFilter?: Date | null;
  /** When set, cap results to this many rows (most-recent first). Omit to fetch all. */
  fetchLimit?: number;
};

function mergeExpenseRowsById(
  batches: HierarchyReviewerExpenseRow[][],
): HierarchyReviewerExpenseRow[] {
  const byId = new Map<string, HierarchyReviewerExpenseRow>();
  for (const batch of batches) {
    for (const row of batch) {
      const id = row.id as string | undefined;
      if (id) byId.set(id, row);
    }
  }
  return [...byId.values()];
}

function filterRowsByDate(
  rows: HierarchyReviewerExpenseRow[],
  dateFilter?: Date | null,
): HierarchyReviewerExpenseRow[] {
  if (!dateFilter) return rows;
  const minTs = dateFilter.toISOString();
  return rows.filter((row) => {
    const created = row.created_at as string | undefined;
    return created ? created >= minTs : true;
  });
}

function sortReviewRows(rows: HierarchyReviewerExpenseRow[]): HierarchyReviewerExpenseRow[] {
  return [...rows].sort((a, b) => {
    const ta = new Date(String(a.updated_at ?? a.created_at ?? 0)).getTime();
    const tb = new Date(String(b.updated_at ?? b.created_at ?? 0)).getTime();
    return tb - ta;
  });
}

async function fetchAssignedHierarchyExpenses(
  supabase: SupabaseClient,
  params: FetchHierarchyReviewerExpensesParams,
): Promise<HierarchyReviewerExpenseRow[]> {
  const { organizationId, dateFilter, fetchLimit } = params;

  // The legacy RPC has no keyset cursor, so it is paged with explicit ranges.
  // A request with no .range() is capped by PostgREST at 1000 rows and there is
  // no way to tell that truncation apart from a genuinely small result set —
  // that is exactly how this page used to stop at 1000 assigned rows.
  const pageSize = LEGACY_RPC_PAGE_SIZE;
  const collected: HierarchyReviewerExpenseRow[] = [];
  let rpcFailed: { message: string } | null = null;

  for (let page = 0; page < LEGACY_RPC_MAX_PAGES; page++) {
    const from = page * pageSize;
    const remaining = fetchLimit ? fetchLimit - collected.length : pageSize;
    if (remaining <= 0) break;
    const size = Math.min(pageSize, remaining);

    const { data, error } = await supabase
      .rpc("list_hierarchy_reviewer_expenses", { p_organization_id: organizationId })
      .range(from, from + size - 1);

    if (error) {
      rpcFailed = error;
      break;
    }

    const rows = (data ?? []) as HierarchyReviewerExpenseRow[];
    collected.push(...rows);

    if (rows.length < size) break; // short page — end of data
  }

  if (!rpcFailed) {
    return collected;
  }

  console.warn(
    "list_hierarchy_reviewer_expenses RPC failed, using direct query:",
    rpcFailed.message,
  );

  // Table fallback is paged for the same reason as the RPC above: an unbounded
  // select would be silently capped at 1000 rows.
  const fallbackRows: HierarchyReviewerExpenseRow[] = [];
  for (let page = 0; page < LEGACY_RPC_MAX_PAGES; page++) {
    const from = page * pageSize;
    const remaining = fetchLimit ? fetchLimit - fallbackRows.length : pageSize;
    if (remaining <= 0) break;
    const size = Math.min(pageSize, remaining);

    let query = supabase
      .from("expenses")
      .select("*")
      .eq("organization_id", organizationId)
      .in("status", [...REVIEW_EXPENSE_STATUSES])
      .or(buildHierarchyReviewerExpenseOrFilter(params.userId));

    if (dateFilter) {
      query = query.gte("created_at", dateFilter.toISOString());
    }

    const { data, error } = await query
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + size - 1);

    if (error) throw error;

    const rows = (data ?? []) as HierarchyReviewerExpenseRow[];
    fallbackRows.push(...rows);
    if (rows.length < size) break;
  }

  return fallbackRows;
}

async function fetchReviewerHistoryExpenseIds(
  supabase: SupabaseClient,
  organizationId: string,
  userId: string,
): Promise<string[]> {
  const runQuery = async (withOrgFilter: boolean) => {
    let query = supabase
      .from("audit_logs")
      .select("expense_id")
      .eq("user_id", userId)
      .in("action", [...REVIEWER_HISTORY_AUDIT_ACTIONS]);

    if (withOrgFilter) {
      query = query.eq("organization_id", organizationId);
    }

    return query;
  };

  let { data, error } = await runQuery(true);
  if (error && /organization_id|column/i.test(error.message)) {
    ({ data, error } = await runQuery(false));
  }
  if (error) {
    console.warn("fetchReviewerHistoryExpenseIds:", error.message);
    return [];
  }

  return [
    ...new Set(
      (data ?? [])
        .map((row) => row.expense_id as string | null)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
}

async function fetchExpensesByIds(
  supabase: SupabaseClient,
  organizationId: string,
  expenseIds: string[],
  dateFilter?: Date | null,
): Promise<HierarchyReviewerExpenseRow[]> {
  if (expenseIds.length === 0) return [];

  const batches = await Promise.all(
    chunkArray(expenseIds).map(async (batch) => {
      let query = supabase
        .from("expenses")
        .select("*")
        .eq("organization_id", organizationId)
        .in("status", [...REVIEW_EXPENSE_STATUSES])
        .in("id", batch);

      if (dateFilter) {
        query = query.gte("created_at", dateFilter.toISOString());
      }

      const { data, error } = await query;
      if (error) {
        console.warn("fetchExpensesByIds:", error.message);
        return [] as HierarchyReviewerExpenseRow[];
      }
      return (data ?? []) as HierarchyReviewerExpenseRow[];
    }),
  );

  return batches.flat();
}

/** Primary fetch for TL/executive review queue (RPC, then table fallback). */
export async function fetchHierarchyReviewerExpenses(
  supabase: SupabaseClient,
  params: FetchHierarchyReviewerExpensesParams,
): Promise<HierarchyReviewerExpenseRow[]> {
  const { organizationId, userId, dateFilter, fetchLimit } = params;

  const [assignedRows, historyIds] = await Promise.all([
    fetchAssignedHierarchyExpenses(supabase, params),
    fetchReviewerHistoryExpenseIds(supabase, organizationId, userId),
  ]);

  const assignedIds = new Set(
    assignedRows
      .map((row) => row.id as string | undefined)
      .filter((id): id is string => Boolean(id)),
  );
  const missingHistoryIds = historyIds.filter((id) => !assignedIds.has(id));
  const historyRows = await fetchExpensesByIds(
    supabase,
    organizationId,
    missingHistoryIds,
    dateFilter,
  );

  let rows = sortReviewRows(filterRowsByDate(mergeExpenseRowsById([assignedRows, historyRows]), dateFilter));
  if (fetchLimit && rows.length > fetchLimit) {
    rows = rows.slice(0, fetchLimit);
  }
  return rows;
}
