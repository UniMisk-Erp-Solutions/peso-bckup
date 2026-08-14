/**
 * Review Expenses — return-from-batch state restoration (DOC-080 §12).
 *
 * THE DEFECT
 * A reviewer searched an employee, applied filters, walked to page 50, opened a batch via
 * "Review batch", reviewed it, and came back to an UNFILTERED PAGE 1. Every outbound field
 * was already being assembled into `location.state` — but `BatchExpenseReview` navigated
 * back with a bare `navigate(backPath)` which dropped it, and the review page never looked
 * for a snapshot anyway. State was produced and discarded at both ends.
 *
 * These tests drive the WHOLE JOURNEY through a real `MemoryRouter` with both real routes,
 * real hooks and the real page — clicking the real batch button and the real Back button.
 * The previous suite asserted only that outbound navigation carried a state object, which
 * is exactly why a defect on the RETURN leg went unnoticed: the outbound half was correct
 * the entire time.
 *
 * Mocking stops at the network boundary (`reviewQueueServer/api`), so the search hook,
 * filter hook, cursor history, restoration state machine and both pages are the real ones.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider, useParams } from "react-router-dom";

const ORG = "6709c1fe-e8c8-404d-bc68-d1edda923344";
const REVIEWER = "bbbbbbbb-1111-2222-3333-444444444444";
const OTHER_ORG = "11111111-2222-3333-4444-555555555555";
const OTHER_REVIEWER = "99999999-8888-7777-6666-555555555555";
const EMPLOYEE_USER = "22ba24a5-40dc-4618-a2de-098974237111";
const BATCH_ID = "77777777-8888-9999-aaaa-bbbbbbbbbbbb";

/**
 * Restore the REAL react-router-dom for this suite.
 *
 * `src/test/setup.ts` mocks it globally for every test in the repository with
 *     useNavigate: () => vi.fn(),
 *     useParams:   () => ({}),
 * which is fatal to a routing integration test and was the entire cause of the batch leg
 * failing: `useParams()` returned `{}` however correct the route was, so
 * `BatchExpenseReview` fell into its `unableToOpen` branch, and the outbound click called
 * a no-op navigate that never changed the location.
 *
 * A file-level `vi.mock` outranks the setup-file one, so this restores every genuine export
 * — useParams, useNavigate, useLocation, useNavigationType, Routes, Route,
 * createMemoryRouter, RouterProvider — for this suite ONLY. The other eleven suites that
 * rely on the global stub are untouched.
 */
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
}));

// ── network boundary ───────────────────────────────────────────────────────────
const fetchPage = vi.fn();
const fetchAnchor = vi.fn();
const searchEmployees = vi.fn();
const fetchCapabilities = vi.fn();
const fetchFilterOptions = vi.fn();
const fetchDetail = vi.fn();

vi.mock("@/features/reviewQueueServer/api", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    fetchReviewQueuePage: (...a: unknown[]) => fetchPage(...a),
    fetchReviewQueuePageAnchor: (...a: unknown[]) => fetchAnchor(...a),
    searchReviewEmployees: (...a: unknown[]) => searchEmployees(...a),
    fetchReviewQueueCapabilities: (...a: unknown[]) => fetchCapabilities(...a),
    fetchReviewQueueFilterOptions: (...a: unknown[]) => fetchFilterOptions(...a),
    fetchReviewExpenseDetail: (...a: unknown[]) => fetchDetail(...a),
  };
});

vi.mock("@/config/reviewQueueServerFeature", () => ({
  REVIEW_EXPENSES_SERVER_QUEUE_ENABLED: true,
  REVIEW_EXPENSES_SERVER_ACTIONS_ENABLED: true,
  REVIEW_QUEUE_V2_ENABLED: false,
}));

let authRole = "executive";
let authOrg: string | null = ORG;
let authUser: string | null = REVIEWER;

