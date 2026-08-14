/**
 * Debug Review Expenses — page, hooks, SQL corrections and request budget
 * (DOC-080 Phase 28).
 *
 * The load-bearing assertions here are the ones a reviewer would otherwise have
 * to verify by hand in DevTools: typing issues zero requests, the employee
 * filter travels as an immutable user_id, cursors reset when the query shape
 * changes, and no browser call is ever made to profiles / audit_logs /
 * expense_form_field_values or to any V1 or V2 review RPC.
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
  supabase: {
    rpc: (...a: unknown[]) => rpc(...a),
    from: (...a: unknown[]) => from(...a),
  },
}));

vi.mock("react-i18next", () => ({
  // Return the key plus its interpolated values, so assertions can target stable
  // keys while still proving the right data reached the string.
  useTranslation: () => ({
    t: (k: string, params?: Record<string, unknown>) => {
      if (!params) return k;
      const values = Object.entries(params)
        .filter(([p]) => p !== "defaultValue")
        .map(([, v]) => String(v))
        .join(" ");
      return values ? `${k} ${values}` : k;
    },
    i18n: { language: "en" },
  }),
  Trans: ({ children }: { children?: ReactNode }) => children ?? null,
}));

import { DebugEmployeeSearch } from "@/features/debugReviewQueue/DebugEmployeeSearch";
import { DebugGeneralSearch } from "@/features/debugReviewQueue/DebugGeneralSearch";
import { DebugReviewErrorState } from "@/features/debugReviewQueue/DebugReviewErrorState";
import { DebugReviewPagination } from "@/features/debugReviewQueue/DebugReviewPagination";
import { DebugReviewStats } from "@/features/debugReviewQueue/DebugReviewStats";
import { DebugReviewTable } from "@/features/debugReviewQueue/DebugReviewTable";
import { DebugReviewMobileList } from "@/features/debugReviewQueue/DebugReviewMobileList";
import {
  timePeriodToRange,
  useDebugReviewFilters,
} from "@/features/debugReviewQueue/hooks/useDebugReviewFilters";
import { debugReviewPageKey } from "@/features/debugReviewQueue/hooks/useDebugReviewPage";
import {
  buildRedactedDiagnostics,
  maskId,
} from "@/features/debugReviewQueue/hooks/useDebugReviewDiagnostics";
import { REVIEW_QUEUE_RPCS } from "@/features/reviewQueueServer/api";
import {
  fetchDebugReviewExpenseDetail,
  fetchDebugReviewFilterOptions,
  fetchDebugReviewPage,
  parseCapabilities,
} from "@/features/debugReviewQueue/api";
import {
  DebugReviewValidationError,
  formatEmployeeIdentity,
  identityIssueLabel,
} from "@/features/debugReviewQueue/types";
import { pageWindow, formatAmount } from "@/features/debugReviewQueue/format";

const ORG = "6709c1fe-e8c8-404d-bc68-d1edda923344";
const KATARA = "c76edc75-3cab-4c70-85d2-5762fe949d1b";
const KATHERIA = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const cwd = process.cwd();
const strip = (s: string) =>
  s.split(/\r?\n/).filter((l) => !l.trim().startsWith("--")).join("\n");
const SQL_FIX = strip(
  readFileSync(
    resolve(cwd, "supabase/migrations/20260801150000_debug_review_queue_v1_corrections.sql"),
    "utf-8",
  ),
);
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

const item = (over: Partial<Record<string, unknown>> = {}) => ({
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
  scope_summary: { assigned_to_me: 5, pending_review: 3, verified: 2, total_amount: 1000 },
  diagnostics: { page_returned: 1, identity_resolved: 1, identity_unresolved: 0 },
  ...over,
});

beforeEach(() => {
  rpc.mockReset();
  from.mockReset();
});

// ── SQL corrections (Phases 2, 3, 5, 6) ─────────────────────────────────────

describe("SQL corrections migration", () => {
  it("is additive — it never drops or alters the base migration's functions", () => {
    expect(SQL_FIX).not.toMatch(/DROP\s+FUNCTION/i);
    expect(SQL_FIX).not.toMatch(/ALTER\s+TABLE/i);
    expect(SQL_FIX).not.toMatch(/DROP\s+TABLE/i);
  });

  it("defines exactly one canonical actionability helper", () => {
    const defs = SQL_FIX.match(/CREATE OR REPLACE FUNCTION public\._debug_review_actionability_v1/g);
    expect(defs).toHaveLength(1);
  });

  it("actionability accounts for role, tier, assignment, hierarchy and handoff", () => {
    const fn = SQL_FIX.slice(
      SQL_FIX.indexOf("FUNCTION public._debug_review_actionability_v1"),
      SQL_FIX.indexOf("FUNCTION public._debug_review_handoff_ids_v1"),
    );
    expect(fn).toContain("p_role");
    expect(fn).toContain("p_tier");
    expect(fn).toContain("v_is_reviewer");
    expect(fn).toContain("v_is_engineer");
    expect(fn).toContain("p_hierarchy_enabled");
    expect(fn).toContain("p_team_leader_enabled");
    expect(fn).toContain("p_executive_enabled");
    expect(fn).toContain("p_handoff");
    expect(fn).toContain("v_skipped");
    expect(fn).toContain("available_actions");
    expect(fn).toContain("view_only");
    expect(fn).toContain("actionable_stage");
    expect(fn).toContain("actionable_reason");
  });

  it("employee-search counts and KPI counts both call the same helper", () => {
    // Three call sites: employee search, queue page, detail.
    const calls = SQL_FIX.match(/public\._debug_review_actionability_v1\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
    // The naive definition must not survive anywhere as an actionability source.
    expect(SQL_FIX).not.toContain(
      "'is_actionable', pr.status NOT IN ('verified','approved','rejected')",
    );
  });

  it("resolves identity to at most one row per user_id", () => {
    const fn = SQL_FIX.slice(SQL_FIX.indexOf("FUNCTION public._debug_review_resolve_identity_v1"));
    expect(fn).toContain("DISTINCT ON (r.user_id)");
    expect(fn).toContain("duplicate_profiles");
    expect(fn).toContain("profile_missing");
  });

  it("keyset comparison is null-free and always ascending", () => {
    expect(SQL_FIX).toContain("(k.sk, k.id) > (v_c_sk, v_c_id)");
    expect(SQL_FIX).toContain("ORDER BY k.sk ASC, k.id ASC");
    // The NULL-producing tuple comparisons from the base migration are gone.
    expect(SQL_FIX).not.toContain("(f.created_at, f.id) <");
    expect(SQL_FIX).not.toContain("(f.trip_start, f.id) <");
  });

  it("gives every sort a finite sentinel so NULLs sort last deterministically", () => {
    for (const sort of [
      "created_desc",
      "created_asc",
      "expense_date_desc",
      "expense_date_asc",
      "amount_desc",
    ]) {
      expect(SQL_FIX).toContain(`WHEN '${sort}'`);
    }
    expect(SQL_FIX).toContain("v_hi     numeric := 1e30");
    expect(SQL_FIX).toContain("v_lo     numeric := -1e30");
  });

  it("uses page_size + 1 for has_more and never OFFSET", () => {
    expect(SQL_FIX).toContain("o.rn <= v_size + 1");
    expect(SQL_FIX).not.toMatch(/\bOFFSET\b/i);
  });

  it("pins the cursor to the sort that produced it", () => {
    expect(SQL_FIX).toContain("coalesce(p_cursor->>'sort', v_sort) = v_sort");
  });

  it("excludes soft-deleted attachments from detail", () => {
    expect(SQL_FIX).toContain("a.deleted_at IS NULL");
    expect(SQL_FIX).toContain("deleted_attachment_count");
  });

  it("keeps every function SECURITY DEFINER with an empty search_path", () => {
    const defs = SQL_FIX.match(/CREATE OR REPLACE FUNCTION public\.(\w+)/g) ?? [];
    expect(defs.length).toBeGreaterThan(0);
    // The pure helper is IMMUTABLE and touches no tables, so it needs no definer.
    const definers = SQL_FIX.match(/SECURITY DEFINER/g) ?? [];
    expect(definers.length).toBe(defs.length - 1);
    const paths = SQL_FIX.match(/SET search_path = ''/g) ?? [];
    expect(paths.length).toBe(defs.length - 1);
  });

  it("revokes from PUBLIC and anon and grants only to authenticated", () => {
    const pub = SQL_FIX.match(/REVOKE ALL ON FUNCTION[^;]*FROM PUBLIC/g) ?? [];
    const anon = SQL_FIX.match(/REVOKE ALL ON FUNCTION[^;]*FROM anon/g) ?? [];
    const auth = SQL_FIX.match(/GRANT EXECUTE ON FUNCTION[^;]*TO authenticated/g) ?? [];
    expect(pub.length).toBe(anon.length);
    expect(auth.length).toBe(pub.length);
    expect(SQL_FIX).not.toMatch(/GRANT EXECUTE ON FUNCTION[^;]*TO (anon|PUBLIC)/);
  });

  it("selected_employee survives a missing profile", () => {
    expect(SQL_FIX).toContain("FROM sel_ident si");
    expect(SQL_FIX).toContain("coalesce(si.employee_name, 'Unknown employee')");
  });

  it("the employee filter is still an exact user_id and never a transaction number", () => {
    expect(SQL_FIX).toContain("p_employee_user_id IS NULL OR r.user_id = p_employee_user_id");
    const searchFn = SQL_FIX.slice(
      SQL_FIX.indexOf("FUNCTION public.search_debug_review_employees_v1"),
      SQL_FIX.indexOf("FUNCTION public.get_debug_review_queue_page_v1"),
    );
    expect(searchFn).not.toContain("transaction_number");
  });
});

// ── Filters + cursor history (Phase 9) ──────────────────────────────────────

describe("cursor history", () => {
  const cursor = (id: string) => ({ sk: "1", id, sort: "created_desc" as const });

  it("starts on page 1 with a null cursor and no previous", () => {
    const { result } = renderHook(() => useDebugReviewFilters());
    expect(result.current.cursor).toBeNull();
    expect(result.current.pageNumber).toBe(1);
    expect(result.current.canGoPrevious).toBe(false);
  });

  it("pushes and pops through pages", () => {
    const { result } = renderHook(() => useDebugReviewFilters());
    act(() => result.current.goNext(cursor("a")));
    expect(result.current.pageNumber).toBe(2);
    expect(result.current.cursor?.id).toBe("a");
    expect(result.current.canGoPrevious).toBe(true);

    act(() => result.current.goNext(cursor("b")));
    expect(result.current.pageNumber).toBe(3);

    act(() => result.current.goPrevious());
    expect(result.current.pageNumber).toBe(2);
    expect(result.current.cursor?.id).toBe("a");

    act(() => result.current.goPrevious());
    expect(result.current.pageNumber).toBe(1);
    expect(result.current.cursor).toBeNull();
  });

  it("ignores Next when the server sent no cursor", () => {
    const { result } = renderHook(() => useDebugReviewFilters());
    act(() => result.current.goNext(null));
    expect(result.current.pageNumber).toBe(1);
  });

  it.each([
    ["sort", (r: ReturnType<typeof useDebugReviewFilters>) => r.setSort("amount_desc")],
    ["status", (r: ReturnType<typeof useDebugReviewFilters>) => r.setStatuses(["submitted"])],
    ["category", (r: ReturnType<typeof useDebugReviewFilters>) => r.setCategories(["Travel"])],
    ["time period", (r: ReturnType<typeof useDebugReviewFilters>) => r.setTimePeriod("week")],
    ["actionable only", (r: ReturnType<typeof useDebugReviewFilters>) => r.setActionableOnly(true)],
    ["page size", (r: ReturnType<typeof useDebugReviewFilters>) => r.setPageSize(50)],
    [
      "custom filters",
      (r: ReturnType<typeof useDebugReviewFilters>) =>
        r.setCustomFilters([{ source: "template", field_id: "f1", values: ["x"] }]),
    ],
  ])("resets pagination when %s changes", (_label, change) => {
    const { result } = renderHook(() => useDebugReviewFilters());
    act(() => result.current.goNext(cursor("a")));
    expect(result.current.pageNumber).toBe(2);
    act(() => change(result.current));
    expect(result.current.cursor).toBeNull();
    expect(result.current.pageNumber).toBe(1);
    expect(result.current.canGoPrevious).toBe(false);
  });

  it("resets pagination when the general search is submitted or cleared", () => {
    const { result } = renderHook(() => useDebugReviewFilters());
    act(() => result.current.setDraftGeneralSearch("CCTV"));
    act(() => result.current.goNext(cursor("a")));
    act(() => result.current.submitGeneralSearch());
    expect(result.current.pageNumber).toBe(1);
    expect(result.current.submittedGeneralSearch).toBe("CCTV");

    act(() => result.current.goNext(cursor("b")));
    act(() => result.current.clearGeneralSearch());
    expect(result.current.pageNumber).toBe(1);
    expect(result.current.submittedGeneralSearch).toBeNull();
  });

  it("only the SUBMITTED expense search is observable", () => {
    const { result } = renderHook(() => useDebugReviewFilters());
    act(() => result.current.setDraftGeneralSearch("CC"));
    act(() => result.current.setDraftGeneralSearch("CCT"));
    act(() => result.current.setDraftGeneralSearch("CCTV"));
    // Typing changed nothing the query key can see.
    expect(result.current.submittedGeneralSearch).toBeNull();
  });

  it("treats a whitespace-only search as cleared", () => {
    const { result } = renderHook(() => useDebugReviewFilters());
    act(() => result.current.setDraftGeneralSearch("   "));
    act(() => result.current.submitGeneralSearch());
    expect(result.current.submittedGeneralSearch).toBeNull();
  });

  it("derives inclusive date windows and no bounds for All Time", () => {
    const now = new Date("2026-08-01T00:00:00Z");
    expect(timePeriodToRange("all", now)).toEqual({ from: null, to: null });
    expect(timePeriodToRange("week", now).to).toBe("2026-08-01");
    expect(timePeriodToRange("week", now).from).toBe("2026-07-25");
    expect(timePeriodToRange("year", now).from).toBe("2025-08-01");
  });
});

// ── Query key: only submitted values (Phase 8) ──────────────────────────────

describe("page query key", () => {
  const base = {
    organizationId: ORG,
    userId: "u1",
    employeeUserId: KATARA,
    generalSearch: "CCTV",
    statuses: ["submitted"],
    categories: ["Travel"],
    dateFrom: null,
    dateTo: null,
    actionableOnly: false,
    customFilters: [],
    sort: "created_desc" as const,
    pageSize: 25,
    cursor: null,
  };

  it("contains the selected user_id and the submitted search", () => {
    const key = JSON.stringify(debugReviewPageKey(base));
    expect(key).toContain(KATARA);
    expect(key).toContain("CCTV");
  });

  it("is stable across equivalent filter orderings", () => {
    const a = debugReviewPageKey({ ...base, statuses: ["submitted", "edited"] });
    const b = debugReviewPageKey({ ...base, statuses: ["edited", "submitted"] });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("changes when the cursor changes", () => {
    const a = debugReviewPageKey(base);
    const b = debugReviewPageKey({ ...base, cursor: { sk: "5", id: "e-9" } });
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it("never reads draft text — the hook has no draft field at all", () => {
    const src = tsCode("src/features/debugReviewQueue/hooks/useDebugReviewPage.ts");
    expect(src).not.toContain("draft");
    expect(src).not.toMatch(/debounce|setTimeout/i);
  });
});

// ── Employee search UI (Phase 12) ───────────────────────────────────────────

describe("employee search UI", () => {
  const renderSearch = (over: Record<string, unknown> = {}) => {
    const onSubmit = vi.fn();
    const onDraftChange = vi.fn();
    const onClear = vi.fn();
    render(
      <DebugEmployeeSearch
        draft=""
        onDraftChange={onDraftChange}
        onSubmit={onSubmit}
        onClear={onClear}
        state="idle"
        selected={null}
        submitted={null}
        {...over}
      />,
      { wrapper },
    );
    return { onSubmit, onDraftChange, onClear };
  };

  it("issues no submit while typing", () => {
    const { onSubmit, onDraftChange } = renderSearch();
    const input = screen.getByTestId("debug-employee-search-input");
    fireEvent.change(input, { target: { value: "6" } });
    fireEvent.change(input, { target: { value: "61" } });
    fireEvent.change(input, { target: { value: "617" } });
    fireEvent.change(input, { target: { value: "6174" } });
    expect(onDraftChange).toHaveBeenCalledTimes(4);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("submits once on the Search button", () => {
    const { onSubmit } = renderSearch({ draft: "6174" });
    fireEvent.click(screen.getByTestId("debug-employee-search-submit"));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("submits once on Enter", () => {
    const { onSubmit } = renderSearch({ draft: "6174" });
    fireEvent.submit(screen.getByTestId("debug-employee-search-input").closest("form")!);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("shows a not-found state rather than an empty queue", () => {
    renderSearch({ state: "not_found", submitted: "nobody" });
    expect(screen.getByTestId("debug-employee-not-found")).toBeTruthy();
  });

  it("shows the selected employee with both counts", () => {
    renderSearch({
      state: "selected",
      selected: {
        user_id: KATARA,
        employee_name: "Sanjaykumar Vinodbhai Katara",
        employee_id: "6174",
        identity_source: "current_profile",
        identity_issue: null,
        visible_expense_count: 24,
        actionable_expense_count: 24,
      },
    });
    const chip = screen.getByTestId("debug-selected-employee");
    expect(chip.textContent).toContain("Sanjaykumar Vinodbhai Katara");
    expect(chip.textContent).toContain("6174");
    expect(screen.getByTestId("debug-selected-visible-count").textContent).toContain("24");
  });

  it("exposes a Clear employee control", () => {
    const { onClear } = renderSearch({
      state: "selected",
      selected: {
        user_id: KATARA,
        employee_name: "K",
        employee_id: "6174",
        identity_source: "current_profile",
        identity_issue: null,
        visible_expense_count: 1,
        actionable_expense_count: 0,
      },
    });
    fireEvent.click(screen.getByTestId("debug-clear-employee"));
    expect(onClear).toHaveBeenCalled();
  });
});

// ── General expense search (Phase 13) ───────────────────────────────────────

describe("expense search UI", () => {
  it("does not submit while typing and submits once on Search", () => {
    const onSubmit = vi.fn();
    const onDraftChange = vi.fn();
    render(
      <DebugGeneralSearch
        draft="06174"
        onDraftChange={onDraftChange}
        onSubmit={onSubmit}
        onClear={vi.fn()}
      />,
      { wrapper },
    );
    fireEvent.change(screen.getByTestId("debug-general-search-input"), {
      target: { value: "0617" },
    });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("debug-general-search-submit"));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("clearing the expense search does not clear the employee", () => {
    const { result } = renderHook(() => useDebugReviewFilters());
    act(() => result.current.setDraftGeneralSearch("CCTV"));
    act(() => result.current.submitGeneralSearch());
    act(() => result.current.clearGeneralSearch());
    // The filters hook holds no employee state at all — clearing here provably
    // cannot touch the selection.
    expect(Object.keys(result.current)).not.toContain("selectedEmployee");
    expect(result.current.submittedGeneralSearch).toBeNull();
  });
});

// ── 6174 / 06174 separation, end to end through the API layer ───────────────

describe("6174 versus transaction 06174", () => {
  it("employee selection sends the user_id and no search text", async () => {
    rpc.mockResolvedValue({ data: pageResponse({ filtered_total: 24 }), error: null });
    const page = await fetchDebugReviewPage({ organizationId: ORG, employeeUserId: KATARA });
    const args = rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(args.p_employee_user_id).toBe(KATARA);
    expect(args.p_general_search).toBeNull();
    expect(page.filtered_total).toBe(24);
  });

  it("transaction 06174 remains reachable through Expense Search", async () => {
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
    const page = await fetchDebugReviewPage({ organizationId: ORG, generalSearch: "06174" });
    const args = rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(args.p_general_search).toBe("06174");
    expect(args.p_employee_user_id).toBeNull();
    // It resolves to its real owner, not to employee 6174.
    expect(page.items[0].employee_id).toBe("6557");
    expect(page.items[0].user_id).toBe(KATHERIA);
  });

  it("employee filter and expense search combine without colliding", async () => {
    rpc.mockResolvedValue({ data: pageResponse({ filtered_total: 2 }), error: null });
    await fetchDebugReviewPage({
      organizationId: ORG,
      employeeUserId: KATARA,
      generalSearch: "CCTV",
    });
    const args = rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(args.p_employee_user_id).toBe(KATARA);
    expect(args.p_general_search).toBe("CCTV");
  });
});

// ── Identity (Phase 5) ──────────────────────────────────────────────────────

describe("identity rendering", () => {
  it("prefers name + employee ID", () => {
    expect(
      formatEmployeeIdentity({
        employee_name: "K",
        employee_id: "6174",
        employee_email: "e@x",
      }),
    ).toEqual({ primary: "K", secondary: "6174" });
  });

  it("falls back to email, then ID, then a labelled reason — never a dash", () => {
    expect(
      formatEmployeeIdentity({ employee_name: "K", employee_id: null, employee_email: "e@x" })
        .secondary,
    ).toBe("e@x");
    expect(
      formatEmployeeIdentity({
        employee_name: null,
        employee_id: "6174",
        employee_email: null,
      }).primary,
    ).toBe("6174");
    const unknown = formatEmployeeIdentity({
      employee_name: "Unknown employee",
      employee_id: null,
      employee_email: null,
      identity_issue: "duplicate_profiles",
    });
    expect(unknown.primary).toBe("Unknown employee");
    expect(unknown.secondary).toBe("duplicateProfiles");
    expect(unknown.secondary).not.toBe("-");
    expect(unknown.secondary).not.toBe("—");
  });

  it("maps both identity issues to stable keys", () => {
    expect(identityIssueLabel("profile_missing")).toBe("profileMissing");
    expect(identityIssueLabel("duplicate_profiles")).toBe("duplicateProfiles");
    expect(identityIssueLabel(null)).toBeNull();
  });

  it("renders the issue instead of a bare dash in the table", () => {
    render(
      <DebugReviewTable
        items={[
          item({
            id: "e-x",
            employee_name: "Unknown employee",
            employee_id: null,
            employee_email: null,
            identity_issue: "profile_missing",
          }),
        ]}
        selectedIds={new Set()}
        onToggle={vi.fn()}
        onView={vi.fn()}
        actionsEnabled={false}
      />,
      { wrapper },
    );
    const row = screen.getByTestId("debug-row-e-x");
    expect(row.textContent).toContain("identity.profileMissing");
    expect(screen.getByTestId("debug-row-employee-e-x").textContent).toBe("Unknown employee");
  });

  it("identity is present in the very first page response", async () => {
    rpc.mockResolvedValue({ data: pageResponse(), error: null });
    const page = await fetchDebugReviewPage({ organizationId: ORG });
    expect(page.items[0].employee_name).toBe("Sanjaykumar Vinodbhai Katara");
    expect(page.items[0].employee_id).toBe("6174");
  });
});

// ── KPI cards (Phase 14) ────────────────────────────────────────────────────

describe("KPI cards", () => {
  it("render server values, not React row counts", () => {
    render(<DebugReviewStats page={pageResponse() as never} loading={false} />, { wrapper });
    expect(screen.getByTestId("debug-stat-assignedToMe").textContent).toBe("5");
    expect(screen.getByTestId("debug-stat-pendingReview").textContent).toBe("3");
    expect(screen.getByTestId("debug-stat-verified").textContent).toBe("2");
    // One item in the page, but the KPI reports the whole scope.
    expect(screen.getByTestId("debug-stat-assignedToMe").textContent).not.toBe("1");
  });

  it("are unchanged by page size and page number", () => {
    const p2 = pageResponse({ items: [], diagnostics: { page_returned: 0, identity_resolved: 0, identity_unresolved: 0 } });
    render(<DebugReviewStats page={p2 as never} loading={false} />, { wrapper });
    expect(screen.getByTestId("debug-stat-pendingReview").textContent).toBe("3");
  });

  it("never renders a stat from an undefined page as a number", () => {
    render(<DebugReviewStats page={null} loading={false} />, { wrapper });
    expect(screen.getByTestId("debug-stat-verified").textContent).toBe("—");
  });
});

// ── Pagination UI (Phase 18) ────────────────────────────────────────────────

describe("pagination UI", () => {
  const renderPager = (over: Record<string, unknown> = {}) => {
    const onNext = vi.fn();
    const onPrevious = vi.fn();
    render(
      <DebugReviewPagination
        pageNumber={1}
        pageSize={25}
        returned={25}
        filteredTotal={24}
        hasMore={false}
        canGoPrevious={false}
        onPrevious={onPrevious}
        onNext={onNext}
        employeeLabel={null}
        {...over}
      />,
      { wrapper },
    );
    return { onNext, onPrevious };
  };

  it("disables Previous on the first page", () => {
    renderPager();
    expect((screen.getByTestId("debug-page-previous") as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables Next when has_more is false — an exact full final page", () => {
    renderPager({ returned: 25, filteredTotal: 25, hasMore: false });
    expect((screen.getByTestId("debug-page-next") as HTMLButtonElement).disabled).toBe(true);
  });

  it("enables Next when the server says there is more", () => {
    const { onNext } = renderPager({ hasMore: true });
    const btn = screen.getByTestId("debug-page-next") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(onNext).toHaveBeenCalled();
  });

  it("computes the window from the logical page, not from a sliced array", () => {
    expect(pageWindow(1, 25, 25)).toEqual({ from: 1, to: 25 });
    expect(pageWindow(2, 25, 10)).toEqual({ from: 26, to: 35 });
    expect(pageWindow(1, 25, 0)).toEqual({ from: 0, to: 0 });
  });

  it("names the selected employee in the summary", () => {
    renderPager({ employeeLabel: "Sanjaykumar Vinodbhai Katara · 6174", filteredTotal: 24 });
    expect(screen.getByTestId("debug-pagination-summary").textContent).toContain(
      "pagination.showingForEmployee",
    );
  });
});

// ── Table / mobile (Phases 16–17) ───────────────────────────────────────────

describe("results rendering", () => {
  it("renders a sticky Status / Actions column", () => {
    render(
      <DebugReviewTable
        items={[item()]}
        selectedIds={new Set()}
        onToggle={vi.fn()}
        onView={vi.fn()}
        actionsEnabled={false}
      />,
      { wrapper },
    );
    const cell = screen.getByTestId("debug-row-e-1").lastElementChild as HTMLElement;
    expect(cell.className).toContain("sticky");
    expect(cell.className).toContain("right-0");
    // Opaque, or the middle columns would show through while scrolling.
    expect(cell.className).toContain("bg-background");
    expect(cell.className).toContain("border-l");
  });

  it("scrolls the middle columns horizontally", () => {
    render(
      <DebugReviewTable
        items={[item()]}
        selectedIds={new Set()}
        onToggle={vi.fn()}
        onView={vi.fn()}
        actionsEnabled={false}
      />,
      { wrapper },
    );
    expect(screen.getByTestId("debug-table-scroll").className).toContain("overflow-x-auto");
  });

  it("shows actions disabled and never a mutation control", () => {
    render(
      <DebugReviewTable
        items={[item()]}
        selectedIds={new Set()}
        onToggle={vi.fn()}
        onView={vi.fn()}
        actionsEnabled={false}
      />,
      { wrapper },
    );
    const btn = screen.getByTestId("debug-action-disabled-e-1") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.queryByText(/verify|approve|reject/i)).toBeNull();
  });

  it("opens detail from the View button", () => {
    const onView = vi.fn();
    render(
      <DebugReviewTable
        items={[item()]}
        selectedIds={new Set()}
        onToggle={vi.fn()}
        onView={onView}
        actionsEnabled={false}
      />,
      { wrapper },
    );
    fireEvent.click(screen.getByTestId("debug-view-e-1"));
    expect(onView).toHaveBeenCalledWith("e-1");
  });

  it("renders mobile cards with identity, amount and a View action", () => {
    const onView = vi.fn();
    render(<DebugReviewMobileList items={[item()]} onView={onView} />, { wrapper });
    const card = screen.getByTestId("debug-mobile-row-e-1");
    expect(card.textContent).toContain("00424");
    expect(card.textContent).toContain("Sanjaykumar Vinodbhai Katara");
    fireEvent.click(screen.getByTestId("debug-mobile-view-e-1"));
    expect(onView).toHaveBeenCalledWith("e-1");
  });

  it("formats a missing amount without crashing", () => {
    expect(formatAmount(null)).toBe("—");
    expect(formatAmount(3960)).toContain("3,960");
  });
});

// ── Error states (Phase 21) ─────────────────────────────────────────────────

describe("error states", () => {
  it.each([
    "flag_disabled",
    "capability",
    "authorization",
    "network",
    "timeout",
    "validation",
    "unknown",
    "employee_not_found",
    "employee_no_expenses",
    "no_matching_expenses",
  ] as const)("renders a distinct surface for %s", (kind) => {
    render(<DebugReviewErrorState kind={kind} />, { wrapper });
    expect(screen.getByTestId(`debug-error-${kind}`)).toBeTruthy();
  });

  it("names the unavailable functions on a partial migration", () => {
    render(
      <DebugReviewErrorState kind="capability" missingFunctions={["page", "detail"]} />,
      { wrapper },
    );
    expect(screen.getByTestId("debug-missing-functions").textContent).toContain("page, detail");
  });

  it("offers /review only as an explicit link, never an automatic fallback", () => {
    render(<DebugReviewErrorState kind="network" />, { wrapper });
    const link = screen.getByText("backToReview").closest("a") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/review");
    const page = tsCode("src/features/debugReviewQueue/DebugReviewExpensesPage.tsx");
    expect(page).not.toMatch(/Navigate\s+to=["']\/review/);
  });

  it("shows a controlled message for a malformed response, not the raw error", async () => {
    rpc.mockResolvedValue({ data: { contract: "debug-review-queue", version: 1 }, error: null });
    await expect(fetchDebugReviewPage({ organizationId: ORG })).rejects.toBeInstanceOf(
      DebugReviewValidationError,
    );
  });

  it("rejects a wrong-contract capability response", () => {
    expect(() => parseCapabilities({ contract: "something-else", version: 1 })).toThrow();
  });
});

// ── Diagnostics redaction (Phase 20) ────────────────────────────────────────

describe("diagnostics", () => {
  const input = {
    contract: "debug-review-queue",
    contractVersion: 1,
    capabilityReady: true,
    functions: { page: true },
    schemaRevision: "20260801150000",
    reviewerRole: "executive",
    organizationId: ORG,
    selectedEmployeeId: "6174",
    selectedEmployeeUserId: KATARA,
    submittedEmployeeSearch: "6174",
    submittedGeneralSearch: null,
    pageSize: 25,
    logicalPage: 2,
    filteredTotal: 24,
    returnedRows: 25,
    hasMore: true,
    currentCursor: { sk: "1", id: "e-1" },
    nextCursor: { sk: "2", id: "e-2" },
    requestDurationMs: 412,
    identityResolved: 25,
    identityUnresolved: 0,
    error: null,
    timestamp: "2026-08-01T00:00:00.000Z",
  };

  it("includes the operational fields an operator needs", () => {
    const d = buildRedactedDiagnostics(input);
    expect(d.filtered_total).toBe(24);
    expect(d.request_duration_ms).toBe(412);
    expect(d.identity_resolved).toBe(25);
    expect(d.has_more).toBe(true);
    expect(d.logical_page).toBe(2);
    expect(d.schema_revision).toBe("20260801150000");
  });

  it("masks ids rather than publishing them", () => {
    const d = buildRedactedDiagnostics(input);
    expect(d.organization_id).toBe("6709c1fe…");
    expect(d.selected_employee_user_id).toBe("c76edc75…");
    expect(JSON.stringify(d)).not.toContain(ORG);
    expect(JSON.stringify(d)).not.toContain(KATARA);
    expect(maskId(null)).toBeNull();
  });

  it("emits no credential-shaped key", () => {
    const text = JSON.stringify(buildRedactedDiagnostics(input));
    for (const bad of [
      "token",
      "jwt",
      "password",
      "secret",
      "apikey",
      "authorization",
      "cookie",
      "service_role",
    ]) {
      expect(text.toLowerCase()).not.toContain(bad);
    }
  });

  it("never reads storage or the auth session", () => {
    const src = tsCode("src/features/debugReviewQueue/hooks/useDebugReviewDiagnostics.ts");
    expect(src).not.toContain("localStorage");
    expect(src).not.toContain("sessionStorage");
    expect(src).not.toContain("document.cookie");
    expect(src).not.toContain("auth.getSession");
  });
});

// ── Request budget (Phase 25) ───────────────────────────────────────────────

describe("request budget", () => {
  const FEATURE_FILES = [
    "src/features/debugReviewQueue/api.ts",
    "src/features/debugReviewQueue/DebugReviewExpensesPage.tsx",
    "src/features/debugReviewQueue/DebugReviewTable.tsx",
    "src/features/debugReviewQueue/DebugReviewMobileList.tsx",
    "src/features/debugReviewQueue/DebugReviewExpenseDetail.tsx",
    "src/features/debugReviewQueue/DebugReviewFilters.tsx",
    "src/features/debugReviewQueue/hooks/useDebugReviewPage.ts",
    "src/features/debugReviewQueue/hooks/useDebugReviewFilterOptions.ts",
    "src/features/debugReviewQueue/hooks/useDebugReviewExpenseDetail.ts",
    "src/features/debugReviewQueue/hooks/useDebugEmployeeSearch.ts",
  ];
  const ALL = FEATURE_FILES.map(tsCode).join("\n");

  it.each([
    "profiles",
    "expense_form_field_values",
    "audit_logs",
    "expense_correction_logs",
  ])("makes no direct browser query to %s", (table) => {
    expect(ALL).not.toContain(`from("${table}")`);
    expect(ALL).not.toContain(`from('${table}')`);
  });

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

  it("only ever calls the proven RPCs plus the page anchor", () => {
    // The debug api is a pure alias now; the RPC names live in the shared core.
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

  it("keeps exactly one RPC implementation — the debug api only re-exports", () => {
    const debugApi = tsCode("src/features/debugReviewQueue/api.ts");
    expect(debugApi).not.toContain("supabase");
    expect(debugApi).not.toMatch(/p_organization_id/);
    expect(debugApi).toContain("@/features/reviewQueueServer/api");
  });

  it("issues exactly one RPC per page fetch", async () => {
    rpc.mockResolvedValue({ data: pageResponse(), error: null });
    await fetchDebugReviewPage({ organizationId: ORG });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("issues exactly one RPC per detail open", async () => {
    rpc.mockResolvedValue({
      data: {
        contract: "debug-review-expense-detail",
        version: 1,
        expense: { id: "e-1", status: "submitted" },
        employee: { employee_name: "K", identity_source: "current_profile" },
        custom_fields: [],
        attachments: [],
        timeline: [],
        corrections: [],
      },
      error: null,
    });
    await fetchDebugReviewExpenseDetail(ORG, "e-1");
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][0]).toBe("get_debug_review_expense_detail_v1");
  });

  it("issues exactly one RPC for filter options", async () => {
    rpc.mockResolvedValue({
      data: {
        contract: "debug-review-filter-options",
        version: 1,
        statuses: ["submitted"],
        sorts: ["created_desc"],
        time_periods: ["all"],
        categories: ["Travel"],
        employees: [],
        custom_fields: [],
      },
      error: null,
    });
    const opts = await fetchDebugReviewFilterOptions(ORG);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(opts.categories).toEqual(["Travel"]);
  });

  it("never uses the Supabase table builder anywhere in the feature", () => {
    expect(ALL).not.toMatch(/supabase\s*\.\s*from\(/);
  });
});

// ── Routing, sidebar and flags (Phases 22–23) ───────────────────────────────

describe("route and sidebar wiring", () => {
  const APP = tsCode("src/App.tsx");
  const SIDEBAR = tsCode("src/components/AppSidebar.tsx");

  it("removes the /debug/review-expenses route and its lazy import (consolidated)", () => {
    expect(APP).not.toContain('path="/debug/review-expenses"');
    expect(APP).not.toContain("DebugReviewExpenses");
  });

  it("consolidates /review to the single canonical EngineerReview page", () => {
    expect(APP).toContain('path="/review"');
    expect(APP).toContain("<ReviewExpenses />");
    const wrapper = tsCode("src/pages/ReviewExpenses.tsx");
    expect(wrapper).toContain("<ManagerReview />");
    expect(wrapper).not.toContain("REVIEW_EXPENSES_SERVER_QUEUE_ENABLED");
  });

  it("removes the debug sidebar nav entry", () => {
    expect(SIDEBAR).not.toContain('url: "/debug/review-expenses"');
    expect(SIDEBAR).not.toContain('titleKey: "debugReviewExpenses"');
  });

  it("requires the flag to be exactly \"true\"", () => {
    const cfg = tsCode("src/config/debugReviewQueueFeature.ts");
    expect(cfg).toContain('?.trim() === "true"');
    expect(cfg).not.toMatch(/!==\s*["']false["']/);
  });

  it("keeps the actions flag independent and off by default", () => {
    const cfg = tsCode("src/config/debugReviewQueueFeature.ts");
    expect(cfg).toContain("VITE_DEBUG_REVIEW_ACTIONS_ENABLED");
    expect(cfg).toContain("VITE_DEBUG_REVIEW_EXPENSES_ENABLED");
  });

  it("the page carries no mutation call at all", () => {
    const page = tsCode("src/features/debugReviewQueue/DebugReviewExpensesPage.tsx");
    const detail = tsCode("src/features/debugReviewQueue/DebugReviewExpenseDetail.tsx");
    for (const src of [page, detail]) {
      expect(src).not.toMatch(/useMutation/);
      // Supabase writers specifically — a local Set.delete is not a mutation.
      expect(src).not.toMatch(/supabase[\s\S]{0,40}\.(update|insert|upsert|delete)\(/);
      expect(src).not.toMatch(/storage\s*\.\s*from\(/);
      expect(src).not.toMatch(/\.rpc\(/);
    }
  });
});

// ── i18n coverage (Phase 24) ────────────────────────────────────────────────

describe("translations", () => {
  const load = (lang: string) =>
    JSON.parse(readFileSync(resolve(cwd, `src/locales/${lang}/debugReview.json`), "utf-8"));

  const flatten = (o: Record<string, unknown>, prefix = ""): string[] =>
    Object.entries(o).flatMap(([k, v]) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? flatten(v as Record<string, unknown>, `${prefix}${k}.`)
        : [`${prefix}${k}`],
    );

  it("has identical key sets in EN, HI and GU", () => {
    const en = flatten(load("en")).sort();
    expect(flatten(load("hi")).sort()).toEqual(en);
    expect(flatten(load("gu")).sort()).toEqual(en);
  });

  it("has no empty string in any language", () => {
    for (const lang of ["en", "hi", "gu"]) {
      const json = JSON.stringify(load(lang));
      expect(json).not.toContain('""');
    }
  });

  it("registers the namespace so the loader picks it up", () => {
    const cfg = tsCode("src/i18n/config.ts");
    expect(cfg).toContain('"debugReview"');
  });

  it("provides the sidebar label in every language", () => {
    for (const lang of ["en", "hi", "gu"]) {
      const nav = JSON.parse(readFileSync(resolve(cwd, `src/locales/${lang}/nav.json`), "utf-8"));
      expect(typeof nav.debugReviewExpenses).toBe("string");
      expect(nav.debugReviewExpenses.length).toBeGreaterThan(0);
    }
  });
});
