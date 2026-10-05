/**
 * Report preview sort/filter polish (owner QA, 2026-09-25):
 *  - v3 RPC: blanks last in both directions, case-insensitive text, digits
 *    ordered numerically without changing the displayed value, parse-safe.
 *  - the client always applies only the NEWEST preview response.
 * The SQL behaviour itself was proven against a real 21,828-row frozen
 * report in a rolled-back transaction; these tests pin the contract.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { createMonthFetchGuardState, invalidateMonthFetch, runMonthFetch } from "@/lib/monthFetchGuard";

const read = (rel: string) =>
  readFileSync(resolve(__dirname, "../../..", rel), "utf-8").split("\r\n").join("\n");
const v3 = read("supabase/migrations/20261002000000_report_export_job_preview_v3.sql");
const v2 = read("supabase/migrations/20260930000000_report_export_job_preview_v2.sql");
const client = read("src/lib/reportExportJobs.ts");
const panel = read("src/components/ServerReportExportPanel.tsx");

describe("get_report_export_job_preview_v3 migration contract", () => {
  it("is a NEW additive function -- the applied v2 migration is not edited and v1/v2 are not dropped", () => {
    expect(v3).toContain("CREATE OR REPLACE FUNCTION public.get_report_export_job_preview_v3(");
    expect(v3).not.toMatch(/DROP FUNCTION/i);
    expect(v2).toContain("CREATE OR REPLACE FUNCTION public.get_report_export_job_preview_v2(");
    expect(v3).toContain("to_regprocedure('public.get_report_export_job_preview_v2(uuid, integer, integer, text, text, jsonb)') IS NULL");
  });

  it("puts blanks LAST for every kind and both directions", () => {
    expect(v3).toContain("WHEN v_sort_kind = 'date'  AND k.k_date IS NULL THEN 1");
    expect(v3).toContain("WHEN v_sort_kind = 'money' AND k.k_num  IS NULL THEN 1");
    expect(v3).toContain("WHEN v_sort_kind = 'text'  AND k.k_txt = ''     THEN 1");
    // the blank flag is the FIRST ordering key, ahead of every value key
    const order = v3.slice(v3.indexOf("ORDER BY\n          -- blanks always last"));
    expect(order.indexOf("THEN 1")).toBeLessThan(order.indexOf("k.k_date END ASC"));
  });

  it("sorts dates as dates and money as numbers, never as display strings", () => {
    expect(v3).toContain("to_date(f.row_data->>p_sort_column, 'DD-MM-YYYY')");
    expect(v3).toContain("::numeric END AS k_num");
    // parse guards: a malformed cell can never raise
    expect(v3).toContain("~ '^\\d{2}-\\d{2}-\\d{4}$'");
    expect(v3).toContain("~ '^-?\\d+(\\.\\d+)?$'");
  });

  it("text ordering is case-insensitive and orders all-digit values numerically without touching row_data", () => {
    expect(v3).toContain("lower(btrim(COALESCE(f.row_data->>p_sort_column, '')))");
    expect(v3).toContain("lpad(btrim(f.row_data->>p_sort_column), 40, '0')");
    // the sort key is computed in a separate column; the returned JSON is row_data itself
    expect(v3).toContain("jsonb_agg(p.row_data ORDER BY p.rn)");
  });

  it("uses ONE ranking for paging and output, with row_index as the final tie-break", () => {
    expect(v3).toContain("row_number() OVER (");
    expect(v3).toContain("k.row_index ASC\n      ) AS rn");
    expect(v3).toContain("WHERE rn > (v_page - 1) * v_page_size AND rn <= v_page * v_page_size");
  });

  it("keeps the v2 authorization/validation and revokes anon/public", () => {
    expect(v3).toContain("daily_report_caller_can_view_v1(v_job.organization_id, false)");
    expect(v3).toContain("unknown sort column");
    expect(v3).toContain("unknown filter column");
    expect(v3).toContain("invalid sort direction");
    expect(v3).toContain("REVOKE ALL ON FUNCTION public.get_report_export_job_preview_v3(uuid, integer, integer, text, text, jsonb) FROM PUBLIC;");
    expect(v3).toContain("REVOKE ALL ON FUNCTION public.get_report_export_job_preview_v3(uuid, integer, integer, text, text, jsonb) FROM anon;");
    expect(v3).toContain("GRANT EXECUTE ON FUNCTION public.get_report_export_job_preview_v3(uuid, integer, integer, text, text, jsonb) TO authenticated;");
  });

  it("touches no financial table and builds no dynamic SQL", () => {
    for (const t of ["expenses", "balance_ledger", "expense_balance_deductions", "cash_transfer_history", "profiles"]) {
      expect(v3).not.toMatch(new RegExp(`(FROM|UPDATE|INSERT INTO)\\s+public\\.${t}\\b`));
    }
    expect(v3).not.toMatch(/\bEXECUTE\s+(format|'|")/);
  });
});

describe("client", () => {
  it("calls the v3 RPC with sort + filters", () => {
    expect(client).toContain('db.rpc("get_report_export_job_preview_v3", {');
    expect(client).toContain("p_sort_column: sortColumn");
    expect(client).toContain("p_sort_direction: sortDirection");
  });

  it("routes EVERY preview load through the generation-token guard and invalidates it on every reset", () => {
    expect(panel).toContain("runMonthFetch(");
    expect(panel).toContain("previewGuardRef.current,");
    expect(panel).toContain("invalidateMonthFetch(previewGuardRef.current)");
    // no unguarded direct call to the fetcher outside runMonthFetch
    const direct = panel.split("fetchReportExportJobPreviewPageV2(").length - 1;
    expect(direct).toBe(1);
  });

  it("closes the menu when Asc/Desc is clicked", () => {
    expect(panel).toContain('onClick={() => { onSort(column, "asc"); setOpen(false); }}');
    expect(panel).toContain('onClick={() => { onSort(column, "desc"); setOpen(false); }}');
  });

  it("no longer runs a network request inside a state updater (applyFilter)", () => {
    const start = panel.indexOf("const applyFilter = useCallback(");
    const body = panel.slice(start, panel.indexOf("const resetView = useCallback("));
    expect(body).not.toContain("setColumnFilters((prev)");
    expect(body).toContain("void loadPreview(activePreviewJobId, 1, sortColumn, sortDirection, next)");
  });
});

describe("stale preview responses are dropped (real deferred promises)", () => {
  function deferred<T>() {
    let resolveFn!: (v: T) => void;
    const promise = new Promise<T>((res) => { resolveFn = res; });
    return { promise, resolve: resolveFn };
  }

  it("a slow page-2 request that finishes AFTER a newer Date-Desc request never overwrites it", async () => {
    const guard = createMonthFetchGuardState();
    const applied: string[] = [];
    const page2 = deferred<string>();
    const sorted = deferred<string>();

    const a = runMonthFetch(guard, () => true, () => page2.promise).then((o) => o.kind === "success" && applied.push(o.data));
    const b = runMonthFetch(guard, () => true, () => sorted.promise).then((o) => o.kind === "success" && applied.push(o.data));

    sorted.resolve("date-desc"); // newer finishes first
    await b;
    page2.resolve("page-2-canonical"); // older finishes afterwards
    await a;

    expect(applied).toEqual(["date-desc"]);
  });

  it("an old filter response cannot land after Reset view invalidated the guard", async () => {
    const guard = createMonthFetchGuardState();
    const applied: string[] = [];
    const oldFilter = deferred<string>();
    const p = runMonthFetch(guard, () => true, () => oldFilter.promise).then((o) => o.kind === "success" && applied.push(o.data));
    invalidateMonthFetch(guard); // Reset view / org switch / new generation
    oldFilter.resolve("employee-contains-x");
    await p;
    expect(applied).toEqual([]);
  });

  it("a response for a previous organization is dropped even if it is the newest request", async () => {
    const guard = createMonthFetchGuardState();
    let current = "org-a";
    const slow = deferred<string>();
    const p = runMonthFetch(guard, () => current === "org-a", () => slow.promise);
    current = "org-b";
    slow.resolve("org-a-rows");
    expect((await p).kind).toBe("stale");
  });
});
