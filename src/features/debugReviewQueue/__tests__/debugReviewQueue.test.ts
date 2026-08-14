/**
 * Debug Review Queue v1 — employee-6174 regression (DOC-080).
 *
 * Proven on the live database 2026-08-01:
 *   expenses_for_employee_id_6174 = 24
 *   expenses_with_txn_like_6174   = 1  -> txn 06174, owned by employee 6557
 * V1 search for "6174" returned only txn 06174 and dropped all 24, because it
 * matched transaction_number (on the row) but not employee_id (needed a profile
 * enrichment call that was 504-ing).
 *
 * These tests pin the two properties that prevent a repeat: employee lookup is
 * submit-driven, and it resolves to an immutable user_id that never consults
 * transaction numbers.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { readFileSync } from "fs";
import { resolve } from "path";

const rpc = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: (...a: unknown[]) => rpc(...a) },
}));

import {
  fetchDebugReviewPage,
  parseCapabilities,
  parseEmployeeSearch,
  pickAutoSelectableMatch,
  searchDebugReviewEmployees,
} from "@/features/debugReviewQueue/api";
import {
  DebugReviewAuthorizationError,
  DebugReviewCapabilityError,
  DebugReviewValidationError,
  formatEmployeeIdentity,
} from "@/features/debugReviewQueue/types";
import { useDebugEmployeeSearch } from "@/features/debugReviewQueue/hooks/useDebugEmployeeSearch";

const ORG = "6709c1fe-e8c8-404d-bc68-d1edda923344";
const KATARA = "c76edc75-3cab-4c70-85d2-5762fe949d1b";

const cwd = process.cwd();
const stripSql = (s: string) =>
  s.split(/\r?\n/).filter((l) => !l.trim().startsWith("--")).join("\n");
const readSql = (rel: string) => stripSql(readFileSync(resolve(cwd, rel), "utf-8"));

/** Original contract. Already applied to a shared environment, so never edited. */
const SQL_BASE = readSql("supabase/migrations/20260801140000_debug_review_queue_v1.sql");
/** Additive corrections; these definitions supersede the base ones. */
const SQL_FIX = readSql("supabase/migrations/20260801150000_debug_review_queue_v1_corrections.sql");
const SQL_CODE = `${SQL_BASE}\n${SQL_FIX}`;

/** Executable TS only — comments describe what is deliberately absent, so an
 *  absence assertion must not read them. */