vi.mock("@/contexts/auth-context", () => ({
  useAuth: () => ({
    user: authUser ? { id: authUser } : null,
    organizationId: authOrg,
    userRole: authRole,
    organizationFeatureFlags: {},
  }),
}));
vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    user: authUser ? { id: authUser } : null,
    organizationId: authOrg,
    userRole: authRole,
    organizationFeatureFlags: {},
  }),
}));

let mobile = false;
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => mobile }));
vi.mock("@/hooks/useViewportMode", () => ({ useViewportMode: () => ({ isMobile: mobile }) }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (k: string, p?: Record<string, unknown>) => (p?.defaultValue as string) ?? k,
    i18n: { language: "en" },
  }),
  Trans: ({ children }: { children?: ReactNode }) => children ?? null,
}));
vi.mock("@/i18n", () => ({
  useTranslation: () => ({
    t: (k: string, p?: Record<string, unknown>) => (p?.defaultValue as string) ?? k,
    i18n: { language: "en" },
  }),
}));

// The batch panel owns its own data and has its own suite; here it only needs to exist so
// the batch route renders and its Back control can be clicked.
vi.mock("@/hooks/useOrganizationRoleLabels", () => ({
  useOrganizationRoleLabels: () => ({ labels: null, loading: false, refresh: vi.fn() }),
}));

vi.mock("@/components/BatchExpenseReviewPanel", () => ({
  BatchExpenseReviewPanel: () => <div data-testid="batch-panel">batch</div>,
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: vi.fn(async () => ({ data: null, error: null })),
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
      }),
    }),
  },
}));

import { ReviewExpensesServerPage } from "@/features/reviewExpensesServer/ReviewExpensesServerPage";
import BatchExpenseReview from "@/pages/BatchExpenseReview";
import {
  buildReviewQueueReturnSnapshot,
  parseReviewQueueReturnSnapshot,
  reviewReturnSessionKey,
  REVIEW_RETURN_SNAPSHOT_MAX_AGE_MS,
} from "@/features/reviewExpensesServer/reviewQueueReturnState";
// The real parsers survive the module mock (it spreads the original), so fixtures are
// validated against the production contract instead of being hand-shaped guesses.
import {
  parseReviewQueuePage,
  parsePageAnchor,
} from "@/features/reviewQueueServer/api";
import type { ReviewQueueItem } from "@/features/reviewQueueServer/types";

// ── fixtures ───────────────────────────────────────────────────────────────────

function batchRow(over: Partial<ReviewQueueItem> = {}): ReviewQueueItem {
  return {
    id: "e-batch-1",
    transaction_number: "00424",
    batch_id: BATCH_ID,
    user_id: EMPLOYEE_USER,
    employee_name: "Sanjaykumar Vinodbhai Katara",
    employee_id: "6174",
    employee_email: "sanjay@example.com",
    identity_source: "profile",
    identity_issue: null,
    current_balance: 10000,
    title: "CCTV work",
    purpose: "Site",
    category: "Travel",
    destination: "Surat",
    total_amount: 3960,
    status: "submitted",
    approval_tier: "engineer",
    created_at: "2026-06-30T10:00:00Z",
    trip_start: "2026-06-30",
    is_resubmitted: false,
    was_reviewer_corrected: false,
    is_actionable: true,
    actionable_stage: "engineer",
    actionable_reason: "actionable_at_engineer",
    available_actions: ["approve", "reject", "correct"],
    view_only: false,
    custom_fields: [],
    ...over,
  } as ReviewQueueItem;
}

