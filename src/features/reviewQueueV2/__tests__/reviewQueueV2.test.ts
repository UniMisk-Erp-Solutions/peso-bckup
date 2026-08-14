/**
 * Review Queue V2 contract tests (DOC-079).
 *
 * V1 failed because the client assembled the result set and silently fell back when
 * an RPC was missing. These tests pin the properties that prevent a repeat: one
 * JSONB response, runtime validation, no silent fallback, no client-side enrichment,
 * and a cursor carrying every ordering component.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const rpc = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: (...a: unknown[]) => rpc(...a) },
}));

import {
  assertReviewQueueV2Available,
  fetchReviewQueuePage,
  parseReviewFilterOptions,
  parseReviewQueuePage,
  toLegacyRowShape,
} from "@/features/reviewQueueV2/api";
import {
  ReviewQueueAuthorizationError,
  ReviewQueueCapabilityError,
  ReviewQueueTimeoutError,
  ReviewQueueValidationError,
} from "@/features/reviewQueueV2/types";
import { reviewQueueV2Keys, serializeFilters } from "@/features/reviewQueueV2/queryKeys";

const cwd = process.cwd();
const SQL = readFileSync(
  resolve(cwd, "supabase/migrations/20260801130000_review_queue_v2_contracts.sql"),
  "utf-8",
);
/** Executable SQL only — comments explain what is deliberately absent, so asserting
 *  absence must not read them. */
const SQL_CODE = SQL.split(/\r?\n/)
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");

function item(over: Record<string, unknown> = {}) {
  return {
    id: "e1",
    user_id: "u1",
    employee_name: "Akshay Patel",
    title: "Fuel",
    status: "submitted",
    sort_at: "2026-07-30T17:56:27Z",
    total_amount: 653,
    is_actionable: true,
    actionable_reason: "ready",
    actionable_stage: "engineer",
    is_resubmitted: false,
    was_reviewer_corrected: false,
    custom_fields: [
      { source: "template", field_id: "t1", field_key: "vehicle", label: "Vehicle", value: "GJ18BV9405" },
    ],
    ...over,
  };
}
const page = (over: Record<string, unknown> = {}) => ({
  version: 2, sort: "newest", page_size: 25, total: 6088,
  next_cursor: { sort_at: "2026-07-30T17:56:27Z", id: "e1", total_amount: "653" },
  items: [item()], ...over,
});

beforeEach(() => rpc.mockReset());

// ── Response contract ───────────────────────────────────────────────────────

describe("V2 page response", () => {
  it("parses one JSONB document into typed rows", () => {
    const p = parseReviewQueuePage(page());
    expect(p.version).toBe(2);
    expect(p.total).toBe(6088);
    expect(p.items[0].employee_name).toBe("Akshay Patel");
    expect(p.items[0].custom_fields[0].label).toBe("Vehicle");
  });

  it("rejects a malformed response instead of rendering a partial table", () => {
    expect(() => parseReviewQueuePage(null)).toThrow(ReviewQueueValidationError);
    expect(() => parseReviewQueuePage(page({ items: "nope" }))).toThrow(ReviewQueueValidationError);
    expect(() => parseReviewQueuePage(page({ total: "abc" }))).toThrow(ReviewQueueValidationError);
    expect(() => parseReviewQueuePage({ ...page(), items: [{ no_id: true }] })).toThrow(
      ReviewQueueValidationError,
    );
  });

  it("rejects a wrong contract version as a capability problem", () => {
    expect(() => parseReviewQueuePage(page({ version: 1 }))).toThrow(ReviewQueueCapabilityError);
  });

  it("never exposes manager_queue_ready or submitted_at in the contract", () => {
    const p = parseReviewQueuePage(page());
    expect(p.items[0]).not.toHaveProperty("manager_queue_ready");
    expect(p.items[0]).not.toHaveProperty("submitted_at");
    expect(p.items[0].sort_at).toBeTruthy();
  });

  it("maps actionability onto the legacy prop only at the adapter edge", () => {
    const legacy = toLegacyRowShape(parseReviewQueuePage(page()).items[0]);
    expect(legacy.manager_queue_ready).toBe(true);
  });

  it("returns a cursor carrying every ordering component", () => {
    const p = parseReviewQueuePage(page());
    expect(p.next_cursor).toEqual({
      sort_at: "2026-07-30T17:56:27Z", id: "e1", total_amount: "653",
    });
  });

  it("parses identity_source and degrades unknown values to unresolved", () => {
    const p = parseReviewQueuePage(page({ items: [item({ identity_source: "inactive_profile" })] }));
    expect(p.items[0].identity_source).toBe("inactive_profile");
    const bogus = parseReviewQueuePage(page({ items: [item({ identity_source: "made_up" })] }));
    expect(bogus.items[0].identity_source).toBe("unresolved");
    const missing = parseReviewQueuePage(page({ items: [item()] }));
    expect(missing.items[0].identity_source).toBe("unresolved");
  });

  it("has no next cursor on the final page", () => {
    expect(parseReviewQueuePage(page({ next_cursor: null })).next_cursor).toBeNull();
  });
});

