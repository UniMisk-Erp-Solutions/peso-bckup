/**
 * MicroLink report incident (2026-09-24): every Detailed Expense CSV written by
 * the worker was the Daily Project header line plus blank rows, because a
 * module-local toCsv(rows) shadowed the imported toCsv(headers, rows). Rows and
 * preview were right; the downloadable file was unusable. These tests pin the
 * fix, the integrity guard, and the queue/history additions made with it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  assertCsvMatchesRows,
  buildDetailedRows,
  toCsv,
  type BalanceTimelineRow,
} from "../../../supabase/functions/run-report-export-job/expenseReports";

const read = (rel: string) =>
  readFileSync(resolve(__dirname, "../../..", rel), "utf-8").split("\r\n").join("\n");
const worker = read("supabase/functions/run-report-export-job/index.ts");
const migration = read("supabase/migrations/20261001000000_report_export_queue_v2.sql");
const client = read("src/lib/reportExportJobs.ts");

function timelineRow(i: number): BalanceTimelineRow {
  return {
    event_type: "expense_deduction",
    event_label: "Expense Deduction",
    employee_name: `Employee ${i}`,
    employee_code: String(i).padStart(4, "0"),
    effective_date: "2026-08-01",
    transaction_number: String(i).padStart(5, "0"),
    title: `Trip ${i}`,
    category: "Travelling",
    purpose: "line1\nline2",
    destination: "Halol",
    batch_ref: "",
    credit: null,
    debit: 100 + i,
    note: "",
    opening_balance: 0,
    closing_balance: -(100 + i),
    custom_fields: { "Project ID": "17466", "Project Name": "Polycab, Halol" },
  } as unknown as BalanceTimelineRow;
}

describe("worker: no local toCsv may shadow the imported shared toCsv", () => {
  it("imports toCsv from ./expenseReports.ts", () => {
    expect(worker).toMatch(/import \{[^}]*\btoCsv\b[^}]*\} from "\.\/expenseReports\.ts"/);
  });

  it("declares NO module-local function/const/let named toCsv (the incident's exact cause)", () => {
    expect(worker).not.toMatch(/^\s*(?:export\s+)?(?:async\s+)?function\s+toCsv\b/m);
    expect(worker).not.toMatch(/^\s*(?:const|let|var)\s+toCsv\b/m);
  });

  it("keeps the Daily Project builder under its own distinct name and still uses it for that report", () => {
    expect(worker).toContain("function toDailyProjectCsv(");
    expect(worker).toContain("const body = toDailyProjectCsv(rows);");
  });

  it("runs the integrity guard between building the Detailed Expense CSV and uploading it", () => {
    const build = worker.indexOf("const csv = toCsv(headers, builtRows);");
    const guard = worker.indexOf("assertCsvMatchesRows(csv, headers, builtRows.length);");
    const ret = worker.indexOf("csv,\n    rowCount: builtRows.length", guard);
    expect(build).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(build);
    expect(ret).toBeGreaterThan(guard);
  });
});

describe("Detailed Expense CSV body is built from the rows (behavioural)", () => {
  it("produces the report's own header line and one data line per row, not the Daily Project layout", () => {
    const rows = Array.from({ length: 50 }, (_, i) => timelineRow(i));
    const { headers, rows: built } = buildDetailedRows(rows);
    const csv = toCsv(headers, built);
    expect(csv.startsWith("﻿Employee,Employee ID,Date,Transaction #")).toBe(true);
    expect(csv).not.toContain("Track Date");
    expect(csv).toContain("Employee 7");
    expect(() => assertCsvMatchesRows(csv, headers, built.length)).not.toThrow();
    expect(csv.split("\r\n").filter(Boolean).length - 1).toBeGreaterThanOrEqual(50);
  });

  it("scales: 9,000 rows (MicroLink August size) round-trips through the guard with a real file body", () => {
    const rows = Array.from({ length: 9000 }, (_, i) => timelineRow(i));
    const { headers, rows: built } = buildDetailedRows(rows);
    const csv = toCsv(headers, built);
    expect(built.length).toBe(9000);
    expect(new TextEncoder().encode(csv).byteLength).toBeGreaterThan(1_000_000);
    expect(() => assertCsvMatchesRows(csv, headers, built.length)).not.toThrow();
  });
});

describe("assertCsvMatchesRows refuses the incident's file shapes", () => {
  const headers = ["Employee", "Employee ID", "Date"];

  it("rejects a header-only file when rows were counted (the 748-byte MicroLink file)", () => {
    const headerOnly = toCsv(headers, []);
    expect(() => assertCsvMatchesRows(headerOnly, headers, 8706)).toThrow(/integrity/i);
  });

  it("rejects another report's header line even if it is long enough", () => {
    const wrong = "﻿Track Date,Voucher No,project id\r\n,,\r\n,,\r\n";
    expect(() => assertCsvMatchesRows(wrong, headers, 2)).toThrow(/header mismatch/i);
  });

  it("accepts a genuinely empty report (0 rows, correct header)", () => {
    expect(() => assertCsvMatchesRows(toCsv(headers, []), headers, 0)).not.toThrow();
  });
});

describe("targeted worker nudge (client + worker)", () => {
  it("triggerExportWorker(jobId) sends { job_id } and falls back to {} for the global drain", () => {
    const start = client.indexOf("export async function triggerExportWorker(");
    const body = client.slice(start, client.indexOf("\n}\n", start));
    expect(body).toContain("jobId?: string");
    expect(body).toContain("{ job_id: jobId }");
    expect(body).toContain(": {}");
  });

  it("worker validates the job id shape and uses claim_report_export_job_v2 only when one is supplied", () => {
    expect(worker).toContain("[0-9a-fA-F-]{36}");
    expect(worker).toContain('svc.rpc("claim_report_export_job_v2"');
    expect(worker).toContain('svc.rpc("claim_report_export_job_v1"');
    expect(worker).toContain('requestedJobId\n    ? await svc.rpc("claim_report_export_job_v2"');
  });
});

describe("migration 20261001000000_report_export_queue_v2", () => {
  it("claim v2 locks the row, skips locked rows, honours cancellation and the per-org cap", () => {
    expect(migration).toContain("FOR UPDATE SKIP LOCKED");
    expect(migration).toContain("cancel_requested_at IS NULL");
    expect(migration).toContain("< GREATEST(COALESCE(p_max_per_org, 1), 1)");
    expect(migration).toContain("j.id = p_job_id");
    expect(migration).toContain("j.status = 'queued'");
  });

  it("claim v2 is service_role only", () => {
    expect(migration).toContain("REVOKE ALL ON FUNCTION public.claim_report_export_job_v2(text, uuid, integer) FROM PUBLIC;");
    expect(migration).toContain("REVOKE ALL ON FUNCTION public.claim_report_export_job_v2(text, uuid, integer) FROM anon;");
    expect(migration).toContain("REVOKE ALL ON FUNCTION public.claim_report_export_job_v2(text, uuid, integer) FROM authenticated;");
    expect(migration).toContain("GRANT EXECUTE ON FUNCTION public.claim_report_export_job_v2(text, uuid, integer) TO service_role;");
  });

  it("history v4 lists every lifecycle state and only exposes the sanitised error for failed jobs", () => {
    const v4 = migration.slice(migration.indexOf("CREATE OR REPLACE FUNCTION public.list_report_export_jobs_v4("));
    expect(v4).not.toContain("AND status = 'completed'");
    expect(v4).toContain("CASE WHEN j.status = 'failed' THEN j.error_message_safe ELSE NULL END");
    expect(v4).toContain("'stale'");
    expect(v4).toContain("daily_report_caller_can_view_v1(p_organization_id, false)");
    expect(v4).toContain("REVOKE ALL ON FUNCTION public.list_report_export_jobs_v4(uuid, text, integer, integer) FROM anon;");
  });

  it("touches no financial table", () => {
    for (const t of ["INSERT INTO public.expenses", "UPDATE public.profiles", "balance_ledger", "expense_balance_deductions", "cash_transfer_history"]) {
      expect(migration).not.toContain(t);
    }
  });
});

describe("client retry contract", () => {
  it("retryReportExportJob re-enqueues with the job's own frozen parameters as a NEW job", () => {
    const start = client.indexOf("export async function retryReportExportJob(");
    const body = client.slice(start, client.indexOf("\n}\n", start));
    expect(body).toContain("p_filters: params");
    expect(body).toContain("create_expense_report_export_job_v1");
  });
});
