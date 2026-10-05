/**
 * Review RETURN cache (DOC-080 §9-§15).
 *
 * A short-lived, session-scoped snapshot of the Review LIST currently on screen,
 * saved just before navigating into a Review child flow (Review Batch / expense)
 * so that Back can repaint the list INSTANTLY and then silently background-refresh
 * — instead of showing a full "Loading expenses…" screen while a fresh query
 * runs. Stale-while-revalidate for display speed only; it is NEVER a financial
 * authority (approval always re-authorizes server-side, §15).
 *
 * Safety rules encoded here:
 *  - versioned + validated: a corrupt/old snapshot is discarded (§18);
 *  - organization- AND reviewer-scoped: never restores across org/reviewer (§29);
 *  - short TTL (sessionStorage already dies with the tab, §9);
 *  - a max-row guard so we never blow the storage quota (§11);
 *  - contains only LIST rows + query identity — no attachments, audit logs,
 *    receipt blobs, tokens or detail payloads (§10).
 */

export const REVIEW_RETURN_CACHE_VERSION = 2 as const;
export const REVIEW_RETURN_CACHE_TTL_MS = 10 * 60 * 1000;
/** Filtered mode is bounded (~300); normal page holds fewer. Guard the quota. */
export const REVIEW_RETURN_CACHE_MAX_ROWS = 400;

export type ReviewReturnCache = {
  version: typeof REVIEW_RETURN_CACHE_VERSION;
  organizationId: string;
  reviewerUserId: string;
  mode: "normal" | "filtered";
  /** Identity of the query these rows belong to; a mismatch on return is ignored. */
  queryKey: string;
  rows: unknown[];
  totalAvailable: number | null;
  filteredResultCount: number | null;
  allExpensesLoaded: boolean;
  truncated: boolean;
  currentPage: number;
  savedAt: number;
};

function storageKey(organizationId: string, reviewerUserId: string): string {
  return `pesowise:review-return-cache:v${REVIEW_RETURN_CACHE_VERSION}:${organizationId}:${reviewerUserId}`;
}

function getStore(): Storage | null {
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage : null;
  } catch {
    return null;
  }
}

/** Build a stable query-identity string from the committed query state. */
export function reviewQueryKey(input: {
  mode: "normal" | "filtered";
  employeeUserId: string | null;
  generalSearch: string | null;
  statusFilter: string;
  timePeriod: string;
  /** Exact expense-month filter; distinct months must never share identity (§14). */
  expenseMonth?: string;
  sortBy: string;
  sortOrder: string;
}): string {
  return [
    input.mode,
    input.employeeUserId ?? "",
    (input.generalSearch ?? "").trim().toLowerCase(),
    input.statusFilter,
    input.timePeriod,
    input.expenseMonth ?? "all",
    input.sortBy,
    input.sortOrder,
  ].join("|");
}

export function saveReviewReturnCache(cache: ReviewReturnCache): void {
  const store = getStore();
  if (!store) return;
  // Never persist an oversized list — fall back to the network path on return
  // rather than risk a QuotaExceeded that breaks navigation (§11).
  if (cache.rows.length > REVIEW_RETURN_CACHE_MAX_ROWS) {
    clearReviewReturnCache(cache.organizationId, cache.reviewerUserId);
    return;
  }
  try {
    store.setItem(storageKey(cache.organizationId, cache.reviewerUserId), JSON.stringify(cache));
  } catch {
    // Quota/serialization failure must never break navigation.
  }
}

export function clearReviewReturnCache(organizationId: string, reviewerUserId: string): void {
  getStore()?.removeItem(storageKey(organizationId, reviewerUserId));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function validateReviewReturnCache(
  raw: unknown,
  expect: { organizationId: string; reviewerUserId: string; now: number },
): ReviewReturnCache | null {
  if (!isRecord(raw)) return null;
  if (raw.version !== REVIEW_RETURN_CACHE_VERSION) return null;
  if (raw.organizationId !== expect.organizationId) return null;
  if (raw.reviewerUserId !== expect.reviewerUserId) return null;
  if (typeof raw.savedAt !== "number") return null;
  if (expect.now - raw.savedAt > REVIEW_RETURN_CACHE_TTL_MS || raw.savedAt > expect.now) return null;
  if (!Array.isArray(raw.rows) || raw.rows.length > REVIEW_RETURN_CACHE_MAX_ROWS) return null;
  if (raw.mode !== "normal" && raw.mode !== "filtered") return null;
  if (typeof raw.queryKey !== "string") return null;

  return {
    version: REVIEW_RETURN_CACHE_VERSION,
    organizationId: expect.organizationId,
    reviewerUserId: expect.reviewerUserId,
    mode: raw.mode,
    queryKey: raw.queryKey,
    rows: raw.rows,
    totalAvailable: typeof raw.totalAvailable === "number" ? raw.totalAvailable : null,
    filteredResultCount: typeof raw.filteredResultCount === "number" ? raw.filteredResultCount : null,
    allExpensesLoaded: raw.allExpensesLoaded === true,
    truncated: raw.truncated === true,
    currentPage:
      typeof raw.currentPage === "number" && raw.currentPage >= 1 ? Math.floor(raw.currentPage) : 1,
    savedAt: raw.savedAt,
  };
}

export function loadReviewReturnCache(
  organizationId: string,
  reviewerUserId: string,
  now: number,
): ReviewReturnCache | null {
  const store = getStore();
  if (!store) return null;
  const rawStr = store.getItem(storageKey(organizationId, reviewerUserId));
  if (!rawStr) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawStr);
  } catch {
    return null;
  }
  return validateReviewReturnCache(parsed, { organizationId, reviewerUserId, now });
}
