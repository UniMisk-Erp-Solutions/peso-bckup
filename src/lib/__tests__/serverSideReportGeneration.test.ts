/**
 * Server-side report generation -- SQL contract tests.
 *
 * These four migrations were never applied to any database in this session
 * (repo-only integration, no Production/backup access -- see
 * `Documentations MD/server-side-report-generation.md`). Reproducing real
 * Postgres execution is out of scope, so these are source guards proving the
 * authored SQL has the exact security/pagination/lifecycle shape this
 * integration requires: every worker-only function is service_role-locked
 * with no auth.uid() gate, every user-facing function verifies the actual
 * caller before touching the database, pagination is keyset/cursor-based
 * with a bounded page size, and a job can never reach `completed` without a
 * real stored file. Matches the existing convention for testing raw-SQL
 * migrations in this codebase (see
 * repair6546Level2RoutingAndAudit.test.ts).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const cwd = process.cwd();

function read(relativePath: string): string {
  return readFileSync(resolve(cwd, relativePath), "utf-8").replace(/\r\n/g, "\n");
}

const jobs = read("supabase/migrations/20260827150000_report_export_jobs.sql");
const dailyCore = read("supabase/migrations/20260827160000_daily_project_report_shared_core.sql");
const expenseReports = read("supabase/migrations/20260827170000_server_side_expense_reports.sql");
const history = read("supabase/migrations/20260827180000_report_export_history.sql");

describe("report_export_jobs table + lifecycle (part 1)", () => {
  it("allows exactly the four report types from creation -- no later ALTER needed", () => {
    expect(jobs).toContain(
      "CHECK (report_type IN (\n      'daily_project_report', 'claim_verification', 'claim_approval', 'detailed_expense'\n    ))",
    );
  });

  it("a completed job must always name a file", () => {
    expect(jobs).toContain("CHECK (status <> 'completed' OR filename IS NOT NULL)");
  });

  it("RLS is enabled and there is no INSERT/UPDATE/DELETE policy -- writes are function-only", () => {
    expect(jobs).toContain("ALTER TABLE public.report_export_jobs ENABLE ROW LEVEL SECURITY");
    expect(jobs).not.toMatch(/CREATE POLICY[^;]*FOR (INSERT|UPDATE|DELETE)/);
  });

  it("the SELECT policy reuses the existing report-permission gate, never invents a new one", () => {
    const policyStart = jobs.indexOf('CREATE POLICY "Report viewers can see');
    const policyEnd = jobs.indexOf(";", policyStart);
    const policy = jobs.slice(policyStart, policyEnd);
    expect(policy).toContain("public.daily_report_caller_can_view_v1(organization_id, false)");
  });

  it("claim/heartbeat/complete/fail/recover/expire are service_role-only with no auth.uid() gate", () => {
    for (const fn of [
      "claim_report_export_job_v1",
      "report_export_job_heartbeat_v1",
      "complete_report_export_job_v1",
      "fail_report_export_job_v1",
      "recover_stale_report_export_jobs_v1",
      "expire_report_export_files_v1",
    ]) {
      const defStart = jobs.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`);
      expect(defStart, `${fn} not found`).toBeGreaterThan(-1);
      const bodyEnd = jobs.indexOf("$$;", defStart);
      const body = jobs.slice(defStart, bodyEnd);
      expect(body, `${fn} must not gate on auth.uid()`).not.toContain("auth.uid()");

      const grantsBlock = jobs.slice(bodyEnd, jobs.indexOf("\n\n", bodyEnd + 400) + 1);
      expect(grantsBlock, `${fn} must be service_role-only`).toContain("TO service_role");
      expect(grantsBlock, `${fn} must revoke PUBLIC`).toContain("FROM PUBLIC");
      expect(grantsBlock, `${fn} must revoke authenticated`).toContain("FROM authenticated");
    }
  });

  it("claim uses FOR UPDATE SKIP LOCKED so two workers can never take the same job", () => {
    expect(jobs).toContain("FOR UPDATE SKIP LOCKED");
  });

  it("claim enforces a per-organization concurrency cap", () => {
    expect(jobs).toContain("GREATEST(COALESCE(p_max_per_org, 1), 1)");
  });

  it("complete refuses to publish a file without a real storage_path and filename", () => {
    const start = jobs.indexOf("CREATE OR REPLACE FUNCTION public.complete_report_export_job_v1(");
    const body = jobs.slice(start, jobs.indexOf("$$;", start));
    expect(body).toContain("p_storage_path IS NULL OR btrim(p_storage_path) = ''");
    expect(body).toContain("RAISE EXCEPTION 'a completed job requires a stored file'");
  });

  it("complete refuses to publish if cancellation landed mid-run", () => {
    const start = jobs.indexOf("CREATE OR REPLACE FUNCTION public.complete_report_export_job_v1(");
    const body = jobs.slice(start, jobs.indexOf("$$;", start));
    expect(body).toContain("AND cancel_requested_at IS NULL");
  });

  it("cancel is user-facing, gated on auth.uid() and the report-permission check", () => {
    const start = jobs.indexOf("CREATE OR REPLACE FUNCTION public.cancel_report_export_job_v1(");
    const body = jobs.slice(start, jobs.indexOf("$$;", start));
    expect(body).toContain("authentication required");
    expect(body).toContain(
      "v_job.requested_by = auth.uid()\n    OR public.daily_report_caller_can_view_v1",
    );
  });

  it("the generated-reports bucket is private with a bounded file size and CSV/XLSX only", () => {
    const bucketStart = jobs.indexOf("INSERT INTO storage.buckets");
    const bucketEnd = jobs.indexOf(";", bucketStart);
    const bucket = jobs.slice(bucketStart, bucketEnd);
    expect(bucket).toContain("'generated-reports'");
    expect(bucket).toMatch(/false,\s*-- PRIVATE/);
    expect(bucket).toContain("524288000");
    expect(bucket).toContain("text/csv");
  });

  it("storage read policy is scoped to the caller's own organization folder via the report-permission gate", () => {
    const policyStart = jobs.indexOf('CREATE POLICY "Report viewers can read');
    const policyEnd = jobs.indexOf(";", policyStart);
    const policy = jobs.slice(policyStart, policyEnd);
    expect(policy).toContain("bucket_id = 'generated-reports'");
    expect(policy).toContain("public.daily_report_caller_can_view_v1(");
    expect(policy).not.toMatch(/USING\s*\(\s*true\s*\)/);
  });

  it("never grants anon anything", () => {
    expect(jobs).not.toMatch(/GRANT[^;]*TO anon/);
  });
});

describe("Daily Project Report shared core (part 2) -- contract-preserving replacement", () => {
  it("report_daily_project_rows_v1 is service_role-only with no auth.uid() gate", () => {
    const start = dailyCore.indexOf("CREATE OR REPLACE FUNCTION public.report_daily_project_rows_v1(");
    const bodyEnd = dailyCore.indexOf("$$;", start);
    const body = dailyCore.slice(start, bodyEnd);
    expect(body).not.toContain("auth.uid()");
    const grants = dailyCore.slice(bodyEnd, dailyCore.indexOf("COMMENT ON FUNCTION", bodyEnd));
    expect(grants).toContain("TO service_role");
    expect(grants).toContain("FROM authenticated");
  });

  it("get_daily_project_report_page_v1's signature is unchanged from the version already on main -- same 9 parameters, same order", () => {
    const sigStart = dailyCore.indexOf("CREATE OR REPLACE FUNCTION public.get_daily_project_report_page_v1(");
    const sigEnd = dailyCore.indexOf(")\nRETURNS jsonb", sigStart);
    const sig = dailyCore.slice(sigStart, sigEnd);
    for (const param of [
      "p_organization_id uuid",
      "p_date_from       date        DEFAULT NULL",
      "p_date_to         date        DEFAULT NULL",
      "p_user_id         uuid        DEFAULT NULL",
      "p_user_ids        uuid[]      DEFAULT NULL",
      "p_team_scoped     boolean     DEFAULT false",
      "p_snapshot_at     timestamptz DEFAULT NULL",
      "p_cursor          jsonb       DEFAULT NULL",
      "p_page_size       integer     DEFAULT 250",
    ]) {
      expect(sig).toContain(param);
    }
  });

  it("Remarks: enriched carries f.purpose forward instead of dropping it, and source_expenses emits it", () => {
    const enrichedStart = dailyCore.indexOf("enriched AS (");
    const enrichedEnd = dailyCore.indexOf("resolved AS (", enrichedStart);
    const enrichedBlock = dailyCore.slice(enrichedStart, enrichedEnd);
    expect(enrichedBlock).toMatch(/SELECT f\.id, f\.user_id, f\.trip_start, f\.category, f\.total_amount, f\.title,\s*\n\s*f\.transaction_number, f\.purpose,/);

    const groupedStart = dailyCore.indexOf("grouped AS (");
    const groupedEnd = dailyCore.indexOf("denom AS (", groupedStart);
    const groupedBlock = dailyCore.slice(groupedStart, groupedEnd);
    expect(groupedBlock).toContain("'purpose', g.purpose");
  });

  it("Remarks: this is a two-line addition to the pending migration, not a second CREATE OR REPLACE -- the amendment is documented in the file header", () => {
    expect(dailyCore).toContain("AMENDED 2026-08-27 (daily-report-remarks-column integration)");
    expect(dailyCore).toContain("migration has NEVER been applied to any database");
  });

  it("get_daily_project_report_page_v1 still checks auth.uid() and delegates the actual computation, never duplicating it", () => {
    const start = dailyCore.indexOf("-- ── The authenticated wrapper now delegates");
    const body = dailyCore.slice(start, dailyCore.indexOf("$$;", start));
    expect(body).toContain("authentication required");
    expect(body).toContain("daily_report_caller_can_view_v1(p_organization_id, COALESCE(p_team_scoped, false))");
    expect(body).toContain("RETURN public.report_daily_project_rows_v1(");
  });

  it("pagination is keyset/cursor-based on a composite key, never OFFSET", () => {
    expect(dailyCore).toContain(
      "(gr.track_date_key, gr.user_id, gr.project_id_key) > (v_cur_date, v_cur_user, v_cur_proj)",
    );
    expect(dailyCore).not.toMatch(/\bOFFSET\b/);
  });

  it("page size is bounded server-side regardless of what the caller asks for", () => {
    expect(dailyCore).toContain("LEAST(GREATEST(COALESCE(p_page_size, 250), 1), 2000)");
  });

  it("resolves project_name through three fallbacks, closing the documented blank-name defect", () => {
    expect(dailyCore).toContain("project_name_configured");
    expect(dailyCore).toContain("project_name_branch");
    expect(dailyCore).toContain("def_name");
  });
});

describe("Expense report row production + enqueue (part 3)", () => {
  it("report_expense_rows_v1 and report_expense_allocations_v1 are service_role-only", () => {
    for (const fn of ["report_expense_rows_v1", "report_expense_allocations_v1", "_report_expense_custom_fields_v1"]) {
      const start = expenseReports.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`);
      expect(start, `${fn} not found`).toBeGreaterThan(-1);
      const grantIdx = expenseReports.indexOf(`GRANT EXECUTE ON FUNCTION public.${fn}(`, start);
      expect(grantIdx, `${fn} grant not found`).toBeGreaterThan(-1);
      expect(expenseReports.slice(grantIdx, grantIdx + 200)).toContain("TO service_role");
    }
  });

  it("report_expense_rows_v1 uses composite keyset pagination, never OFFSET", () => {
    expect(expenseReports).toContain("< (v_cur_val, v_cur_id)");
    const start = expenseReports.indexOf("CREATE OR REPLACE FUNCTION public.report_expense_rows_v1(");
    const body = expenseReports.slice(start, expenseReports.indexOf("$$;", start));
    expect(body).not.toMatch(/\bOFFSET\b/);
  });

  it("create_expense_report_export_job_v1 verifies the real caller, never trusts a client-supplied organization_id unchecked", () => {
    const start = expenseReports.indexOf("CREATE OR REPLACE FUNCTION public.create_expense_report_export_job_v1(");
    const body = expenseReports.slice(start, expenseReports.indexOf("$$;", start));
    expect(body).toContain("v_uid      uuid := auth.uid();");
    expect(body).toContain("authentication required");
    expect(body).toContain("daily_report_caller_can_view_v1(p_organization_id, v_team)");
    expect(body).toContain("not permitted to generate this report");
  });

  it("create_expense_report_export_job_v1 rejects the Daily Project Report type -- that one has its own enqueue function", () => {
    const start = expenseReports.indexOf("CREATE OR REPLACE FUNCTION public.create_expense_report_export_job_v1(");
    const body = expenseReports.slice(start, expenseReports.indexOf("$$;", start));
    expect(body).toContain("IF p_report_type NOT IN ('claim_verification', 'claim_approval', 'detailed_expense')");
  });

  it("create_expense_report_export_job_v1 handles a concurrent-enqueue race instead of raising an unhandled unique_violation", () => {
    const start = expenseReports.indexOf("CREATE OR REPLACE FUNCTION public.create_expense_report_export_job_v1(");
    const end = expenseReports.indexOf("REVOKE ALL", start);
    const body = expenseReports.slice(start, end);
    expect(body).toContain("WHEN unique_violation THEN");
  });

  it("create_expense_report_export_job_v1 is authenticated-only with PUBLIC/anon revoked", () => {
    const start = expenseReports.indexOf("REVOKE ALL ON FUNCTION public.create_expense_report_export_job_v1");
    const grantBlock = expenseReports.slice(start, start + 400);
    expect(grantBlock).toContain("FROM PUBLIC");
    expect(grantBlock).toContain("FROM anon");
    expect(grantBlock).toContain("TO authenticated");
  });

  it("never grants anon anything", () => {
    expect(expenseReports).not.toMatch(/GRANT[^;]*TO anon/);
  });
});

describe("Report export history (part 4)", () => {
  it("list_report_export_jobs_v1 verifies the caller and the report-view permission before returning anyone's history", () => {
    const start = history.indexOf("CREATE OR REPLACE FUNCTION public.list_report_export_jobs_v1(");
    const body = history.slice(start, history.indexOf("$$;", start));
    expect(body).toContain("authentication required");
    expect(body).toContain("daily_report_caller_can_view_v1(p_organization_id, false)");
    expect(body).toContain("not permitted to view this report");
  });

  it("returns the {schema_version, jobs} envelope the frontend actually destructures", () => {
    const start = history.indexOf("CREATE OR REPLACE FUNCTION public.list_report_export_jobs_v1(");
    const body = history.slice(start, history.indexOf("$$;", start));
    expect(body).toContain("'schema_version', 1");
    expect(body).toContain("'jobs', COALESCE(jsonb_agg(");
  });

  it("downloadable folds status, expiry AND real object presence into one boolean -- never just status", () => {
    const start = history.indexOf("'downloadable', (");
    const block = history.slice(start, start + 500);
    expect(block).toContain("j.status = 'completed'");
    expect(block).toContain("j.storage_path IS NOT NULL");
    expect(block).toContain("j.expires_at IS NULL OR j.expires_at > now()");
    expect(block).toContain("EXISTS (\n          SELECT 1 FROM storage.objects o");
  });

  it("resolves the requester's name server-side instead of letting the client join profiles directly", () => {
    expect(history).toContain("LEFT JOIN public.profiles p ON p.user_id = j.requested_by");
    expect(history).toContain("'Unknown user'");
  });

  it("only ever returns completed jobs -- queued/running/failed/cancelled never appear in history", () => {
    const start = history.indexOf("FROM (\n    SELECT *");
    const block = history.slice(start, history.indexOf(") j", start));
    expect(block).toContain("AND status = 'completed'");
  });

  it("is authenticated-only with PUBLIC/anon revoked", () => {
    expect(history).toContain("REVOKE ALL ON FUNCTION public.list_report_export_jobs_v1(uuid, text, integer) FROM PUBLIC");
    expect(history).toContain("REVOKE ALL ON FUNCTION public.list_report_export_jobs_v1(uuid, text, integer) FROM anon");
    expect(history).toContain("GRANT EXECUTE ON FUNCTION public.list_report_export_jobs_v1(uuid, text, integer) TO authenticated");
  });
});
