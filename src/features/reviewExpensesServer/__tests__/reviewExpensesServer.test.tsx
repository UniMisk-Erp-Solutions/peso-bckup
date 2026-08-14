/**
 * Server-backed Review Expenses (DOC-080 §21).
 *
 * The assertions that matter are behavioural: the single search bar preserves
 * the employee/transaction separation that the 6174 regression proved necessary,
 * typing issues zero requests, KPI values come from the server, and pagination
 * is keyset with honest page numbers.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { renderHook } from "@testing-library/react";
import { readFileSync } from "fs";
import { resolve } from "path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";

const rpc = vi.fn();
const from = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: (...a: unknown[]) => rpc(...a), from: (...a: unknown[]) => from(...a) },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (k: string, params?: Record<string, unknown>) => {
      if (!params) return k;
      const vals = Object.entries(params)
        .filter(([p]) => p !== "defaultValue")
        .map(([, v]) => String(v))
        .join(" ");
      return vals ? `${k} ${vals}` : k;
    },
    i18n: { language: "en" },
  }),
  Trans: ({ children }: { children?: ReactNode }) => children ?? null,
}));

import { useSingleBarSearch, parseExplicitExpenseQuery } from "@/features/reviewQueueServer/hooks/useSingleBarSearch";
import { useCursorHistory } from "@/features/reviewQueueServer/hooks/useCursorHistory";
import {
  buildQueryShapeKey,
  useReviewQueueFilters,
} from "@/features/reviewQueueServer/hooks/useReviewQueueFilters";
import { buildPageLinks, validatePageInput } from "@/features/reviewExpensesServer/pageLinks";
import {
  applySelection,
  fieldCounts,
  pruneHidden,
  visibleFields,
} from "@/features/reviewExpensesServer/customFieldGraph";
import { reviewQueuePageKey } from "@/features/reviewQueueServer/queryKeys";
import { fetchReviewQueuePage, REVIEW_QUEUE_RPCS } from "@/features/reviewQueueServer/api";
import { ReviewStatsCards } from "@/features/reviewExpensesServer/ReviewStatsCards";
import { isReconciled } from "@/features/reviewExpensesServer/reconciliation";
import { ReviewExpensesTable } from "@/features/reviewExpensesServer/ReviewExpensesTable";
import { ReviewExpensesMobileList } from "@/features/reviewExpensesServer/ReviewExpensesMobileList";
import { ReviewPagination } from "@/features/reviewExpensesServer/ReviewPagination";
import { ReviewSearchBar } from "@/features/reviewExpensesServer/ReviewSearchBar";
import { ReviewEmployeeResultsPopover } from "@/features/reviewExpensesServer/ReviewEmployeeResultsPopover";
import { ReviewErrorState } from "@/features/reviewExpensesServer/ReviewErrorState";
import {
  isBulkEligible,
  isSelectableForBulk,
  summarizeBulkApprove,
} from "@/features/reviewExpensesServer/bulkEligibility";
import {
  customFieldKey,
  customFiltersToValues,
  valuesToCustomFilters,
} from "@/features/reviewExpensesServer/customFieldGraph";
import { formatEmployeeIdentity } from "@/features/reviewQueueServer/types";

const ORG = "6709c1fe-e8c8-404d-bc68-d1edda923344";
const KATARA = "c76edc75-3cab-4c70-85d2-5762fe949d1b";
const KATHERIA = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const cwd = process.cwd();
const tsCode = (rel: string) =>
  readFileSync(resolve(cwd, rel), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const wrapper = ({ children }: { children: ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
};

const item = (over: Record<string, unknown> = {}) => ({
  id: "e-1",
  transaction_number: "00424",
  batch_id: null,
  user_id: KATARA,
  employee_name: "Sanjaykumar Vinodbhai Katara",
  employee_id: "6174",
  employee_email: "e@x.invalid",
  identity_source: "current_profile",
  identity_issue: null,
  current_balance: 100,
  title: "CCTV work",
  purpose: null,
  category: "Travel",
  destination: "Site A",
  total_amount: 3960,
  status: "submitted",
  approval_tier: "engineer",
  created_at: "2026-07-01T10:00:00Z",
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
});

const pageResponse = (over: Record<string, unknown> = {}) => ({
  contract: "debug-review-queue",
  version: 1,
  filtered_total: 24,
  has_more: false,
  next_cursor: null,
  items: [item()],
  selected_employee: null,
  scope_summary: { assigned_to_me: 41, pending_review: 12, verified: 7, total_amount: 98000 },
  diagnostics: { page_returned: 1, identity_resolved: 1, identity_unresolved: 0 },
  ...over,
});

const employeeResponse = (matches: unknown[]) => ({
  contract: "debug-review-employee-search",
  version: 1,
  query: "6174",
  matches,
});

const katara = {
  user_id: KATARA,
  employee_name: "Sanjaykumar Vinodbhai Katara",
  employee_id: "6174",
  employee_email: "emp@x.invalid",
  identity_source: "current_profile",
  identity_issue: null,
  visible_expense_count: 24,
  actionable_expense_count: 24,
  match_type: "exact_employee_id",
};

beforeEach(() => {
  rpc.mockReset();
  from.mockReset();
});

// ── Routing and rollback (§3, §21.1–5) ──────────────────────────────────────

describe("route wrapper", () => {
  const WRAPPER = tsCode("src/pages/ReviewExpenses.tsx");
  const APP = tsCode("src/App.tsx");

  it("/review renders the wrapper, not EngineerReview directly", () => {
    expect(APP).toContain('path="/review"');
    expect(APP).toContain("<ReviewExpenses />");
    expect(APP).not.toContain("<ManagerReview />");
  });

  it("keeps /review role access unchanged", () => {
    const seg = APP.slice(APP.indexOf('path="/review"'));
    expect(seg).toContain("allowedRoles={[...EXPENSE_REVIEW_ROLES]}");
  });

  it("renders the ONE canonical EngineerReview page (no flag switch, no server page)", () => {
    // Consolidation: /review always renders the legacy EngineerReview workflow.
    expect(WRAPPER).toContain("<ManagerReview />");
    expect(WRAPPER).not.toContain("<ReviewExpensesServerPage");
    expect(WRAPPER).not.toContain("REVIEW_EXPENSES_SERVER_QUEUE_ENABLED");
    expect(WRAPPER).not.toContain("forceLegacy");
  });

  it("retains EngineerReview.tsx untouched as the default", () => {
    expect(() => readFileSync(resolve(cwd, "src/pages/EngineerReview.tsx"))).not.toThrow();
    expect(WRAPPER).toContain('from "@/pages/EngineerReview"');
  });

  it("requires the flags to be exactly \"true\"", () => {
    const cfg = tsCode("src/config/reviewQueueServerFeature.ts");
    expect(cfg).toContain("VITE_REVIEW_EXPENSES_SERVER_QUEUE_ENABLED");
    expect(cfg).toContain("VITE_REVIEW_EXPENSES_SERVER_ACTIONS_ENABLED");
    expect((cfg.match(/\?\.trim\(\) ===\s*\n?\s*"true"/g) ?? []).length).toBeGreaterThanOrEqual(1);
  });

  it("removes the /debug/review-expenses route (single canonical Review surface)", () => {
    expect(APP).not.toContain('path="/debug/review-expenses"');
    expect(APP).not.toContain("DebugReviewExpenses");
  });
});

// ── The single-bar search algorithm (§8) — the core new logic ───────────────

describe("single-bar search resolution", () => {
  const setup = () => renderHook(() => useSingleBarSearch({ organizationId: ORG }));

  it("makes NO request while typing", () => {
    const { result } = setup();
    act(() => result.current.setDraft("6"));
    act(() => result.current.setDraft("61"));
    act(() => result.current.setDraft("617"));
    act(() => result.current.setDraft("6174"));
    expect(rpc).not.toHaveBeenCalled();
    expect(result.current.getEmployeeRequestCount()).toBe(0);
    expect(result.current.state).toBe("idle");
  });

  it("resolves an exact employee ID to the immutable user_id", async () => {
    rpc.mockResolvedValue({ data: employeeResponse([katara]), error: null });
    const { result } = setup();
    act(() => result.current.setDraft("6174"));
    await act(async () => { await result.current.submit(); });

    await waitFor(() => expect(result.current.state).toBe("employee_selected"));
    expect(result.current.selectedEmployee?.user_id).toBe(KATARA);
    expect(result.current.selectedEmployee?.employee_id).toBe("6174");
    expect(result.current.selectedEmployee?.visible_expense_count).toBe(24);
    // Employee selection supersedes text search.
    expect(result.current.generalSearch).toBeNull();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][0]).toBe(REVIEW_QUEUE_RPCS.employeeSearch);
  });

  it("resolves an exact employee NAME to the immutable user_id", async () => {
    rpc.mockResolvedValue({
      data: employeeResponse([{ ...katara, match_type: "exact_employee_name" }]),
      error: null,
    });
    const { result } = setup();
    act(() => result.current.setDraft("Sanjaykumar Vinodbhai Katara"));
    await act(async () => { await result.current.submit(); });
    await waitFor(() => expect(result.current.state).toBe("employee_selected"));
    expect(result.current.selectedEmployee?.user_id).toBe(KATARA);
  });

  it("asks when several employees match, and loads nothing until chosen", async () => {
    rpc.mockResolvedValue({
      data: employeeResponse([
        { ...katara, match_type: "name_contains" },
        { ...katara, user_id: "other", employee_id: "6175", match_type: "name_contains" },
      ]),
      error: null,
    });
    const { result } = setup();
    act(() => result.current.setDraft("Sanjay"));
    await act(async () => { await result.current.submit(); });

    await waitFor(() => expect(result.current.state).toBe("choose_employee"));
    expect(result.current.selectedEmployee).toBeNull();
    expect(result.current.generalSearch).toBeNull();
    expect(result.current.matches).toHaveLength(2);

    act(() => result.current.chooseEmployee(result.current.matches[1]));
    expect(result.current.selectedEmployee?.user_id).toBe("other");
    expect(result.current.state).toBe("employee_selected");
  });

  it("falls through to expense search when nothing matches an employee", async () => {
    rpc.mockResolvedValue({ data: employeeResponse([]), error: null });
    const { result } = setup();
    act(() => result.current.setDraft("CCTV"));
    await act(async () => { await result.current.submit(); });

    await waitFor(() => expect(result.current.state).toBe("expense_search"));
    expect(result.current.generalSearch).toBe("CCTV");
    expect(result.current.selectedEmployee).toBeNull();
  });

  it("txn: bypasses employee lookup entirely", async () => {
    const { result } = setup();
    act(() => result.current.setDraft("txn:06174"));
    await act(async () => { await result.current.submit(); });

    expect(rpc).not.toHaveBeenCalled();
    expect(result.current.state).toBe("expense_search");
    expect(result.current.generalSearch).toBe("06174");
    expect(result.current.selectedEmployee).toBeNull();
  });

  it("# bypasses employee lookup entirely", async () => {
    const { result } = setup();
    act(() => result.current.setDraft("#06174"));
    await act(async () => { await result.current.submit(); });
    expect(rpc).not.toHaveBeenCalled();
    expect(result.current.generalSearch).toBe("06174");
  });

  it("strips the prefix before sending it to the server", () => {
    expect(parseExplicitExpenseQuery("txn:06174")).toBe("06174");
    expect(parseExplicitExpenseQuery("TXN: 06174")).toBe("06174");
    expect(parseExplicitExpenseQuery("#06174")).toBe("06174");
    expect(parseExplicitExpenseQuery("6174")).toBeNull();
    expect(parseExplicitExpenseQuery("txn:")).toBeNull();
  });

  it("\"search expenses instead\" abandons employee resolution", async () => {
    rpc.mockResolvedValue({
      data: employeeResponse([
        { ...katara, match_type: "name_contains" },
        { ...katara, user_id: "other", match_type: "name_contains" },
      ]),
      error: null,
    });
    const { result } = setup();
    act(() => result.current.setDraft("6174"));
    await act(async () => { await result.current.submit(); });
    await waitFor(() => expect(result.current.state).toBe("choose_employee"));

    act(() => result.current.searchExpensesInstead());
    expect(result.current.state).toBe("expense_search");
    expect(result.current.generalSearch).toBe("6174");
    expect(result.current.selectedEmployee).toBeNull();
  });

  it("empty submit clears everything", async () => {
    const { result } = setup();
    act(() => result.current.setDraft("   "));
    await act(async () => { await result.current.submit(); });
    expect(rpc).not.toHaveBeenCalled();
    expect(result.current.state).toBe("idle");
    expect(result.current.selectedEmployee).toBeNull();
    expect(result.current.generalSearch).toBeNull();
  });

  it("clearAll resets draft, submitted, employee and expense search", async () => {
    rpc.mockResolvedValue({ data: employeeResponse([katara]), error: null });
    const { result } = setup();
    act(() => result.current.setDraft("6174"));
    await act(async () => { await result.current.submit(); });
    act(() => result.current.clearAll());
    expect(result.current.draft).toBe("");
    expect(result.current.submitted).toBeNull();
    expect(result.current.selectedEmployee).toBeNull();
    expect(result.current.generalSearch).toBeNull();
    expect(result.current.state).toBe("idle");
  });

  it("clearing the employee keeps an active expense search intact", async () => {
    rpc.mockResolvedValue({ data: employeeResponse([]), error: null });
    const { result } = setup();
    act(() => result.current.setDraft("CCTV"));
    await act(async () => { await result.current.submit(); });
    await waitFor(() => expect(result.current.generalSearch).toBe("CCTV"));
    act(() => result.current.clearEmployee());
    expect(result.current.generalSearch).toBe("CCTV");
  });

  it("surfaces an error instead of silently returning everything", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "57014", message: "timeout" } });
    const { result } = setup();
    act(() => result.current.setDraft("6174"));
    await act(async () => { await result.current.submit(); });
    await waitFor(() => expect(result.current.state).toBe("error"));
    expect(result.current.selectedEmployee).toBeNull();
    expect(result.current.generalSearch).toBeNull();
  });

  it("has no debounce and no effect on the draft", () => {
    const src = tsCode("src/features/reviewQueueServer/hooks/useSingleBarSearch.ts");
    expect(src).not.toMatch(/setTimeout|debounce/i);
    expect(src).not.toMatch(/useEffect/);
  });
});

// ── 6174 vs 06174, end to end through the API ──────────────────────────────

describe("6174 versus transaction 06174", () => {
  it("sends the immutable user_id and no search text", async () => {
    rpc.mockResolvedValue({ data: pageResponse({ filtered_total: 24 }), error: null });
    const page = await fetchReviewQueuePage({ organizationId: ORG, employeeUserId: KATARA });
    const args = rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(args.p_employee_user_id).toBe(KATARA);
    expect(args.p_general_search).toBeNull();
    expect(JSON.stringify(args)).not.toContain("Sanjaykumar");
    expect(page.filtered_total).toBe(24);
  });

  it("returns transaction 06174 to its real owner through expense search", async () => {
    rpc.mockResolvedValue({
      data: pageResponse({
        filtered_total: 1,
        items: [
          item({
            id: "e-06174",
            transaction_number: "06174",
            user_id: KATHERIA,
            employee_name: "Katheria Arun Amrutbhai",
            employee_id: "6557",
          }),
        ],
      }),
      error: null,
    });
    const page = await fetchReviewQueuePage({ organizationId: ORG, generalSearch: "06174" });
    const args = rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(args.p_general_search).toBe("06174");
    expect(args.p_employee_user_id).toBeNull();
    expect(page.items[0].employee_id).toBe("6557");
  });

  it("identity is present on the first list response — no second request", async () => {
    rpc.mockResolvedValue({ data: pageResponse(), error: null });
    const page = await fetchReviewQueuePage({ organizationId: ORG, employeeUserId: KATARA });
    expect(page.items[0].employee_name).toBe("Sanjaykumar Vinodbhai Katara");
    expect(page.items[0].employee_id).toBe("6174");
    expect(page.diagnostics.identity_unresolved).toBe(0);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(from).not.toHaveBeenCalled();
  });
});

// ── Cursor history and pagination (§12) ─────────────────────────────────────

describe("cursor cache", () => {
  const SHAPE = "shape-a";
  const c = (id: string) => ({ sk: "1", id, sort: "created_desc" as const });

  it("walks forward and back without OFFSET", () => {
    const { result } = renderHook(() => useCursorHistory(SHAPE));
    expect(result.current.pageNumber).toBe(1);
    expect(result.current.canGoPrevious).toBe(false);

    act(() => result.current.goNext(c("a")));
    expect(result.current.pageNumber).toBe(2);
    act(() => result.current.goNext(c("b")));
    expect(result.current.pageNumber).toBe(3);

    act(() => result.current.goPrevious());
    expect(result.current.pageNumber).toBe(2);
    expect(result.current.cursor?.id).toBe("a");
    act(() => result.current.goPrevious());
    expect(result.current.pageNumber).toBe(1);
    expect(result.current.cursor).toBeNull();
  });

  it("ignores Next when the server sent no cursor", () => {
    const { result } = renderHook(() => useCursorHistory(SHAPE));
    act(() => result.current.goNext(null));
    expect(result.current.pageNumber).toBe(1);
  });

  it("caches a walked page so revisiting costs no anchor request", () => {
    const { result } = renderHook(() => useCursorHistory(SHAPE));
    act(() => result.current.goNext(c("a")));
    act(() => result.current.goNext(c("b")));
    expect(result.current.hasCursorFor(2)).toBe(true);
    expect(result.current.hasCursorFor(3)).toBe(true);
    // Never walked, so it needs the anchor RPC.
    expect(result.current.hasCursorFor(9)).toBe(false);

    act(() => {
      expect(result.current.goToCachedPage(2)).toBe(true);
    });
    expect(result.current.pageNumber).toBe(2);
    expect(result.current.cursor?.id).toBe("a");
  });

  it("refuses to fabricate a cursor for an unvisited page", () => {
    const { result } = renderHook(() => useCursorHistory(SHAPE));
    act(() => {
      expect(result.current.goToCachedPage(9)).toBe(false);
    });
    expect(result.current.pageNumber).toBe(1);
  });

  it("lands on an anchored page and remembers it", () => {
    const { result } = renderHook(() => useCursorHistory(SHAPE));
    act(() => result.current.goToAnchoredPage(125, c("anchor")));
    expect(result.current.pageNumber).toBe(125);
    expect(result.current.cursor?.id).toBe("anchor");
    expect(result.current.hasCursorFor(125)).toBe(true);
  });

  it("drops the whole cache when the query shape changes", () => {
    const { result, rerender } = renderHook(({ shape }) => useCursorHistory(shape), {
      initialProps: { shape: SHAPE },
    });
    act(() => result.current.goNext(c("a")));
    act(() => result.current.goToAnchoredPage(50, c("b")));
    expect(result.current.pageNumber).toBe(50);

    // A cursor from another filter set points into a different sequence.
    rerender({ shape: "shape-b" });
    expect(result.current.pageNumber).toBe(1);
    expect(result.current.cursor).toBeNull();
    expect(result.current.hasCursorFor(50)).toBe(false);
  });

  it("keys the shape on every input that changes the filtered order", () => {
    const base = {
      organizationId: ORG,
      employeeUserId: null,
      generalSearch: null,
      statuses: [] as string[],
      categories: [] as string[],
      dateFrom: null,
      dateTo: null,
      actionableOnly: false,
      customFilters: [],
      sort: "created_desc" as const,
      pageSize: 25,
    };
    const a = buildQueryShapeKey(base);
    expect(buildQueryShapeKey({ ...base, sort: "amount_desc" })).not.toBe(a);
    expect(buildQueryShapeKey({ ...base, statuses: ["submitted"] })).not.toBe(a);
    expect(buildQueryShapeKey({ ...base, employeeUserId: KATARA })).not.toBe(a);
    expect(buildQueryShapeKey({ ...base, pageSize: 50 })).not.toBe(a);
    // Order-insensitive: the same filters must share a cache entry.
    expect(buildQueryShapeKey({ ...base, statuses: ["a", "b"] })).toBe(
      buildQueryShapeKey({ ...base, statuses: ["b", "a"] }),
    );
  });

  it("filter changes still clear row selection", () => {
    const onQueryShapeChange = vi.fn();
    const { result } = renderHook(() => useReviewQueueFilters({ onQueryShapeChange }));
    act(() => result.current.setStatuses(["submitted"]));
    expect(onQueryShapeChange).toHaveBeenCalled();
  });
});

// ── Page quick links and manual jump (DOC-080 sections 9 and 10) ────────────

describe("page links", () => {
  it("shows 1, 2, 3 and the last page near the beginning", () => {
    expect(buildPageLinks(1, 298)).toEqual([1, 2, 3, "ellipsis", 298]);
  });

  it("shows both ends and the current neighbours in the middle", () => {
    expect(buildPageLinks(147, 298)).toEqual([
      1, 2, 3, "ellipsis", 146, 147, 148, "ellipsis", 298,
    ]);
  });

  it("shows the tail without a trailing ellipsis near the end", () => {
    expect(buildPageLinks(298, 298)).toEqual([1, 2, 3, "ellipsis", 297, 298]);
  });

  it("deduplicates when the ranges overlap", () => {
    expect(buildPageLinks(2, 4)).toEqual([1, 2, 3, 4]);
    expect(buildPageLinks(1, 1)).toEqual([1]);
    expect(buildPageLinks(1, 0)).toEqual([]);
  });

  it("prints a single skipped page instead of an ellipsis for it", () => {
    expect(buildPageLinks(5, 6)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("validates manual page input", () => {
    expect(validatePageInput("125", 298)).toEqual({ ok: true, page: 125 });
    expect(validatePageInput(" 7 ", 298)).toEqual({ ok: true, page: 7 });
    expect(validatePageInput("", 298)).toEqual({ ok: false, error: "empty" });
    expect(validatePageInput("   ", 298)).toEqual({ ok: false, error: "empty" });
    expect(validatePageInput("0", 298)).toEqual({ ok: false, error: "outOfRange" });
    expect(validatePageInput("-3", 298)).toEqual({ ok: false, error: "outOfRange" });
    expect(validatePageInput("299", 298)).toEqual({ ok: false, error: "outOfRange" });
    expect(validatePageInput("1.5", 298)).toEqual({ ok: false, error: "notInteger" });
    expect(validatePageInput("abc", 298)).toEqual({ ok: false, error: "notInteger" });
  });
});

describe("pagination UI", () => {
  const renderPager = (over: Record<string, unknown> = {}) => {
    const onNext = vi.fn();
    const onPrevious = vi.fn();
    const onGoToPage = vi.fn();
    render(
      <ReviewPagination
        pageNumber={1}
        pageSize={25}
        returned={25}
        filteredTotal={7450}
        totalPages={298}
        hasMore
        canGoPrevious={false}
        busy={false}
        jumpEnabled
        onPrevious={onPrevious}
        onNext={onNext}
        onGoToPage={onGoToPage}
        {...over}
      />,
      { wrapper },
    );
    return { onNext, onPrevious, onGoToPage };
  };

  it("shows the server total, never a partial browser count", () => {
    renderPager();
    const text = screen.getByTestId("review-pagination-summary").textContent ?? "";
    expect(text).toContain("7450");
    expect(text).not.toContain("loaded");
    expect(text).not.toContain("+");
  });

  it("renders 1, 2, 3 and the last page", () => {
    renderPager();
    expect(screen.getByTestId("review-page-1")).toBeTruthy();
    expect(screen.getByTestId("review-page-2")).toBeTruthy();
    expect(screen.getByTestId("review-page-3")).toBeTruthy();
    expect(screen.getByTestId("review-page-298")).toBeTruthy();
  });

  it("renders the current page and its neighbours", () => {
    renderPager({ pageNumber: 147, canGoPrevious: true });
    for (const p of [146, 147, 148]) expect(screen.getByTestId(`review-page-${p}`)).toBeTruthy();
    expect(screen.getByTestId("review-page-147").getAttribute("aria-current")).toBe("page");
  });

  it("jumps when a page link is clicked, and does nothing on the current page", () => {
    const { onGoToPage } = renderPager({ pageNumber: 1 });
    fireEvent.click(screen.getByTestId("review-page-298"));
    expect(onGoToPage).toHaveBeenCalledWith(298);
    fireEvent.click(screen.getByTestId("review-page-1"));
    expect(onGoToPage).toHaveBeenCalledTimes(1);
  });

  it("disables Previous on page 1 and Next when has_more is false", () => {
    renderPager({ hasMore: false });
    expect((screen.getByTestId("review-page-previous") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("review-page-next") as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables every control while a request is in flight", () => {
    renderPager({ busy: true, canGoPrevious: true, pageNumber: 2 });
    expect((screen.getByTestId("review-page-next") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("review-page-previous") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("review-page-go") as HTMLButtonElement).disabled).toBe(true);
  });

  it("accepts a valid page from the input via Go and via Enter", () => {
    const { onGoToPage } = renderPager();
    const input = screen.getByTestId("review-page-input");
    fireEvent.change(input, { target: { value: "125" } });
    fireEvent.click(screen.getByTestId("review-page-go"));
    expect(onGoToPage).toHaveBeenCalledWith(125);

    fireEvent.change(input, { target: { value: "7" } });
    fireEvent.submit(input.closest("form")!);
    expect(onGoToPage).toHaveBeenCalledWith(7);
  });

  it.each([["0"], ["-3"], ["299"], [""]])("rejects %s with an inline message", (bad) => {
    const { onGoToPage } = renderPager();
    fireEvent.change(screen.getByTestId("review-page-input"), { target: { value: bad } });
    fireEvent.click(screen.getByTestId("review-page-go"));
    expect(onGoToPage).not.toHaveBeenCalled();
    expect(screen.getByTestId("review-page-input-error")).toBeTruthy();
  });

  it("labels the page input for assistive tech", () => {
    renderPager();
    const input = screen.getByTestId("review-page-input");
    expect(input.getAttribute("aria-label")).toBeTruthy();
    expect(input.getAttribute("min")).toBe("1");
    expect(input.getAttribute("max")).toBe("298");
  });

  it("hides the jump controls when the server has no anchor function", () => {
    renderPager({ jumpEnabled: false });
    expect(screen.queryByTestId("review-page-input")).toBeNull();
    expect(screen.queryByTestId("review-page-298")).toBeNull();
  });
});

// ── KPI cards come from the server (§10) ────────────────────────────────────

describe("KPI cards", () => {
  // Shaped from the 2026-08-02 Production snapshot: assigned 7,582 =
  // pending 7,574 + completed 8, with pending = 5,278 actionable + 2,296 not.
  const summary = (over: Record<string, number | boolean> = {}) => ({
    assigned_to_me: 7582,
    scope_total: 7582,
    pending_review: 7574,
    completed_review: 8,
    verified: 2,
    approved: 3,
    rejected: 3,
    paid: 0,
    other_terminal: 0,
    actionable_now: 5278,
    active_not_actionable_now: 2296,
    directly_assigned: 5806,
    hierarchy_assigned: 7581,
    team_assigned: 0,
    admin_scope_assigned: 0,
    unclassified: 0,
    self_owned_visible_expenses: 0,
    visible_without_assignment_reason: 0,
    total_amount: 1671900.85,
    reconciliation_ok: true,
    ...over,
  });

  const live = (over: Record<string, number | boolean> = {}) =>
    pageResponse({ scope_summary: summary(over) }) as never;

  const num = (testid: string) =>
    screen.getByTestId(testid).querySelector("div.text-2xl")?.textContent ?? "";

  it("renders scope_summary, never the length of the page array", () => {
    render(<ReviewStatsCards page={live()} loading={false} />, { wrapper });
    expect(num("review-stat-assigned")).toBe("7582");
    expect(num("review-stat-pending")).toBe("7574");
    expect(num("review-stat-completed")).toBe("8");
    // One item on the page; the cards describe the whole scope.
    expect(num("review-stat-assigned")).not.toBe("1");
  });

  it("satisfies Assigned = Pending + Completed", () => {
    const s = summary();
    expect(s.assigned_to_me).toBe(s.pending_review + s.completed_review);
    render(<ReviewStatsCards page={live()} loading={false} />, { wrapper });
    expect(Number(num("review-stat-assigned"))).toBe(
      Number(num("review-stat-pending")) + Number(num("review-stat-completed")),
    );
  });

  it("shows Actionable now as a subset UNDER Pending, not as Pending", () => {
    render(<ReviewStatsCards page={live()} loading={false} />, { wrapper });
    expect(screen.getByTestId("review-stat-actionable").textContent).toContain("5278");
    // The pending headline is the non-terminal total, not the actionable count.
    expect(num("review-stat-pending")).toBe("7574");
    expect(num("review-stat-pending")).not.toBe("5278");
  });

  it("keeps Pending = Actionable + Active-not-actionable", () => {
    const s = summary();
    expect(s.pending_review).toBe(s.actionable_now + s.active_not_actionable_now);
  });

  it("treats level_1_verified and level_2_verified as PENDING, not completed", () => {
    // 520 level_2 + 36 level_1 + 2 verified was the old "Verified 558" card.
    // Completed must now be the 8 genuinely terminal rows only.
    render(<ReviewStatsCards page={live()} loading={false} />, { wrapper });
    expect(num("review-stat-completed")).toBe("8");
    expect(num("review-stat-completed")).not.toBe("558");
    expect(screen.queryByText(/558/)).toBeNull();
  });

  it("breaks Completed down exhaustively", () => {
    const s = summary();
    expect(s.completed_review).toBe(
      s.verified + s.approved + s.rejected + s.paid + s.other_terminal,
    );
    render(<ReviewStatsCards page={live()} loading={false} />, { wrapper });
    const text = screen.getByTestId("review-stat-completed-breakdown").textContent ?? "";
    expect(text).toContain("2");
    expect(text).toContain("3");
  });

  it("hides Paid until the workflow actually uses it", () => {
    render(<ReviewStatsCards page={live()} loading={false} />, { wrapper });
    expect(screen.getByTestId("review-stat-completed-breakdown").textContent).not.toContain(
      "review.paidCount",
    );
    render(<ReviewStatsCards page={live({ paid: 4, completed_review: 12 })} loading={false} />, {
      wrapper,
    });
    expect(
      screen.getAllByTestId("review-stat-completed-breakdown").pop()?.textContent,
    ).toContain("review.paidCount");
  });

  it("reports reconciled only when every invariant holds", () => {
    expect(isReconciled(live())).toBe(true);
    expect(isReconciled(live({ unclassified: 3 }))).toBe(false);
    expect(isReconciled(live({ self_owned_visible_expenses: 1 }))).toBe(false);
    expect(isReconciled(live({ visible_without_assignment_reason: 1 }))).toBe(false);
    expect(isReconciled(live({ reconciliation_ok: false }))).toBe(false);
    // Arithmetic that does not add up must fail even if the server said ok.
    expect(isReconciled(live({ completed_review: 9 }))).toBe(false);
    expect(isReconciled(live({ actionable_now: 1 }))).toBe(false);
  });

  it("stays put on page 2 even when the page returns nothing", () => {
    const p2 = pageResponse({
      scope_summary: summary(),
      items: [],
      diagnostics: { page_returned: 0, identity_resolved: 0, identity_unresolved: 0 },
    }) as never;
    render(<ReviewStatsCards page={p2} loading={false} />, { wrapper });
    expect(num("review-stat-pending")).toBe("7574");
    expect(num("review-stat-completed")).toBe("8");
  });

  it("formats the total as currency", () => {
    render(<ReviewStatsCards page={live()} loading={false} />, { wrapper });
    expect(screen.getByTestId("review-stat-amount").textContent).toContain("16,71,900");
  });

  it("never counts rows in the card component", () => {
    const src = tsCode("src/features/reviewExpensesServer/ReviewStatsCards.tsx");
    expect(src).not.toMatch(/items\.length|allExpenses/);
    // Both summaries are server-computed; the card only picks between them.
    const source = tsCode("src/features/reviewExpensesServer/summarySource.ts");
    expect(source).toContain("scope_summary");
    expect(source).toContain("filtered_summary");
  });
});

// ── Visual parity (§6, §21.6–15) ────────────────────────────────────────────

describe("visual parity with the existing page", () => {
  const PAGE = tsCode("src/features/reviewExpensesServer/ReviewExpensesServerPage.tsx");

  it("keeps the existing heading and description keys", () => {
    expect(PAGE).toContain('t("admin:review.title")');
    expect(PAGE).toContain('t("admin:review.description")');
    expect(PAGE).toContain("text-2xl sm:text-3xl font-bold tracking-tight");
  });

  it("keeps the Assigned Expenses card and its help text", () => {
    expect(PAGE).toContain('t("admin:review.assignedExpenses")');
    expect(PAGE).toContain('t("admin:review.assignedExpensesDescription")');
    expect(PAGE).toContain('t("admin:review.approvedStayVisible")');
  });

  it("keeps the existing page spacing and filter-row layout", () => {
    expect(PAGE).toContain("space-y-4 sm:space-y-6 lg:space-y-8");
    expect(PAGE).toContain("flex flex-col sm:flex-row gap-3 mb-6");
  });

  it("keeps the four KPI cards with the existing grid and icons", () => {
    const stats = tsCode("src/features/reviewExpensesServer/ReviewStatsCards.tsx");
    expect(stats).toContain("grid gap-4 md:grid-cols-2 lg:grid-cols-4");
    for (const icon of ["Receipt", "Clock", "CheckCircle", "Coins"]) {
      expect(stats).toContain(`<${icon} className="h-4 w-4 text-muted-foreground" />`);
    }
  });

  it("renders the existing table column order", () => {
    render(
      <ReviewExpensesTable
        items={[item()]}
        selectedIds={new Set()}
        onToggle={vi.fn()}
        onSelectAll={vi.fn()}
        onOpen={vi.fn()}
        isSelectable={() => true}
        actionsEnabled={false}
      />,
      { wrapper },
    );
    const heads = Array.from(document.querySelectorAll("thead th")).map((th) =>
      (th.textContent ?? "").trim(),
    );
    expect(heads).toEqual([
      "",
      "Txn #",
      "Employee / Employee ID",
      "Title",
      "Category",
      "Destination",
      "Amount",
      "review.employeeBalance",
      "Status",
      "Expense Date",
      "Date Created",
      "Status / Actions",
    ]);
  });

  it("keeps the Status / Actions column sticky, opaque and separated", () => {
    render(
      <ReviewExpensesTable
        items={[item()]}
        selectedIds={new Set()}
        onToggle={vi.fn()}
        onSelectAll={vi.fn()}
        onOpen={vi.fn()}
        isSelectable={() => true}
        actionsEnabled={false}
      />,
      { wrapper },
    );
    const cell = screen.getByTestId("review-actions-cell");
    expect(cell.className).toContain("sticky");
    expect(cell.className).toContain("right-0");
    expect(cell.className).toContain("bg-background");
    expect(cell.className).toContain("border-l");
    expect(screen.getByTestId("review-scroll-container").className).toContain("overflow-x-auto");
  });

  it("shows NO debug UI anywhere on /review", () => {
    const files = [
      "src/features/reviewExpensesServer/ReviewExpensesServerPage.tsx",
      "src/features/reviewExpensesServer/ReviewStatsCards.tsx",
      "src/features/reviewExpensesServer/ReviewExpensesTable.tsx",
      "src/features/reviewExpensesServer/ReviewSearchBar.tsx",
      "src/features/reviewExpensesServer/ReviewErrorState.tsx",
      "src/features/reviewExpensesServer/ReviewPagination.tsx",
      "src/pages/ReviewExpenses.tsx",
    ].map(tsCode).join("\n");
    for (const forbidden of [
      "Debug Review Expenses",
      "schema_revision",
      "contract_version",
      "capability_ready",
      "diagnostics",
      "request_duration",
      "build_sha",
      "Actions disabled",
      "debugReview",
    ]) {
      expect(files).not.toContain(forbidden);
    }
  });

  it("does not import a single debug component", () => {
    const dir = "src/features/reviewExpensesServer/";
    const files = [
      "ReviewExpensesServerPage.tsx",
      "ReviewExpensesTable.tsx",
      "ReviewExpensesMobileList.tsx",
      "ReviewExpenseDetail.tsx",
      "ReviewSearchBar.tsx",
      "ReviewFilters.tsx",
    ].map((f) => tsCode(dir + f)).join("\n");
    expect(files).not.toContain("debugReviewQueue");
  });
});

// ── Search bar behaviour (§7, §9) ───────────────────────────────────────────

describe("search bar", () => {
  const renderBar = (over: Record<string, unknown> = {}) => {
    const onSubmit = vi.fn();
    const onDraftChange = vi.fn();
    const onClearAll = vi.fn();
    const onClearEmployee = vi.fn();
    const onClearGeneralSearch = vi.fn();
    render(
      <ReviewSearchBar
        draft=""
        onDraftChange={onDraftChange}
        onSubmit={onSubmit}
        onClearAll={onClearAll}
        searching={false}
        selectedEmployee={null}
        generalSearch={null}
        onClearEmployee={onClearEmployee}
        onClearGeneralSearch={onClearGeneralSearch}
        {...over}
      />,
      { wrapper },
    );
    return { onSubmit, onDraftChange, onClearAll, onClearEmployee, onClearGeneralSearch };
  };

  it("is a single input, not two sections", () => {
    renderBar();
    expect(screen.getAllByTestId(/review-.*-input/)).toHaveLength(1);
  });

  it("never submits while typing", () => {
    const { onSubmit } = renderBar();
    const input = screen.getByTestId("review-search-input");
    for (const v of ["6", "61", "617", "6174"]) fireEvent.change(input, { target: { value: v } });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("submits on the Search button and on Enter", () => {
    const { onSubmit } = renderBar({ draft: "6174" });
    fireEvent.click(screen.getByTestId("review-search-submit"));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    fireEvent.submit(screen.getByTestId("review-search-input").closest("form")!);
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it("shows a compact employee chip with the AUTHORITATIVE filtered count", () => {
    renderBar({
      selectedEmployee: {
        user_id: KATARA,
        employee_name: "Sanjaykumar Vinodbhai Katara",
        employee_id: "6174",
        identity_source: "current_profile",
        identity_issue: null,
        // Employee-search count is deliberately WRONG here to prove the chip does
        // not use it — the count comes from selectedEmployeeCount (§4).
        visible_expense_count: 0,
        actionable_expense_count: 0,
      },
      selectedEmployeeCount: 24,
    });
    const chip = screen.getByTestId("review-employee-chip");
    expect(chip.textContent).toContain("Sanjaykumar Vinodbhai Katara");
    expect(chip.textContent).toContain("6174");
    expect(chip.textContent).toContain("24");
  });

  it("shows a loading count (never a false 0) until the filtered result resolves", () => {
    renderBar({
      selectedEmployee: {
        user_id: KATARA,
        employee_name: "Sanjaykumar Vinodbhai Katara",
        employee_id: "6174",
        identity_source: "current_profile",
        identity_issue: null,
        visible_expense_count: 0,
        actionable_expense_count: 0,
      },
      selectedEmployeeCount: null,
    });
    expect(screen.getByTestId("review-employee-count").textContent).toContain("countLoading");
  });

  it("shows a retryable error on the chip when the filtered query fails — never a stuck 'counting…' (§27)", () => {
    renderBar({
      selectedEmployee: {
        user_id: KATARA,
        employee_name: "Sanjaykumar Vinodbhai Katara",
        employee_id: "6174",
        identity_source: "current_profile",
        identity_issue: null,
        visible_expense_count: 0,
        actionable_expense_count: 0,
      },
      selectedEmployeeCount: null,
      countError: true,
    });
    const count = screen.getByTestId("review-employee-count");
    expect(count.textContent).toContain("countError");
    expect(count.textContent).not.toContain("countLoading");
  });

  it("distinguishes the employee chip from the expense-search chip", () => {
    renderBar({
      selectedEmployee: {
        user_id: KATARA,
        employee_name: "K",
        employee_id: "6174",
        identity_source: "current_profile",
        identity_issue: null,
        visible_expense_count: 24,
        actionable_expense_count: 0,
      },
      generalSearch: "CCTV",
    });
    expect(screen.getByTestId("review-employee-chip")).toBeTruthy();
    expect(screen.getByTestId("review-general-chip").textContent).toContain("CCTV");
  });

  it("clears each chip independently", () => {
    const { onClearEmployee, onClearGeneralSearch } = renderBar({
      selectedEmployee: {
        user_id: KATARA,
        employee_name: "K",
        employee_id: "6174",
        identity_source: "current_profile",
        identity_issue: null,
        visible_expense_count: 1,
        actionable_expense_count: 0,
      },
      generalSearch: "CCTV",
    });
    fireEvent.click(screen.getByTestId("review-clear-employee"));
    expect(onClearEmployee).toHaveBeenCalled();
    expect(onClearGeneralSearch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("review-clear-general"));
    expect(onClearGeneralSearch).toHaveBeenCalled();
  });

  it("labels the input and both actions for assistive tech", () => {
    renderBar({ draft: "x" });
    expect(screen.getByTestId("review-search-input").getAttribute("aria-label")).toBeTruthy();
    expect(screen.getByTestId("review-search-clear").getAttribute("aria-label")).toBeTruthy();
  });
});

describe("employee popover", () => {
  const matches = [
    katara,
    { ...katara, user_id: "other", employee_id: "6175", employee_name: "Other Person" },
  ];

  it("lists identity candidates (no misleading count) and offers the expense-search escape", () => {
    const onSelect = vi.fn();
    const onSearchExpensesInstead = vi.fn();
    render(
      <ReviewEmployeeResultsPopover
        matches={matches}
        submitted="6174"
        onSelect={onSelect}
        onSearchExpensesInstead={onSearchExpensesInstead}
        onDismiss={vi.fn()}
      />,
      { wrapper },
    );
    const option = screen.getByTestId(`review-employee-option-${KATARA}`);
    expect(option.textContent).toContain("Sanjaykumar Vinodbhai Katara");
    // The candidate picker chooses an IDENTITY — the employee-search count is not
    // the filtered Review result, so it is deliberately NOT shown (§6).
    expect(option.textContent).not.toContain("24");
    fireEvent.click(screen.getByTestId(`review-employee-option-other`));
    expect(onSelect).toHaveBeenCalledWith(matches[1]);
    fireEvent.click(screen.getByTestId("review-search-expenses-instead"));
    expect(onSearchExpensesInstead).toHaveBeenCalled();
  });

  it("dismisses on Escape", () => {
    const onDismiss = vi.fn();
    render(
      <ReviewEmployeeResultsPopover
        matches={matches}
        submitted="6174"
        onSelect={vi.fn()}
        onSearchExpensesInstead={vi.fn()}
        onDismiss={onDismiss}
      />,
      { wrapper },
    );
    fireEvent.keyDown(screen.getByTestId("review-employee-popover"), { key: "Escape" });
    expect(onDismiss).toHaveBeenCalled();
  });
});

// ── Identity (§13) ──────────────────────────────────────────────────────────

describe("identity", () => {
  it("prefers name + employee ID, then email, then ID", () => {
    expect(
      formatEmployeeIdentity({ employee_name: "K", employee_id: "6174", employee_email: "e@x" }),
    ).toEqual({ primary: "K", secondary: "6174" });
    expect(
      formatEmployeeIdentity({ employee_name: "K", employee_id: null, employee_email: "e@x" })
        .secondary,
    ).toBe("e@x");
    expect(
      formatEmployeeIdentity({ employee_name: null, employee_id: "6174", employee_email: null })
        .primary,
    ).toBe("6174");
  });

  it.each([
    ["profile_missing", "review.identity.profileMissing"],
    ["duplicate_profiles", "review.identity.duplicateProfiles"],
  ])("renders %s as a reason, never a bare dash", (issue, key) => {
    render(
      <ReviewExpensesTable
        items={[
          item({
            id: "e-x",
            employee_name: "Unknown employee",
            employee_id: null,
            employee_email: null,
            identity_issue: issue,
          }),
        ]}
        selectedIds={new Set()}
        onToggle={vi.fn()}
        onSelectAll={vi.fn()}
        onOpen={vi.fn()}
        isSelectable={() => true}
        actionsEnabled={false}
      />,
      { wrapper },
    );
    const cell = screen.getByTestId("review-row-employee-e-x");
    expect(cell.textContent).toContain(key);
    expect(cell.textContent).not.toContain("—");
  });

  it("shows an inactive profile's identity rather than hiding the row", () => {
    render(
      <ReviewExpensesTable
        items={[item({ id: "e-i", identity_source: "inactive_profile" })]}
        selectedIds={new Set()}
        onToggle={vi.fn()}
        onSelectAll={vi.fn()}
        onOpen={vi.fn()}
        isSelectable={() => true}
        actionsEnabled={false}
      />,
      { wrapper },
    );
    expect(screen.getByTestId("review-row-employee-e-i").textContent).toContain(
      "Sanjaykumar Vinodbhai Katara",
    );
  });
});

// ── Actions and bulk eligibility (§16, §17) ─────────────────────────────────

describe("actions", () => {
  it("bulk eligibility comes from available_actions, not from status", () => {
    // Non-terminal but at another reviewer's tier: no actions offered.
    const notMine = item({ is_actionable: false, view_only: true, available_actions: [] });
    expect(isSelectableForBulk(notMine)).toBe(false);
    expect(isBulkEligible(notMine, "approve")).toBe(false);
    expect(notMine.status).toBe("submitted");

    const mine = item();
    expect(isSelectableForBulk(mine)).toBe(true);
    expect(isBulkEligible(mine, "approve")).toBe(true);
    expect(isBulkEligible(mine, "verify")).toBe(false);
  });

  it("excludes batch rows from bulk selection", () => {
    expect(isSelectableForBulk(item({ batch_id: "b-1" }))).toBe(false);
  });

  // Regression for the CONFIRMED production defect (MicroLink admin, txns
  // 10483/10484/10485): a submitted, executive-tier, non-batch row that the org
  // admin may approve. Live audit proved the queue helper wrongly returned
  // is_actionable=false/view_only=true; migration 20260810120000 makes the
  // server emit the admin super-approver shape below. The frontend must render a
  // checkbox for it and count it toward bulk approve.
  it("selects an admin-approvable submitted/executive-tier row (live shape 10485)", () => {
    const adminRow = item({
      id: "10485",
      status: "submitted",
      approval_tier: "executive",
      is_actionable: true,
      actionable_stage: "executive",
      actionable_reason: "admin_approvable",
      available_actions: ["approve", "reject", "correct"],
      view_only: false,
      batch_id: null,
    });
    expect(isSelectableForBulk(adminRow)).toBe(true);
    expect(isBulkEligible(adminRow, "approve")).toBe(true);
    expect(summarizeBulkApprove([adminRow], new Set(["10485"]))).toEqual({
      count: 1,
      total: adminRow.total_amount,
    });
  });

  // The same live row as the server returned it BEFORE the fix: the frontend
  // faithfully reflects the server, so no checkbox — proving the defect was
  // server-side (the queue helper), never a rendering bug to be forced open.
  it("does not select the pre-fix view-only shape of the same row", () => {
    const preFix = item({
      id: "10485",
      status: "submitted",
      approval_tier: "executive",
      is_actionable: false,
      actionable_reason: "not_assigned_to_caller",
      available_actions: [],
      view_only: true,
    });
    expect(isSelectableForBulk(preFix)).toBe(false);
    expect(isBulkEligible(preFix, "approve")).toBe(false);
  });

  // A batch row stays batch-only even when admin-approvable — the batch workflow
  // owns it, so no individual checkbox.
  it("excludes an admin-approvable BATCH row from individual selection (live shape 10489)", () => {
    const batchRow = item({
      id: "10489",
      status: "submitted",
      approval_tier: "executive",
      batch_id: "batch-1",
      is_actionable: true,
      available_actions: ["approve", "reject", "correct"],
      view_only: false,
    });
    expect(isSelectableForBulk(batchRow)).toBe(false);
  });

  // Migration 20260810140000: a plain 'verified' expense is pending final admin
  // approval (balance not yet deducted), so the server marks it admin-actionable.
  // The frontend must select it for bulk approve like any other approvable row.
  it("selects an admin-actionable verified non-batch row", () => {
    const verifiedRow = item({
      id: "v-1",
      status: "verified",
      approval_tier: "executive",
      is_actionable: true,
      actionable_reason: "admin_approvable",
      available_actions: ["approve", "reject", "correct"],
      view_only: false,
      batch_id: null,
    });
    expect(isSelectableForBulk(verifiedRow)).toBe(true);
    expect(isBulkEligible(verifiedRow, "approve")).toBe(true);
    expect(summarizeBulkApprove([verifiedRow], new Set(["v-1"]))).toEqual({
      count: 1,
      total: verifiedRow.total_amount,
    });
  });

  // A verified row in a batch stays batch-only regardless of admin actionability.
  it("excludes a verified BATCH row from individual selection", () => {
    const verifiedBatch = item({
      id: "v-2",
      status: "verified",
      batch_id: "batch-9",
      is_actionable: true,
      available_actions: ["approve", "reject", "correct"],
      view_only: false,
    });
    expect(isSelectableForBulk(verifiedBatch)).toBe(false);
  });

  // Non-admin verified (server marks it view-only) must never be selectable —
  // the frontend faithfully reflects the server's non-admin decision.
  it("does not select a non-admin verified (view-only) row", () => {
    const nonAdminVerified = item({
      id: "v-3",
      status: "verified",
      is_actionable: false,
      actionable_reason: "status_verified",
      available_actions: [],
      view_only: true,
    });
    expect(isSelectableForBulk(nonAdminVerified)).toBe(false);
  });

  it("summarizes bulk-approve count and total from approvable selected rows only (§13)", () => {
    const rows = [
      item({ id: "a", total_amount: 1000, available_actions: ["approve"] }),
      item({ id: "b", total_amount: 2000, available_actions: ["approve"] }),
      // Selected but verify-only — must not be counted toward the approve total.
      item({ id: "c", total_amount: 5000, available_actions: ["verify"] }),
      // Approvable but NOT selected — excluded.
      item({ id: "d", total_amount: 9000, available_actions: ["approve"] }),
    ];
    const selected = new Set(["a", "b", "c"]);
    expect(summarizeBulkApprove(rows, selected)).toEqual({ count: 2, total: 3000 });
  });

  it("summarizes an empty selection as zero", () => {
    expect(summarizeBulkApprove([item({ id: "a" })], new Set())).toEqual({
      count: 0,
      total: 0,
    });
  });

  it("treats a null amount as zero in the total", () => {
    const rows = [item({ id: "a", total_amount: null, available_actions: ["approve"] })];
    expect(summarizeBulkApprove(rows, new Set(["a"]))).toEqual({ count: 1, total: 0 });
  });

  it("renders no mutation control while the actions flag is off", () => {
    render(
      <ReviewExpensesTable
        items={[item()]}
        selectedIds={new Set()}
        onToggle={vi.fn()}
        onSelectAll={vi.fn()}
        onOpen={vi.fn()}
        isSelectable={() => true}
        actionsEnabled={false}
      />,
      { wrapper },
    );
    expect(screen.queryByText(/verify|approve|reject/i)).toBeNull();
    expect(screen.getByTestId("review-view-e-1")).toBeTruthy();
  });

  it("never recomputes actionability in React", () => {
    const files = [
      "src/features/reviewExpensesServer/ReviewExpensesServerPage.tsx",
      "src/features/reviewExpensesServer/ReviewExpensesTable.tsx",
      "src/features/reviewExpensesServer/ReviewBulkActions.tsx",
    ].map(tsCode).join("\n");
    expect(files).not.toContain("computeManagerQueueReady");
    expect(files).not.toContain("canRoleActOnExpense");
    expect(files).not.toContain("isSkippedHierarchyTier");
  });

  it("the page issues no mutation while the flag is off", () => {
    const page = tsCode("src/features/reviewExpensesServer/ReviewExpensesServerPage.tsx");
    expect(page).not.toMatch(/useMutation/);
    expect(page).not.toMatch(/\.rpc\(/);
    expect(page).not.toMatch(/supabase[\s\S]{0,40}\.(update|insert|upsert|delete)\(/);
  });
});

// ── Custom-field filters use stable IDs (§11) ───────────────────────────────

describe("custom field filters", () => {
  it("keys on the stable template/branch UUID, not the label", () => {
    expect(customFieldKey("template", "abc")).toBe("template:abc");
    const filters = valuesToCustomFilters({ "template:abc": "X", "branch:def": "Y" });
    expect(filters).toEqual([
      { source: "template", field_id: "abc", values: ["X"] },
      { source: "branch", field_id: "def", values: ["Y"] },
    ]);
  });

  it("round-trips without losing the source", () => {
    const filters = [
      { source: "template" as const, field_id: "abc", values: ["X"] },
      { source: "branch" as const, field_id: "def", values: ["Y"] },
    ];
    expect(valuesToCustomFilters(customFiltersToValues(filters))).toEqual(filters);
  });

  it("drops empty selections instead of sending a blank predicate", () => {
    expect(valuesToCustomFilters({ "template:abc": "", "template:d": "  " })).toEqual([]);
  });

  it("never queries expense_form_field_values from the browser", () => {
    const src = [
      tsCode("src/features/reviewExpensesServer/ReviewCustomFieldFilters.tsx"),
      tsCode("src/features/reviewExpensesServer/customFieldGraph.ts"),
    ].join("\n");
    expect(src).not.toContain("expense_form_field_values");
    expect(src).not.toMatch(/supabase/);
  });
});

// ── Request budget (§19) ────────────────────────────────────────────────────

describe("request budget", () => {
  const FILES = [
    "src/features/reviewQueueServer/api.ts",
    "src/features/reviewExpensesServer/ReviewExpensesServerPage.tsx",
    "src/features/reviewExpensesServer/ReviewExpensesTable.tsx",
    "src/features/reviewExpensesServer/ReviewExpensesMobileList.tsx",
    "src/features/reviewExpensesServer/ReviewExpenseDetail.tsx",
    "src/features/reviewExpensesServer/ReviewFilters.tsx",
    "src/features/reviewExpensesServer/ReviewCustomFieldFilters.tsx",
    "src/features/reviewQueueServer/hooks/useReviewQueuePage.ts",
    "src/features/reviewQueueServer/hooks/useSingleBarSearch.ts",
  ];
  const ALL = FILES.map(tsCode).join("\n");

  it.each(["profiles", "expense_form_field_values", "audit_logs", "expense_correction_logs"])(
    "makes no direct browser query to %s",
    (table) => {
      expect(ALL).not.toContain(`from("${table}")`);
      expect(ALL).not.toContain(`from('${table}')`);
    },
  );

  it.each([
    "get_expense_submitter_profiles",
    "get_resubmitted_expense_ids",
    "get_reviewer_corrected_expense_ids",
    "list_reviewer_visible_expenses_page",
    "list_hierarchy_reviewer_expenses",
    "list_manager_pending_expenses",
    "get_review_queue_page_v2",
  ])("never calls the legacy RPC %s", (fn) => {
    expect(ALL).not.toContain(fn);
  });

  it.each([
    "reviewExpensePagination",
    "legacyReviewPagination",
    "managerReviewExpenses",
    "hierarchyReviewExpenses",
  ])("never imports the V1 module %s", (mod) => {
    expect(ALL).not.toContain(mod);
  });

  it("uses only the proven RPCs plus the page anchor", () => {
    expect(new Set(Object.values(REVIEW_QUEUE_RPCS))).toEqual(
      new Set([
        "debug_review_queue_capabilities_v1",
        "search_debug_review_employees_v1",
        "get_debug_review_queue_page_v1",
        "get_debug_review_filter_options_v1",
        "get_debug_review_expense_detail_v1",
        "get_debug_review_queue_page_anchor_v1",
      ]),
    );
  });

  it("issues exactly one RPC per page fetch and no table query", async () => {
    rpc.mockResolvedValue({ data: pageResponse(), error: null });
    await fetchReviewQueuePage({ organizationId: ORG });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(from).not.toHaveBeenCalled();
  });

  it("has no Load All / Retry remaining / partial-result machinery", () => {
    expect(ALL).not.toMatch(/loadAll|Load All|retryRemaining|Retry remaining|allExpensesLoaded/i);
    expect(ALL).not.toMatch(/localStorage|sessionStorage/);
  });

  it("uses keyset paging — no offset API, no array slicing", () => {
    // .range() is Supabase's offset pagination; p_offset would be a SQL offset.
    expect(ALL).not.toMatch(/\.range\(/);
    expect(ALL).not.toContain("p_offset");
    expect(ALL).not.toMatch(/\.slice\(\s*(pageStartIndex|start|offset)/);
    // Paging is driven by an opaque server cursor, not an index.
    expect(ALL).toContain("p_cursor");
  });
});

// ── Shared data layer (§4) ──────────────────────────────────────────────────

describe("shared data layer", () => {
  it("both surfaces import the same core", () => {
    const debugApi = tsCode("src/features/debugReviewQueue/api.ts");
    expect(debugApi).toContain("@/features/reviewQueueServer/api");
    const page = tsCode("src/features/reviewExpensesServer/ReviewExpensesServerPage.tsx");
    expect(page).toContain("@/features/reviewQueueServer/hooks/useReviewQueuePage");
  });

  it("keeps exactly one copy of the schemas and the RPC arguments", () => {
    const debugSchemas = tsCode("src/features/debugReviewQueue/schemas.ts");
    expect(debugSchemas).toContain("@/features/reviewQueueServer/schemas");
    expect(debugSchemas).not.toContain("z.object");
    const debugApi = tsCode("src/features/debugReviewQueue/api.ts");
    expect(debugApi).not.toContain("p_organization_id");
  });

  it("scopes caches so debug and review can never share an entry", () => {
    const a = reviewQueuePageKey("review", {
      organizationId: ORG, userId: "u", employeeUserId: null, generalSearch: null,
      statuses: [], categories: [], dateFrom: null, dateTo: null, actionableOnly: false,
      customFilters: [], sort: "created_desc", pageSize: 25, cursor: null,
    });
    const b = reviewQueuePageKey("debug", {
      organizationId: ORG, userId: "u", employeeUserId: null, generalSearch: null,
      statuses: [], categories: [], dateFrom: null, dateTo: null, actionableOnly: false,
      customFilters: [], sort: "created_desc", pageSize: 25, cursor: null,
    });
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it("the page key contains no draft text", () => {
    const src = tsCode("src/features/reviewQueueServer/queryKeys.ts");
    expect(src).not.toContain("draft");
  });
});

// ── Errors (§18) ────────────────────────────────────────────────────────────

describe("error states", () => {
  it.each([
    "capability",
    "session_expired",
    "unauthorized",
    "timeout",
    "network",
    "malformed",
    "employee_not_found",
    "employee_no_expenses",
    "no_matching_expenses",
    "unknown",
  ] as const)("renders a distinct production surface for %s", (kind) => {
    render(<ReviewErrorState kind={kind} />, { wrapper });
    expect(screen.getByTestId(`review-error-${kind}`)).toBeTruthy();
  });

  it("uses production wording — no SQL, contract or schema details", () => {
    const src = [
      tsCode("src/features/reviewExpensesServer/ReviewErrorState.tsx"),
      tsCode("src/features/reviewExpensesServer/errorKind.ts"),
    ].join("\n");
    for (const bad of ["schema_revision", "PGRST", "57014", "to_regprocedure", "SQL"]) {
      expect(src).not.toContain(bad);
    }
  });

  it("retries only the failed request", () => {
    const onRetry = vi.fn();
    render(<ReviewErrorState kind="timeout" onRetry={onRetry} />, { wrapper });
    fireEvent.click(screen.getByTestId("review-error-retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

// ── Mobile (§14) ────────────────────────────────────────────────────────────

describe("mobile list", () => {
  it("shows identity, transaction, amount, status and View", () => {
    const onOpen = vi.fn();
    render(
      <ReviewExpensesMobileList
        items={[item()]}
        selectedIds={new Set()}
        onToggle={vi.fn()}
        onOpen={onOpen}
        isSelectable={() => true}
        actionsEnabled={false}
      />,
      { wrapper },
    );
    const card = screen.getByTestId("review-mobile-row-e-1");
    expect(card.textContent).toContain("00424");
    expect(card.textContent).toContain("Sanjaykumar Vinodbhai Katara");
    expect(card.textContent).toContain("3,960");
    // Main's mobile card is itself the button; there is no separate View control.
    fireEvent.click(card);
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "e-1" }));
  });

  it("hides the selection checkbox while actions are disabled", () => {
    render(
      <ReviewExpensesMobileList
        items={[item()]}
        selectedIds={new Set()}
        onToggle={vi.fn()}
        onOpen={vi.fn()}
        isSelectable={() => true}
        actionsEnabled={false}
      />,
      { wrapper },
    );
    expect(document.querySelectorAll('[role="checkbox"]')).toHaveLength(0);
  });

  it("carries no V1 data dependency", () => {
    const src = tsCode("src/features/reviewExpensesServer/ReviewExpensesMobileList.tsx");
    expect(src).not.toContain("managerReviewExpenses");
    expect(src).toContain("@/features/reviewQueueServer/types");
  });
});
