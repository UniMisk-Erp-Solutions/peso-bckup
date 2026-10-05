/**
 * Review workspace state (DOC-080 §10-§45).
 *
 * ONE versioned, atomic snapshot of the Review queue's query + pagination +
 * scroll, so navigating into Review Batch (or an expense route) and returning
 * lands the reviewer back on the exact same employee, search, filters, sort and
 * page — "as though they never left the queue".
 *
 * Design rules encoded here:
 *  - versioned + validated: a corrupt or old-schema snapshot is discarded, never
 *    trusted (§24);
 *  - organization- AND reviewer-scoped: one reviewer's query never restores for
 *    another reviewer or org (§11/§23);
 *  - a one-shot RETURN INTENT marker distinguishes "returning from a Review child
 *    flow" from "a fresh Review visit", so a sidebar click tomorrow does not trap
 *    the user in yesterday's search (§22/§41);
 *  - contains only safe UI/query state + immutable IDs + display identity — never
 *    tokens, cursors-as-authority or financial payloads (§38/§42).
 *
 * Pure and sessionStorage-only; no React, no network — fully unit-testable.
 */

import { isExpenseMonthValue, ALL_MONTHS, type ExpenseMonthValue } from "@/lib/expenseMonthFilter";

export const REVIEW_WORKSPACE_VERSION = 3 as const;
/** Session-scoped TTL backstop; sessionStorage already dies with the tab (§25). */
export const REVIEW_WORKSPACE_TTL_MS = 24 * 60 * 60 * 1000;

export type ReviewWorkspaceEmployee = {
  userId: string;
  name: string;
  employeeId: string | null;
  email: string | null;
};

export type ReviewWorkspaceQuery = {
  mode: "normal" | "filtered";
  employee: ReviewWorkspaceEmployee | null;
  searchDraft: string;
  submittedSearch: string | null;
  generalSearch: string | null;
  statusFilter: string;
  timePeriod: string;
  /** Exact expense-month filter (v3). */
  expenseMonth: ExpenseMonthValue;
  sortBy: string;
  sortOrder: string;
  /** Opaque custom-field filter object owned by the caller; stored/restored as-is. */
  customFilters: unknown;
  /** Applied "Needs my verification only" toggle (v2). */
  showOnlyActionable: boolean;
  /** Applied hierarchy-inclusion toggles (v2). */
  includeTeamLeaderReports: boolean;
  includeExecutiveReports: boolean;
};

export type ReviewWorkspaceState = {
  version: typeof REVIEW_WORKSPACE_VERSION;
  organizationId: string;
  reviewerUserId: string;
  reviewerRole: string;
  query: ReviewWorkspaceQuery;
  pagination: { page: number; pageSize: number };
  scroll: { y: number; anchorExpenseId: string | null };
  savedAt: number;
};

function storageKey(organizationId: string, reviewerUserId: string): string {
  return `pesowise:review-workspace:v${REVIEW_WORKSPACE_VERSION}:${organizationId}:${reviewerUserId}`;
}

/** One-shot "the next /review mount should restore" marker. */
const RETURN_INTENT_KEY = "pesowise:review:return-pending";

function getStore(): Storage | null {
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage : null;
  } catch {
    return null;
  }
}

export function markReviewReturnPending(): void {
  getStore()?.setItem(RETURN_INTENT_KEY, "true");
}

/** Reads AND clears the marker — restoration is one-shot (§22). */
export function consumeReviewReturnPending(): boolean {
  const store = getStore();
  if (!store) return false;
  const pending = store.getItem(RETURN_INTENT_KEY) === "true";
  if (pending) store.removeItem(RETURN_INTENT_KEY);
  return pending;
}

export function saveReviewWorkspaceState(state: ReviewWorkspaceState): void {
  const store = getStore();
  if (!store) return;
  try {
    store.setItem(storageKey(state.organizationId, state.reviewerUserId), JSON.stringify(state));
  } catch {
    // Quota/serialization failure must never break navigation.
  }
}