const tsCode = (rel: string) =>
  readFileSync(resolve(cwd, rel), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

/** Body of a specific CREATE FUNCTION — not its mention inside the capability
 *  probe, which references every function name via to_regprocedure. */
const bodyFrom = (src: string, name: string): string | null => {
  const start = src.indexOf("CREATE OR REPLACE FUNCTION public." + name);
  if (start < 0) return null;
  const rest = src.slice(start + 1);
  const next = rest.indexOf("CREATE OR REPLACE FUNCTION public.");
  return next === -1 ? src.slice(start) : src.slice(start, start + 1 + next);
};
/** The EFFECTIVE definition: the corrections migration wins where it redefines. */
const sqlFunctionBody = (name: string) =>
  bodyFrom(SQL_FIX, name) ?? bodyFrom(SQL_BASE, name) ?? "";

const match6174 = {
  user_id: KATARA,
  employee_name: "Sanjaykumar Vinodbhai Katara",
  employee_id: "6174",
  employee_email: "emp.ml.6174@example.invalid",
  identity_source: "current_profile",
  visible_expense_count: 24,
  actionable_expense_count: 24,
  match_type: "exact_employee_id",
};
const searchResponse = (matches: unknown[] = [match6174]) => ({
  contract: "debug-review-employee-search", version: 1, query: "6174", matches,
});

beforeEach(() => rpc.mockReset());

// ── The primary requirement: typing must not query ──────────────────────────

describe("employee search is submit-driven", () => {
  it("makes NO request while typing", async () => {
    rpc.mockResolvedValue({ data: searchResponse(), error: null });
    const { result } = renderHook(() => useDebugEmployeeSearch(ORG));

    act(() => result.current.setDraft("6"));
    act(() => result.current.setDraft("61"));
    act(() => result.current.setDraft("617"));
    act(() => result.current.setDraft("6174"));

    expect(rpc).not.toHaveBeenCalled();
    expect(result.current.getRequestCount()).toBe(0);
    expect(result.current.state).toBe("idle");
  });

  it("issues exactly ONE request on submit", async () => {
    rpc.mockResolvedValue({ data: searchResponse(), error: null });
    const { result } = renderHook(() => useDebugEmployeeSearch(ORG));
    act(() => result.current.setDraft("6174"));
    await act(async () => { await result.current.submit(); });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][0]).toBe("search_debug_review_employees_v1");
    expect(result.current.getRequestCount()).toBe(1);
  });

  it("auto-selects a single exact match and exposes its user_id", async () => {
    rpc.mockResolvedValue({ data: searchResponse(), error: null });
    const { result } = renderHook(() => useDebugEmployeeSearch(ORG));
    act(() => result.current.setDraft("6174"));
    await act(async () => { await result.current.submit(); });

    await waitFor(() => expect(result.current.state).toBe("selected"));
    expect(result.current.selected?.user_id).toBe(KATARA);
    expect(result.current.selected?.employee_id).toBe("6174");
    expect(result.current.selected?.visible_expense_count).toBe(24);
  });

  it("does not query on an empty submit", async () => {
    const { result } = renderHook(() => useDebugEmployeeSearch(ORG));
    act(() => result.current.setDraft("   "));
    await act(async () => { await result.current.submit(); });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("requires manual selection when names are ambiguous", async () => {
    rpc.mockResolvedValue({
      data: searchResponse([
        { ...match6174, match_type: "name_contains" },
        { ...match6174, user_id: "other-user", employee_id: "6175", match_type: "name_contains" },
      ]),
      error: null,
    });
    const { result } = renderHook(() => useDebugEmployeeSearch(ORG));
    act(() => result.current.setDraft("Sanjay"));
    await act(async () => { await result.current.submit(); });

    await waitFor(() => expect(result.current.state).toBe("needs_selection"));
    expect(result.current.selected).toBeNull();
    expect(result.current.matches).toHaveLength(2);

    act(() => result.current.select(result.current.matches[1]));
    expect(result.current.selected?.user_id).toBe("other-user");
  });

  it("reports no visible employee without falling back to an unfiltered query", async () => {
    rpc.mockResolvedValue({ data: searchResponse([]), error: null });
    const { result } = renderHook(() => useDebugEmployeeSearch(ORG));
    act(() => result.current.setDraft("nobody"));
    await act(async () => { await result.current.submit(); });
    await waitFor(() => expect(result.current.state).toBe("not_found"));
    expect(result.current.selected).toBeNull();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("clears back to the ordinary queue", async () => {
    rpc.mockResolvedValue({ data: searchResponse(), error: null });
    const { result } = renderHook(() => useDebugEmployeeSearch(ORG));
    act(() => result.current.setDraft("6174"));
    await act(async () => { await result.current.submit(); });
    act(() => result.current.clear());
    expect(result.current.selected).toBeNull();
    expect(result.current.state).toBe("idle");
    expect(result.current.draft).toBe("");
  });

  it("surfaces errors instead of silently returning everything", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "not an authorized reviewer" } });
    const { result } = renderHook(() => useDebugEmployeeSearch(ORG));
    act(() => result.current.setDraft("6174"));
    await act(async () => { await result.current.submit(); });
    await waitFor(() => expect(result.current.state).toBe("error"));
    expect(result.current.selected).toBeNull();
  });

  it("contains no debounce or keystroke effect", () => {
    const hook = tsCode("src/features/debugReviewQueue/hooks/useDebugEmployeeSearch.ts");
    expect(hook).not.toMatch(/setTimeout|debounce/i);
    expect(hook).not.toMatch(/useEffect\([\s\S]{0,200}\[draft/);
  });
});

// ── The 6174 / 06174 collision ──────────────────────────────────────────────

describe("employee ID 6174 is separated from transaction 06174", () => {
  it("sends the immutable user_id, never the name or the raw query", async () => {
    rpc.mockResolvedValue({
      data: { contract: "debug-review-queue", version: 1, filtered_total: 24, has_more: false,
              next_cursor: null, items: [], selected_employee: null,
              scope_summary: { assigned_to_me: 0, pending_review: 0, verified: 0, total_amount: 0 },
              diagnostics: { page_returned: 0, identity_resolved: 0, identity_unresolved: 0 } },
      error: null,
    });
    await fetchDebugReviewPage({ organizationId: ORG, employeeUserId: KATARA });
    const args = rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(args.p_employee_user_id).toBe(KATARA);
    expect(args.p_general_search).toBeNull();
    expect(JSON.stringify(args)).not.toContain("Sanjaykumar");
  });

  it("keeps employee filter and general search as separate parameters", async () => {
    rpc.mockResolvedValue({
      data: { contract: "debug-review-queue", version: 1, filtered_total: 0, has_more: false,
              next_cursor: null, items: [], selected_employee: null,
              scope_summary: { assigned_to_me: 0, pending_review: 0, verified: 0, total_amount: 0 },
              diagnostics: { page_returned: 0, identity_resolved: 0, identity_unresolved: 0 } },
      error: null,
    });
    await fetchDebugReviewPage({ organizationId: ORG, employeeUserId: KATARA, generalSearch: "CCTV" });
    const args = rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(args.p_employee_user_id).toBe(KATARA);
    expect(args.p_general_search).toBe("CCTV");
  });

  it("the SQL employee filter matches user_id and never transaction_number", () => {
    expect(SQL_CODE).toContain("p_employee_user_id IS NULL OR r.user_id = p_employee_user_id");
    const searchFn = sqlFunctionBody("search_debug_review_employees_v1");
    expect(searchFn).not.toContain("transaction_number");
  });

  it("employee search only returns employees with visible expenses", () => {
    const searchFn = sqlFunctionBody("search_debug_review_employees_v1");
    // Candidates come from `counts`, which is built only from expenses inside
    // the reviewer's authorized scope — that inner join is what stops identity
    // enumeration of employees the caller cannot see.
    expect(searchFn).toContain("JOIN counts c ON c.user_id = i.user_id");
    expect(searchFn).toContain("_debug_review_visible_user_ids_v1");
  });

  it("ranks exact employee ID above name matches", () => {
    const r = parseEmployeeSearch(searchResponse([
      { ...match6174, match_type: "name_contains", user_id: "u-b" },
      { ...match6174, match_type: "exact_employee_id", user_id: "u-a" },
    ]));
    expect(pickAutoSelectableMatch(r)?.user_id).toBe("u-a");
  });

  it("never auto-selects when two strong matches exist", () => {
    const r = parseEmployeeSearch(searchResponse([
      { ...match6174, match_type: "exact_employee_id", user_id: "u-a" },
      { ...match6174, match_type: "exact_employee_id", user_id: "u-b" },
    ]));
    expect(pickAutoSelectableMatch(r)).toBeNull();
  });
});

// ── Capability / safety ─────────────────────────────────────────────────────

describe("contract and safety", () => {
  it("refuses to report ready on a partial migration", () => {
    const c = parseCapabilities({
      contract: "debug-review-queue", version: 1, ready: false,
      functions: { employee_search: true, page: false, filters: true, detail: true },
      schema_revision: "x", server_time: "t",
    });
    expect(c.ready).toBe(false);
    expect(c.functions.page).toBe(false);
  });

  it("rejects a foreign or wrong-version contract", () => {
    expect(() => parseCapabilities({ contract: "something-else" })).toThrow(DebugReviewCapabilityError);
    expect(() => parseCapabilities({ contract: "debug-review-queue", version: 2 })).toThrow(
      DebugReviewCapabilityError);
  });

  it("maps authorization errors without leaking SQL", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "not an authorized reviewer" } });
    await expect(searchDebugReviewEmployees({ organizationId: ORG, query: "6174" }))
      .rejects.toBeInstanceOf(DebugReviewAuthorizationError);
  });

  it("rejects a malformed page response", () => {
    rpc.mockResolvedValue({ data: {}, error: null });
    expect(() => parseEmployeeSearch({ contract: "wrong" })).toThrow(DebugReviewValidationError);
  });

  it("never queries enrichment tables or V1/V2 RPCs from the browser", () => {
    const api = tsCode("src/features/debugReviewQueue/api.ts");
    for (const t of ["expense_form_field_values", "audit_logs", "expense_correction_logs",
                     "get_expense_submitter_profiles", "get_resubmitted_expense_ids",
                     "review_queue_api_version", "get_review_queue_page_v2"]) {
      expect(api).not.toContain(t);
    }
    for (const v1 of ["managerReviewExpenses", "hierarchyReviewExpenses",
                      "reviewExpensePagination", "legacyReviewPagination", "EngineerReview"]) {
      expect(api).not.toContain(v1);
    }
  });

  it("locks every RPC down to authenticated only", () => {
    expect(SQL_CODE.match(/REVOKE ALL ON FUNCTION/g)?.length).toBeGreaterThanOrEqual(7);
    expect(SQL_CODE.match(/FROM anon/g)?.length).toBeGreaterThanOrEqual(7);
    expect(SQL_CODE).not.toMatch(/GRANT EXECUTE[^;]*TO\s+(PUBLIC|anon)/i);
    expect(SQL_CODE.match(/SET search_path = ''/g)?.length).toBeGreaterThanOrEqual(7);
  });

  it("restricts callers to reviewer roles", () => {
    expect(SQL_CODE).toContain("'engineer','team_leader','executive','admin'");
    expect(SQL_CODE).toContain("not an authorized reviewer for this organization");
  });

  it("uses keyset pagination with page_size + 1 and no OFFSET", () => {
    expect(SQL_CODE).not.toMatch(/\bOFFSET\b/i);
    expect(SQL_CODE).toContain("o.rn <= v_size + 1");
    expect(SQL_CODE).toContain("ORDER BY pr.rn DESC");
  });

  it("uses created_at for Date Created, never updated_at", () => {
    expect(SQL_CODE).toContain("v_sort='created_desc'      THEN f.created_at");
    const ordering = SQL_CODE.slice(SQL_CODE.indexOf("ordered AS MATERIALIZED"),
                                    SQL_CODE.indexOf("page_plus_one"));
    expect(ordering).not.toContain("updated_at");
  });

  it("supports all six sorts", () => {
    expect(SQL_CODE).toContain("'created_desc','created_asc','expense_date_desc'");
    expect(SQL_CODE).toContain("'expense_date_asc','amount_desc','amount_asc'");
  });
});

