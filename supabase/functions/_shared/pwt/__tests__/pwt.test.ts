import { describe, expect, it } from "vitest";
import {
  DEFAULT_PWT_CONFIG, activeCompanyRequest, mastersImportXml, normalizeRow, parseActiveCompany,
  parseImportResponse, parseVoucherReadback, planPosting, reconcile, toFiveColumns, vouchersImportXml,
  monthEnd, parseAmount, toIsoDate,
  type CanonicalTxn, type PosterState,
} from "../index.ts";

const ORG = "org-1";
const EMPTY: PosterState = { postedSourceIds: new Set(), voucherCounts: {} };

function detailed(over: Record<string, unknown> = {}) {
  return {
    event_id: "ev1", expense_id: "e1", event_type: "expense_deduction", employee_code: "1001",
    employee_name: "Test Person", category: "Travelling (Public and Private Transport)",
    debit: 140, credit: null, effective_date: "2026-08-05", transaction_number: "T1", ...over,
  };
}

async function txns(rows: Record<string, unknown>[], report: Parameters<typeof normalizeRow>[1] = "detailed_expense") {
  const out: CanonicalTxn[] = [];
  for (const r of rows) {
    const n = await normalizeRow(ORG, report, r);
    if (n.txn) out.push(n.txn);
  }
  return out;
}

describe("helpers", () => {
  it("parses amounts and dates", () => {
    expect(parseAmount("₹ 1,234.50")).toBe(1234.5);
    expect(parseAmount("(10)")).toBe(-10);
    expect(Number.isNaN(parseAmount(""))).toBe(true);
    expect(toIsoDate("02-07-2026")).toBe("2026-07-02");
    expect(toIsoDate("2026-02-30")).toBe("");
    expect(monthEnd("2028-02-10")).toBe("2028-02-29");
  });
});

describe("five-column aggregation (Sumit methodology)", () => {
  it("sums by employee ledger + expense ledger, one voucher per category", async () => {
    const t = await txns([
      detailed({ expense_id: "a", debit: 100 }),
      detailed({ expense_id: "b", debit: 40.5 }),
      detailed({ expense_id: "c", employee_code: "1002", employee_name: "Other Person", debit: 10 }),
      detailed({ expense_id: "d", category: "Food", debit: 7, effective_date: "2026-08-20" }),
    ]);
    const r = planPosting(DEFAULT_PWT_CONFIG, t, EMPTY);
    expect(r.issues).toEqual([]);
    const table = toFiveColumns(r.rows);
    expect(table[0]).toEqual(["Voucher Date (Tally)", "Expense Ledger", "Employe Ledger", "Voucher ID", "Total"]);
    expect(table.slice(1)).toEqual([
      ["2026-08-31", "Travelling Expenses", "Other Person-1002", "PESO/08/01", "10.00"],
      ["2026-08-31", "Travelling Expenses", "Test Person-1001", "PESO/08/01", "140.50"],
      ["2026-08-31", "Travelling Expenses", "Test Person-1001", "PESO/08/09", "7.00"],
    ]);
    expect(r.vouchers).toHaveLength(2);
    const v1 = r.vouchers[0];
    expect(v1.total).toBe(150.5);
    expect(v1.lines[0]).toEqual({ ledger: "Travelling Expenses", side: "debit", amount: 150.5 });
    const dr = v1.lines.filter((l) => l.side === "debit").reduce((s, l) => s + l.amount, 0);
    const cr = v1.lines.filter((l) => l.side === "credit").reduce((s, l) => s + l.amount, 0);
    expect(dr).toBe(cr);
  });

  it("voucher date can be the FIRST day of the month (for Tally editions that refuse month-end dates); the voucher id is unchanged", async () => {
    const t = await txns([
      detailed({ expense_id: "a", debit: 100, effective_date: "2026-06-17" }),
      detailed({ expense_id: "b", debit: 40.5, effective_date: "2026-06-29" }),
    ]);
    const end = planPosting(DEFAULT_PWT_CONFIG, t, EMPTY);
    const start = planPosting({ ...DEFAULT_PWT_CONFIG, postingDatePolicy: "month_start" }, t, EMPTY);
    expect(end.rows.map((r) => r.voucherDate)).toEqual(["2026-06-30"]);
    expect(start.rows.map((r) => r.voucherDate)).toEqual(["2026-06-01"]);
    expect(start.rows.map((r) => r.voucherId)).toEqual(end.rows.map((r) => r.voucherId));
    expect(start.vouchers[0].total).toBe(140.5);
  });

  it("is deterministic regardless of input order", async () => {
    const rows = [detailed({ expense_id: "a" }), detailed({ expense_id: "b", employee_code: "9", employee_name: "Z" })];
    const a = planPosting(DEFAULT_PWT_CONFIG, await txns(rows), EMPTY);
    const b = planPosting(DEFAULT_PWT_CONFIG, await txns([...rows].reverse()), EMPTY);
    expect(a.rows.map((x) => [x.employeeLedger, x.total])).toEqual(b.rows.map((x) => [x.employeeLedger, x.total]));
  });

  it("never guesses: unmapped type / missing employee / bad amount are blocking and excluded", async () => {
    const t = await txns([
      detailed({ expense_id: "a", category: "Parking" }),
      detailed({ expense_id: "b", employee_code: "" }),
      detailed({ expense_id: "c", debit: 0 }),
      detailed({ expense_id: "d", effective_date: "" }),
      detailed({ expense_id: "ok" }),
    ]);
    const r = planPosting(DEFAULT_PWT_CONFIG, t, EMPTY);
    expect(r.issues.filter((i) => i.blocking).map((i) => i.code).sort()).toEqual([
      "BAD_DATE", "MISSING_EMPLOYEE_ID", "NON_POSITIVE_AMOUNT", "UNMAPPED_EXPENSE_TYPE",
    ]);
    expect(r.rows).toHaveLength(1);
  });
});

