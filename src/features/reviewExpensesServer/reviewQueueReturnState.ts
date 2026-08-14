/**
 * Review Expenses return-state contract (DOC-080 §12).
 *
 * THE DEFECT THIS EXISTS FOR
 * A reviewer searched an employee, applied filters, walked to page 50, opened a batch
 * through "Review batch", reviewed it, and came back to an unfiltered page 1. Every
 * outbound field was already being assembled in `ReviewExpensesServerPage.openExpense`
 * and put into `location.state` — but `BatchExpenseReview` navigated back with a bare
 * `navigate(backPath)`, dropping it, and the review page never looked for a snapshot
 * anyway. The data was produced and then discarded at both ends.
 *
 * WHAT THIS IS NOT
 * Navigation/query state ONLY. It records WHAT WAS BEING ASKED — employee, search text,
 * filters, sort, page size, logical page, scroll — never any part of the ANSWER. No
 * expense rows, attachments, balances, comments, audit entries, tokens or keys. The
 * server queue deliberately holds no client-side result cache and this must not become
 * one by the back door: returning always re-reads the server, so a reviewer sees the
 * consequences of the batch action they just performed.
 *
 * WHY THE CURSOR IS ABSENT
 * A keyset cursor is only meaningful inside the exact filtered ordering that produced
 * it. Reviewing a batch can change status, actionability, filtered totals and therefore
 * row ordering, so a cursor saved before the review may address a different logical
 * slice afterwards. The snapshot carries the PAGE NUMBER and the query shape; the live
 * cursor is re-resolved server-side through the page-anchor RPC. See §10 of the page.
 */

import { z } from "zod";
import { REVIEW_PAGE_SIZES } from "@/features/reviewQueueServer/hooks/useReviewQueueFilters";
import {
  debugReviewSortSchema,
  debugSelectedEmployeeSchema,
} from "@/features/reviewQueueServer/schemas";

/** A stale snapshot is worse than none: the population may have moved on. */
export const REVIEW_RETURN_SNAPSHOT_MAX_AGE_MS = 30 * 60 * 1000;

export const REVIEW_RETURN_STATE_KEY = "reviewQueueState";

const customFilterSchema = z.object({
  source: z.enum(["template", "branch"]),
  field_id: z.string().min(1),
  values: z.array(z.string()),
});

const filterStateSchema = z.object({
  statuses: z.array(z.string()),
  categories: z.array(z.string()),
  timePeriod: z.enum(["all", "week", "month", "year"]),
  actionableOnly: z.boolean(),
  customFilters: z.array(customFilterSchema),
  sort: debugReviewSortSchema,
  // Anything outside the offered set would produce a page the UI cannot represent.
  pageSize: z.number().refine(
    (n): n is (typeof REVIEW_PAGE_SIZES)[number] =>
      (REVIEW_PAGE_SIZES as readonly number[]).includes(n),
    { message: "pageSize must be one of the offered page sizes" },
  ),
});

const scrollSchema = z.object({
  windowY: z.number().finite().min(0),
  appMainY: z.number().finite().min(0),
});

export const reviewQueueReturnSnapshotSchema = z.object({
  version: z.literal(1),
  organizationId: z.string().min(1),
  reviewerUserId: z.string().min(1),
  savedAt: z.number().finite().positive(),

  search: z.object({
    draft: z.string(),
    submitted: z.string().nullable(),
    // The immutable user_id travels with the display identity, so restoration never
    // re-searches a display name to reconstruct who was selected.
    selectedEmployee: debugSelectedEmployeeSchema.nullable(),
    generalSearch: z.string().nullable(),
  }),

  filters: filterStateSchema,

  pageNumber: z.number().int().positive(),

  scroll: scrollSchema,
});

export type ReviewQueueReturnSnapshot = z.infer<typeof reviewQueueReturnSnapshotSchema>;

/**
 * An employee filter and a free-text expense search are alternatives, never a pair —
 * `useSingleBarSearch` clears one when the other resolves. A snapshot carrying both is
 * not something this app can produce, so it is treated as corrupt rather than guessed at.
 */
function searchIsCoherent(snapshot: ReviewQueueReturnSnapshot): boolean {
  return !(snapshot.search.selectedEmployee && snapshot.search.generalSearch);
}

export type ParseReturnSnapshotContext = {
  organizationId: string | null | undefined;
  reviewerUserId: string | null | undefined;
  /** Injected so tests need no clock control and the check stays pure. */
  now?: number;
  maxAgeMs?: number;
};

/**
 * Validate an untrusted snapshot. Fails CLOSED — any doubt returns null and the caller
 * renders a clean page 1.
 *
 * The identity checks are not ceremony. `sessionStorage` outlives a sign-out in the same
 * tab, so without them a second reviewer on a shared machine could inherit the first
 * one's employee filter and page position. It grants no access on its own — rows still
 * come from the server queue under RLS — but it would silently mislead about whose
 * working context is on screen.
 */
export function parseReviewQueueReturnSnapshot(
  raw: unknown,
  context: ParseReturnSnapshotContext,
): ReviewQueueReturnSnapshot | null {
  if (!context.organizationId || !context.reviewerUserId) return null;

  const parsed = reviewQueueReturnSnapshotSchema.safeParse(raw);
  if (!parsed.success) return null;

  const snapshot = parsed.data;
  if (snapshot.organizationId !== context.organizationId) return null;
  if (snapshot.reviewerUserId !== context.reviewerUserId) return null;
  if (!searchIsCoherent(snapshot)) return null;

  const now = context.now ?? Date.now();
  const maxAge = context.maxAgeMs ?? REVIEW_RETURN_SNAPSHOT_MAX_AGE_MS;
  // A clock-skewed future timestamp is as untrustworthy as an expired one.
  if (now - snapshot.savedAt > maxAge) return null;
  if (snapshot.savedAt > now + 60_000) return null;

  return snapshot;
}

