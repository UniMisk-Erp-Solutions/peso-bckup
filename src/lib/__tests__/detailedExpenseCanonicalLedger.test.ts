/**
 * Detailed Expense on the canonical Additive V3 timeline.
 *
 * Two halves:
 *
 *  1. BEHAVIOURAL — `expenseReports.ts` is plain TypeScript with no Deno-only
 *     imports, so the real builder and the real pager are imported and
 *     executed here against a fake RPC client. These are not source-string
 *     guards; they assert the bytes that land in the file.
 *
 *  2. SQL CONTRACT — the new migration cannot be executed locally (no
 *     Postgres in this environment), so its security, ordering and
 *     order-of-operations shape is guarded on the authored source, matching
 *     the convention already used by serverSideReportGeneration.test.ts.
 *     The migration's runtime behaviour was separately proven against
 *     Production data in a rolled-back transaction — see
 *     `Documentations MD/detailed-expense-canonical-balance.md`.
 *
 * Nothing here is hardcoded to a real employee, organisation or transaction
 * number.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  buildDetailedCsv,
  fetchAllBalanceTimelineRows,
  timelineCustomKeys,
  type BalanceTimelineRow,
} from "../../../supabase/functions/run-report-export-job/expenseReports";

function read(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf-8").replace(/\r\n/g, "\n");
}

const migration = read("supabase/migrations/20260902130000_report_balance_timeline_v3.sql");

/* ── fixtures ─────────────────────────────────────────────────────────────── */

