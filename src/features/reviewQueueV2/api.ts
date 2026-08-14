/**
 * Review Queue V2 RPC layer (DOC-079).
 *
 * The only place in the client that talks to the V2 contracts. Every response is a
 * single JSONB document, validated at runtime before it reaches React — a malformed
 * or truncated payload raises rather than rendering a half-built table.
 *
 * The Supabase cast is deliberately confined to `callRpc` below: the generated types
 * are stale and do not know these RPCs, and DOC-079 forbids hand-editing them to
 * pretend otherwise.
 */

import { supabase } from "@/integrations/supabase/client";
import { REVIEW_QUEUE_REQUIRED_API_VERSION } from "@/config/reviewQueueFeature";
import {
  REVIEW_QUEUE_SORTS,
  ReviewQueueAuthorizationError,
  ReviewQueueCapabilityError,
  ReviewQueueNetworkError,
  ReviewQueueTimeoutError,
  ReviewQueueUnknownError,
  ReviewQueueValidationError,
  type ReviewCustomFieldValueV2,
  type ReviewFilterOptionsV2,
  type ReviewQueueCursorV2,
  type ReviewQueueFiltersV2,
  type ReviewQueueItemV2,
  type ReviewQueuePageV2,
  type ReviewQueueSortV2,
  type ReviewIdentitySourceV2,
  IDENTITY_SOURCES,
} from "./types";

/** PostgREST "function not found" — the V2 migration has not been applied. */
const RPC_MISSING = "PGRST202";
/** PostgreSQL statement timeout. */
const STATEMENT_TIMEOUT = "57014";

type RpcError = { code?: string; message?: string } | null;

function translateError(error: RpcError): Error {
  const code = error?.code ?? "";
  const message = error?.message ?? "";
  if (code === RPC_MISSING || /review_queue_api_version|get_review_queue_page_v2/.test(message)) {
    return new ReviewQueueCapabilityError();
  }
  if (code === "42501" || code === "28000" || /not authorized|not an active member/i.test(message)) {
    return new ReviewQueueAuthorizationError();
  }
  if (code === STATEMENT_TIMEOUT || /timeout/i.test(message)) {
    return new ReviewQueueTimeoutError();
  }
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return new ReviewQueueNetworkError();
  }
  if (code === "22023") {
    return new ReviewQueueValidationError(message);
  }
  // Never surface a raw database error to an ordinary reviewer.
  return new ReviewQueueUnknownError();
}

async function callRpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  // Single, isolated cast: these RPCs are absent from the stale generated types.
  const client = supabase as unknown as {
    rpc: (name: string, params: Record<string, unknown>) => Promise<{ data: unknown; error: RpcError }>;
  };
  const { data, error } = await client.rpc(fn, args);
  if (error) throw translateError(error);
  return data as T;
}

// ── Runtime validation ──────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseCustomFields(raw: unknown): ReviewCustomFieldValueV2[] {
  if (!Array.isArray(raw)) return [];
  const out: ReviewCustomFieldValueV2[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const source = entry.source;
    if (source !== "template" && source !== "branch") continue;
    if (typeof entry.field_id !== "string") continue;
    out.push({
      source,
      field_id: entry.field_id,
      field_key: typeof entry.field_key === "string" ? entry.field_key : entry.field_id,
      label: typeof entry.label === "string" ? entry.label : entry.field_id,
      value: entry.value == null ? "" : String(entry.value),
    });
  }
  return out;
}

function parseItem(raw: unknown): ReviewQueueItemV2 {
  if (!isRecord(raw) || typeof raw.id !== "string") {
    throw new ReviewQueueValidationError("Review queue row is missing its id.");
  }
  const num = (v: unknown, fallback: number | null): number | null => {
    if (v == null) return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const stage = raw.actionable_stage;
  return {
    id: raw.id,
    transaction_number: typeof raw.transaction_number === "string" ? raw.transaction_number : null,
    batch_id: typeof raw.batch_id === "string" ? raw.batch_id : null,
    user_id: typeof raw.user_id === "string" ? raw.user_id : "",
    employee_name: typeof raw.employee_name === "string" ? raw.employee_name : "Unknown employee",
    employee_email: typeof raw.employee_email === "string" ? raw.employee_email : null,
    employee_id: typeof raw.employee_id === "string" ? raw.employee_id : null,
    // Unknown/absent provenance degrades to "unresolved" rather than being dropped —
    // silently discarding it is how a fabricated identity could go unnoticed.
    identity_source: (IDENTITY_SOURCES as readonly string[]).includes(String(raw.identity_source))
      ? (raw.identity_source as ReviewIdentitySourceV2)
      : "unresolved",
    current_balance: num(raw.current_balance, 0) ?? 0,
    title: typeof raw.title === "string" ? raw.title : "",
    purpose: typeof raw.purpose === "string" ? raw.purpose : null,
    category: typeof raw.category === "string" ? raw.category : null,
    destination: typeof raw.destination === "string" ? raw.destination : null,
    total_amount: num(raw.total_amount, null),
    status: typeof raw.status === "string" ? raw.status : "",
    approval_tier: typeof raw.approval_tier === "string" ? raw.approval_tier : null,
    created_at: typeof raw.created_at === "string" ? raw.created_at : null,
    updated_at: typeof raw.updated_at === "string" ? raw.updated_at : null,
    sort_at: typeof raw.sort_at === "string" ? raw.sort_at : "",
    is_resubmitted: raw.is_resubmitted === true,
    was_reviewer_corrected: raw.was_reviewer_corrected === true,
    is_actionable: raw.is_actionable === true,
    actionable_reason: typeof raw.actionable_reason === "string" ? raw.actionable_reason : null,
    actionable_stage:
      stage === "team_leader" || stage === "executive" || stage === "engineer" || stage === "admin"
        ? stage
        : null,
    custom_fields: parseCustomFields(raw.custom_fields),
  };
}

function parseCursor(raw: unknown): ReviewQueueCursorV2 | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.sort_at !== "string" || typeof raw.id !== "string") return null;
  return {
    sort_at: raw.sort_at,
    id: raw.id,
    total_amount: raw.total_amount == null ? null : String(raw.total_amount),
  };
}