/** Pull a snapshot out of a router `location.state` object of unknown shape. */
export function readSnapshotFromLocationState(
  state: unknown,
  context: ParseReturnSnapshotContext,
): ReviewQueueReturnSnapshot | null {
  if (!state || typeof state !== "object") return null;
  const candidate = (state as Record<string, unknown>)[REVIEW_RETURN_STATE_KEY];
  if (candidate === undefined) return null;
  return parseReviewQueueReturnSnapshot(candidate, context);
}

// ── sessionStorage fallback ────────────────────────────────────────────────────
//
// Router state covers the application's own Back button. Browser Back returns to the
// PREVIOUS /review history entry, whose state was written before the batch was opened —
// so the snapshot has to survive somewhere the history entry does not own. Scoped per
// organization and reviewer so two accounts in one tab cannot read each other's.

export function reviewReturnSessionKey(
  organizationId: string,
  reviewerUserId: string,
): string {
  return `pw.review.return.v1:${organizationId}:${reviewerUserId}`;
}

function sessionStorageOrNull(): Storage | null {
  try {
    if (typeof window === "undefined" || !window.sessionStorage) return null;
    return window.sessionStorage;
  } catch {
    // Access itself throws under some privacy modes.
    return null;
  }
}

export function saveReturnSnapshotToSession(snapshot: ReviewQueueReturnSnapshot): void {
  const store = sessionStorageOrNull();
  if (!store) return;
  try {
    store.setItem(
      reviewReturnSessionKey(snapshot.organizationId, snapshot.reviewerUserId),
      JSON.stringify(snapshot),
    );
  } catch {
    // A full or unavailable quota must never break navigation; the router-state path
    // still works and restoration is an enhancement, not a precondition.
  }
}

export function clearReturnSnapshotFromSession(
  organizationId: string | null | undefined,
  reviewerUserId: string | null | undefined,
): void {
  const store = sessionStorageOrNull();
  if (!store || !organizationId || !reviewerUserId) return;
  try {
    store.removeItem(reviewReturnSessionKey(organizationId, reviewerUserId));
  } catch {
    /* nothing actionable */
  }
}

/**
 * Read and validate the session fallback. Anything invalid — expired, malformed, or
 * belonging to another organization or reviewer — is DELETED as well as rejected, so a
 * bad entry cannot sit there being re-evaluated on every subsequent visit.
 */
export function readReturnSnapshotFromSession(
  context: ParseReturnSnapshotContext,
): ReviewQueueReturnSnapshot | null {
  const store = sessionStorageOrNull();
  if (!store || !context.organizationId || !context.reviewerUserId) return null;

  const key = reviewReturnSessionKey(context.organizationId, context.reviewerUserId);
  let raw: string | null = null;
  try {
    raw = store.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;

  let decoded: unknown = null;
  try {
    decoded = JSON.parse(raw);
  } catch {
    clearReturnSnapshotFromSession(context.organizationId, context.reviewerUserId);
    return null;
  }

  const snapshot = parseReviewQueueReturnSnapshot(decoded, context);
  if (!snapshot) {
    clearReturnSnapshotFromSession(context.organizationId, context.reviewerUserId);
    return null;
  }
  return snapshot;
}

// ── outbound ───────────────────────────────────────────────────────────────────

/** The application's scrolling main panel. Window scroll alone misses it entirely. */
export const APP_MAIN_SCROLL_ID = "app-main-scroll";

export function readCurrentScrollPositions(): { windowY: number; appMainY: number } {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return { windowY: 0, appMainY: 0 };
  }
  const main = document.getElementById(APP_MAIN_SCROLL_ID);
  return {
    windowY: Math.max(0, window.scrollY || 0),
    appMainY: Math.max(0, main?.scrollTop ?? 0),
  };
}

export type BuildReturnSnapshotInput = {
  organizationId: string;
  reviewerUserId: string;
  search: ReviewQueueReturnSnapshot["search"];
  filters: ReviewQueueReturnSnapshot["filters"];
  pageNumber: number;
  now?: number;
  scroll?: { windowY: number; appMainY: number };
};

/**
 * Build a snapshot and validate it through the SAME parser the reader uses. Producing
 * something the consumer would reject is a bug worth failing on here, where the offending
 * field is still in scope, rather than silently one navigation later.
 */
export function buildReviewQueueReturnSnapshot(
  input: BuildReturnSnapshotInput,
): ReviewQueueReturnSnapshot | null {
  const candidate = {
    version: 1 as const,
    organizationId: input.organizationId,
    reviewerUserId: input.reviewerUserId,
    savedAt: input.now ?? Date.now(),
    search: input.search,
    filters: input.filters,
    pageNumber: input.pageNumber,
    scroll: input.scroll ?? readCurrentScrollPositions(),
  };

  return parseReviewQueueReturnSnapshot(candidate, {
    organizationId: input.organizationId,
    reviewerUserId: input.reviewerUserId,
    now: candidate.savedAt,
  });
}