describe("report rules", () => {
  it("credits and non-expense ledger events post nothing", async () => {
    const out = await normalizeRow(ORG, "detailed_expense", detailed({ debit: null, credit: 500, event_type: "balance_credit" }));
    expect(out.skipped).toBeTruthy();
    const e = await normalizeRow(ORG, "detailed_expense", detailed({ event_type: "balance_adjustment" }));
    expect(e.skipped).toBeTruthy();
  });

  it("claim verification and daily project never post", async () => {
    const cv = await txns([{ id: "e9", status: "level_2_verified", total_amount: 50, category: "Food", employee_code: "1", employee_name: "A", bill_date: "2026-08-01" }], "claim_verification");
    expect(planPosting(DEFAULT_PWT_CONFIG, cv, EMPTY).rows).toHaveLength(0);
    expect((await normalizeRow(ORG, "daily_project", { track_date: "2026-08-01" })).skipped).toBeTruthy();
  });

  it("claim approval posts only final-approved + HO approved", async () => {
    const base = { total_amount: 50, category: "Food", employee_code: "1", employee_name: "A", bill_date: "2026-08-01" };
    const t = await txns([
      { ...base, id: "ok", status: "approved", ho_approval: "Approved" },
      { ...base, id: "pending", status: "approved", ho_approval: "Pending" },
      { ...base, id: "ver", status: "verified", ho_approval: "Pending" },
    ], "claim_approval");
    const r = planPosting(DEFAULT_PWT_CONFIG, t, EMPTY);
    expect(r.rows).toHaveLength(1);
    expect(r.postedSourceIds).toEqual([`${ORG}:expense:ok`]);
    expect(r.issues.filter((i) => i.code === "NOT_APPROVED")).toHaveLength(2);
  });
});