// ── Errors: no silent fallback ──────────────────────────────────────────────

describe("capability and error mapping", () => {
  it("raises a capability error when the V2 migration is absent", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "get_review_queue_page_v2" } });
    await expect(fetchReviewQueuePage({ organizationId: "o1" })).rejects.toBeInstanceOf(
      ReviewQueueCapabilityError,
    );
  });

  it("refuses to run when the database reports a version below 2", async () => {
    rpc.mockResolvedValue({ data: 1, error: null });
    await expect(assertReviewQueueV2Available()).rejects.toBeInstanceOf(ReviewQueueCapabilityError);
  });

  it("accepts version 2", async () => {
    rpc.mockResolvedValue({ data: 2, error: null });
    await expect(assertReviewQueueV2Available()).resolves.toBe(2);
  });

  it("maps authorization and timeout errors without leaking SQL", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "not authorized" } });
    await expect(fetchReviewQueuePage({ organizationId: "o1" })).rejects.toBeInstanceOf(
      ReviewQueueAuthorizationError,
    );
    rpc.mockResolvedValue({ data: null, error: { code: "57014", message: "statement timeout" } });
    await expect(fetchReviewQueuePage({ organizationId: "o1" })).rejects.toBeInstanceOf(
      ReviewQueueTimeoutError,
    );
  });

  it("does not leak raw database text for unknown failures", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: 'relation "secret" does not exist' } });
    await expect(fetchReviewQueuePage({ organizationId: "o1" })).rejects.toThrow(
      /temporarily unavailable/i,
    );
  });
});

// ── One RPC per page, no client enrichment ──────────────────────────────────

describe("request budget", () => {
  it("populates the table from exactly one RPC", async () => {
    rpc.mockResolvedValue({ data: page(), error: null });
    const p = await fetchReviewQueuePage({ organizationId: "o1" });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][0]).toBe("get_review_queue_page_v2");
    expect(p.items).toHaveLength(1);
  });

  it("never queries enrichment tables from the browser", () => {
    const api = readFileSync(resolve(cwd, "src/features/reviewQueueV2/api.ts"), "utf-8");
    for (const t of ["expense_form_field_values", "audit_logs", "expense_correction_logs"]) {
      expect(api).not.toContain(`from("${t}")`);
    }
    expect(api).not.toContain("get_resubmitted_expense_ids");
    expect(api).not.toContain("get_reviewer_corrected_expense_ids");
  });

  it("passes cursor and filters straight to the server", async () => {
    rpc.mockResolvedValue({ data: page(), error: null });
    await fetchReviewQueuePage({
      organizationId: "o1",
      cursor: { sort_at: "2026-07-30T00:00:00Z", id: "e0", total_amount: null },
      sort: "amount_high",
      filters: {
        search: "TXN-1", statuses: ["submitted"], actionableOnly: true,
        customFilters: [{ source: "template", field_id: "t1", values: ["CNG"] }],
      },
    });
    const args = rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(args.p_sort).toBe("amount_high");
    expect(args.p_search).toBe("TXN-1");
    expect(args.p_actionable_only).toBe(true);
    expect(args.p_custom_filters).toEqual([{ source: "template", field_id: "t1", values: ["CNG"] }]);
    expect(args.p_cursor).toMatchObject({ id: "e0" });
  });
});

