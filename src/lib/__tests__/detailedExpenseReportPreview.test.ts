/**
 * Detailed Expense on-page preview + paginated report history (DOC-131) --
 * SQL contract tests.
 *
 * The migration cannot be executed locally (no Postgres in this
 * environment), so its security/pagination/idempotency shape is guarded on
 * the authored source, matching the convention already used by
 * serverSideReportGeneration.test.ts. Its runtime behavior was separately
 * proven against the shared self-hosted database in a rolled-back
 * transaction (migration + a full functional test: chunked writes, exact
 * page-boundary correctness with no overlap, anon rejection, cross-org
 * rejection, not-completed graceful degrade, and history-v2 total_count) --
 * see Documentations MD/detailed-expense-report-preview.md.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const cwd = process.cwd();
const migration = readFileSync(
  resolve(cwd, "supabase/migrations/20260924000000_detailed_expense_report_preview_v1.sql"),
  "utf-8",
).replace(/\r\n/g, "\n");

describe("report_export_job_rows -- storage table", () => {
  it("is additive only (CREATE TABLE IF NOT EXISTS / ALTER TABLE ADD COLUMN IF NOT EXISTS)", () => {
    expect(migration).toContain("ALTER TABLE public.report_export_jobs\n  ADD COLUMN IF NOT EXISTS preview_columns text[]");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.report_export_job_rows");
  });

  it("cascades away with its parent job -- no orphaned preview data ever lingers", () => {
    expect(migration).toContain("REFERENCES public.report_export_jobs(id) ON DELETE CASCADE");
  });

  it("is keyed for stable, gap-free pagination", () => {
    expect(migration).toContain("PRIMARY KEY (job_id, row_index)");
  });

  it("has RLS enabled with no policies -- direct client access is impossible either way, only the definer RPCs below reach it", () => {
    const start = migration.indexOf("CREATE TABLE IF NOT EXISTS public.report_export_job_rows");
    const end = migration.indexOf("CREATE OR REPLACE FUNCTION public.clear_report_export_job_preview_v1");
    const body = migration.slice(start, end);
    expect(body).toContain("ALTER TABLE public.report_export_job_rows ENABLE ROW LEVEL SECURITY");
    expect(body).not.toMatch(/CREATE POLICY/);
  });

  it("is revoked from PUBLIC, anon and authenticated -- writable only by service_role", () => {
    const start = migration.indexOf("CREATE TABLE IF NOT EXISTS public.report_export_job_rows");
    const end = migration.indexOf("CREATE OR REPLACE FUNCTION public.clear_report_export_job_preview_v1");
    const body = migration.slice(start, end);
    expect(body).toContain("REVOKE ALL ON public.report_export_job_rows FROM PUBLIC");
    expect(body).toContain("REVOKE ALL ON public.report_export_job_rows FROM anon");
    expect(body).toContain("REVOKE ALL ON public.report_export_job_rows FROM authenticated");
    expect(body).toContain("GRANT ALL ON public.report_export_job_rows TO service_role");
  });
});

describe("store_report_export_job_preview_chunk_v1 -- worker-only write", () => {
  const sig = "public.store_report_export_job_preview_chunk_v1(uuid, integer, text[], jsonb)";

  it("is revoked from PUBLIC, anon and authenticated, granted only to service_role", () => {
    expect(migration).toContain(`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC`);
    expect(migration).toContain(`REVOKE ALL ON FUNCTION ${sig} FROM anon`);
    expect(migration).toContain(`REVOKE ALL ON FUNCTION ${sig} FROM authenticated`);
    expect(migration).toContain(`GRANT EXECUTE ON FUNCTION ${sig} TO service_role`);
  });

  it("upserts on (job_id, row_index) -- a retried chunk overwrites in place, never duplicates", () => {
    const start = migration.indexOf("CREATE OR REPLACE FUNCTION public.store_report_export_job_preview_chunk_v1");
    const body = migration.slice(start, migration.indexOf("$$;", start));
    expect(body).toContain("ON CONFLICT (job_id, row_index) DO UPDATE SET row_data = EXCLUDED.row_data");
  });

  it("computes row_index from p_start_index + ordinality -- chunk boundaries never overlap or leave gaps", () => {
    const start = migration.indexOf("CREATE OR REPLACE FUNCTION public.store_report_export_job_preview_chunk_v1");
    const body = migration.slice(start, migration.indexOf("$$;", start));
    expect(body).toContain("p_start_index + (ord - 1)");
    expect(body).toContain("WITH ORDINALITY");
  });

  it("sets safe search_path (SECURITY DEFINER hardening)", () => {
    const start = migration.indexOf("CREATE OR REPLACE FUNCTION public.store_report_export_job_preview_chunk_v1");
    const body = migration.slice(start, migration.indexOf("AS $$", start));
    expect(body).toContain("SECURITY DEFINER");
    expect(body).toContain("SET search_path = public");
  });
});

describe("get_report_export_job_preview_v1 -- authenticated, paginated read", () => {
  const sig = "public.get_report_export_job_preview_v1(uuid, integer, integer)";

  it("is revoked from PUBLIC and anon, granted only to authenticated -- never service_role-only, this is a client-facing read", () => {
    expect(migration).toContain(`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC`);
    expect(migration).toContain(`REVOKE ALL ON FUNCTION ${sig} FROM anon`);
    expect(migration).toContain(`GRANT EXECUTE ON FUNCTION ${sig} TO authenticated`);
  });

  it("requires authentication before touching any row", () => {
    const start = migration.indexOf("CREATE OR REPLACE FUNCTION public.get_report_export_job_preview_v1");
    const body = migration.slice(start, migration.indexOf("$$;", start));
    expect(body).toContain("IF v_uid IS NULL THEN");
    expect(body).toContain("RAISE EXCEPTION 'authentication required'");
  });

  it("authorizes via daily_report_caller_can_view_v1 against the JOB'S OWN organization_id -- never a client-supplied org id", () => {
    const start = migration.indexOf("CREATE OR REPLACE FUNCTION public.get_report_export_job_preview_v1");
    const body = migration.slice(start, migration.indexOf("$$;", start));
    // The function only ever takes p_job_id (+ paging) -- no p_organization_id
    // parameter exists to trust or spoof.
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION public.get_report_export_job_preview_v1(\n  p_job_id    uuid,",
    );
    expect(body).toContain("SELECT * INTO v_job FROM public.report_export_jobs WHERE id = p_job_id");
    expect(body).toContain("daily_report_caller_can_view_v1(v_job.organization_id, false)");
    expect(body).toContain("RAISE EXCEPTION 'not permitted to view this report'");
  });

  it("degrades gracefully -- not-completed and no-stored-preview are a normal envelope, never an error", () => {
    const start = migration.indexOf("CREATE OR REPLACE FUNCTION public.get_report_export_job_preview_v1");
    const body = migration.slice(start, migration.indexOf("$$;", start));
    expect(body).toContain("'reason', 'not_completed'");
    expect(body).toContain("'reason', 'no_preview_available'");
  });

  it("clamps page_size to [1, 200] and page to >= 1 -- a malicious or malformed page number cannot force a huge scan", () => {
    const start = migration.indexOf("CREATE OR REPLACE FUNCTION public.get_report_export_job_preview_v1");
    const body = migration.slice(start, migration.indexOf("$$;", start));
    expect(body).toContain("LEAST(GREATEST(COALESCE(p_page_size, 50), 1), 200)");
    expect(body).toContain("GREATEST(COALESCE(p_page, 1), 1)");
  });

  it("paginates with a deterministic ORDER BY row_index and OFFSET derived from the page number", () => {
    const start = migration.indexOf("CREATE OR REPLACE FUNCTION public.get_report_export_job_preview_v1");
    const body = migration.slice(start, migration.indexOf("$$;", start));
    expect(body).toContain("ORDER BY row_index");
    expect(body).toContain("LIMIT v_page_size OFFSET (v_page - 1) * v_page_size");
  });

  it("returns the exact stored columns array, not a re-derived one, so preview headers can never drift from the CSV", () => {
    const start = migration.indexOf("CREATE OR REPLACE FUNCTION public.get_report_export_job_preview_v1");
    const body = migration.slice(start, migration.indexOf("$$;", start));
    expect(body).toContain("to_jsonb(v_job.preview_columns)");
  });
});

describe("list_report_export_jobs_v2 -- paginated report history", () => {
  const sig = "public.list_report_export_jobs_v2(uuid, text, integer, integer)";

  it("is additive -- v1 is completely untouched, still callable by any existing caller", () => {
    expect(migration).not.toContain("DROP FUNCTION public.list_report_export_jobs_v1");
    expect(migration).toContain("CREATE OR REPLACE FUNCTION public.list_report_export_jobs_v2");
  });

  it("is revoked from PUBLIC and anon, granted only to authenticated", () => {
    expect(migration).toContain(`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC`);
    expect(migration).toContain(`REVOKE ALL ON FUNCTION ${sig} FROM anon`);
    expect(migration).toContain(`GRANT EXECUTE ON FUNCTION ${sig} TO authenticated`);
  });

  it("uses the SAME authorization rule as v1 (daily_report_caller_can_view_v1) -- no separate, driftable permission model", () => {
    const start = migration.indexOf("CREATE OR REPLACE FUNCTION public.list_report_export_jobs_v2");
    const body = migration.slice(start, migration.indexOf("$$;", start));
    expect(body).toContain("daily_report_caller_can_view_v1(p_organization_id, false)");
  });

  it("returns a real total_count via a separate scalar subquery, not a guess from the page's own row count", () => {
    const start = migration.indexOf("CREATE OR REPLACE FUNCTION public.list_report_export_jobs_v2");
    const body = migration.slice(start, migration.indexOf("$$;", start));
    expect(body).toContain("'total_count', (");
    expect(body).toContain("SELECT count(*)::integer FROM public.report_export_jobs");
  });

  it("defaults to a 5-per-page history, newest first, with a real OFFSET (not a hardcoded top-N)", () => {
    const start = migration.indexOf("CREATE OR REPLACE FUNCTION public.list_report_export_jobs_v2");
    const body = migration.slice(start, migration.indexOf("$$;", start));
    expect(body).toContain("p_limit           integer DEFAULT 5");
    expect(body).toContain("ORDER BY created_at DESC");
    expect(body).toContain("LIMIT v_limit OFFSET v_offset");
  });

  it("clamps limit to [1, 100] and offset to >= 0", () => {
    const start = migration.indexOf("CREATE OR REPLACE FUNCTION public.list_report_export_jobs_v2");
    const body = migration.slice(start, migration.indexOf("$$;", start));
    expect(body).toContain("LEAST(GREATEST(COALESCE(p_limit, 5), 1), 100)");
    expect(body).toContain("GREATEST(COALESCE(p_offset, 0), 0)");
  });

  it("exposes has_preview per row so the client can decide whether to offer the preview UI for that job", () => {
    const start = migration.indexOf("CREATE OR REPLACE FUNCTION public.list_report_export_jobs_v2");
    const body = migration.slice(start, migration.indexOf("$$;", start));
    expect(body).toContain("'has_preview', (j.preview_columns IS NOT NULL)");
  });
});

describe("install-time verification", () => {
  it("asserts every new object exists before the migration is considered installed", () => {
    expect(migration).toContain("DO $verify$");
    expect(migration).toContain("report_export_job_rows");
    expect(migration).toContain("clear_report_export_job_preview_v1(uuid)");
    expect(migration).toContain("store_report_export_job_preview_chunk_v1(uuid, integer, text[], jsonb)");
    expect(migration).toContain("get_report_export_job_preview_v1(uuid, integer, integer)");
    expect(migration).toContain("list_report_export_jobs_v2(uuid, text, integer, integer)");
  });
});