describe("duplicate prevention across reports and syncs", () => {
  it("same expense through Detailed then Claim Approval posts once", async () => {
    const d = await txns([detailed({ expense_id: "X1", debit: 100 })]);
    const first = planPosting(DEFAULT_PWT_CONFIG, d, EMPTY);
    expect(first.rows).toHaveLength(1);
    const state: PosterState = {
      postedSourceIds: new Set(first.postedSourceIds),
      voucherCounts: { "2026-08-31|1": 1 },
      postedAmounts: { [first.postedSourceIds[0]]: 100 },
    };
    const a = await txns([{ id: "X1", status: "approved", ho_approval: "Approved", total_amount: 100, category: "Travelling (Public and Private Transport)", employee_code: "1001", employee_name: "Test Person", bill_date: "2026-08-05" }], "claim_approval");
    const second = planPosting(DEFAULT_PWT_CONFIG, a, state);
    expect(second.rows).toHaveLength(0);
    expect(second.issues[0].code).toBe("ALREADY_POSTED");
  });

  it("flags amount mismatch without re-posting", async () => {
    const a = await txns([detailed({ expense_id: "X1", debit: 90 })]);
    const r = planPosting(DEFAULT_PWT_CONFIG, a, { postedSourceIds: new Set([`${ORG}:expense:X1`]), voucherCounts: {}, postedAmounts: { [`${ORG}:expense:X1`]: 100 } });
    expect(r.rows).toHaveLength(0);
    expect(r.issues[0].code).toBe("AMOUNT_MISMATCH");
  });

  it("new expense in an already-posted period gets a supplementary voucher number", async () => {
    const t = await txns([detailed({ expense_id: "late" })]);
    const r = planPosting(DEFAULT_PWT_CONFIG, t, { postedSourceIds: new Set(), voucherCounts: { "2026-08-31|1": 1 } });
    expect(r.rows[0].voucherId).toBe("PESO/08/01-S1");
  });

  it("same expense twice in one run counts once", async () => {
    const t = await txns([detailed({ expense_id: "dup", event_id: "e1" }), detailed({ expense_id: "dup", event_id: "e2" })]);
    expect(planPosting(DEFAULT_PWT_CONFIG, t, EMPTY).rows[0].total).toBe(140);
  });
});

describe("Tally XML", () => {
  it("builds a balanced voucher with Tally sign conventions and escapes", async () => {
    const t = await txns([detailed({ employee_name: "A & B <x>" })]);
    const r = planPosting(DEFAULT_PWT_CONFIG, t, EMPTY);
    const xml = vouchersImportXml("PesoWise Integration Demo", r.vouchers);
    expect(xml).toContain("<SVCURRENTCOMPANY>PesoWise Integration Demo</SVCURRENTCOMPANY>");
    expect(xml).toContain("<DATE>20260831</DATE>");
    expect(xml).toContain("<AMOUNT>-140.00</AMOUNT>");
    expect(xml).toContain("<AMOUNT>140.00</AMOUNT>");
    expect(xml).toContain("A &amp; B &lt;x&gt;-1001");
    expect(xml).toContain("<NARRATION>PWT PESO/08/01</NARRATION>");
  });

  it("creates only masters it is told to", () => {
    const xml = mastersImportXml("Co", DEFAULT_PWT_CONFIG, [{ name: "Test Person-1001", kind: "employee" }]);
    expect(xml).toContain('ACTION="Create"');
    expect(xml).toContain("<PARENT>Sundry Debtors</PARENT>");
  });

  it("parses import responses fail-closed", () => {
    expect(parseImportResponse("<RESPONSE><CREATED>2</CREATED><ALTERED>0</ALTERED><ERRORS>0</ERRORS></RESPONSE>").ok).toBe(true);
    expect(parseImportResponse("<RESPONSE><CREATED>1</CREATED><ALTERED>0</ALTERED><ERRORS>1</ERRORS></RESPONSE>").ok).toBe(false);
    expect(parseImportResponse("<RESPONSE><LINEERROR>Ledger &apos;X&apos; does not exist</LINEERROR></RESPONSE>").ok).toBe(false);
    expect(parseImportResponse("").ok).toBe(false);
    expect(parseImportResponse("<RESPONSE><CREATED>1</CREATED><CREATED>1</CREATED><ALTERED>0</ALTERED><ERRORS>0</ERRORS></RESPONSE>").ok).toBe(false);
  });

  it("verifies the active company from the response", () => {
    expect(activeCompanyRequest()).toContain("$$CurrentCompany");
    expect(parseActiveCompany("<ENVELOPE><COMPANY NAME=\"A\"><PWTCURCO TYPE=\"String\">PesoWise Integration Demo</PWTCURCO></COMPANY></ENVELOPE>")).toBe("PesoWise Integration Demo");
    expect(parseActiveCompany("<ENVELOPE/>")).toBeNull();
  });
});

