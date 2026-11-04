/**
 * Daily Project Report group-first paging — static contract (DOC-101 §10).
 *
 * The behavioural proof (identical rows/cursor chain vs the pre-fix Production body,
 * 11 filter/mapping scenarios, 10 isolation/determinism cases, timings up to 30,000
 * groups) runs on a throwaway Postgres: supabase/tests/daily_report_perf/. These checks
 * keep the migration's shape from regressing.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  REPORT_TIMEOUT_MESSAGE,
  toSafeReportError,
} from "../../../supabase/functions/run-report-export-job/expenseReports";

function read(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf-8").replace(/\r\n/g, "\n");
}

const sql = read("supabase/migrations/20261023100000_daily_project_report_group_first_v1.sql");
const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
const worker = read("supabase/functions/run-report-export-job/index.ts");

describe("20261023100000 daily project group-first migration", () => {
  it("replaces only report_daily_project_rows_v1 and keeps its signature", () => {
    expect(code.match(/CREATE OR REPLACE FUNCTION/g)?.length).toBe(1);
    expect(code).toMatch(
      /CREATE OR REPLACE FUNCTION public\.report_daily_project_rows_v1\(p_organization_id uuid, p_config jsonb, p_date_from date DEFAULT NULL::date, p_date_to date DEFAULT NULL::date, p_user_id uuid DEFAULT NULL::uuid, p_user_ids uuid\[\] DEFAULT NULL::uuid\[\], p_snapshot_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_cursor jsonb DEFAULT NULL::jsonb, p_page_size integer DEFAULT 250, p_with_total boolean DEFAULT NULL::boolean\)/,
    );
  });

  it("selects the page's (day, employee) buckets BEFORE any enrichment or aggregation", () => {
    const iAll = code.indexOf("all_f AS NOT MATERIALIZED");
    const iBuckets = code.indexOf("page_buckets AS");
    const iFiltered = code.indexOf("filtered AS");
    const iEnriched = code.indexOf("enriched AS");
    const iGrouped = code.indexOf("grouped AS");
    expect(iAll).toBeGreaterThan(-1);
    expect(iAll).toBeLessThan(iBuckets);
    expect(iBuckets).toBeLessThan(iFiltered);
    expect(iFiltered).toBeLessThan(iEnriched);
    expect(iEnriched).toBeLessThan(iGrouped);
    expect(code).toMatch(/LIMIT v_size \+ 1/);
  });

  it("enriches only the filtered (page) rows, never the full population", () => {
    const enriched = code.slice(code.indexOf("enriched AS"), code.indexOf("resolved AS"));
    expect(enriched).toMatch(/FROM filtered f/);
    expect(enriched).not.toMatch(/FROM all_f/);
  });

  it("computes whole-population totals without the enrichment pipeline", () => {
    expect(code).toMatch(/total_groups AS/);
    const tot = code.slice(code.indexOf("tot AS"), code.indexOf("SELECT jsonb_build_object(\n    'schema_version'"));
    expect(tot).toMatch(/FROM total_groups/);
    expect(tot).toMatch(/FROM all_f/);
    expect(tot).not.toMatch(/FROM grouped/);
    expect(code.slice(code.indexOf("total_groups AS"), code.indexOf("tot AS"))).toMatch(/WHERE v_total_req/);
  });

  it("keeps the scope filters, snapshot rule and approved-only rule exactly", () => {
    const allF = code.slice(code.indexOf("all_f AS"), code.indexOf("page_buckets AS"));
    for (const clause of [
      "e.organization_id = p_organization_id",
      "e.status = 'approved'",
      "e.created_at <= v_snapshot",
      "p_user_ids  IS NULL OR e.user_id = ANY (p_user_ids)",
    ]) {
      expect(allF).toContain(clause);
    }
  });

  it("does not touch timeouts, roles, indexes or other functions, and verifies service_role-only", () => {
    expect(code).not.toMatch(/statement_timeout/i);
    expect(code).not.toMatch(/ALTER (ROLE|DATABASE|SYSTEM)/i);
    expect(code).not.toMatch(/CREATE (UNIQUE )?INDEX/i);
    expect(code).not.toMatch(/GRANT /i);
    expect(code).toMatch(/must stay service_role-only/);
  });

  it("does not replace the custom-field helpers (Production's live versions are correct)", () => {
    expect(code).not.toMatch(/_report_expense_custom_fields_v1/);
    expect(code).not.toMatch(/_report_humanize_field_key_v1/);
  });
});

describe("Daily Project worker", () => {
  it("pages with a size the producer supports and stores friendly errors only", () => {
    expect(worker).toMatch(/const PAGE_SIZE = 500;/);
    expect(worker).toContain("const safe = toSafeReportError(message)");
    expect(worker).toContain("p_error_message_safe: safe.message");
  });

  it("maps a statement timeout to the friendly sentence", () => {
    const r = toSafeReportError("page 1: canceling statement due to statement timeout");
    expect(r.message).toBe(REPORT_TIMEOUT_MESSAGE);
    expect(r.message).not.toMatch(/canceling statement/i);
    expect(r.retryable).toBe(true);
  });

  it("is restart-safe: each attempt rebuilds from the frozen parameters and overwrites the same file", () => {
    expect(worker).toMatch(/upsert: true/);
    expect(worker).toMatch(/Incomplete: expected \$\{total\} rows, assembled \$\{groups\.length\}/);
  });
});