export function parseReviewQueuePage(raw: unknown): ReviewQueuePageV2 {
  if (!isRecord(raw)) throw new ReviewQueueValidationError();
  if (raw.version !== REVIEW_QUEUE_REQUIRED_API_VERSION) {
    throw new ReviewQueueCapabilityError(
      `Review queue returned contract version ${String(raw.version)}, expected ${REVIEW_QUEUE_REQUIRED_API_VERSION}.`,
    );
  }
  if (!Array.isArray(raw.items)) throw new ReviewQueueValidationError("Review queue items missing.");
  const total = Number(raw.total);
  if (!Number.isFinite(total)) throw new ReviewQueueValidationError("Review queue total missing.");
  const sort = raw.sort;
  return {
    version: 2,
    sort: (REVIEW_QUEUE_SORTS as readonly string[]).includes(String(sort))
      ? (sort as ReviewQueueSortV2)
      : "newest",
    page_size: Number(raw.page_size) || 25,
    total,
    next_cursor: parseCursor(raw.next_cursor),
    items: raw.items.map(parseItem),
  };
}

export function parseReviewFilterOptions(raw: unknown): ReviewFilterOptionsV2 {
  if (!isRecord(raw) || raw.version !== REVIEW_QUEUE_REQUIRED_API_VERSION) {
    throw new ReviewQueueValidationError("Filter options response was not version 2.");
  }
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);
  return {
    version: 2,
    statuses: arr(raw.statuses).filter((s): s is string => typeof s === "string"),
    categories: arr(raw.categories).filter((s): s is string => typeof s === "string"),
    employees: arr(raw.employees)
      .filter(isRecord)
      .map((e) => ({
        user_id: String(e.user_id ?? ""),
        name: typeof e.name === "string" ? e.name : "Unknown employee",
        employee_id: typeof e.employee_id === "string" ? e.employee_id : null,
      })),
    custom_fields: arr(raw.custom_fields)
      .filter(isRecord)
      .filter((f) => f.source === "template" || f.source === "branch")
      .map((f) => ({
        source: f.source as "template" | "branch",
        field_id: String(f.field_id ?? ""),
        field_key: typeof f.field_key === "string" ? f.field_key : String(f.field_id ?? ""),
        label: typeof f.label === "string" ? f.label : String(f.field_id ?? ""),
        options: f.options ?? null,
      })),
  };
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function fetchReviewQueueApiVersion(): Promise<number> {
  const raw = await callRpc<unknown>("review_queue_api_version", {});
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new ReviewQueueCapabilityError();
  return n;
}

/** Throws ReviewQueueCapabilityError unless the database is at V2 or newer. */
export async function assertReviewQueueV2Available(): Promise<number> {
  const version = await fetchReviewQueueApiVersion();
  if (version < REVIEW_QUEUE_REQUIRED_API_VERSION) throw new ReviewQueueCapabilityError();
  return version;
}

export async function fetchReviewQueuePage(params: {
  organizationId: string;
  pageSize?: number;
  cursor?: ReviewQueueCursorV2 | null;
  sort?: ReviewQueueSortV2;
  filters?: ReviewQueueFiltersV2;
}): Promise<ReviewQueuePageV2> {
  const f = params.filters ?? {};
  const raw = await callRpc<unknown>("get_review_queue_page_v2", {
    p_organization_id: params.organizationId,
    p_page_size: params.pageSize ?? 25,
    p_cursor: params.cursor ?? null,
    p_sort: params.sort ?? "newest",
    p_search: f.search ?? null,
    p_statuses: f.statuses ?? null,
    p_categories: f.categories ?? null,
    p_user_ids: f.userIds ?? null,
    p_date_from: f.dateFrom ?? null,
    p_date_to: f.dateTo ?? null,
    p_actionable_only: f.actionableOnly ?? false,
    p_custom_filters: f.customFilters ?? [],
  });
  return parseReviewQueuePage(raw);
}

export async function fetchReviewFilterOptions(organizationId: string): Promise<ReviewFilterOptionsV2> {
  const raw = await callRpc<unknown>("get_review_filter_options_v2", {
    p_organization_id: organizationId,
  });
  return parseReviewFilterOptions(raw);
}

export async function fetchReviewExpenseDetail(
  organizationId: string,
  expenseId: string,
): Promise<Record<string, unknown>> {
  const raw = await callRpc<unknown>("get_review_expense_detail_v2", {
    p_organization_id: organizationId,
    p_expense_id: expenseId,
  });
  if (!isRecord(raw) || raw.version !== REVIEW_QUEUE_REQUIRED_API_VERSION) {
    throw new ReviewQueueValidationError("Expense detail response was not version 2.");
  }
  return raw;
}

/**
 * Compatibility shim for shared presentational components that still read
 * `manager_queue_ready`. The V2 contract does not contain that field; this maps
 * server-authoritative actionability onto the old prop name at the edge only.
 */
export function toLegacyRowShape(item: ReviewQueueItemV2): Record<string, unknown> {
  return { ...item, manager_queue_ready: item.is_actionable };
}
