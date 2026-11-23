/**
 * Phase 5.2 — one Sync to Tally click = one report_type job (isolation contract).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { buildTallySyncParameters } from "@/lib/tallySyncParameters";
import { TALLY_SYNC_REPORT_TYPES } from "@/lib/tallyReportTypes";

const cwd = process.cwd();
const panel = readFileSync(resolve(cwd, "src/components/ServerReportExportPanel.tsx"), "utf-8");
const jobs = readFileSync(resolve(cwd, "src/lib/tallySyncJobs.ts"), "utf-8");
const startFn = readFileSync(resolve(cwd, "supabase/functions/start-tally-sync/index.ts"), "utf-8");
const workerFn = readFileSync(resolve(cwd, "supabase/functions/run-tally-sync-job/index.ts"), "utf-8");
const phase2Sql = readFileSync(
  resolve(cwd, "supabase/migrations/20261005160000_tally_sync_jobs_phase2.sql"),
  "utf-8",
);

describe("Phase 5.2 — one job per report_type (client API)", () => {
  it("startTallySync sends a single report_type per request", () => {
    expect(jobs).toMatch(/report_type:\s*input\.reportType/);
    expect(jobs).not.toMatch(/report_types|reportTypes|TALLY_SYNC_REPORT_TYPES\.map/);
  });

  it("start-tally-sync creates exactly one job via RPC per HTTP request", () => {
    const rpcCalls = startFn.match(/\.rpc\(\s*"create_tally_sync_job_v1"/g) ?? [];
    expect(rpcCalls.length).toBe(1);
    expect(startFn).toContain("p_report_type: reportType");
    expect(startFn).not.toContain("for (const");
    expect(startFn).not.toContain("TALLY_SYNC_REPORT_TYPES");
  });
});

describe("Phase 5.2 — worker routes one report_type per job", () => {
  it("preparation switch is exclusive if/else on job.report_type", () => {
    expect(workerFn).toContain('const reportType = String(job.report_type)');
    expect(workerFn).toContain('reportType === "claim_verification" || reportType === "claim_approval"');
    expect(workerFn).toContain('reportType === "detailed_expense"');
    expect(workerFn).toContain('reportType === "daily_project_report"');
    expect(workerFn).not.toMatch(/for\s*\(\s*const\s+\w+\s+of\s+.*report/i);
  });

  it("claim paths set payload.report_type from the job argument, not all types", () => {
    expect(workerFn).toMatch(/report_type:\s*reportType/);
  });
});

describe("Phase 5.2 — filter freeze & pagination boundary", () => {
  it.each(TALLY_SYNC_REPORT_TYPES)("parameters for %s omit preview pagination keys", (reportType) => {
    const p = buildTallySyncParameters({ reportType });
    expect(p).not.toHaveProperty("page");
    expect(p).not.toHaveProperty("page_size");
    expect(p).not.toHaveProperty("preview");
    expect(p).not.toHaveProperty("rows");
  });

  it("panel sync handler does not read preview page or column filters", () => {
    const fnStart = panel.indexOf("const syncToTally = async () =>");
    const fnEnd = panel.indexOf("const generate = async () =>");
    const block = panel.slice(fnStart, fnEnd);
    expect(block).not.toContain("previewPage");
    expect(block).not.toContain("columnFilters");
    expect(block).not.toContain("PREVIEW_PAGE_SIZE");
  });

  it("worker uses server RPC paging (EXPENSE_PAGE), not UI page size", () => {
    expect(workerFn).toContain("p_page_size: EXPENSE_PAGE");
    expect(workerFn).not.toContain("PREVIEW_PAGE_SIZE");
    expect(workerFn).not.toContain("page_size: 50");
  });
});

describe("Phase 5.2 — admin backend enforcement", () => {
  it("create_tally_sync_job_v1 requires tally_sync_admin_can_view_v1", () => {
    expect(phase2Sql).toContain("tally_sync_admin_can_view_v1(p_organization_id)");
    expect(phase2Sql).toContain("'not permitted to create tally sync jobs' USING ERRCODE = '42501'");
  });

  it("start-tally-sync maps not permitted to HTTP 403", () => {
    expect(startFn).toContain('createErr.message.includes("not permitted")');
    expect(startFn).toContain("403");
  });
});

describe("Phase 5.2 — UI report label → report_type mapping (Reports.tsx)", () => {
  const reports = readFileSync(resolve(cwd, "src/pages/Reports.tsx"), "utf-8");

  const mappings: [string, string][] = [
    ["verification", "claim_verification"],
    ["approval", "claim_approval"],
    ["detailed", "detailed_expense"],
  ];

  it.each(mappings)("tab %s wires reportType %s", (tab, reportType) => {
    const start = reports.indexOf(`<TabsContent value="${tab}"`);
    const end = reports.indexOf("</TabsContent>", start);
    expect(reports.slice(start, end)).toContain(`reportType="${reportType}"`);
  });

  it("Daily Project panel omits reportType (defaults to daily_project_report in panel)", () => {
    const start = reports.indexOf('<TabsContent value="daily"');
    const end = reports.indexOf("</TabsContent>", start);
    const block = reports.slice(start, end);
    const panelStart = block.indexOf("<ServerReportExportPanel");
    const panelEnd = block.indexOf("/>", panelStart);
    expect(block.slice(panelStart, panelEnd)).not.toContain("reportType=");
    expect(panel).toContain('return "daily_project_report"');
  });
});