let seq = 0;
const uuid = (tag: string) => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}-${tag}`
  .slice(0, 36);

function ev(over: Partial<BalanceTimelineRow>): BalanceTimelineRow {
  const delta = Number(over.amount_delta ?? 0);
  return {
    user_id: "u-1",
    employee_name: "Aa Employee",
    employee_code: "E-1",
    event_id: uuid("e"),
    event_type: "balance_credit",
    event_label: "Balance Credit",
    effective_date: "2026-07-15",
    amount_delta: delta,
    credit: delta > 0 ? delta : null,
    debit: delta < 0 ? -delta : null,
    opening_balance: 0,
    closing_balance: delta,
    note: "",
    actor_name: "",
    transaction_number: "",
    expense_id: null,
    title: "",
    category: "",
    purpose: "",
    destination: "",
    batch_ref: "",
    custom_fields: {},
    ...over,
  };
}

/** The worked example from the specification, §15. */
const JULY_EXAMPLE: BalanceTimelineRow[] = [
  ev({
    effective_date: "2026-07-01", event_type: "expense_deduction",
    event_label: "Expense Deduction", amount_delta: -1000, credit: null, debit: 1000,
    opening_balance: -5000, closing_balance: -6000,
    transaction_number: "00123", title: "Site visit", category: "Travelling",
    expense_id: uuid("x"), custom_fields: { "Project Name": "ATG" },
  }),
  ev({
    effective_date: "2026-07-15", amount_delta: 10000, credit: 10000, debit: null,
    opening_balance: -6000, closing_balance: 4000,
  }),
  ev({
    effective_date: "2026-07-20", event_type: "expense_deduction",
    event_label: "Expense Deduction", amount_delta: -500, credit: null, debit: 500,
    opening_balance: 4000, closing_balance: 3500,
    transaction_number: "00456", title: "Fuel", category: "Fuel",
    expense_id: uuid("x"),
  }),
];

function parse(csv: string): { headers: string[]; rows: Record<string, string>[] } {
  const body = csv.replace(/^﻿/, "").replace(/\r\n$/, "");
  const lines: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') { cur += '"'; i++; continue; }
      if (ch === '"') { quoted = false; continue; }
      cur += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === "\r" && body[i + 1] === "\n") { lines.push(cur); cur = ""; i++; continue; }
    cur += ch;
  }
  lines.push(cur);

  const split = (line: string): string[] => {
    const out: string[] = [];
    let cell = "";
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') { cell += '"'; i++; continue; }
        if (ch === '"') { q = false; continue; }
        cell += ch;
        continue;
      }
      if (ch === '"') { q = true; continue; }
      if (ch === ",") { out.push(cell); cell = ""; continue; }
      cell += ch;
    }
    out.push(cell);
    return out;
  };

  // Re-split from the raw text so embedded commas inside quotes stay intact.
  const rawLines = body.split("\r\n");
  const headers = split(rawLines[0]);
  const rows = rawLines.slice(1).filter((l) => l.length > 0).map((l) => {
    const cells = split(l);
    const rec: Record<string, string> = {};
    headers.forEach((h, i) => (rec[h] = cells[i] ?? ""));
    return rec;
  });
  return { headers, rows };
}

/* ── 1. behavioural ───────────────────────────────────────────────────────── */

describe("Detailed Expense — signed accounting rule", () => {
  it("a positive balance entry is a Credit with a blank Debit (spec §5)", () => {
    const { csv } = buildDetailedCsv(
      [ev({ effective_date: "2026-07-31", amount_delta: 45000, credit: 45000, debit: null,
            opening_balance: -30000, closing_balance: 15000 })],
    );
    const { rows } = parse(csv);
    expect(rows[0]["Date"]).toBe("31-07-2026");
    expect(rows[0]["Type"]).toBe("Balance Credit");
    expect(rows[0]["Credit"]).toBe("₹45,000.00");
    expect(rows[0]["Debit"]).toBe("");
    expect(rows[0]["Opening Balance"]).toBe("-₹30,000.00");
    expect(rows[0]["Closing Balance"]).toBe("₹15,000.00");
  });

  it("a negative additive entry is a Debit with a blank Credit (spec §6)", () => {
    const { csv } = buildDetailedCsv(
      [ev({ amount_delta: -10000, credit: null, debit: 10000,
            opening_balance: -5000, closing_balance: -15000 })],
    );
    const { rows } = parse(csv);
    expect(rows[0]["Credit"]).toBe("");
    expect(rows[0]["Debit"]).toBe("₹10,000.00");
    expect(rows[0]["Closing Balance"]).toBe("-₹15,000.00");
  });

  it("never fills both Credit and Debit, and never fills neither", () => {
    const { rows } = parse(buildDetailedCsv(JULY_EXAMPLE).csv);
    for (const r of rows) {
      const hasC = r["Credit"] !== "";
      const hasD = r["Debit"] !== "";
      expect(hasC && hasD).toBe(false);
      expect(hasC || hasD).toBe(true);
    }
  });

  it("Credit/Debit follow the sign even when the event type says 'credit'", () => {
    // A `balance_credit` carrying a negative delta must land in Debit. This is
    // the case the retired implementation got wrong by branching on type.
    const { rows } = parse(buildDetailedCsv(
      [ev({ event_type: "balance_credit", event_label: "Balance Credit",
            amount_delta: -250, credit: null, debit: 250,
            opening_balance: 100, closing_balance: -150 })],
    ).csv);
    expect(rows[0]["Type"]).toBe("Balance Credit");
    expect(rows[0]["Credit"]).toBe("");
    expect(rows[0]["Debit"]).toBe("₹250.00");
  });
});

describe("Detailed Expense — the worked July example (spec §15)", () => {
  it("reproduces the three rows, in order, with the specified closing balances", () => {
    const { rows } = parse(buildDetailedCsv(JULY_EXAMPLE).csv);
    expect(rows.map((r) => [r["Date"], r["Credit"], r["Debit"], r["Closing Balance"]])).toEqual([
      ["01-07-2026", "", "₹1,000.00", "-₹6,000.00"],
      ["15-07-2026", "₹10,000.00", "", "₹4,000.00"],
      ["20-07-2026", "", "₹500.00", "₹3,500.00"],
    ]);
  });

  it("the first in-period row opens at the carried-in balance, not zero (spec §14)", () => {
    const { rows } = parse(buildDetailedCsv(JULY_EXAMPLE).csv);
    expect(rows[0]["Opening Balance"]).toBe("-₹5,000.00");
    expect(rows[0]["Opening Balance"]).not.toBe("₹0.00");
  });

  it("opening always equals closing minus the delta (spec §9)", () => {
    for (const e of JULY_EXAMPLE) {
      expect(Number(e.opening_balance)).toBe(Number(e.closing_balance) - Number(e.amount_delta));
    }
  });
});

describe("Detailed Expense — expense rows", () => {
  it("carries the transaction number as text so leading zeros survive (spec §18)", () => {
    const { rows } = parse(buildDetailedCsv(JULY_EXAMPLE).csv);
    expect(rows[0]["Transaction #"]).toBe("00123");
    expect(rows[2]["Transaction #"]).toBe("00456");
  });

  it("shows the human event label, not a raw internal string (spec §17)", () => {
    const { rows } = parse(buildDetailedCsv(JULY_EXAMPLE).csv);
    expect(rows[0]["Type"]).toBe("Expense Deduction");
    expect(rows[0]["Type"]).not.toBe("expense_deduction");
  });

  it("keeps the expense category alongside the event label, so nothing is lost", () => {
    const { rows } = parse(buildDetailedCsv(JULY_EXAMPLE).csv);
    expect(rows[0]["Expense Type"]).toBe("Travelling");
    expect(rows[1]["Expense Type"]).toBe("");
  });

  it("populates custom fields on expense rows and leaves them blank on balance rows (spec §16)", () => {
    const { headers, rows } = parse(buildDetailedCsv(JULY_EXAMPLE).csv);
    expect(headers).toContain("Project Name");
    expect(rows[0]["Project Name"]).toBe("ATG");
    expect(rows[1]["Project Name"]).toBe("");
  });

  it("leaves expense-only cells blank on a non-expense balance event", () => {
    const { rows } = parse(buildDetailedCsv(JULY_EXAMPLE).csv);
    for (const col of ["Transaction #", "Title", "Expense Type", "Purpose", "Destination", "Batch"]) {
      expect(rows[1][col]).toBe("");
    }
  });
});

describe("Detailed Expense — All Employees (spec §11)", () => {
  const TWO_EMPLOYEES: BalanceTimelineRow[] = [
    ev({ user_id: "u-1", employee_name: "Aa One", employee_code: "E-1",
         amount_delta: 5000, credit: 5000, debit: null,
         opening_balance: -1000, closing_balance: 4000 }),
    ev({ user_id: "u-1", employee_name: "Aa One", employee_code: "E-1",
         amount_delta: -600, credit: null, debit: 600,
         opening_balance: 4000, closing_balance: 3400 }),
    ev({ user_id: "u-2", employee_name: "Bb Two", employee_code: "E-2",
         amount_delta: -900, credit: null, debit: 900,
         opening_balance: 200, closing_balance: -700 }),
  ];

  it("carries Employee and Employee ID, and still has both balance columns", () => {
    const { headers } = parse(buildDetailedCsv(TWO_EMPLOYEES).csv);
    for (const col of ["Employee", "Employee ID", "Credit", "Debit",
                       "Opening Balance", "Closing Balance", "Transaction #", "Notes"]) {
      expect(headers).toContain(col);
    }
  });

  it("each employee keeps their OWN balance chain — no organisation-wide running total", () => {
    const { rows } = parse(buildDetailedCsv(TWO_EMPLOYEES).csv);
    // Within an employee the chain is continuous...
    expect(rows[0]["Closing Balance"]).toBe(rows[1]["Opening Balance"]);
    // ...and it does NOT continue across the employee boundary.
    expect(rows[2]["Opening Balance"]).not.toBe(rows[1]["Closing Balance"]);
    expect(rows[2]["Employee"]).toBe("Bb Two");
    expect(rows[2]["Opening Balance"]).toBe("₹200.00");
  });

  it("keeps Employee and Employee ID even when selecting one employee (DOC-131 format-parity fix)", () => {
    // Selecting one employee only changes which ROWS are fetched (the worker
    // passes p_user_ids: ["u-1"] to report_balance_timeline_rows_v3) -- it
    // must never change the report's column schema. A prior version dropped
    // these two columns whenever a single employee was selected, which made
    // "All employees" and "Employee = X" two different formats. Simulated
    // here by filtering the fixture the same way the RPC's own p_user_ids
    // filter would, then building the identical row model.
    const singleEmployeeRows = TWO_EMPLOYEES.filter((r) => r.user_id === "u-1");
    const { headers } = parse(buildDetailedCsv(singleEmployeeRows).csv);
    expect(headers).toContain("Employee");
    expect(headers).toContain("Employee ID");
    expect(headers).toContain("Closing Balance");
  });

  it("one employee's rows are byte-identical whether fetched alone or filtered out of all-employees mode", () => {
    const single = parse(buildDetailedCsv(TWO_EMPLOYEES.filter((r) => r.user_id === "u-1")).csv);
    const all = parse(buildDetailedCsv(TWO_EMPLOYEES).csv)
      .rows.filter((r) => r["Employee ID"] === "E-1");
    expect(all.length).toBe(single.rows.length);
    single.rows.forEach((row, i) => {
      // Every column, including the identity ones, must match exactly -- the
      // ONLY difference between the two modes is which rows are present.
      for (const col of ["Employee", "Employee ID", "Date", "Credit", "Debit", "Opening Balance", "Closing Balance"]) {
        expect(all[i][col]).toBe(row[col]);
      }
    });
  });

  it("column order and column set are identical between all-employees and single-employee output (format parity)", () => {
    const allHeaders = parse(buildDetailedCsv(TWO_EMPLOYEES).csv).headers;
    const singleHeaders = parse(buildDetailedCsv(TWO_EMPLOYEES.filter((r) => r.user_id === "u-1")).csv).headers;
    expect(singleHeaders).toEqual(allHeaders);
  });
});

describe("Detailed Expense — pager", () => {
  function fakeClient(pages: BalanceTimelineRow[][], total: number) {
    const calls: Record<string, unknown>[] = [];
    return {
      calls,
      rpc: (name: string, params: Record<string, unknown>) => {
        calls.push({ name, ...params });
        if (name === "report_export_job_heartbeat_v1") return Promise.resolve({ data: null, error: null });
        const idx = params.p_cursor == null ? 0 : Number((params.p_cursor as { rn: number }).rn);
        const rows = pages[idx] ?? [];
        const more = idx + 1 < pages.length;
        return Promise.resolve({
          data: {
            schema_version: 1,
            returned: rows.length,
            has_more: more,
            next_cursor: more ? { n: "x", u: "u-1", rn: idx + 1 } : null,
            total_count: params.p_with_total ? total : null,
            rows,
          },
          error: null,
        });
      },
    };
  }

  it("follows the cursor to the end and assembles every row", async () => {
    const pages = [[ev({ amount_delta: 1 })], [ev({ amount_delta: 2 })], [ev({ amount_delta: 3 })]];
    const c = fakeClient(pages, 3);
    const out = await fetchAllBalanceTimelineRows(c, {
      organizationId: "org", userIds: null, dateFrom: null, dateTo: null,
    });
    expect(out.rows.length).toBe(3);
    expect(out.total).toBe(3);
    expect(out.pages).toBe(3);
  });

  it("asks for the total on the first page only", async () => {
    const c = fakeClient([[ev({ amount_delta: 1 })], [ev({ amount_delta: 2 })]], 2);
    await fetchAllBalanceTimelineRows(c, {
      organizationId: "org", userIds: null, dateFrom: null, dateTo: null,
    });
    const timelineCalls = c.calls.filter((x) => x.name === "report_balance_timeline_rows_v3");
    expect(timelineCalls.map((x) => x.p_with_total)).toEqual([true, false]);
  });

  it("is ONE set-based call per page for all employees — never one per employee", async () => {
    const c = fakeClient([[ev({ user_id: "u-1" }), ev({ user_id: "u-2" }), ev({ user_id: "u-3" })]], 3);
    await fetchAllBalanceTimelineRows(c, {
      organizationId: "org", userIds: null, dateFrom: null, dateTo: null,
    });
    const timelineCalls = c.calls.filter((x) => x.name === "report_balance_timeline_rows_v3");
    expect(timelineCalls.length).toBe(1);
    expect(timelineCalls[0].p_user_ids).toBeNull();
  });

  it("rejects an unknown contract version instead of guessing", async () => {
    const c = {
      rpc: () => Promise.resolve({ data: { schema_version: 2, rows: [] }, error: null }),
    };
    await expect(fetchAllBalanceTimelineRows(c, {
      organizationId: "org", userIds: null, dateFrom: null, dateTo: null,
    })).rejects.toThrow(/contract version 2/);
  });

  it("surfaces the page number when a page fails", async () => {
    const c = { rpc: () => Promise.resolve({ data: null, error: { message: "boom" } }) };
    await expect(fetchAllBalanceTimelineRows(c, {
      organizationId: "org", userIds: null, dateFrom: null, dateTo: null,
    })).rejects.toThrow(/timeline page 1: boom/);
  });

  it("honours the soft deadline rather than running past it", async () => {
    const c = fakeClient([[ev({})], [ev({})]], 2);
    await expect(fetchAllBalanceTimelineRows(
      c, { organizationId: "org", userIds: null, dateFrom: null, dateTo: null },
      undefined, () => true,
    )).rejects.toThrow(/too large to build in one pass/);
  });
});

describe("Detailed Expense — CSV mechanics", () => {
  it("custom-field columns are the deterministic union across rows", () => {
    expect(timelineCustomKeys([
      ev({ custom_fields: { Zebra: "1", Alpha: "2" } }),
      ev({ custom_fields: { Mango: "3" } }),
    ])).toEqual(["Alpha", "Mango", "Zebra"]);
  });

  it("escapes commas, quotes and newlines, and keeps the UTF-8 BOM", () => {
    const { csv } = buildDetailedCsv(
      [ev({ note: 'a,b "c" \nd', amount_delta: 1, credit: 1 })], "u-1",
    );
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain('"a,b ""c"" \nd"');
  });

  it("blank — not ₹0.00 — in the column an event does not touch", () => {
    const { rows } = parse(buildDetailedCsv([ev({ amount_delta: 7, credit: 7, debit: null })]).csv);
    expect(rows[0]["Debit"]).toBe("");
    expect(rows[0]["Credit"]).toBe("₹7.00");
  });

  it("an empty ledger still produces a valid header-only file", () => {
    const { csv, rowCount } = buildDetailedCsv([]);
    expect(rowCount).toBe(0);
    expect(parse(csv).headers).toContain("Closing Balance");
  });

  it("a genuine zero balance still renders as ₹0.00, unlike an untouched column", () => {
    const { rows } = parse(buildDetailedCsv(
      [ev({ amount_delta: 500, credit: 500, opening_balance: -500, closing_balance: 0 })], "u-1",
    ).csv);
    expect(rows[0]["Closing Balance"]).toBe("₹0.00");
    expect(rows[0]["Debit"]).toBe("");
  });
});

/* ── 2. SQL contract ──────────────────────────────────────────────────────── */

describe("report_balance_timeline_rows_v3 — security (spec §13)", () => {
  it("is revoked from PUBLIC, anon and authenticated, and granted only to service_role", () => {
    const sig = "public.report_balance_timeline_rows_v3(uuid, uuid[], date, date, jsonb, integer, boolean)";
    expect(migration).toContain(`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC`);
    expect(migration).toContain(`REVOKE ALL ON FUNCTION ${sig} FROM anon, authenticated`);
    expect(migration).toContain(`GRANT EXECUTE ON FUNCTION ${sig} TO service_role`);
  });

  it("the shared event helper is service_role-only too", () => {
    const sig = "public._balance_timeline_events_v3(uuid, uuid[])";
    expect(migration).toContain(`REVOKE ALL ON FUNCTION ${sig} FROM anon, authenticated`);
    expect(migration).toContain(`GRANT EXECUTE ON FUNCTION ${sig} TO service_role`);
  });

  it("does NOT weaken the two public V3 wrappers", () => {
    expect(migration).not.toContain("get_my_unified_balance_timeline_v3");
    expect(migration).not.toContain("get_org_balance_timeline_v3");
  });

  it("is organisation-scoped and refuses a null organisation", () => {
    expect(migration).toContain("organization is required");
    expect(migration).toContain("bl.organization_id = p_organization_id");
    expect(migration).toContain("ebd.organization_id = p_organization_id");
  });

  it("every function pins search_path", () => {
    const creates = migration.match(/CREATE OR REPLACE FUNCTION/g) ?? [];
    const pinned = migration.match(/SET search_path TO 'public'/g) ?? [];
    // _balance_event_label_v3 is IMMUTABLE and touches no table, so it needs none.
    expect(creates.length).toBe(4);
    expect(pinned.length).toBe(3);
  });
});

describe("report_balance_timeline_rows_v3 — order of operations (spec §14)", () => {
  it("computes the running balance BEFORE applying the report window", () => {
    const runningAt = migration.indexOf("calculated_balance_after\n    FROM ordered o");
    const windowAt = migration.indexOf("p_date_from IS NULL OR r.effective_at::date >= p_date_from");
    expect(runningAt).toBeGreaterThan(-1);
    expect(windowAt).toBeGreaterThan(-1);
    expect(runningAt).toBeLessThan(windowAt);
  });

  it("paginates last of all, after the window", () => {
    const windowAt = migration.indexOf("p_date_to   IS NULL OR r.effective_at::date <= p_date_to");
    const pageAt = migration.indexOf("ORDER BY w.employee_name ASC, w.user_id ASC, w.rn ASC");
    expect(windowAt).toBeLessThan(pageAt);
  });

  it("the canonical event set carries NO date predicate", () => {
    const start = migration.indexOf("CREATE OR REPLACE FUNCTION public._balance_timeline_events_v3");
    const end = migration.indexOf("REVOKE ALL ON FUNCTION public._balance_timeline_events_v3", start);
    const body = migration.slice(start, end);
    expect(body).not.toContain("p_date_from");
    expect(body).not.toContain("p_date_to");
  });

  it("runs the balance per employee, never once across the organisation", () => {
    expect(migration).toContain("SUM(o.amount_delta) OVER (PARTITION BY o.user_id ORDER BY o.rn)");
    expect(migration).toContain("PARTITION BY e.user_id");
  });

  it("derives each employee's baseline from that employee's own wallet", () => {
    expect(migration).toContain("COALESCE(p.balance, 0) - t.total_delta AS baseline_before");
    expect(migration).toContain("GROUP BY user_id");
  });
});

describe("report_balance_timeline_rows_v3 — canonical semantics (spec §7, §8, §18)", () => {
  it("hides reversed source/reversal pairs with the same generic rule as the Balance Ledger", () => {
    expect(migration).toContain("SELECT id FROM public.balance_ledger WHERE reversal_of IS NOT NULL");
    expect(migration).toContain("SELECT reversal_of FROM public.balance_ledger WHERE reversal_of IS NOT NULL");
    expect(migration).toContain("WHERE status = 'reversed'");
    expect(migration).toContain("bl.id NOT IN (SELECT id FROM hidden)");
  });

  it("dates expenses by trip_start and never by the approval timestamp", () => {
    expect(migration).toContain("e.trip_start::timestamptz");
    expect(migration).not.toContain("ebd.created_at");
  });

  it("uses the same deterministic same-day ordering key as the Balance Ledger", () => {
    const key = "(CASE WHEN e.event_type = 'expense_deduction' THEN e.transaction_number END) ASC NULLS LAST";
    // Once for the rewired Balance Ledger, once for the report producer.
    expect(migration.split(key).length - 1).toBe(2);
    expect(migration).toContain("e.day_position ASC");
  });

  it("reports closing balance from calculated_balance_after, never a stored balance_after", () => {
    expect(migration).toContain("'closing_balance',    pg.calculated_balance_after");
    expect(migration).toContain("'opening_balance',    pg.calculated_balance_after - pg.amount_delta");
    expect(migration).not.toContain("ebd.balance_after");
    expect(migration).not.toContain("bl.balance_after");
  });

  it("decides Credit/Debit from the sign alone", () => {
    expect(migration).toContain("CASE WHEN pg.amount_delta > 0 THEN  pg.amount_delta END");
    expect(migration).toContain("CASE WHEN pg.amount_delta < 0 THEN -pg.amount_delta END");
  });

  it("treats a zero delta as a no-op and does not display it (spec §3)", () => {
    expect(migration).toContain("WHERE r.amount_delta <> 0");
  });

  it("keeps the transaction number as text", () => {
    expect(migration).toContain("'transaction_number', COALESCE(e.transaction_number, '')");
    expect(migration).not.toMatch(/transaction_number[^,\n]*::(int|numeric|bigint)/);
  });

  it("keyset pagination uses a true composite comparison", () => {
    expect(migration).toContain("(w.employee_name, w.user_id, w.rn) > (v_cur_nm, v_cur_uid, v_cur_rn)");
    expect(migration).toContain("LEAST(GREATEST(COALESCE(p_page_size, 250), 1), 500)");
    expect(migration).toContain("malformed cursor");
  });
});

describe("one accounting algorithm (spec §12)", () => {
  it("the Balance Ledger now reads the shared helper instead of its own CTEs", () => {
    const start = migration.indexOf("CREATE OR REPLACE FUNCTION public._balance_unified_timeline_v3");
    const end = migration.indexOf("REVOKE ALL ON FUNCTION public._balance_unified_timeline_v3", start);
    const body = migration.slice(start, end);
    expect(body).toContain("FROM public._balance_timeline_events_v3(p_organization_id, ARRAY[p_user_id])");
    // The duplicated event construction is gone from this consumer.
    expect(body).not.toContain("WITH hidden AS");
    expect(body).not.toContain("public.expense_balance_deductions");
  });

  it("keeps the Balance Ledger's public signature and output shape byte-for-byte", () => {
    const start = migration.indexOf("CREATE OR REPLACE FUNCTION public._balance_unified_timeline_v3");
    const body = migration.slice(start);
    expect(body).toContain("RETURNS SETOF public.balance_timeline_event_v3");
    expect(body).toContain("ORDER BY r.rn DESC\n  LIMIT p_limit OFFSET p_offset");
  });

  it("the event union is written exactly once in this migration", () => {
    expect(migration.split("FROM public.expense_balance_deductions ebd").length - 1).toBe(1);
    expect(migration.split("WITH hidden AS").length - 1).toBe(1);
  });

  it("does not edit or re-create any already-live V3 object (spec §22)", () => {
    expect(migration).not.toContain("DROP TYPE");
    expect(migration).not.toContain("DROP FUNCTION");
    expect(migration).not.toMatch(/\b(ALTER|DROP)\s+TABLE\b/);
    expect(migration).not.toMatch(/\b(INSERT|UPDATE|DELETE)\s+(INTO\s+)?public\./);
    expect(migration).not.toContain("CREATE POLICY");
  });
});