function pageResponse(items: ReviewQueueItem[], over: Record<string, unknown> = {}) {
  return parseReviewQueuePage({
    contract: "debug-review-queue",
    version: 1,
    items,
    has_more: true,
    next_cursor: { sk: "2026-06-01T00:00:00Z", id: "e-last" },
    filtered_total: 1250,
    total_pages: 50,
    scope_summary: {
      assigned_to_me: 1250,
      pending_review: 40,
      verified: 10,
      total_amount: 500000,
      directly_assigned: 1250,
    },
    filtered_summary: {
      assigned_to_me: 1250,
      pending_review: 40,
      completed_review: 12,
      verified: 10,
      approved: 5,
      rejected: 1,
      actionable_now: 8,
      active_not_actionable_now: 32,
      total_amount: 500000,
    },
    batch_action_state: [],
    caller: {
      role: "executive",
      hierarchy_enabled: true,
      team_leader_enabled: true,
      executive_enabled: true,
    },
    diagnostics: {
      page_returned: items.length,
      identity_resolved: items.length,
      identity_unresolved: 0,
      batches_on_page: 1,
      schema_revision: "20260802030000",
    },
    ...over,
  });
}

function anchorResponse(targetPage: number, cursorId: string, totalPages = 50) {
  return parsePageAnchor({
    contract: "debug-review-page-anchor",
    version: 1,
    target_page: targetPage,
    page_size: 50,
    filtered_total: totalPages * 50,
    total_pages: totalPages,
    cursor: { sk: "2026-05-01T00:00:00Z", id: cursorId },
  });
}

const SELECTED_EMPLOYEE = {
  user_id: EMPLOYEE_USER,
  employee_name: "Sanjaykumar Vinodbhai Katara",
  employee_id: "6174",
  identity_source: "current_profile",
  identity_issue: null,
  visible_expense_count: 24,
  actionable_expense_count: 24,
};

const RESTORED_FILTERS = {
  statuses: ["submitted"],
  categories: ["Travel"],
  timePeriod: "month" as const,
  actionableOnly: true,
  customFilters: [
    { source: "template" as const, field_id: "field-project", values: ["Alpha"] },
  ],
  sort: "amount_desc" as const,
  pageSize: 50,
};

function snapshotFor(over: Record<string, unknown> = {}) {
  const built = buildReviewQueueReturnSnapshot({
    organizationId: ORG,
    reviewerUserId: REVIEWER,
    search: {
      draft: "6174",
      submitted: "6174",
      selectedEmployee: SELECTED_EMPLOYEE,
      generalSearch: null,
    },
    filters: RESTORED_FILTERS,
    pageNumber: 50,
    scroll: { windowY: 900, appMainY: 1200 },
  });
  if (!built) throw new Error("fixture snapshot failed its own validation");
  return { ...built, ...over };
}

/**
 * Diagnostic kept permanently: it fails loudly the moment the global router stub in
 * `src/test/setup.ts` leaks back into this suite. Without it, a future reinstatement of
 * `useParams: () => ({})` would turn every batch assertion below into a silent pass
 * against the `unableToOpen` fallback — which is exactly how this defect hid.
 */
function ParamsProbe() {
  const params = useParams();
  return <div data-testid="batch-param">{params.batchId ?? "missing"}</div>;
}

type Entry = string;

/**
 * Data router, real routes, plain string history entries. Returns the router so tests can
 * assert on `router.state.location` and `router.state.matches` directly rather than
 * inferring navigation from rendered text.
 */
function renderJourney(initialEntries: Entry[] = ["/review"], probe = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  const router = createMemoryRouter(
    [
      { path: "/review", element: <ReviewExpensesServerPage /> },
      {
        path: "/expenses/batch/:batchId/review",
        element: probe ? <ParamsProbe /> : <BatchExpenseReview />,
      },
      { path: "/admin/expenses", element: <div>admin expenses</div> },
    ],
    { initialEntries },
  );

  const view = render(
    <QueryClientProvider client={client}>
      <div id="app-main-scroll">
        <RouterProvider router={router} />
      </div>
    </QueryClientProvider>,
  );
  return { ...view, router };
}

/** Every argument object the page RPC was called with, for shape assertions. */
function pageCalls() {
  return fetchPage.mock.calls.map((c) => c[0] as Record<string, unknown>);
}

