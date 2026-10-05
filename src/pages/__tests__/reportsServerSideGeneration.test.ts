/**
 * src/pages/Reports.tsx -- server-side report generation wiring.
 *
 * Reports.tsx has no existing render-test harness (its real data pipeline
 * needs more Supabase query-builder mocking than this integration
 * warrants), so this proves the wiring contract by reading the actual
 * source directly -- the same pattern already used elsewhere in this
 * codebase for pages/migrations without one (see
 * EngineerReview.expenseTableDensity.test.ts, repair6546...test.ts).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const cwd = process.cwd();
const src = readFileSync(resolve(cwd, "src/pages/Reports.tsx"), "utf-8").replace(/\r\n/g, "\n");

function tabBlock(tabValue: string): string {
  const start = src.indexOf(`<TabsContent value="${tabValue}"`);
  expect(start, `tab "${tabValue}" not found`).toBeGreaterThan(-1);
  const end = src.indexOf("</TabsContent>", start);
  return src.slice(start, end);
}

describe("Reports.tsx imports ServerReportExportPanel", () => {
  it('imports it from "@/components/ServerReportExportPanel"', () => {
    expect(src).toContain('import { ServerReportExportPanel } from "@/components/ServerReportExportPanel";');
  });
});

describe("Claim Verification tab", () => {
  const block = tabBlock("verification");

  it("wires ServerReportExportPanel with reportType claim_verification", () => {
    expect(block).toContain('reportType="claim_verification"');
  });

  it("no longer triggers a client-side fetch/preview -- Submit and Export buttons for this tab are gone", () => {
    expect(block).not.toContain("verificationQuery.refetch()");
    expect(block).not.toContain('openExportDialog("verification")');
  });

  it("still offers Clear so the filter controls remain usable", () => {
    expect(block).toContain("onClick={clearFilters}");
  });

  it("still renders the Employee/Category/Manager-Approval filters the panel reads from", () => {
    expect(block).toContain("selectedEmployee");
    expect(block).toContain("selectedCategory");
    expect(block).toContain("engineerStatus");
  });
});

describe("Claim Approval tab", () => {
  const block = tabBlock("approval");

  it("wires ServerReportExportPanel with reportType claim_approval", () => {
    expect(block).toContain('reportType="claim_approval"');
  });

  it("no longer triggers a client-side fetch/preview", () => {
    expect(block).not.toContain("approvalQuery.refetch()");
    expect(block).not.toContain('openExportDialog("approval")');
  });
});

describe("Detailed Expense tab", () => {
  const block = tabBlock("detailed");

  it("wires ServerReportExportPanel with reportType detailed_expense", () => {
    expect(block).toContain('reportType="detailed_expense"');
  });

  it("no longer triggers a client-side fetch/preview, print, or export dialog", () => {
    expect(block).not.toContain("detailedQuery.refetch()");
    expect(block).not.toContain('openExportDialog("detailed")');
    expect(block).not.toContain("window.print()");
  });

  it("derives dateFrom/dateTo/custom-field-filters from the one canonical Detailed Expense filter model (owner QA fix pass) -- not an inline re-derivation", () => {
    expect(block).toContain("dateFrom={detailedExpenseDateRange.dateFrom}");
    expect(block).toContain("dateTo={detailedExpenseDateRange.dateTo}");
    expect(block).toContain("customFieldFilters={activeCustomFieldFilters(customFieldFilters)}");
    expect(block).toContain("selectedYear={selectedYear}");
    expect(block).toContain("selectedMonth={selectedMonth}");
    expect(block).toContain("selectedWeek={selectedWeek}");
  });
});

describe("Daily Project Report tab -- additive, not replacing", () => {
  const block = tabBlock("daily");

  it("keeps the existing client-side coordinator: dailyQuery, its Generate button and the source-expense drill-down are unchanged", () => {
    expect(block).toContain("dailyQuery.refetch()");
    expect(block).toContain("setDailyReportSourceOpen(true)");
  });

  it("adds ServerReportExportPanel alongside it as a background-generation option, with no reportType prop (daily is the default)", () => {
    expect(block).toContain("<ServerReportExportPanel");
    const panelStart = block.indexOf("<ServerReportExportPanel");
    const panelEnd = block.indexOf("/>", panelStart);
    const panelProps = block.slice(panelStart, panelEnd);
    expect(panelProps).not.toContain("reportType=");
  });
});

describe("disabled client-side queries", () => {
  it("verificationQuery, approvalQuery and detailedQuery are permanently disabled", () => {
    for (const name of ["verificationQuery", "approvalQuery", "detailedQuery"]) {
      const declStart = src.indexOf(`const ${name} = useQuery(`);
      expect(declStart, `${name} not found`).toBeGreaterThan(-1);
      const declEnd = src.indexOf("...QUERY_DEFAULTS,", declStart);
      expect(src.slice(declStart, declEnd)).toContain("enabled: false,");
    }
  });

  it("dailyQuery is NOT disabled -- it remains the live foreground experience", () => {
    const declStart = src.indexOf("const dailyQuery = useQuery(");
    const declEnd = src.indexOf("...QUERY_DEFAULTS,", declStart);
    const decl = src.slice(declStart, declEnd);
    expect(decl).not.toContain("enabled: false,");
    expect(decl).toContain('activeTab === "daily"');
  });

  it("never uses a bare `false &&` chain -- would trip no-constant-binary-expression", () => {
    expect(src).not.toMatch(/enabled:\s*\n?\s*false\s*&&/);
  });
});

describe("QUERY_DEFAULTS refetch-storm fix", () => {
  it("aligns with the app-wide QueryClient defaults instead of overriding them to the most aggressive settings available", () => {
    const start = src.indexOf("const QUERY_DEFAULTS = {");
    const end = src.indexOf("} as const;", start);
    const block = src.slice(start, end);
    expect(block).toContain("staleTime: 5 * 60 * 1000");
    expect(block).toContain("refetchOnMount: false");
    expect(block).toContain("refetchOnWindowFocus: false");
    expect(block).toContain("refetchOnReconnect: false");
    expect(block).not.toContain("staleTime: 0");
    expect(block).not.toContain('refetchOnMount: "always"');
  });

  it("keeps keepPreviousData so a refresh never blanks an already-rendered table", () => {
    const start = src.indexOf("const QUERY_DEFAULTS = {");
    const end = src.indexOf("} as const;", start);
    expect(src.slice(start, end)).toContain("placeholderData: keepPreviousData");
  });
});

describe("scope guards", () => {
  it("touches no mobile view component", () => {
    expect(src).not.toMatch(/MobileAdminExpensesView|MobileReviewQueueView|MobileReviewDetailView/);
  });

  it("still renders MobileDetailedExpenseReportView -- unrelated to this integration, left untouched", () => {
    expect(src).toContain("MobileDetailedExpenseReportView");
  });
});