describe("readback + reconciliation gate", () => {
  const xmlFor = (num: string, dr: number, cr: number) =>
    `<VOUCHER><DATE>20260831</DATE><VOUCHERNUMBER>${num}</VOUCHERNUMBER><NARRATION>PWT ${num}</NARRATION>` +
    `<ALLLEDGERENTRIES.LIST><AMOUNT>-${dr}</AMOUNT></ALLLEDGERENTRIES.LIST>` +
    `<ALLLEDGERENTRIES.LIST><AMOUNT>${cr}</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER>`;

  it("passes only when every planned voucher is read back with the right total", async () => {
    const r = planPosting(DEFAULT_PWT_CONFIG, await txns([detailed()]), EMPTY);
    expect(reconcile(r.vouchers, parseVoucherReadback(xmlFor("PESO/08/01", 140, 140))).ok).toBe(true);
    expect(reconcile(r.vouchers, []).missing).toEqual(["PESO/08/01"]);
    expect(reconcile(r.vouchers, parseVoucherReadback(xmlFor("PESO/08/01", 100, 100))).mismatched).toEqual(["PESO/08/01"]);
    expect(reconcile(r.vouchers, parseVoucherReadback(xmlFor("PESO/08/01", 140, 130))).unbalanced).toEqual(["PESO/08/01"]);
  });
});

import { withNaRule } from "../index.ts";
import { buildJobPlan, buildJobPlanFromNormalized, mergeNormalized, normalizeRows, FIVE_COLUMNS, REPORT_COLUMNS, viewFlat, formatIndian, planView } from "../index.ts";

describe("planning in chunks gives exactly the one-shot plan", () => {
  const rows = Array.from({ length: 25 }, (_, i) => detailed({ expense_id: "e" + i, event_id: "ev" + i, debit: 10 + i, employee_code: String(1000 + (i % 4)), employee_name: "Emp " + (i % 4) }));
  const cfg = { ...DEFAULT_PWT_CONFIG };
  const base = { organizationId: ORG, jobId: "job-1", company: "Co", cfg, state: { postedSourceIds: new Set<string>(), voucherCounts: {} }, revision: 1760000000 };

  it("normalising 7 rows at a time and merging, then planning, equals planning the whole report at once", async () => {
    const whole = await buildJobPlan({ ...base, report: "detailed_expense", rows });
    const parts = [];
    for (let i = 0; i < rows.length; i += 7) parts.push(await normalizeRows(ORG, "detailed_expense", rows.slice(i, i + 7), cfg));
    const chunked = await buildJobPlanFromNormalized({ ...base, report: "detailed_expense" }, mergeNormalized(parts));
    expect(chunked).toEqual(whole);
    expect(chunked.summary.row_count).toBe(25);
  });
  it("the same holds for a display-only report and for rows that cannot be read", async () => {
    const bad = [{ nothing: true }, ...rows.slice(0, 3)];
    const whole = await buildJobPlan({ ...base, report: "claim_verification", rows: bad });
    const parts = [await normalizeRows(ORG, "claim_verification", bad.slice(0, 2), cfg), await normalizeRows(ORG, "claim_verification", bad.slice(2), cfg)];
    expect(await buildJobPlanFromNormalized({ ...base, report: "claim_verification" }, mergeNormalized(parts))).toEqual(whole);
  });
});

