/**
 * Employee-filter correctness, filtered KPIs and authoritative batch state
 * (DOC-080 §12).
 *
 * The runtime defect these prevent: searching employee 6174 — an employee the
 * employee-search RPC had just reported 24 visible expenses for — produced an
 * empty table with the KPI cards still reading organization-wide totals. Two
 * causes, both covered below: a leftover status filter silently intersecting the
 * employee, and a cursor from the previous query surviving one render into the
 * new query key, which asks the server for "employee 6174's rows after position
 * ~4,000 of the unfiltered ordering" and can only return nothing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { readFileSync } from "fs";
import { resolve } from "path";

const rpc = vi.fn();
const from = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: (...a: unknown[]) => rpc(...a), from: (...a: unknown[]) => from(...a) },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (k: string, p?: Record<string, unknown>) =>
      (p?.defaultValue as string) ?? (p?.name ? `${k} ${p.name}` : k),
    i18n: { language: "en" },
  }),
  Trans: ({ children }: { children?: ReactNode }) => children ?? null,
}));
vi.mock("@/hooks/useOrganizationRoleLabels", () => ({
  useOrganizationRoleLabels: () => ({ labels: null, loading: false, refresh: vi.fn() }),
}));

import { useSingleBarSearch } from "@/features/reviewQueueServer/hooks/useSingleBarSearch";
import { useCursorHistory } from "@/features/reviewQueueServer/hooks/useCursorHistory";
import {
  buildQueryShapeKey,
  useReviewQueueFilters,
} from "@/features/reviewQueueServer/hooks/useReviewQueueFilters";
import { useReviewQueuePage } from "@/features/reviewQueueServer/hooks/useReviewQueuePage";
import { reviewQueuePageKey } from "@/features/reviewQueueServer/queryKeys";
import {
  chooseSummary,
  filteredSummaryMatchesTotal,
  hasContentFilter,
} from "@/features/reviewExpensesServer/summarySource";
import { batchButtonStyle } from "@/features/reviewExpensesServer/reviewRowPresentation";
import { ReviewStatsCards } from "@/features/reviewExpensesServer/ReviewStatsCards";
import { ReviewExpensesTable } from "@/features/reviewExpensesServer/ReviewExpensesTable";
import { ReviewExpensesMobileList } from "@/features/reviewExpensesServer/ReviewExpensesMobileList";
import { isRowSelectable } from "@/features/reviewExpensesServer/reviewRowPresentation";
import type { ReviewQueueItem, ReviewQueuePage } from "@/features/reviewQueueServer/types";

const ORG = "6709c1fe-e8c8-404d-bc68-d1edda923344";
const KATARA = "c76edc75-3cab-4c70-85d2-5762fe949d1b";

const wrapper = ({ children }: { children: ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
};

function employeeResponse(matches: unknown[]) {
  return {
    data: {
      contract: "debug-review-employee-search",
      version: 1,
      query: "6174",
      match_count: matches.length,
      matches,
      truncated: false,
    },
    error: null,
  };
}

const KATARA_MATCH = {
  user_id: KATARA,
  employee_name: "Sanjaykumar Vinodbhai Katara",
  employee_id: "6174",
  employee_email: "sanjay@example.com",
  identity_source: "profile",
  identity_issue: null,
  visible_expense_count: 24,
  actionable_expense_count: 24,
  match_type: "exact_employee_id",
};

beforeEach(() => {
  rpc.mockReset();
  from.mockReset();
});

// ── Search requests (§16) ──────────────────────────────────────────────────

describe("employee search requests", () => {
  it("issues zero requests while typing", () => {
    const { result } = renderHook(() => useSingleBarSearch({ organizationId: ORG }), { wrapper });
    act(() => result.current.setDraft("6"));
    act(() => result.current.setDraft("61"));
    act(() => result.current.setDraft("617"));
    act(() => result.current.setDraft("6174"));
    expect(rpc).not.toHaveBeenCalled();
    expect(result.current.getEmployeeRequestCount()).toBe(0);
  });

  it("issues exactly one employee lookup per submit", async () => {
    rpc.mockResolvedValue(employeeResponse([KATARA_MATCH]));
    const { result } = renderHook(() => useSingleBarSearch({ organizationId: ORG }), { wrapper });
    act(() => result.current.setDraft("6174"));
    await act(async () => {
      await result.current.submit();
    });
    expect(result.current.getEmployeeRequestCount()).toBe(1);
  });

  it("collapses a double submit into one lookup", async () => {
    let release: (v: unknown) => void = () => undefined;
    rpc.mockImplementation(
      () => new Promise((res) => { release = res; }),
    );
    const { result } = renderHook(() => useSingleBarSearch({ organizationId: ORG }), { wrapper });
    act(() => result.current.setDraft("6174"));
    // Enter and the button click, or a double click — same intent, once.
    let first: Promise<void> = Promise.resolve();
    let second: Promise<void> = Promise.resolve();
    act(() => {
      first = result.current.submit();
      second = result.current.submit();
    });
    await act(async () => {
      release(employeeResponse([KATARA_MATCH]));
      await Promise.all([first, second]);
    });
    expect(result.current.getEmployeeRequestCount()).toBe(1);
  });

  it("selects the immutable user_id on an exact match, not the typed text", async () => {
    rpc.mockResolvedValue(employeeResponse([KATARA_MATCH]));
    const { result } = renderHook(() => useSingleBarSearch({ organizationId: ORG }), { wrapper });
    act(() => result.current.setDraft("6174"));
    await act(async () => {
      await result.current.submit();
    });
    expect(result.current.selectedEmployee?.user_id).toBe(KATARA);
    // The digits must not survive as a text filter — that is the collision.
    expect(result.current.generalSearch).toBeNull();
  });

  it("reports an employee resolution to the page", async () => {
    rpc.mockResolvedValue(employeeResponse([KATARA_MATCH]));
    const onResolved = vi.fn();
    const { result } = renderHook(
      () => useSingleBarSearch({ organizationId: ORG, onResolved }),
      { wrapper },
    );
    act(() => result.current.setDraft("6174"));
    await act(async () => {
      await result.current.submit();
    });
    expect(onResolved).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "employee", employee: expect.objectContaining({ user_id: KATARA }) }),
    );
  });

  it("bypasses employee lookup for txn:06174", async () => {
    const { result } = renderHook(() => useSingleBarSearch({ organizationId: ORG }), { wrapper });
    act(() => result.current.setDraft("txn:06174"));
    await act(async () => {
      await result.current.submit();
    });
    expect(rpc).not.toHaveBeenCalled();
    expect(result.current.generalSearch).toBe("06174");
    expect(result.current.selectedEmployee).toBeNull();
  });

  it("discards a stale employee response that lands after a newer one", async () => {
    const resolvers: Array<(v: unknown) => void> = [];
    rpc.mockImplementation(() => new Promise((res) => resolvers.push(res)));
    const { result } = renderHook(() => useSingleBarSearch({ organizationId: ORG }), { wrapper });

    act(() => result.current.setDraft("617"));
    let slow: Promise<void> = Promise.resolve();
    act(() => { slow = result.current.submit(); });

    // Free the guard so a genuinely newer submit can run, as a real second
    // search would after the first settles.
    await act(async () => {
      resolvers[0]?.({
        data: {
          contract: "debug-review-employee-search",
          version: 1,
          query: "617",
          match_count: 0,
          matches: [],
          truncated: false,
        },
        error: null,
      });
      await slow;
    });

    act(() => result.current.setDraft("6174"));
    let fresh: Promise<void> = Promise.resolve();
    act(() => { fresh = result.current.submit(); });
    await act(async () => {
      resolvers[1]?.(employeeResponse([KATARA_MATCH]));
      await fresh;
    });

    expect(result.current.selectedEmployee?.user_id).toBe(KATARA);
  });
});

// ── Filter reset and cursor reset (§16.5–9) ────────────────────────────────

describe("employee selection transition", () => {
  it("clears status, category, time, actionable and custom filters", () => {
    const { result } = renderHook(() => useReviewQueueFilters(), { wrapper });
    act(() => {
      result.current.setStatuses(["level_2_verified"]);
      result.current.setCategories(["Travel"]);
      result.current.setTimePeriod("month");
      result.current.setActionableOnly(true);
      result.current.setCustomFilters([{ source: "template", field_id: "f1", values: ["x"] }]);
      result.current.setSort("amount_desc");
      result.current.setPageSize(50);
    });
    act(() => result.current.resetContentFilters());

    expect(result.current.filters.statuses).toEqual([]);
    expect(result.current.filters.categories).toEqual([]);
    expect(result.current.filters.timePeriod).toBe("all");
    expect(result.current.filters.actionableOnly).toBe(false);
    expect(result.current.filters.customFilters).toEqual([]);
    // Presentation preferences are about HOW results show, not WHICH.
    expect(result.current.filters.sort).toBe("amount_desc");
    expect(result.current.filters.pageSize).toBe(50);
  });

  it("drops the previous cursor in the SAME render the shape changes", () => {
    const shapeA = buildQueryShapeKey({
      organizationId: ORG, employeeUserId: null, generalSearch: null,
      statuses: [], categories: [], dateFrom: null, dateTo: null,
      actionableOnly: false, customFilters: [], sort: "created_desc", pageSize: 25,
    });
    const shapeB = buildQueryShapeKey({
      organizationId: ORG, employeeUserId: KATARA, generalSearch: null,
      statuses: [], categories: [], dateFrom: null, dateTo: null,
      actionableOnly: false, customFilters: [], sort: "created_desc", pageSize: 25,
    });

    const { result, rerender } = renderHook(({ k }: { k: string }) => useCursorHistory(k), {
      wrapper,
      initialProps: { k: shapeA },
    });

    act(() => result.current.goNext({ sk: "4000", id: "deep-row" }));
    expect(result.current.pageNumber).toBe(2);
    expect(result.current.cursor).not.toBeNull();

    rerender({ k: shapeB });

    // THE regression. If this reset lagged by a commit, the very next queue key
    // would pair employee 6174 with a cursor from the unfiltered ordering and
    // the server would correctly return nothing.
    expect(result.current.cursor).toBeNull();
    expect(result.current.pageNumber).toBe(1);
  });

  it("puts the employee user id, not the typed digits, in the query key", () => {
    const base = {
      organizationId: ORG, userId: "reviewer", employeeUserId: KATARA,
      generalSearch: null, statuses: [], categories: [], dateFrom: null, dateTo: null,
      actionableOnly: false, customFilters: [], sort: "created_desc" as const,
      pageSize: 25, cursor: null,
    };
    const key = reviewQueuePageKey("review", base);
    expect(key).toContain(KATARA);
    expect(key).not.toContain("6174");
  });

  it("changes the query key when the employee is selected and when cleared", () => {
    const base = {
      organizationId: ORG, userId: "r", generalSearch: null, statuses: [], categories: [],
      dateFrom: null, dateTo: null, actionableOnly: false, customFilters: [],
      sort: "created_desc" as const, pageSize: 25, cursor: null,
    };
    const none = JSON.stringify(reviewQueuePageKey("review", { ...base, employeeUserId: null }));
    const picked = JSON.stringify(reviewQueuePageKey("review", { ...base, employeeUserId: KATARA }));
    expect(none).not.toBe(picked);
  });

  it("issues exactly one queue request for the new key", async () => {
    rpc.mockResolvedValue({ data: pageResponse({ filteredTotal: 24 }), error: null });
    const input = {
      organizationId: ORG, userId: "r", employeeUserId: KATARA, generalSearch: null,
      statuses: [], categories: [], dateFrom: null, dateTo: null, actionableOnly: false,
      customFilters: [], sort: "created_desc" as const, pageSize: 25, cursor: null,
      enabled: true,
    };
    const { result } = renderHook(() => useReviewQueuePage("review", input), { wrapper });
    await waitFor(() => expect(result.current.page).not.toBeNull());
    expect(result.current.getRequestCount()).toBe(1);
    const args = rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(args.p_employee_user_id).toBe(KATARA);
    expect(args.p_general_search).toBeNull();
    expect(args.p_statuses).toBeNull();
    expect(args.p_categories).toBeNull();
    expect(args.p_actionable_only).toBe(false);
    expect(args.p_custom_filters).toEqual([]);
  });
});

// ── Filtered KPI summary (§17) ─────────────────────────────────────────────

function summary(over: Record<string, number> = {}) {
  return {
    assigned_to_me: 24, pending_review: 20, completed_review: 4,
    verified: 1, approved: 2, rejected: 1, paid: 0, other_terminal: 0,
    actionable_now: 15, active_not_actionable_now: 5, unclassified: 0,
    total_amount: 96000, reconciliation_ok: true, ...over,
  };
}

function pageResponse(o: { filteredTotal?: number; withFiltered?: boolean; items?: unknown[] } = {}) {
  return {
    contract: "debug-review-queue",
    version: 1,
    request: {
      employee_user_id: KATARA, general_search: null, sort: "created_desc",
      page_size: 25, actionable_only: false,
    },
    caller: {
      role: "executive", hierarchy_enabled: true,
      team_leader_enabled: true, executive_enabled: true,
    },
    selected_employee: null,
    scope_summary: {
      assigned_to_me: 7699, scope_total: 7699, pending_review: 7691,
      completed_review: 8, verified: 2, approved: 3, rejected: 3, paid: 0,
      other_terminal: 0, actionable_now: 5900, active_not_actionable_now: 1791,
      directly_assigned: 5921, hierarchy_assigned: 7699, team_assigned: 0,
      admin_scope_assigned: 0, unclassified: 0, self_owned_visible_expenses: 0,
      visible_without_assignment_reason: 0, total_amount: 16909968.88,
      reconciliation_ok: true,
    },
    filtered_summary: o.withFiltered === false ? null : summary({
      assigned_to_me: o.filteredTotal ?? 24,
    }),
    filtered_total: o.filteredTotal ?? 24,
    total_pages: 1,
    has_more: false,
    next_cursor: null,
    items: o.items ?? [],
    diagnostics: {
      page_returned: (o.items ?? []).length, identity_resolved: 0,
      identity_unresolved: 0, batches_on_page: 0, schema_revision: "20260802030000",
    },
  };
}

describe("filtered KPI summary", () => {
  const parsed = (o = {}) => pageResponse(o) as unknown as ReviewQueuePage;

  it("uses scope_summary when nothing is filtered", () => {
    const c = chooseSummary(parsed(), false);
    expect(c.state).toBe("ready");
    if (c.state === "ready") {
      expect(c.filtered).toBe(false);
      expect(c.summary.assigned_to_me).toBe(7699);
    }
  });

  it("uses filtered_summary the moment anything is filtered", () => {
    const c = chooseSummary(parsed(), true);
    expect(c.state).toBe("ready");
    if (c.state === "ready") {
      expect(c.filtered).toBe(true);
      expect(c.summary.assigned_to_me).toBe(24);
    }
  });

  it("treats a missing filtered_summary as unsupported, never as zero", () => {
    const c = chooseSummary(parsed({ withFiltered: false }), true);
    expect(c.state).toBe("unsupported");
  });

  it("requires filtered assigned_to_me to equal filtered_total", () => {
    expect(filteredSummaryMatchesTotal(parsed({ filteredTotal: 24 }))).toBe(true);
    const bad = parsed({ filteredTotal: 24 }) as ReviewQueuePage;
    (bad.filtered_summary as { assigned_to_me: number }).assigned_to_me = 23;
    expect(filteredSummaryMatchesTotal(bad)).toBe(false);
  });

  it("counts a selected employee as a content filter", () => {
    const none = {
      employeeUserId: null, generalSearch: null, statuses: [], categories: [],
      timePeriod: "all", actionableOnly: false, customFilterCount: 0,
    };
    expect(hasContentFilter(none)).toBe(false);
    expect(hasContentFilter({ ...none, employeeUserId: KATARA })).toBe(true);
    expect(hasContentFilter({ ...none, statuses: ["submitted"] })).toBe(true);
    expect(hasContentFilter({ ...none, categories: ["Travel"] })).toBe(true);
    expect(hasContentFilter({ ...none, timePeriod: "month" })).toBe(true);
    expect(hasContentFilter({ ...none, actionableOnly: true })).toBe(true);
    expect(hasContentFilter({ ...none, customFilterCount: 1 })).toBe(true);
    expect(hasContentFilter({ ...none, generalSearch: "hotel" })).toBe(true);
  });

  it("renders the employee's numbers, not the organization's", () => {
    render(
      <ReviewStatsCards
        page={parsed()}
        loading={false}
        filtered
        context={{ kind: "employee", name: "Sanjaykumar Vinodbhai Katara", employeeId: "6174" }}
      />,
      { wrapper },
    );
    expect(screen.getByTestId("review-stat-assigned").textContent).toContain("24");
    expect(screen.getByTestId("review-stat-assigned").textContent).not.toContain("7699");
    expect(screen.getByTestId("review-stats-context").textContent).toContain(
      "Sanjaykumar Vinodbhai Katara",
    );
  });

  it("renders the global numbers when unfiltered, with no context line", () => {
    render(<ReviewStatsCards page={parsed()} loading={false} />, { wrapper });
    expect(screen.getByTestId("review-stat-assigned").textContent).toContain("7699");
    expect(screen.queryByTestId("review-stats-context")).toBeNull();
  });

  it("shows a contract warning rather than zeros on an older server", () => {
    render(<ReviewStatsCards page={parsed({ withFiltered: false })} loading={false} filtered />, {
      wrapper,
    });
    expect(screen.getByTestId("review-filtered-summary-unsupported")).toBeTruthy();
    expect(screen.getByTestId("review-stat-assigned").textContent).not.toContain("0");
  });

  it("does not change when the page or page size changes", () => {
    // filtered_summary is aggregated before the cursor and the limit, so two
    // pages of the same query carry identical numbers.
    const p1 = chooseSummary(parsed({ filteredTotal: 24 }), true);
    const p2 = chooseSummary(parsed({ filteredTotal: 24 }), true);
    expect(p1).toEqual(p2);
  });
});

// ── Batch state (§18) ──────────────────────────────────────────────────────

function item(over: Partial<ReviewQueueItem> = {}): ReviewQueueItem {
  return {
    id: "e-1", transaction_number: "00424", batch_id: null, user_id: KATARA,
    employee_name: "Sanjaykumar Vinodbhai Katara", employee_id: "6174",
    employee_email: "s@e.com", identity_source: "profile", identity_issue: null,
    current_balance: 10000, title: "CCTV", purpose: "Site", category: "Travel",
    destination: "Surat", total_amount: 3960, status: "submitted",
    approval_tier: "engineer", created_at: "2026-06-30T10:00:00Z",
    trip_start: "2026-06-30", is_resubmitted: false, was_reviewer_corrected: false,
    is_actionable: true, actionable_stage: "engineer",
    actionable_reason: "actionable_at_engineer",
    available_actions: ["approve", "reject"], view_only: false,
    batch_total_lines: null, batch_actionable_lines: null,
    batch_non_actionable_lines: null, batch_action_state: null,
    custom_fields: [], ...over,
  } as ReviewQueueItem;
}

describe("batch state", () => {
  it("is blue when every line is actionable", () => {
    const s = batchButtonStyle("all_pending");
    expect(s.className).toContain("bg-blue-600");
    expect(s.variant).toBe("default");
  });

  it("is amber when only some lines are actionable", () => {
    const s = batchButtonStyle("partial");
    expect(s.className).toContain("bg-amber-500");
  });

  it("is grey when no line is actionable for this reviewer", () => {
    const s = batchButtonStyle("all_done");
    expect(s.variant).toBe("secondary");
    expect(s.className).not.toContain("bg-blue");
    expect(s.className).not.toContain("bg-amber");
  });

  it("falls back to blue, never grey, when the server did not say", () => {
    // Grey would claim a batch is finished on no evidence at all.
    expect(batchButtonStyle(null).className).toContain("bg-blue-600");
    expect(batchButtonStyle(undefined).className).toContain("bg-blue-600");
  });

  function renderTable(items: ReviewQueueItem[]) {
    return render(
      <ReviewExpensesTable
        items={items}
        selectedIds={new Set()}
        onToggle={vi.fn()}
        onSelectAll={vi.fn()}
        onOpen={vi.fn()}
        isSelectable={isRowSelectable}
        actionsEnabled
      />,
      { wrapper },
    );
  }

  it("greys a level_2_verified batch that is done for this executive", () => {
    renderTable([
      item({
        id: "b-1", batch_id: "batch-9", status: "level_2_verified",
        is_actionable: false, view_only: true, available_actions: [],
        batch_total_lines: 6, batch_actionable_lines: 0,
        batch_non_actionable_lines: 6, batch_action_state: "all_done",
      }),
    ]);
    const btn = screen.getByTestId("review-batch-b-1");
    expect(btn.getAttribute("data-batch-state")).toBe("all_done");
    expect(btn.className).not.toContain("bg-blue");
  });

  it("keeps a grey batch button clickable", () => {
    const onOpen = vi.fn();
    render(
      <ReviewExpensesTable
        items={[item({ id: "b-1", batch_id: "batch-9", batch_action_state: "all_done", batch_total_lines: 3, batch_actionable_lines: 0 })]}
        selectedIds={new Set()}
        onToggle={vi.fn()}
        onSelectAll={vi.fn()}
        onOpen={onOpen}
        isSelectable={isRowSelectable}
        actionsEnabled
      />,
      { wrapper },
    );
    const btn = screen.getByTestId("review-batch-b-1");
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ batch_id: "batch-9" }));
  });

  it("uses whole-batch counts, not the lines on this page", () => {
    // One line visible, six in the batch — the state must come from the six.
    renderTable([
      item({
        id: "b-1", batch_id: "batch-9", is_actionable: true,
        batch_total_lines: 6, batch_actionable_lines: 2,
        batch_non_actionable_lines: 4, batch_action_state: "partial",
      }),
    ]);
    expect(screen.getByTestId("review-batch-b-1").getAttribute("data-batch-state")).toBe("partial");
  });

  it("needs no request of its own — the state arrives on the row", () => {
    renderTable([
      item({ id: "b-1", batch_id: "batch-9", batch_action_state: "all_done", batch_total_lines: 2, batch_actionable_lines: 0 }),
      item({ id: "b-2", batch_id: "batch-8", batch_action_state: "partial", batch_total_lines: 5, batch_actionable_lines: 2 }),
      item({ id: "b-3", batch_id: "batch-7", batch_action_state: "all_pending", batch_total_lines: 3, batch_actionable_lines: 3 }),
    ]);
    expect(rpc).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  it("agrees between desktop and mobile", () => {
    const row = item({
      id: "b-1", batch_id: "batch-9", batch_action_state: "all_done",
      batch_total_lines: 4, batch_actionable_lines: 0,
    });
    const desktop = render(
      <ReviewExpensesTable
        items={[row]} selectedIds={new Set()} onToggle={vi.fn()} onSelectAll={vi.fn()}
        onOpen={vi.fn()} isSelectable={isRowSelectable} actionsEnabled
      />,
      { wrapper },
    );
    const desktopState = screen
      .getByTestId("review-batch-b-1")
      .getAttribute("data-batch-state");
    desktop.unmount();

    render(
      <ReviewExpensesMobileList
        items={[row]} selectedIds={new Set()} onToggle={vi.fn()}
        onOpen={vi.fn()} isSelectable={isRowSelectable} actionsEnabled
      />,
      { wrapper },
    );
    expect(
      screen.getByTestId("review-mobile-batch-badge-b-1").getAttribute("data-batch-state"),
    ).toBe(desktopState);
  });
});

// ── Server contract: the migration computes it, the client never does ──────

describe("batch state is server-authoritative", () => {
  const sql = () =>
    readFileSync(
      resolve(
        process.cwd(),
        "supabase/migrations/20260802030000_review_filtered_summary_and_batch_state.sql",
      ),
      "utf-8",
    );

  it("computes batch state over the canonical assigned scope", () => {
    const s = sql();
    expect(s).toContain("_debug_review_assigned_scope_v1");
    expect(s).toContain("batch_action_state");
    expect(s).toContain("all_done");
  });

  it("aggregates the filtered summary before the cursor and the limit", () => {
    const s = sql();
    const fs = s.indexOf("fsummary AS");
    const ordered = s.indexOf("ordered AS MATERIALIZED");
    expect(fs).toBeGreaterThan(-1);
    expect(fs).toBeLessThan(ordered);
  });

  it("mutates nothing", () => {
    const s = sql().replace(/--.*$/gm, "");
    expect(s).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(s).not.toMatch(/\bUPDATE\s+\w/i);
    expect(s).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(s).not.toMatch(/\bTRUNCATE\b/i);
    expect(s).not.toMatch(/\bALTER\s+TABLE\b/i);
    expect(s).not.toMatch(/\bDROP\s+TABLE\b/i);
  });

  it("never grants the new helper to anon", () => {
    const s = sql();
    expect(s).toContain(
      "REVOKE ALL ON FUNCTION public._debug_review_batch_state_v1(uuid,uuid[]) FROM anon",
    );
    // Statement-scoped: the header prose mentions GRANT and anon separately, so
    // a whole-file regex would match across unrelated lines.
    const grants = s
      .replace(/--.*$/gm, "")
      .split(";")
      .filter((stmt) => /\bGRANT\b/i.test(stmt));
    expect(grants.length).toBeGreaterThan(0);
    for (const g of grants) expect(g).not.toMatch(/\banon\b/i);
  });
});