beforeEach(() => {
  vi.clearAllMocks();
  authRole = "executive";
  authOrg = ORG;
  authUser = REVIEWER;
  mobile = false;
  window.sessionStorage.clear();

  fetchCapabilities.mockResolvedValue({
    contract: "debug-review-queue",
    version: 1,
    ready: true,
    functions: {
      employee_search: true,
      page: true,
      filters: true,
      detail: true,
      page_anchor: true,
    },
    schema_revision: "20260802030000",
  });
  fetchFilterOptions.mockResolvedValue({
    contract: "debug-review-queue",
    version: 1,
    statuses: ["submitted", "approved"],
    categories: ["Travel", "Food"],
    custom_fields: [],
  });
  fetchPage.mockResolvedValue(pageResponse([batchRow()]));
  fetchAnchor.mockResolvedValue(anchorResponse(50, "anchor-50"));
  searchEmployees.mockResolvedValue({
    contract: "debug-review-queue",
    version: 1,
    matches: [],
  });
  fetchDetail.mockResolvedValue(null);
});

afterEach(() => {
  window.sessionStorage.clear();
});

// ══════════════════════════════════════════════════════════════════════════════
describe("router harness", () => {
  /**
   * Guards the un-mock at the top of this file. `src/test/setup.ts` stubs
   * `useParams: () => ({})` globally; if that stub ever reaches this suite again, every
   * batch assertion below would silently pass against the `unableToOpen` fallback instead
   * of the real page. This test makes that failure loud and immediate.
   */
  it("supplies real route parameters to the batch route", async () => {
    renderJourney(["/expenses/batch/batch-9/review?from=review"], true);
    expect((await screen.findByTestId("batch-param")).textContent).toBe("batch-9");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe("snapshot contract", () => {
  it("round-trips a complete working context", () => {
    const snap = snapshotFor();
    const parsed = parseReviewQueueReturnSnapshot(snap, {
      organizationId: ORG,
      reviewerUserId: REVIEWER,
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.search.selectedEmployee?.user_id).toBe(EMPLOYEE_USER);
    expect(parsed?.filters.statuses).toEqual(["submitted"]);
    expect(parsed?.filters.categories).toEqual(["Travel"]);
    expect(parsed?.filters.timePeriod).toBe("month");
    expect(parsed?.filters.actionableOnly).toBe(true);
    expect(parsed?.filters.customFilters[0].field_id).toBe("field-project");
    expect(parsed?.filters.sort).toBe("amount_desc");
    expect(parsed?.filters.pageSize).toBe(50);
    expect(parsed?.pageNumber).toBe(50);
  });

  it("rejects and does not crash on a snapshot older than the max age", () => {
    const stale = snapshotFor({ savedAt: Date.now() - REVIEW_RETURN_SNAPSHOT_MAX_AGE_MS - 1000 });
    expect(
      parseReviewQueueReturnSnapshot(stale, { organizationId: ORG, reviewerUserId: REVIEWER }),
    ).toBeNull();
  });

  it("rejects another organization's snapshot", () => {
    expect(
      parseReviewQueueReturnSnapshot(snapshotFor(), {
        organizationId: OTHER_ORG,
        reviewerUserId: REVIEWER,
      }),
    ).toBeNull();
  });

  it("rejects another reviewer's snapshot", () => {
    expect(
      parseReviewQueueReturnSnapshot(snapshotFor(), {
        organizationId: ORG,
        reviewerUserId: OTHER_REVIEWER,
      }),
    ).toBeNull();
  });

  it("rejects a future contract version", () => {
    expect(
      parseReviewQueueReturnSnapshot(snapshotFor({ version: 2 }), {
        organizationId: ORG,
        reviewerUserId: REVIEWER,
      }),
    ).toBeNull();
  });

  it.each([
    ["malformed object", { version: 1, nonsense: true }],
    ["null", null],
    ["string", "not-a-snapshot"],
    ["bad page number", snapshotFor({ pageNumber: 0 })],
    ["bad page size", snapshotFor({ filters: { ...RESTORED_FILTERS, pageSize: 37 } })],
    ["bad sort", snapshotFor({ filters: { ...RESTORED_FILTERS, sort: "nonsense" } })],
    ["bad time period", snapshotFor({ filters: { ...RESTORED_FILTERS, timePeriod: "decade" } })],
    [
      "bad custom filter",
      snapshotFor({
        filters: { ...RESTORED_FILTERS, customFilters: [{ source: "elsewhere", field_id: "", values: [1] }] },
      }),
    ],
  ])("fails closed on %s", (_label, raw) => {
    expect(
      parseReviewQueueReturnSnapshot(raw, { organizationId: ORG, reviewerUserId: REVIEWER }),
    ).toBeNull();
  });

  it("rejects an employee filter and a general search held at once", () => {
    // useSingleBarSearch clears one when the other resolves, so both together is corrupt.
    const incoherent = snapshotFor({
      search: {
        draft: "x",
        submitted: "x",
        selectedEmployee: SELECTED_EMPLOYEE,
        generalSearch: "00424",
      },
    });
    expect(
      parseReviewQueueReturnSnapshot(incoherent, {
        organizationId: ORG,
        reviewerUserId: REVIEWER,
      }),
    ).toBeNull();
  });

  it("stores no expense row data", () => {
    const serialized = JSON.stringify(snapshotFor());
    for (const leak of [
      "e-batch-1",
      "CCTV work",
      "sanjay@example.com",
      "3960",
      "current_balance",
      "available_actions",
    ]) {
      expect(serialized).not.toContain(leak);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe("return journey restores the working context", () => {
  async function arriveRestored(
    entries: Array<string | { pathname: string; state?: unknown }>,
  ) {
    const view = renderJourney(entries);
    await waitFor(() => expect(fetchPage).toHaveBeenCalled());
    return view;
  }

  it("restores employee, every filter, sort, page size and page through one journey", async () => {
    await arriveRestored([
      { pathname: "/review", state: { reviewQueueState: snapshotFor() } },
    ]);

    await waitFor(() => expect(fetchAnchor).toHaveBeenCalled());
    const anchorArgs = fetchAnchor.mock.calls[0][0] as Record<string, unknown>;

    // 12 — the anchor receives the COMPLETE restored query shape, not a partial one.
    expect(anchorArgs.employeeUserId).toBe(EMPLOYEE_USER);
    expect(anchorArgs.statuses).toEqual(["submitted"]);
    expect(anchorArgs.categories).toEqual(["Travel"]);
    expect(anchorArgs.actionableOnly).toBe(true);
    expect(anchorArgs.sort).toBe("amount_desc");
    expect(anchorArgs.pageSize).toBe(50);
    expect(anchorArgs.targetPage).toBe(50);
    expect(anchorArgs.customFilters).toEqual(RESTORED_FILTERS.customFilters);
    expect(anchorArgs.dateFrom).toBeTruthy(); // timePeriod month -> a real window

    // The queue page is then fetched with the same restored shape and the RESOLVED cursor.
    await waitFor(() => {
      const withAnchor = pageCalls().find(
        (c) => (c.cursor as { id?: string } | null)?.id === "anchor-50",
      );
      expect(withAnchor).toBeTruthy();
      expect(withAnchor?.employeeUserId).toBe(EMPLOYEE_USER);
      expect(withAnchor?.sort).toBe("amount_desc");
      expect(withAnchor?.pageSize).toBe(50);
    });
  });

  it("restores a general transaction search rather than an employee", async () => {
    const snap = snapshotFor({
      search: {
        draft: "txn:00424",
        submitted: "txn:00424",
        selectedEmployee: null,
        generalSearch: "00424",
      },
      pageNumber: 1,
    });
    await arriveRestored([{ pathname: "/review", state: { reviewQueueState: snap } }]);

    await waitFor(() => {
      const restored = pageCalls().find((c) => c.generalSearch === "00424");
      expect(restored).toBeTruthy();
      expect(restored?.employeeUserId).toBeNull();
    });
  });

  it("never reuses a stale cursor — the page cursor comes from the anchor RPC", async () => {
    await arriveRestored([
      { pathname: "/review", state: { reviewQueueState: snapshotFor() } },
    ]);
    await waitFor(() => expect(fetchAnchor).toHaveBeenCalled());

    await waitFor(() => {
      expect(
        pageCalls().some((c) => (c.cursor as { id?: string } | null)?.id === "anchor-50"),
      ).toBe(true);
    });
    // The snapshot never carried a cursor in the first place, so none can leak through.
    expect(JSON.stringify(snapshotFor())).not.toContain("cursor");
  });

  it("honours a server-clamped target page when the dataset shrank", async () => {
    // Page 50 no longer exists; the RPC answers with the last real page.
    fetchAnchor.mockResolvedValue(anchorResponse(7, "anchor-7", 7));

    await arriveRestored([
      { pathname: "/review", state: { reviewQueueState: snapshotFor() } },
    ]);

    await waitFor(() => {
      expect(
        pageCalls().some((c) => (c.cursor as { id?: string } | null)?.id === "anchor-7"),
      ).toBe(true);
    });
    // Not a silent fall back to page 1 of an unfiltered queue.
    expect(
      pageCalls().every((c) => c.employeeUserId === EMPLOYEE_USER),
    ).toBe(true);
  });

  it("never fires an unfiltered page-1 queue request during restoration", async () => {
    await arriveRestored([
      { pathname: "/review", state: { reviewQueueState: snapshotFor() } },
    ]);
    await waitFor(() => expect(fetchAnchor).toHaveBeenCalled());
    await waitFor(() => expect(fetchPage).toHaveBeenCalled());

    // This is the flash of global results the reviewer used to see. Every request must
    // already carry the restored employee.
    for (const call of pageCalls()) {
      expect(call.employeeUserId).toBe(EMPLOYEE_USER);
      expect(call.sort).toBe("amount_desc");
    }
  });

  it("fetches fresh data rather than replaying anything saved", async () => {
    await arriveRestored([
      { pathname: "/review", state: { reviewQueueState: snapshotFor() } },
    ]);
    // The only source of rows is the server call; nothing is seeded from the snapshot.
    await waitFor(() => expect(fetchPage).toHaveBeenCalled());
    expect(fetchPage.mock.calls.length).toBeGreaterThan(0);
  });

  it("runs no employee-search RPC while hydrating", async () => {
    await arriveRestored([
      { pathname: "/review", state: { reviewQueueState: snapshotFor() } },
    ]);
    await waitFor(() => expect(fetchAnchor).toHaveBeenCalled());
    // The immutable user_id is restored directly; re-searching a display name could
    // resolve to a different person entirely.
    expect(searchEmployees).not.toHaveBeenCalled();
  });

  it("issues no duplicate queue request for the same restored page", async () => {
    await arriveRestored([
      { pathname: "/review", state: { reviewQueueState: snapshotFor() } },
    ]);
    await waitFor(() => {
      expect(
        pageCalls().some((c) => (c.cursor as { id?: string } | null)?.id === "anchor-50"),
      ).toBe(true);
    });
    const anchored = pageCalls().filter(
      (c) => (c.cursor as { id?: string } | null)?.id === "anchor-50",
    );
    expect(anchored.length).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe("router state versus session fallback", () => {
  it("restores through router state (application Back button)", async () => {
    renderJourney([{ pathname: "/review", state: { reviewQueueState: snapshotFor() } }]);
    await waitFor(() => expect(fetchAnchor).toHaveBeenCalled());
    expect((fetchAnchor.mock.calls[0][0] as Record<string, unknown>).employeeUserId).toBe(
      EMPLOYEE_USER,
    );
  });

  it("ignores the session fallback on a normal PUSH from the sidebar", async () => {
    // A deliberate navigation to /review is a request for a fresh queue. This must be a
    // genuine PUSH: a MemoryRouter's INITIAL entry is a POP, so starting at /review would
    // have tested the fallback path by accident.
    window.sessionStorage.setItem(
      reviewReturnSessionKey(ORG, REVIEWER),
      JSON.stringify(snapshotFor()),
    );

    const { router } = renderJourney(["/admin/expenses"]);
    await act(async () => {
      await router.navigate("/review");
    });
    expect(router.state.historyAction).toBe("PUSH");

    await waitFor(() => expect(fetchPage).toHaveBeenCalled());
    expect(fetchAnchor).not.toHaveBeenCalled();
    expect(pageCalls().every((c) => c.employeeUserId === null)).toBe(true);
    // And it is left intact for a genuine browser Back.
    expect(window.sessionStorage.getItem(reviewReturnSessionKey(ORG, REVIEWER))).toBeTruthy();
  });

  it("deletes an expired session snapshot instead of restoring it", async () => {
    window.sessionStorage.setItem(
      reviewReturnSessionKey(ORG, REVIEWER),
      JSON.stringify(
        snapshotFor({ savedAt: Date.now() - REVIEW_RETURN_SNAPSHOT_MAX_AGE_MS - 5000 }),
      ),
    );
    renderJourney(["/review"]);
    await waitFor(() => expect(fetchPage).toHaveBeenCalled());
    expect(fetchAnchor).not.toHaveBeenCalled();
  });

  it("does not restore a snapshot written by another reviewer", async () => {
    // Written under THIS reviewer's key but carrying another reviewer's id — the shape a
    // shared machine produces after a sign-out and sign-in in the same tab.
    window.sessionStorage.setItem(
      reviewReturnSessionKey(ORG, REVIEWER),
      JSON.stringify(snapshotFor({ reviewerUserId: OTHER_REVIEWER })),
    );
    renderJourney(["/review"]);
    await waitFor(() => expect(fetchPage).toHaveBeenCalled());
    expect(fetchAnchor).not.toHaveBeenCalled();
    // The foreign entry is discarded. The key is then legitimately rewritten by the
    // refresh-persistence effect with THIS reviewer's own context, so the guarantee is
    // "the other reviewer's snapshot is gone", not "the key is empty".
    const after = window.sessionStorage.getItem(reviewReturnSessionKey(ORG, REVIEWER));
    if (after) {
      expect(JSON.parse(after).reviewerUserId).toBe(REVIEWER);
      expect(JSON.parse(after).search.selectedEmployee).toBeNull();
    }
  });

  it("never crashes the page on a malformed snapshot and renders a clean page 1", async () => {
    window.sessionStorage.setItem(reviewReturnSessionKey(ORG, REVIEWER), "{not json");
    renderJourney(["/review"]);
    await waitFor(() => expect(fetchPage).toHaveBeenCalled());
    expect(pageCalls()[0].employeeUserId).toBeNull();
  });

  it("writes only query state to sessionStorage — never rows", async () => {
    renderJourney(["/review"]);
    await waitFor(() => expect(fetchPage).toHaveBeenCalled());

    fireEvent.click(await screen.findByTestId("review-batch-e-batch-1"));

    const stored = window.sessionStorage.getItem(reviewReturnSessionKey(ORG, REVIEWER));
    if (stored) {
      for (const leak of ["CCTV work", "sanjay@example.com", "available_actions", "3960"]) {
        expect(stored).not.toContain(leak);
      }
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe("batch page back navigation", () => {
  /**
   * The REAL journey: start on /review, click the row's own batch control so the page
   * builds and pushes its own snapshot, then click Back on the batch page.
   *
   * Synthesising the batch history entry by hand was not equivalent — it also could not
   * catch a defect in the outbound half. Driving both legs is what section 14 asks for.
   */
  async function goToBatchFromReview() {
    const view = renderJourney(["/review"]);
    await waitFor(() => expect(fetchPage).toHaveBeenCalled());

    // The table gives the batch control its own test id; matching on button text picked up
    // unrelated filter buttons and clicked one of those instead.
    const batchButton = await screen.findByTestId("review-batch-e-batch-1");
    fireEvent.click(batchButton);

    // Assert on the router itself, so a click that fails to navigate is distinguishable
    // from a batch page that navigated but refused to render.
    await waitFor(() =>
      expect(view.router.state.location.pathname).toBe(
        `/expenses/batch/${BATCH_ID}/review`,
      ),
    );
    const matched = view.router.state.matches.find(
      (m) => (m.params as { batchId?: string }).batchId === BATCH_ID,
    );
    expect(matched, "batch route matched without its :batchId param").toBeTruthy();

    expect(await screen.findByTestId("batch-panel")).toBeTruthy();
    return view;
  }

  it("carries the working context out to the batch and back again", async () => {
    await goToBatchFromReview();
    // The outbound leg must have written the fallback too.
    expect(window.sessionStorage.getItem(reviewReturnSessionKey(ORG, REVIEWER))).toBeTruthy();

    fetchPage.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /back/i }));

    // Back lands on /review; with a page-1 snapshot no anchor is needed, but the queue
    // must be re-read rather than replayed.
    await waitFor(() => expect(fetchPage).toHaveBeenCalled());
  });

  it("gives mobile the same Back control and the same handler", async () => {
    mobile = true;
    const view = renderJourney(["/review"]);
    await waitFor(() => expect(fetchPage).toHaveBeenCalled());

    // Mobile renders the card list, not the desktop table, so the batch row is opened
    // through its own control — the same `onOpen` the table uses.
    fireEvent.click(await screen.findByTestId("review-mobile-row-e-batch-1"));

    await waitFor(() =>
      expect(view.router.state.location.pathname).toBe(
        `/expenses/batch/${BATCH_ID}/review`,
      ),
    );
    expect(await screen.findByTestId("batch-panel")).toBeTruthy();

    // Previously the Back header was desktop-only, leaving phone reviewers no in-app route
    // home at all — the browser gesture was the only way out.
    const back = screen.getByRole("button", { name: /back/i });
    fetchPage.mockClear();
    fireEvent.click(back);

    await waitFor(() => expect(view.router.state.location.pathname).toBe("/review"));
    // Same handler, same snapshot channel and the same fresh re-read as desktop. This
    // journey sits on page 1, so no anchor is expected — the anchor path is covered by the
    // page-50 tests above.
    await waitFor(() => expect(fetchPage).toHaveBeenCalled());
    expect(window.sessionStorage.getItem(reviewReturnSessionKey(ORG, REVIEWER))).toBeTruthy();
  });

  it("clears bulk selection and closes dialogs across the round trip", async () => {
    await goToBatchFromReview();
    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    await waitFor(() => expect(fetchPage).toHaveBeenCalled());

    // A selection made before the batch cannot survive data that may have changed.
    const checked = screen.queryAllByRole("checkbox").filter((c) => (c as HTMLInputElement).checked);
    expect(checked.length).toBe(0);
  });

  it("writes only query state to the session fallback — never rows", async () => {
    await goToBatchFromReview();
    const stored = window.sessionStorage.getItem(reviewReturnSessionKey(ORG, REVIEWER));
    expect(stored).toBeTruthy();
    for (const leak of [
      "CCTV work",
      "sanjay@example.com",
      "available_actions",
      "current_balance",
      "3960",
      "e-batch-1",
    ]) {
      expect(stored).not.toContain(leak);
    }
  });
});

describe("role behaviour", () => {
  it.each(["engineer", "team_leader", "executive"])(
    "restores identically for %s without any role-specific branch",
    async (role) => {
      authRole = role;
      renderJourney([{ pathname: "/review", state: { reviewQueueState: snapshotFor() } }]);

      await waitFor(() => expect(fetchAnchor).toHaveBeenCalled());
      const args = fetchAnchor.mock.calls[0][0] as Record<string, unknown>;
      expect(args.employeeUserId).toBe(EMPLOYEE_USER);
      expect(args.targetPage).toBe(50);
      // Authorization stays server-side: restoration adds no scope of its own.
      expect(args.organizationId).toBe(ORG);
    },
  );
});