describe("job planner", () => {
  const base = { organizationId: ORG, jobId: "job-1", company: "PesoWise Integration Demo", cfg: DEFAULT_PWT_CONFIG, state: EMPTY, revision: 1760000000 };

  it("detailed sync -> masters, report_rows, vouchers in strict order, with reservations", async () => {
    const plan = await buildJobPlan({ ...base, report: "detailed_expense", rows: [detailed({ expense_id: "a" }), detailed({ expense_id: "b", debit: 60 })] });
    expect(plan.batches.map((b) => [b.seq, b.kind])).toEqual([[1, "masters"], [2, "report_rows"], [3, "vouchers"]]);
    expect(plan.reservations).toHaveLength(2);
    // each reservation records the ledgers it hit, so a later deletion of that expense can be corrected in Tally exactly
    expect(plan.reservations[0]).toMatchObject({ employee_ledger: "Test Person-1001", expense_ledger: "Travelling Expenses", serial: 1, voucher_number: "PESO/08/01" });
    expect(plan.summary).toMatchObject({ row_count: 2, posted_count: 2, voucher_count: 1, blocking_count: 0 });
    expect(plan.batches[2].xml).toContain("<VOUCHERNUMBER>PESO/08/01</VOUCHERNUMBER>");
    expect(plan.vouchers["3"][0]).toMatchObject({ number: "PESO/08/01", total: 200 });
    // the report shows ONE aggregated row (2 source rows, same employee x ledger x date), not individual transactions
    expect(plan.rowRecords).toHaveLength(1);
    expect(plan.rowRecords[0].flat.split("|")).toEqual(["2026-08-31", "31-08-2026", "Travelling Expenses", "Test Person-1001", "PESO/08/01", "200.00", "200.00"]);
  });

  const cvRow = { id: "c1", status: "verified", total_amount: 10, category: "Food", employee_id: "1", user_name: "A", transaction_number: "T9", trip_start: "2026-08-03" };

  it("claim verification and daily project show five-column rows but never post", async () => {
    const cv = await buildJobPlan({ ...base, report: "claim_verification", rows: [cvRow] });
    expect(cv.batches.map((b) => b.kind)).toEqual(["report_rows"]);
    expect(cv.reservations).toEqual([]);
    expect(cv.rowRecords).toHaveLength(1);
    const dp = await buildJobPlan({ ...base, report: "daily_project", rows: [
      { track_date: "2026-08-01", user_id: "u1", project_id: "p1", voucher_no: "V1", employee_name: "A", employee_code: "7", costs: { petrol_cost: 12, hotel_exp: 100, other_exp: 5 } },
      { track_date: "2026-08-02", user_id: "u1", project_id: "p2", voucher_no: "V2", employee_name: "A", employee_code: "7", costs: { petrol_cost: 8 } },
    ] });
    expect(dp.batches.map((b) => b.kind)).toEqual(["report_rows"]);
    expect(dp.reservations).toEqual([]);
    // petrol 12+8 aggregates to one row; hotel is another; unmapped Other Exp. is reported, not guessed
    expect(dp.rowRecords.map((r) => r.flat.split("|").slice(2, 4).concat(r.flat.split("|")[6]).join("/")).sort()).toEqual(["Conveyance Expenses/A-7/20.00", "Lodging Expenses/A-7/100.00"]);
    expect(dp.summary.issues.some((i) => /other_exp/.test(i.detail) && !i.blocking)).toBe(true);
  });

  it("is idempotent for report rows: same content -> same ledger name; changed content -> new name, same key", async () => {
    const a = await buildJobPlan({ ...base, report: "claim_verification", rows: [cvRow] });
    const b = await buildJobPlan({ ...base, report: "claim_verification", rows: [cvRow], revision: 1760000999 });
    const c = await buildJobPlan({ ...base, report: "claim_verification", rows: [{ ...cvRow, total_amount: 11 }] });
    expect(b.rowRecords[0].name).toBe(a.rowRecords[0].name);
    expect(c.rowRecords[0].name).not.toBe(a.rowRecords[0].name);
    expect(c.rowRecords[0].key).toBe(a.rowRecords[0].key);
  });

  it("with report rows ON, every sync ends with a prune keep-list so a re-sync replaces the view exactly (even when empty)", async () => {
    const on = { ...DEFAULT_PWT_CONFIG, reportRowsInTally: true };
    const a = await buildJobPlan({ ...base, cfg: on, report: "claim_verification", rows: [cvRow] });
    const last = a.batches[a.batches.length - 1];
    expect(last.expected).toMatchObject({ prune: { prefix: "PWT-CV-", keep: [a.rowRecords[0].name] } });
    const empty = await buildJobPlan({ ...base, cfg: on, report: "claim_verification", rows: [] });
    expect(empty.batches).toHaveLength(1);
    expect(empty.batches[0].expected).toMatchObject({ prune: { prefix: "PWT-CV-", keep: [] } });
  });

  it("report rows are OFF by default: no report ledgers are written, only a prune-only batch that removes leftovers of that report", async () => {
    expect(DEFAULT_PWT_CONFIG.reportRowsInTally).toBe(false);
    const a = await buildJobPlan({ ...base, report: "claim_verification", rows: [cvRow] });
    expect(a.batches).toHaveLength(1);
    expect(a.batches[0].kind).toBe("report_rows");
    expect(a.batches[0].item_count).toBe(0);
    expect(a.batches[0].xml).not.toContain("<LEDGER");
    expect(a.batches[0].xml).not.toContain("PesoWise Report Data");
    expect(a.batches[0].expected).toEqual({ ledgers: [], prune: { prefix: "PWT-CV-", keep: [] } });
  });

  it("with report rows OFF a posting report still creates its vouchers, and no report ledgers", async () => {
    const plan = await buildJobPlan({ ...base, report: "detailed_expense", rows: [detailed({ expense_id: "a" }), detailed({ expense_id: "b", debit: 60 })] });
    expect(plan.batches.map((b) => b.kind)).toEqual(["masters", "report_rows", "vouchers"]);
    const rr = plan.batches.find((b) => b.kind === "report_rows")!;
    expect(rr.item_count).toBe(0);
    expect(plan.summary).toMatchObject({ posted_count: 2, voucher_count: 1, blocking_count: 0 });
    expect(plan.batches.find((b) => b.kind === "vouchers")!.xml).toContain("<VOUCHERNUMBER>PESO/08/01</VOUCHERNUMBER>");
    expect(plan.batches.find((b) => b.kind === "masters")!.xml).not.toContain("PWT-DE-");
  });

  it("batches large vouchers sets and keeps blocking issues visible", async () => {
    const rows = Array.from({ length: 95 }, (_, i) => detailed({ expense_id: `e${i}`, employee_code: String(2000 + i), employee_name: `N${i}`, category: Object.values(DEFAULT_PWT_CONFIG.categories)[i % 10].expenseType }));
    rows.push(detailed({ expense_id: "bad", category: "Parking" }));
    const plan = await buildJobPlan({ ...base, report: "detailed_expense", rows });
    expect(plan.summary.blocking_count).toBe(1);
    expect(plan.summary.issues[0].code).toBe("UNMAPPED_EXPENSE_TYPE");
    expect(plan.batches.filter((b) => b.kind === "vouchers").length).toBe(1); // 10 vouchers <= 40/batch
  });

  it("view totals equal source totals (nothing lost or double counted by aggregation)", async () => {
    const rows = Array.from({ length: 60 }, (_, i) => detailed({ expense_id: `e${i}`, employee_code: String(1 + (i % 7)), employee_name: `N${i % 7}`, debit: 10 + (i % 13) + 0.25, effective_date: `2026-08-${String(1 + (i % 28)).padStart(2, "0")}` }));
    const sum = rows.reduce((s, r) => s + (r.debit as number), 0);
    const plan = await buildJobPlan({ ...base, report: "detailed_expense", rows });
    const viewSum = plan.rowRecords.reduce((s, r) => s + Number(r.flat.split("|")[6]), 0);
    expect(Math.round(viewSum * 100)).toBe(Math.round(sum * 100));
    expect(plan.vouchers["3"].reduce((s, v) => s + v.total, 0)).toBeCloseTo(sum, 2);
  });
});

