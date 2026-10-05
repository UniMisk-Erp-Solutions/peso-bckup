/**
 * Report export worker (supabase/functions/run-report-export-job/) --
 * source contract tests.
 *
 * Deno was not available in this environment (`deno check` could not be
 * run), so these are structural guards on the actual worker source proving
 * the fail-closed pagination invariant, the RFC 4180 CSV escaping, the
 * distinct Verification/Approval balance-walk algorithms, and the
 * heartbeat/deadline handling this integration's design depends on --
 * matching the codebase's existing convention for testing files no local
 * runtime can execute.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const cwd = process.cwd();

function read(relativePath: string): string {
  return readFileSync(resolve(cwd, relativePath), "utf-8").replace(/\r\n/g, "\n");
}

const index = read("supabase/functions/run-report-export-job/index.ts");
const expenseReports = read("supabase/functions/run-report-export-job/expenseReports.ts");

describe("worker index.ts", () => {
  it("authorizes itself with the service-role key or a valid user token, matching every other function in this codebase", () => {
    expect(index).toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(index).toContain("svc.auth.getUser(token)");
    expect(index).toContain('return jsonResponse({ error: "Unauthorized" }, 401)');
  });

  it("reads report data via the service-role client, never a user session", () => {
    expect(index).toContain("function serviceClient()");
    expect(index).toContain("createClient<any>(url, key, { auth: { persistSession: false } })");
  });

  it("claims at most one job per organization per invocation via claim_report_export_job_v1", () => {
    expect(index).toContain('svc.rpc("claim_report_export_job_v1"');
    expect(index).toContain("p_max_per_org: 1");
  });

  it("an empty queue is not an error -- claimed:false returns HTTP 200", () => {
    expect(index).toContain("if (!claim?.claimed) return jsonResponse({ claimed: false }, 200)");
  });

  it("Daily Project Report pagination is bounded by a soft deadline, not an unbounded loop", () => {
    expect(index).toContain("const SOFT_DEADLINE_MS = 50_000");
    expect(index).toContain("Date.now() - startedAt > SOFT_DEADLINE_MS");
    expect(index).toContain("throw new Error(REPORT_TOO_LARGE_MESSAGE)");
    // A deadline failure must never be retried: the same input would time out again.
    expect(index).toContain("p_retryable: message !== REPORT_TOO_LARGE_MESSAGE");
  });

  it("validates the report contract version every page instead of guessing at an unknown shape", () => {
    expect(index).toContain("Number(p.schema_version) !== DAILY_REPORT_SCHEMA_VERSION");
    expect(index).toContain("is not supported by this worker");
  });

  it("Daily Project Report never completes with a row-count mismatch against the server-reported total -- fail-closed", () => {
    const start = index.indexOf("// Same invariant the browser coordinator enforces");
    expect(start).toBeGreaterThan(-1);
    const block = index.slice(start, start + 300);
    expect(block).toContain("if (total != null && groups.length !== total)");
    expect(block).toContain("throw new Error(`Incomplete:");
  });

  it("the three expense reports also never complete with a row-count mismatch -- same fail-closed invariant", () => {
    expect(index).toContain("if (total != null && rows.length !== total)");
  });

  it("heartbeats once per page, not once per row", () => {
    const dailyLoopStart = index.indexOf("for (;;) {", index.indexOf("try {\n    const groups: Group[] = []"));
    const loopEnd = index.indexOf("if (!p.has_more", dailyLoopStart);
    const loopBody = index.slice(dailyLoopStart, loopEnd);
    expect(loopBody).toContain('svc.rpc("report_daily_project_rows_v1"');
    expect(loopBody).toContain('svc.rpc("report_export_job_heartbeat_v1"');
  });

  it("uploads with the bare 'text/csv' content-type (the documented Storage mime-type fix), never a charset suffix", () => {
    const uploads = [...index.matchAll(/contentType:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(uploads.length).toBeGreaterThan(0);
    for (const ct of uploads) expect(ct).toBe("text/csv");
  });

  it("a failed job is reported through fail_report_export_job_v1 as retryable, never silently swallowed", () => {
    expect(index).toContain('p_error_code: "worker_error"');
    // Retryable unless the report is too large for one invocation (retrying would time out again).
    expect(index).toContain("p_retryable: message !== REPORT_TOO_LARGE_MESSAGE");
  });

  it("truncates the error message before writing it, matching the 500-char column limit enforced in SQL", () => {
    expect(index).toContain("message.slice(0, 300)");
  });

  it("storage path is {orgId}/{jobId}/{filename} for every report type -- unique per job, no collision risk", () => {
    const paths = [...index.matchAll(/const storagePath = `([^`]+)`/g)].map((m) => m[1]);
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) expect(p).toBe("${orgId}/${jobId}/${filename}");
  });

  describe("Remarks", () => {
    it("Group carries a remarks: string[] field", () => {
      const start = index.indexOf("type Group = {");
      const body = index.slice(start, index.indexOf("};", start));
      expect(body).toContain("remarks: string[];");
    });

    it("toGroup reads source_expenses[].purpose, not any other field, preserving RPC order and keeping duplicates", () => {
      const start = index.indexOf("function toGroup(");
      const body = index.slice(start, index.indexOf("\n}\n", start));
      expect(body).toContain("row.source_expenses");
      expect(body).toContain('String(src?.purpose ?? "").trim()');
      // Only a blank-string filter -- no .sort(), no Set()/dedupe.
      expect(body).toContain('.filter((p) => p !== "")');
      expect(body).not.toMatch(/remarks[\s\S]{0,80}\.sort\(/);
      expect(body).not.toMatch(/remarks[\s\S]{0,80}new Set\(/);
    });

    it("finalize writes the Remarks cell as a comma-space join of the group's remarks", () => {
      const start = index.indexOf("function finalize(");
      const body = index.slice(start, index.indexOf("\n}\n", start));
      expect(body).toContain('row["Remarks"] = g.remarks.join(", ");');
    });

    it("Remarks is assigned before HEADERS iteration would already have blanked it, so it survives to the CSV", () => {
      const start = index.indexOf("function finalize(");
      const body = index.slice(start, index.indexOf("\n}\n", start));
      const headerBlankIdx = body.indexOf('for (const h of HEADERS) row[h] = "";');
      const remarksIdx = body.indexOf('row["Remarks"] = g.remarks.join(", ");');
      expect(headerBlankIdx).toBeGreaterThan(-1);
      expect(remarksIdx).toBeGreaterThan(headerBlankIdx);
    });
  });
});

describe("worker expenseReports.ts", () => {
  it("pages report_expense_rows_v1 with a bounded page size and stops on the server's has_more/next_cursor contract", () => {
    expect(expenseReports).toContain('svc.rpc("report_expense_rows_v1"');
    expect(expenseReports).toContain("const PAGE_SIZE = 250");
    expect(expenseReports).toContain("if (!p.has_more || !p.next_cursor) break;");
  });

  it("fetchAllExpenseRows respects the worker's soft deadline mid-pagination", () => {
    const start = expenseReports.indexOf("export async function fetchAllExpenseRows(");
    const body = expenseReports.slice(start, expenseReports.indexOf("\n}\n", start));
    expect(body).toContain("if (deadline?.()) throw new Error(REPORT_TOO_LARGE_MESSAGE);");
  });

  it("Claim Verification and Claim Approval use genuinely different balance-walk algorithms, not the same function with a flag", () => {
    expect(expenseReports).toContain("export function balancesForVerification(");
    expect(expenseReports).toContain("export function balancesForApproval(");
    const verBody = expenseReports.slice(
      expenseReports.indexOf("export function balancesForVerification("),
      expenseReports.indexOf("export function balancesForApproval("),
    );
    const apprBody = expenseReports.slice(
      expenseReports.indexOf("export function balancesForApproval("),
      expenseReports.indexOf("function csvCell("),
    );
    // Verification walks FORWARD from balance+total; Approval walks BACKWARD from balance alone.
    expect(verBody).toContain("num(sorted[0]?.user_balance) + total");
    expect(apprBody).toContain("for (let i = sorted.length - 1; i >= 0; i--)");
    expect(apprBody).not.toContain("+ total");
  });

  // The two assertions that used to live here asserted the OLD Detailed
  // Expense architecture -- a backward walk from rows[0].user_balance, and an
  // "All employees" mode that degraded to a flat Debit-only list. Both were
  // the defect, not the contract: they predated Additive Credit V3 and could
  // not represent V3 credits, negative additive entries or opening credits.
  // They are replaced by the guards below, plus the behavioural suite in
  // detailedExpenseCanonicalLedger.test.ts.
  it("Detailed Expense computes NO balance in TypeScript -- the old backward walk is gone", () => {
    const start = expenseReports.indexOf("export function buildDetailedRows(");
    const body = expenseReports.slice(start);
    expect(body).not.toContain("let running = closingBalance;");
    expect(body).not.toContain(".reverse()");
    // No arithmetic on balances at all: the server already did it.
    expect(body).not.toMatch(/running\s*[-+]/);
  });

  it("Detailed Expense reads the V4 row producer (every approved expense, not only modern-deduction ones); V3 is kept for any other caller, not dropped", () => {
    expect(expenseReports).toContain('rpcName: "report_balance_timeline_rows_v3" | "report_detailed_expense_rows_v4"');
    expect(expenseReports).toContain("export async function fetchAllBalanceTimelineRows(");
    expect(expenseReports).toContain("export async function fetchAllDetailedExpenseRowsV4(");
    expect(index).toContain("fetchAllDetailedExpenseRowsV4(");
    // The retired second accounting source must be gone from this worker.
    expect(expenseReports).not.toContain("report_expense_allocations_v1");
    expect(expenseReports).not.toContain("AllocationRow");
    expect(index).not.toContain("report_expense_allocations_v1");
  });

  it('"All employees" and a selected employee are ONE format -- Employee/Employee ID always present, balance columns never dropped (DOC-131)', () => {
    const start = expenseReports.indexOf("export function buildDetailedRows(");
    // Bounded to buildDetailedRows's own body -- NOT the rest of the file,
    // which (as of the owner QA fix pass) legitimately declares its own,
    // unrelated `singleUserId` parameter on buildDetailedExpenseFilename.
    const body = expenseReports.slice(start, expenseReports.indexOf("\n}\n", start));
    // No conditional identity-column logic left at all -- the whole point of
    // the fix is that there is no branch to have wrong in the first place.
    expect(body).not.toMatch(/singleUserId\s*\?\s*\[\]/);
    expect(body).not.toContain("singleUserId");
    expect(body).toContain('"Employee"');
    expect(body).toContain('"Employee ID"');
    expect(body).toContain('"Opening Balance"');
    expect(body).toContain('"Closing Balance"');
    // Exactly ONE header list, shared by both shapes -- selecting an employee
    // only ever changes which rows are fetched, never the schema.
    expect(body.match(/const headers = \[/g) ?? []).toHaveLength(1);
  });

  it("Credit/Debit are decided by the sign carried from the server, never by event type", () => {
    const start = expenseReports.indexOf("export function buildDetailedRows(");
    const body = expenseReports.slice(start);
    expect(body).toContain('"Credit": money(r.credit)');
    expect(body).toContain('"Debit": money(r.debit)');
    expect(body).not.toMatch(/kind === "credit"/);
  });

  it("the on-page preview is stored from the SAME computed row objects the CSV is built from, not a second derivation", () => {
    expect(index).toContain("buildDetailedRows(filteredRows)");
    expect(index).toContain("storeDetailedExpensePreview(svc, jobId, headers, builtRows)");
    expect(index).toContain("toCsv(headers, builtRows)");
    // Only one call site fetches the timeline rows for this report type --
    // the preview is stored from what that single fetch already produced,
    // never a second independent query.
    const fetchCallCount = (index.match(/fetchAllDetailedExpenseRowsV4\(/g) ?? []).length;
    expect(fetchCallCount).toBe(1);
  });

  it("Detailed Expense refuses to write a partial ledger", () => {
    const start = index.indexOf("async function buildDetailedExpenseReport(");
    expect(start).toBeGreaterThan(-1);
    const body = index.slice(start, index.indexOf("\n}\n", start));
    expect(body).toContain("if (total != null && rows.length !== total)");
    expect(body).toContain("Incomplete: expected");
  });

  it("Detailed Expense is routed to its own builder; the claim reports keep theirs", () => {
    expect(index).toContain('reportType === "detailed_expense"');
    expect(index).toContain("await buildDetailedExpenseReport(svc,");
    expect(index).toContain("await buildExpenseReport(svc,");
  });

  it("CSV escaping is RFC 4180 -- quotes, commas and newlines are all escaped, and the file carries a UTF-8 BOM", () => {
    expect(expenseReports).toContain('/[",\\r\\n]/.test(s)');
    expect(expenseReports).toContain('s.replace(/"/g, \'""\')');
    expect(expenseReports).toMatch(/return\s+"\uFEFF"\s*\+/);
  });

  it("custom-field columns are the union of every row's fields, deterministically ordered", () => {
    expect(expenseReports).toContain("export function customKeys(");
    expect(expenseReports).toContain("[...keys].sort((a, b) => a.localeCompare(b))");
  });

  it("INR formatting matches the client formatter exactly, including the zero-fallback", () => {
    expect(expenseReports).toContain('currency: "INR"');
    expect(expenseReports).toContain('return Number.isFinite(n) ? INR.format(n) : "₹0.00";');
  });

  describe("Expense Type / custom-field filters and filename (owner QA fix pass, 2026-09-23)", () => {
    it("applies matchesDetailedExpenseFilters to the FULL fetched timeline, before buildDetailedRows -- never by asking the RPC for a partial event set", () => {
      const start = index.indexOf("async function buildDetailedExpenseReport(");
      const body = index.slice(start, index.indexOf("\n}\n", start));
      const filterIdx = body.indexOf("matchesDetailedExpenseFilters");
      const buildRowsIdx = body.indexOf("buildDetailedRows(filteredRows)");
      const incompleteCheckIdx = body.indexOf("if (total != null && rows.length !== total)");
      expect(filterIdx).toBeGreaterThan(-1);
      expect(buildRowsIdx).toBeGreaterThan(-1);
      // The incomplete-ledger guard runs against the ORIGINAL fetch, strictly
      // before any presentation filtering is applied.
      expect(incompleteCheckIdx).toBeLessThan(filterIdx);
      expect(filterIdx).toBeLessThan(buildRowsIdx);
    });

    it("preview and CSV are built from the SAME filtered row set -- never filtered independently", () => {
      const start = index.indexOf("async function buildDetailedExpenseReport(");
      const body = index.slice(start, index.indexOf("\n}\n", start));
      expect(body).toContain("buildDetailedRows(filteredRows)");
      expect(body).toContain("storeDetailedExpensePreview(svc, jobId, headers, builtRows)");
      expect(body).toContain("toCsv(headers, builtRows)");
    });

    it("resolves the employee's name/code from the already-fetched timeline rows first, falling back to a direct profiles lookup only when that employee has zero rows in range", () => {
      const start = index.indexOf("async function buildDetailedExpenseReport(");
      const body = index.slice(start, index.indexOf("\n}\n", start));
      expect(body).toContain('rows.find((r) => r.user_id === singleUserId)?.employee_name');
      expect(body).toContain('.from("profiles")');
      expect(body).toContain('.eq("user_id", singleUserId)');
      expect(body).toContain('.eq("organization_id", orgId)');
    });

    it("Detailed Expense uses the worker-computed filename (employee + actual date range); every other report type keeps its existing generic name", () => {
      const start = index.indexOf('const result = reportType === "detailed_expense"');
      const body = index.slice(start, start + 900);
      expect(body).toContain('"filename" in result && result.filename');
      expect(body).toContain("REPORT_FILENAMES[reportType]");
    });
  });

  describe("Detailed Expense V4 coverage (owner \"critical integrated fix pass\", 2026-09-23)", () => {
    it("carries modern_deduction_present through the row interface -- V4-only, absent from V3/non-expense rows", () => {
      expect(expenseReports).toContain("modern_deduction_present?: boolean;");
    });

    it("computes and returns a modern/legacy expense-row diagnostic split, proving the legacy population is genuinely included", () => {
      const start = index.indexOf("async function buildDetailedExpenseReport(");
      const body = index.slice(start, index.indexOf("\n}\n", start));
      expect(body).toContain('r.event_type === "expense_deduction"');
      expect(body).toContain("r.modern_deduction_present === true");
      expect(body).toContain("expenseRowCount: expenseTypeRows.length");
      expect(body).toContain("modernExpenseRowCount");
      expect(body).toContain("legacyExpenseRowCount");
    });

    it("surfaces the diagnostic split in the completion HTTP response for Detailed Expense only", () => {
      const start = index.indexOf('return jsonResponse({\n        claimed: true, job_id: jobId, status: "completed",');
      const body = index.slice(start, start + 600);
      expect(body).toContain('"expenseRowCount" in result');
      expect(body).toContain("expense_row_count: result.expenseRowCount");
      expect(body).toContain("modern_expense_row_count: result.modernExpenseRowCount");
      expect(body).toContain("legacy_expense_row_count: result.legacyExpenseRowCount");
    });
  });
});