// ── Identity display ────────────────────────────────────────────────────────

describe("identity display never falls back to a bare dash", () => {
  it("prefers name + employee ID", () => {
    expect(formatEmployeeIdentity({ employee_name: "Sanjaykumar Vinodbhai Katara",
      employee_id: "6174", employee_email: null }))
      .toEqual({ primary: "Sanjaykumar Vinodbhai Katara", secondary: "6174" });
  });

  it("falls back through email, then ID, then a readable reason", () => {
    expect(formatEmployeeIdentity({ employee_name: "A", employee_id: null, employee_email: "a@x.test" }))
      .toEqual({ primary: "A", secondary: "a@x.test" });
    expect(formatEmployeeIdentity({ employee_name: null, employee_id: "6174", employee_email: null }).primary)
      .toBe("6174");
    const unknown = formatEmployeeIdentity({ employee_name: "Unknown employee", employee_id: null,
      employee_email: null, identity_issue: "profile_missing" });
    expect(unknown.primary).toBe("Unknown employee");
    expect(unknown.secondary).toBe("profileMissing");
  });
});

// ── Flags ───────────────────────────────────────────────────────────────────

describe("feature flags", () => {
  const cfg = readFileSync(resolve(cwd, "src/config/debugReviewQueueFeature.ts"), "utf-8");
  it("both default off and require exact 'true'", () => {
    expect(cfg).toContain("VITE_DEBUG_REVIEW_EXPENSES_ENABLED");
    expect(cfg).toContain("VITE_DEBUG_REVIEW_ACTIONS_ENABLED");
    expect((cfg.match(/=== "true"/g) ?? []).length).toBe(2);
  });
});