// ── Query keys ──────────────────────────────────────────────────────────────

describe("query keys", () => {
  const base = { orgId: "o1", userId: "u1", pageSize: 25, sort: "newest" as const, cursor: null };

  it("changes when any server-visible input changes", () => {
    const k1 = reviewQueueV2Keys.page(base);
    expect(reviewQueueV2Keys.page({ ...base, sort: "oldest" })).not.toEqual(k1);
    expect(reviewQueueV2Keys.page({ ...base, pageSize: 50 })).not.toEqual(k1);
    expect(reviewQueueV2Keys.page({ ...base, filters: { search: "x" } })).not.toEqual(k1);
    expect(
      reviewQueueV2Keys.page({ ...base, cursor: { sort_at: "t", id: "e1", total_amount: null } }),
    ).not.toEqual(k1);
  });

  it("is stable regardless of filter ordering", () => {
    expect(serializeFilters({ statuses: ["b", "a"] })).toBe(serializeFilters({ statuses: ["a", "b"] }));
  });

  it("scopes every key to organization and user", () => {
    expect(reviewQueueV2Keys.page(base)).toEqual(expect.arrayContaining(["o1", "u1"]));
  });
});

// ── Feature flag ────────────────────────────────────────────────────────────

describe("rollout flag", () => {
  const cfg = readFileSync(resolve(cwd, "src/config/reviewQueueFeature.ts"), "utf-8");

  it("defaults off and requires an explicit true", () => {
    expect(cfg).toContain('=== "true"');
    expect(cfg).toContain("VITE_REVIEW_QUEUE_V2_ENABLED");
  });

  it("does not import V1 modules, so V1 cannot be a fallback", () => {
    const api = readFileSync(resolve(cwd, "src/features/reviewQueueV2/api.ts"), "utf-8");
    for (const v1 of ["legacyReviewPagination", "reviewExpensePagination", "managerReviewExpenses"]) {
      expect(api).not.toContain(v1);
    }
  });
});

// ── SQL contract ────────────────────────────────────────────────────────────