export function clearReviewWorkspaceState(organizationId: string, reviewerUserId: string): void {
  getStore()?.removeItem(storageKey(organizationId, reviewerUserId));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validate an untrusted parsed snapshot. Returns the typed state only when it is
 * the right version, belongs to THIS organization + reviewer, is within the TTL,
 * and has the required shape. Anything else → null (discarded safely, §23/§24).
 */
export function validateReviewWorkspaceState(
  raw: unknown,
  expect: { organizationId: string; reviewerUserId: string; now: number },
): ReviewWorkspaceState | null {
  if (!isRecord(raw)) return null;
  if (raw.version !== REVIEW_WORKSPACE_VERSION) return null;
  if (raw.organizationId !== expect.organizationId) return null;
  if (raw.reviewerUserId !== expect.reviewerUserId) return null;
  if (typeof raw.savedAt !== "number") return null;
  if (expect.now - raw.savedAt > REVIEW_WORKSPACE_TTL_MS || raw.savedAt > expect.now) return null;

  const q = raw.query;
  if (!isRecord(q)) return null;
  if (q.mode !== "normal" && q.mode !== "filtered") return null;

  let employee: ReviewWorkspaceEmployee | null = null;
  if (q.employee !== null && q.employee !== undefined) {
    if (!isRecord(q.employee) || typeof q.employee.userId !== "string" || !q.employee.userId) {
      return null;
    }
    employee = {
      userId: q.employee.userId,
      name: typeof q.employee.name === "string" ? q.employee.name : "",
      employeeId: typeof q.employee.employeeId === "string" ? q.employee.employeeId : null,
      email: typeof q.employee.email === "string" ? q.employee.email : null,
    };
  }

  const pag = raw.pagination;
  const page = isRecord(pag) && typeof pag.page === "number" && pag.page >= 1 ? Math.floor(pag.page) : 1;
  const pageSize = isRecord(pag) && typeof pag.pageSize === "number" && pag.pageSize > 0 ? Math.floor(pag.pageSize) : 25;

  const scr = raw.scroll;
  const y = isRecord(scr) && typeof scr.y === "number" && scr.y >= 0 ? scr.y : 0;
  const anchorExpenseId = isRecord(scr) && typeof scr.anchorExpenseId === "string" ? scr.anchorExpenseId : null;

  const str = (v: unknown, fallback: string) => (typeof v === "string" ? v : fallback);

  return {
    version: REVIEW_WORKSPACE_VERSION,
    organizationId: expect.organizationId,
    reviewerUserId: expect.reviewerUserId,
    reviewerRole: str(raw.reviewerRole, ""),
    query: {
      mode: q.mode,
      employee,
      searchDraft: str(q.searchDraft, ""),
      submittedSearch: typeof q.submittedSearch === "string" ? q.submittedSearch : null,
      generalSearch: typeof q.generalSearch === "string" ? q.generalSearch : null,
      statusFilter: str(q.statusFilter, "all"),
      timePeriod: str(q.timePeriod, "all"),
      expenseMonth: isExpenseMonthValue(q.expenseMonth) ? q.expenseMonth : ALL_MONTHS,
      sortBy: str(q.sortBy, "created_at"),
      sortOrder: str(q.sortOrder, "desc"),
      customFilters: q.customFilters ?? null,
      showOnlyActionable: q.showOnlyActionable === true,
      includeTeamLeaderReports: q.includeTeamLeaderReports === true,
      includeExecutiveReports: q.includeExecutiveReports === true,
    },
    pagination: { page, pageSize },
    scroll: { y, anchorExpenseId },
    savedAt: raw.savedAt,
  };
}

export function loadReviewWorkspaceState(
  organizationId: string,
  reviewerUserId: string,
  now: number,
): ReviewWorkspaceState | null {
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
  return validateReviewWorkspaceState(parsed, { organizationId, reviewerUserId, now });
}

/** Clamp a restored page into the valid range for the freshly-fetched result (§16/§31). */
export function clampRestoredPage(savedPage: number, totalPages: number): number {
  if (!Number.isFinite(savedPage) || savedPage < 1) return 1;
  if (!Number.isFinite(totalPages) || totalPages < 1) return 1;
  return Math.min(Math.floor(savedPage), Math.floor(totalPages));
}