describe("five-column report format", () => {
  it("all four reports use exactly the workbook's five headings in order", () => {
    for (const r of ["daily_project", "detailed_expense", "claim_verification", "claim_approval"] as const) {
      expect([...REPORT_COLUMNS[r]]).toEqual(["Voucher Date (Tally)", "Expense Ledger", "Employe Ledger", "Voucher ID", "Total"]);
    }
    expect(FIVE_COLUMNS).toHaveLength(5);
  });
  it("formats Total with Indian grouping and 2 decimals; pipes cannot break the flat row", () => {
    expect(formatIndian(2207674.69)).toBe("22,07,674.69");
    expect(formatIndian(5238)).toBe("5,238.00");
    expect(formatIndian(0.5)).toBe("0.50");
    expect(viewFlat({ voucherDate: "2026-08-31", expenseLedger: "A|B", employeeLedger: "X", voucherId: "PESO/08/01", total: 12 }).split("|")).toHaveLength(7);
  });
  it("planView aggregates any origin without the registry or posting gate", async () => {
    const cv = (await normalizeRow(ORG, "claim_verification", { id: "z", status: "level_2_verified", total_amount: 5, category: "Food", employee_id: "9", user_name: "Q", trip_start: "2026-08-09" })).txn!;
    const v = planView(DEFAULT_PWT_CONFIG, [cv]);
    expect(v.rows).toHaveLength(1);
    expect(v.rows[0].voucherId).toBe("PESO/08/09");
  });
});
import { fetchReportRows, resolveDates } from "../index.ts";

