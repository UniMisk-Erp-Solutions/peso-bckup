/**
 * Report History parameter summary (list_report_export_jobs_v3) -- SQL
 * contract tests, owner QA fix pass, 2026-09-23.
 *
 * The migration cannot be executed locally (no Postgres in this
 * environment), so its shape is guarded on the authored source, matching the
 * convention used by detailedExpenseReportPreview.test.ts. Its runtime
 * behavior was separately proven against the shared self-hosted database.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const cwd = process.cwd();
const migration = readFileSync(
  resolve(cwd, "supabase/migrations/20260925000000_report_history_parameter_summary_v1.sql"),
  "utf-8",
).replace(/\r\n/g, "\n");

describe("list_report_export_jobs_v3", () => {
  it("is additive -- v1 and v2 are asserted to still exist, never dropped or replaced", () => {
    expect(migration).toContain("CREATE OR REPLACE FUNCTION public.list_report_export_jobs_v3(");
    expect(migration).toContain("list_report_export_jobs_v1(uuid, text, integer)");
    expect(migration).toContain("list_report_export_jobs_v2(uuid, text, integer, integer)");
    expect(migration).toContain("must not have been dropped");
  });

  it("uses the same authorization gate as v1/v2 -- no new, weaker permission model introduced", () => {
    expect(migration).toContain("daily_report_caller_can_view_v1(p_organization_id, false)");
  });

  it("returns parameters verbatim from the job row -- never re-derived, never defaulted to something else", () => {
    expect(migration).toContain("'parameters', COALESCE(j.parameters, '{}'::jsonb)");
  });

  it("resolves employee_display server-side from the job's OWN stored user_id -- never the raw uuid, never from anything the caller supplies", () => {
    expect(migration).toContain("NULLIF(j.parameters->>'user_id', '')");
    expect(migration).toContain("ep.user_id = NULLIF(j.parameters->>'user_id', '')::uuid");
    expect(migration).not.toContain("p_user_id");
  });

  it("employee_display is null (not \"Employee\" or an empty string) when the job has no user_id -- lets the caller render \"All employees\"", () => {
    expect(migration).toContain("WHEN NULLIF(j.parameters->>'user_id', '') IS NULL THEN NULL");
  });

  it("explicitly revokes anon and PUBLIC and grants only authenticated -- the DOC-130 default-privileges lesson applied proactively", () => {
    expect(migration).toContain(
      "REVOKE ALL ON FUNCTION public.list_report_export_jobs_v3(uuid, text, integer, integer) FROM PUBLIC;",
    );
    expect(migration).toContain(
      "REVOKE ALL ON FUNCTION public.list_report_export_jobs_v3(uuid, text, integer, integer) FROM anon;",
    );
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION public.list_report_export_jobs_v3(uuid, text, integer, integer) TO authenticated;",
    );
  });

  it("has a verification block that fails loudly (RAISE EXCEPTION) rather than silently if anon somehow has access", () => {
    expect(migration).toContain("has_function_privilege('anon'");
    expect(migration).toContain("RAISE EXCEPTION 'anon must not have EXECUTE on list_report_export_jobs_v3'");
  });

  it("clamps limit/offset the same way v2 does (no unbounded page size)", () => {
    expect(migration).toContain("LEAST(GREATEST(COALESCE(p_limit, 5), 1), 100)");
    expect(migration).toContain("GREATEST(COALESCE(p_offset, 0), 0)");
  });
});
