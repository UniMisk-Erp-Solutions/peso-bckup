/**
 * 6546 Level 2 routing + audit repair (debug/6456-supervisor-auth-runtime,
 * 2026-08-12): one-time Production data repair for 100 real MicroLink
 * expenses left in an inconsistent state (status=level_2_verified,
 * approval_tier='executive', zero tier_advanced audit trail) by the
 * pre-fix `main`-branch Issue 2 defect (client derived tier from a stale
 * expense.approval_tier snapshot instead of the caller's real current
 * role, threw the legacy migration-name error before writing the audit
 * row, even though the server-side status transition had already
 * committed).
 *
 * This is a raw-SQL, DO-block migration (supabase/migrations/
 * 20260812150000_repair_6546_level2_routing_and_audit.sql), applied and
 * verified live against Production in a dry-run (BEGIN...ROLLBACK) that
 * exactly matched the permanent apply. Reproducing the real Postgres
 * function/DO-block execution is out of scope for this suite, so these
 * are source guards proving the deployed SQL has the exact shape verified
 * live: the candidate selector matches only the proven bad-state pattern,
 * excludes the 58 already-correct sibling rows, never touches financial
 * fields or re-runs verification, is idempotent, and writes truthful
 * (not fabricated) audit evidence.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const cwd = process.cwd();

// Normalizes CRLF -> LF so the multi-line literal assertions below match
// regardless of the checkout's line-ending convention (this repo's
// core.autocrlf setting can check this file out with \r\n on Windows) --
// this reads the file for comparison only and never touches the migration
// file itself, so its committed bytes/audit-trail content are untouched.
function read(relativePath: string): string {
  return readFileSync(resolve(cwd, relativePath), "utf-8").replace(/\r\n/g, "\n");
}

describe("6546 Level 2 routing + audit repair (SQL)", () => {
  const migration = read(
    "supabase/migrations/20260812150000_repair_6546_level2_routing_and_audit.sql",
  );

  it("resolves organization and employee from stable business keys, never hardcoded UUIDs as the selection criteria", () => {
    expect(migration).toContain("WHERE name ILIKE '%microlink%'");
    expect(migration).toContain("p.employee_id = '6546'");
  });

  it("candidate selector matches exactly the proven bad-state pattern", () => {
    expect(migration).toContain("e.status = 'level_2_verified'");
    expect(migration).toContain("e.approval_tier = 'executive'");
    expect(migration).toContain("e.approved_by IS NULL");
    expect(migration).toContain("e.approved_at IS NULL");
    expect(migration).toContain("al.action = 'tier_advanced'");
  });

  it("excludes rows that already have a legitimate tier_advanced audit entry — the 58 correct siblings can never be selected", () => {
    expect(migration).toContain(
      "NOT EXISTS (\n      SELECT 1 FROM public.audit_logs al\n      WHERE al.expense_id = e.id AND al.action = 'tier_advanced'",
    );
  });

  it("asserts an exact population of 100 and aborts on any other count — refuses to guess at an unproven population", () => {
    expect(migration).toContain("v_candidate_count <> 100");
    expect(migration).toContain("RAISE EXCEPTION");
  });

  it("is idempotent — zero candidates is treated as a clean no-op, not an error", () => {
    expect(migration).toContain("IF v_candidate_count = 0 THEN");
    expect(migration).toContain("RAISE NOTICE 'Repair: 0 candidate rows found");
    expect(migration).toContain("RETURN;");
  });

  it("defensively verifies pre-repair routing state before writing anything", () => {
    expect(migration).toContain("v_bad_precondition_count");
    expect(migration).toContain("e.assigned_reviewer_id IS DISTINCT FROM v_kunvar_id");
    expect(migration).toContain("e.assigned_engineer_id IS DISTINCT FROM v_kunvar_id");
  });

  it("the UPDATE touches only approval_tier — never status, amounts, batch_id, transaction_number, approved_by, or approved_at", () => {
    const updateBlock = migration.slice(
      migration.indexOf("UPDATE public.expenses e"),
      migration.indexOf("GET DIAGNOSTICS v_updated_count"),
    );
    expect(updateBlock).toContain("SET approval_tier = 'engineer'");
    expect(updateBlock).not.toMatch(/\bstatus\s*=/);
    expect(updateBlock).not.toMatch(/total_amount|category|attachments|batch_id|transaction_number|approved_by|approved_at/);
  });

  it("deliberately never assigns to updated_at — the existing provable historical timestamp is preserved, not overwritten", () => {
    const updateBlock = migration.slice(
      migration.indexOf("UPDATE public.expenses e"),
      migration.indexOf("GET DIAGNOSTICS v_updated_count"),
    );
    expect(updateBlock).not.toMatch(/updated_at\s*=/);
  });

  it("never modifies assigned_reviewer_id/assigned_engineer_id in the UPDATE — they were already proven correct", () => {
    const updateBlock = migration.slice(
      migration.indexOf("UPDATE public.expenses e"),
      migration.indexOf("GET DIAGNOSTICS v_updated_count"),
    );
    expect(updateBlock).not.toMatch(/assigned_reviewer_id\s*=|assigned_engineer_id\s*=/);
  });

  it("attributes the backfilled audit entry to the real actor (Kunvar), never to admin/system/the migration itself", () => {
    expect(migration).toContain("v_kunvar_id,\n    'tier_advanced',");
  });

  it("audit comment truthfully distinguishes the historical event from the reconstruction recorded now, and cites the per-row proven timestamp", () => {
    expect(migration).toContain("was already committed server-side on");
    expect(migration).toContain("rc.original_updated_at");
    expect(migration).toContain("No re-verification was performed");
  });

  it("carries a deterministic, greppable repair marker for de-duplication and audit traceability", () => {
    expect(migration).toContain("6546_level2_metadata_repair_20260812");
  });

  it("asserts exact row counts after both the UPDATE and the INSERT, aborting on any partial-failure mismatch", () => {
    expect(migration).toContain("v_updated_count <> 100");
    expect(migration).toContain("v_audit_inserted_count <> 100");
  });
});