describe("fetchReportRows", () => {
  const mk = (n: number, size: number, extra = {}) => async (name: string, args: Record<string, unknown>) => {
    if (name === "pwt_expense_meta_v1") return { data: {}, error: null };
    const start = args.p_cursor ? Number(args.p_cursor) : 0;
    const rows = Array.from({ length: Math.min(size, n - start) }, (_, i) => ({ id: `r${start + i}`, event_type: "expense_deduction", ...extra }));
    const next = start + rows.length;
    return { data: { rows, total_count: n, has_more: next < n, next_cursor: next < n ? String(next) : null }, error: null };
  };
  it("walks every page", async () => {
    const got: unknown[] = [];
    const n = await fetchReportRows({ rpc: mk(1234, 250), organizationId: "o", report: "claim_approval", parameters: {}, onRows: async (r) => { got.push(...r); } });
    expect(n).toBe(1234);
    expect(got).toHaveLength(1234);
  });
  it("fails when the page walk is short of the reported total", async () => {
    const rpc = async () => ({ data: { rows: [{ id: "a" }], total_count: 5, has_more: false, next_cursor: null }, error: null });
    await expect(fetchReportRows({ rpc, organizationId: "o", report: "claim_verification", parameters: {}, onRows: async () => {} })).rejects.toThrow(/Incomplete/);
  });
  it("surfaces RPC errors", async () => {
    const rpc = async () => ({ data: null, error: { message: "boom" } });
    await expect(fetchReportRows({ rpc, organizationId: "o", report: "detailed_expense", parameters: {}, onRows: async () => {} })).rejects.toThrow(/boom/);
  });
  it("resolves year/month/week like the Detailed Expense report", () => {
    expect(resolveDates({ year: "2026", month: "2" })).toEqual({ dateFrom: "2026-02-01", dateTo: "2026-02-28" });
    expect(resolveDates({ year: "2026" })).toEqual({ dateFrom: "2026-01-01", dateTo: "2026-12-31" });
    expect(resolveDates({ date_from: "2026-03-01" })).toEqual({ dateFrom: "2026-03-01", dateTo: null });
  });
});

import { ledgerNamesRequest, parseLedgerNames, pruneMasters, mastersEnvelope } from "../index.ts";