describe("V2 migration", () => {
  it("uses a valid 14-digit timestamp after the previous migration", () => {
    expect(/^\d{14}_/.test("20260801130000_review_queue_v2_contracts.sql")).toBe(true);
    expect(Number("20260801130000")).toBeGreaterThan(Number("20260731100000"));
  });

  it("declares every RPC SECURITY DEFINER with a fixed search_path", () => {
    expect(SQL.match(/SECURITY DEFINER/g)?.length).toBeGreaterThanOrEqual(5);
    expect(SQL.match(/SET search_path = public/g)?.length).toBeGreaterThanOrEqual(5);
  });

  it("revokes PUBLIC and grants only authenticated", () => {
    expect(SQL.match(/REVOKE ALL ON FUNCTION/g)?.length).toBeGreaterThanOrEqual(5);
    expect(SQL).not.toMatch(/GRANT EXECUTE[^;]*TO\s+PUBLIC/i);
    expect(SQL).not.toMatch(/GRANT EXECUTE[^;]*TO\s+anon/i);
  });

  it("requires an active organization membership and rejects cross-organization access", () => {
    expect(SQL).toContain("not an active member of this organization");
    expect(SQL).toContain("expense not visible to this reviewer");
    expect(SQL.match(/organization_id = p_organization_id/g)?.length).toBeGreaterThan(5);
  });

  it("never references audit_logs.organization_id", () => {
    const auditRefs = SQL.split("\n").filter((l) => /audit_logs/.test(l) && /organization_id/.test(l));
    expect(auditRefs.filter((l) => !l.trim().startsWith("--"))).toHaveLength(0);
  });

  it("scopes audit and correction lookups through the expense", () => {
    expect(SQL_CODE).toContain("al.expense_id = pr.id");
    expect(SQL_CODE).toContain("cl.expense_id = pr.id");
    expect(SQL).toContain("cl.organization_id = p_organization_id");
  });

  it("uses the confirmed flag sources", () => {
    expect(SQL).toContain("al.action = 'expense_resubmitted'");
    expect(SQL).toContain("public.expense_correction_logs");
  });

  it("computes sort_at instead of assuming submitted_at", () => {
    expect(SQL_CODE).toContain("COALESCE(e.updated_at, e.created_at, 'epoch'::timestamptz)");
    expect(SQL_CODE).not.toContain("submitted_at");
  });

  it("uses keyset pagination with an id tie-breaker, never OFFSET", () => {
    expect(SQL_CODE).not.toMatch(/\bOFFSET\b/i);
    expect(SQL_CODE).toContain("(e.sort_at, e.id) < (v_cur_sort_at, v_cur_id)");
    expect(SQL_CODE).toContain("(e.sort_at, e.id) > (v_cur_sort_at, v_cur_id)");
  });

  it("maps sort explicitly and rejects anything else", () => {
    expect(SQL).toContain("unsupported sort");
    expect(SQL).toContain("'newest', 'oldest', 'amount_high', 'amount_low'");
  });

  it("caps page size at 100", () => {
    expect(SQL).toContain("LEAST(GREATEST(COALESCE(p_page_size, 25), 1), 100)");
  });

  it("shares one filtered relation between count and page", () => {
    expect(SQL_CODE).toContain("SELECT count(*) AS total FROM eligible");
    expect(SQL_CODE).toContain("FROM eligible e");
  });

  it("contains no EXECUTABLE CREATE TEMP TABLE — a STABLE function may not run DDL", () => {
    // The first cut of this migration declared the page RPC STABLE while creating
    // temp tables. PostgreSQL refuses DDL in a non-volatile function, so it would
    // have failed on every call; the regex tests passed regardless. This asserts on
    // executable SQL only, so an explanatory comment cannot satisfy it.
    expect(SQL_CODE).not.toMatch(/CREATE\s+(TEMP|TEMPORARY)\s+TABLE/i);
  });

  it("uses MATERIALIZED CTEs so enrichment cannot be inlined across the LIMIT", () => {
    expect((SQL_CODE.match(/AS MATERIALIZED/g) ?? []).length).toBeGreaterThanOrEqual(6);
    expect(SQL_CODE).toContain("page_identity AS MATERIALIZED");
    expect(SQL_CODE).toContain("page_custom_fields AS MATERIALIZED");
  });

  it("resolves submitter identity server-side for page users only", () => {
    // The four blank rows (Txn 00421-00424) were caused by a failed browser profile
    // call, not by missing data. V2 resolves identity inside the page RPC.
    expect(SQL_CODE).toContain("employee_name");
    expect(SQL_CODE).toContain("identity_source");
    expect(SQL_CODE).toContain("'current_profile'");
    expect(SQL_CODE).toContain("'inactive_profile'");
    expect(SQL_CODE).toContain("pr.user_id FROM page_rows pr");
  });

  it("keeps an inactive employee's identity rather than blanking the row", () => {
    const start = SQL_CODE.indexOf("page_identity AS MATERIALIZED");
    const body = SQL_CODE.slice(start, start + 900);
    expect(body).not.toMatch(/WHERE[\s\S]*is_active\s*=\s*true/i);
  });

  it("rejects a malformed cursor with a controlled validation error", () => {
    expect(SQL_CODE).toContain("malformed cursor");
  });

  it("aggregates items in the SAME order the page was selected", () => {
    // Regression: items were aggregated with a fixed `ORDER BY pr.sort_at DESC,
    // pr.id DESC` regardless of p_sort, so oldest/amount sorts returned correctly
    // paged but incorrectly ordered JSON.
    expect(SQL_CODE).toContain("ORDER BY pr.rn) AS arr");
    expect(SQL_CODE).not.toContain("ORDER BY pr.sort_at DESC, pr.id DESC) AS arr");
  });

  it("derives the cursor from the exact last returned row", () => {
    // Regression: the cursor came from an approximate inverse ordering that could
    // disagree with the item order, producing skipped or repeated rows.
    expect(SQL_CODE).toContain("ORDER BY pr.rn DESC");
    expect(SQL_CODE).not.toMatch(/total_amount END ASC NULLS FIRST/);
  });

  it("orders page, items and cursor from one row_number() definition", () => {
    expect(SQL_CODE).toContain("row_number() OVER (");
    expect(SQL_CODE).toContain(") AS rn");
    expect((SQL_CODE.match(/ORDER BY pr\.rn/g) ?? []).length).toBe(2);
  });

  it("enriches only page rows", () => {
    expect(SQL_CODE).toContain("FROM page_rows pr");
    const enrichAt = SQL_CODE.indexOf("page_identity AS MATERIALIZED");
    const pageAt = SQL_CODE.indexOf("page_rows AS MATERIALIZED");
    expect(enrichAt).toBeGreaterThan(pageAt);
  });

  it("filters custom fields by stable id with AND across fields, OR within values", () => {
    expect(SQL).toContain("fv.template_id     = (cf->>'field_id')::uuid");
    expect(SQL).toContain("fv.branch_field_id = (cf->>'field_id')::uuid");
    expect(SQL).toContain("jsonb_array_elements_text(cf->'values')");
    expect(SQL).toContain("NOT EXISTS");
  });

  it("validates malformed custom-filter JSON", () => {
    expect(SQL).toContain("p_custom_filters must be a JSON array");
  });

  it("guards hierarchy recursion against cycles and runaway depth", () => {
    expect(SQL).toContain("WITH RECURSIVE");
    expect(SQL).toContain("NOT p.user_id = ANY(w.path)");
    expect(SQL).toContain("w.depth < 10");
  });

  it("maps roles as text so a missing enum literal cannot raise", () => {
    expect(SQL).toContain("m.role::text");
    expect(SQL).toContain("t.manager_user_id     = c.user_id");
    expect(SQL).toContain("t.executive_user_id   = c.user_id");
    expect(SQL).toContain("t.team_leader_user_id = c.user_id");
  });

  it("intersects visibility with active membership", () => {
    expect(SQL).toContain("AND m.is_active = true");
  });

  it("ports the manager actionability rules", () => {
    expect(SQL).toContain("p_status IN ('verified','approved','rejected') THEN false");
    expect(SQL).toContain("p_status = 'level_2_verified' THEN true");
    expect(SQL).toContain("p_tier = 'engineer'");
    expect(SQL).toContain("_review_executive_handoff_v2");
    expect(SQL).toContain("_review_skipped_tier_v2");
  });

  it("returns actionable_stage and keeps visibility separate from actionability", () => {
    expect(SQL).toContain("actionable_stage");
    expect(SQL).toContain("reviewer_visible_user_ids_v2");
  });

  it("returns one jsonb value per RPC, never a row set", () => {
    expect(SQL.match(/RETURNS jsonb/g)?.length).toBeGreaterThanOrEqual(3);
    expect(SQL_CODE).toContain("'version', 2");
  });

  it("keeps detail data out of the list contract", () => {
    const listStart = SQL.indexOf("get_review_queue_page_v2");
    const listEnd = SQL.indexOf("_review_manager_actionable_status_v2");
    const listBody = SQL.slice(listStart, listEnd);
    expect(listBody).not.toContain("public.attachments");
    expect(listBody).not.toContain("'timeline'");
  });

  it("does not build indexes CONCURRENTLY inside the migration", () => {
    expect(SQL).not.toMatch(/CREATE INDEX CONCURRENTLY/i);
    expect(SQL).toContain("CONCURRENTLY is deliberately not used");
  });

  it("filter options read definitions, not expense values", () => {
    const start = SQL.indexOf("get_review_filter_options_v2");
    const body = SQL.slice(start, SQL.indexOf("get_review_expense_detail_v2"));
    expect(body).toContain("expense_form_field_templates");
    expect(body).not.toContain("expense_form_field_values");
  });
});

// ── Filter options parsing ──────────────────────────────────────────────────

describe("filter options", () => {
  it("parses definitions and rejects a wrong version", () => {
    const parsed = parseReviewFilterOptions({
      version: 2, statuses: ["submitted"], categories: ["Fuel"],
      employees: [{ user_id: "u1", name: "A", employee_id: "5003" }],
      custom_fields: [{ source: "template", field_id: "t1", field_key: "vehicle", label: "Vehicle", options: [] }],
    });
    expect(parsed.employees[0].employee_id).toBe("5003");
    expect(parsed.custom_fields[0].source).toBe("template");
    expect(() => parseReviewFilterOptions({ version: 1 })).toThrow(ReviewQueueValidationError);
  });
});