describe("master pruning (create only what is missing)", () => {
  it("drops already-existing ledgers and groups, keeps new ones", () => {
    const xml = mastersImportXml("Co", DEFAULT_PWT_CONFIG, [
      { name: "A-1", kind: "employee" }, { name: "B-2", kind: "employee" }, { name: "Travelling Expenses", kind: "expense" },
    ]);
    const out = pruneMasters(xml, new Set(["A-1", "Travelling Expenses"]));
    expect(out.kept).toEqual(["B-2"]);
    expect(out.skipped.sort()).toEqual(["A-1", "Travelling Expenses"]);
    expect(out.xml).toContain('NAME="B-2"');
    expect(out.xml).not.toContain('NAME="A-1"');
    expect(out.xml.startsWith("<ENVELOPE>")).toBe(true);
    expect(out.xml.endsWith("</ENVELOPE>")).toBe(true);
  });
  it("parses ledger/group names from exports and requests the right object type", () => {
    expect(ledgerNamesRequest("Co", "Group")).toContain("<TYPE>Group</TYPE>");
    const names = parseLedgerNames('<ENVELOPE><LEDGER NAME="X &amp; Y"><NAME>X &amp; Y</NAME></LEDGER><GROUP NAME="G"/></ENVELOPE>');
    expect(names.has("X & Y")).toBe(true);
    expect(names.has("G")).toBe(true);
    expect(mastersEnvelope("Co", "").includes("Co")).toBe(true);
  });
});

describe("ledger events that are not expenses", () => {
  it("opening-balance credits without an expense id are skipped, not reported as bad rows", async () => {
    const r = await normalizeRow(ORG, "detailed_expense", { event_type: "historical_opening_balance", credit: "1471.00", debit: null, expense_id: null, transaction_number: "", category: "", effective_date: "2026-09-24" });
    expect(r.skipped).toBeTruthy();
    expect(r.error).toBeUndefined();
  });
  it("a genuine expense without any identity is still an error", async () => {
    const r = await normalizeRow(ORG, "detailed_expense", { event_type: "expense_deduction", debit: 5, effective_date: "2026-09-01" });
    expect(r.error).toMatch(/neither/);
  });
});

describe("Other-category spelling variants", () => {
  it("map to the same Other ledger and serial as the main Other category", async () => {
    const rows = ["Other ( Xerox, Printing, Courier, Stationery & Medical )", "Other ( Xerox, Printing, Courier & Stationery )", "other"].map((c, i) => detailed({ expense_id: "o" + i, category: c, debit: 10 }));
    const r = planPosting(DEFAULT_PWT_CONFIG, await txns(rows), EMPTY);
    expect(r.issues).toEqual([]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ expenseLedger: "Site Expenses", voucherId: "PESO/08/03", total: 30 });
  });
  it("a blank category is treated as N/A and posted to Miscellaneous Expenses (Voucher ID .../99), never left out", async () => {
    const r = planPosting(DEFAULT_PWT_CONFIG, await txns([detailed({ expense_id: "b", category: "" })]), EMPTY);
    expect(r.issues).toEqual([]);
    expect(r.rows[0]).toMatchObject({ expenseLedger: "Miscellaneous Expenses", voucherId: "PESO/08/99" });
    expect(r.postings[0]).toMatchObject({ expenseLedger: "Miscellaneous Expenses", serial: 99 });
  });
  it("an organisation mapping saved before N/A existed gets the N/A rule added, and a rule it already has is respected", async () => {
    const old = { ...DEFAULT_PWT_CONFIG, categories: DEFAULT_PWT_CONFIG.categories.filter((c) => c.expenseType !== "N/A") };
    expect(old.categories.some((c) => c.expenseType === "N/A")).toBe(false);
    const withNa = withNaRule(old);
    expect(withNa.categories.at(-1)).toMatchObject({ expenseType: "N/A", serial: 99, expenseLedger: "Miscellaneous Expenses" });
    const r = planPosting(withNa, await txns([detailed({ expense_id: "b", category: "" }), detailed({ expense_id: "c", category: "n/a" })]), EMPTY);
    expect(r.issues).toEqual([]);
    expect(r.rows).toHaveLength(1);                                   // "", "N/A" and "n/a" all land in the same N/A voucher
    const own = withNaRule({ ...old, categories: [...old.categories, { serial: 50, expenseType: "N/A", expenseLedger: "My Misc" }] });
    expect(own.categories.filter((c) => c.expenseType === "N/A")).toHaveLength(1);
    expect(planPosting(own, await txns([detailed({ expense_id: "d", category: "" })]), EMPTY).rows[0].expenseLedger).toBe("My Misc");
  });
});
