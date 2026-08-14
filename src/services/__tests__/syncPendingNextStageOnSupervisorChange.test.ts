/**
 * Issue 1 fix (debug/6456-supervisor-auth-runtime, 2026-08-12): "supervisor
 * changed after Level 1 was already verified" leaves the still-pending NEXT
 * stage stuck on stale reviewers from the OLD hierarchy.
 *
 * Root cause, confirmed read-only against Production (MicroLink): the
 * existing sync trigger (20260812121000) deliberately only resyncs
 * never-yet-verified rows (status IN submitted/edited/under_review) — a
 * correct choice, to avoid rewriting completed hierarchy history — but left
 * a real gap: once Level 1 (or Level 2) completes and the employee's
 * hierarchy changes afterward, assigned_reviewer_id/assigned_engineer_id for
 * the still-pending NEXT tier keep pointing at the OLD hierarchy's reviewer
 * forever, because nothing ever re-derives them. This is the exact same
 * "stale snapshot vs current hierarchy" shape as the original 6546 incident,
 * one tier later.
 *
 * This migration extends the SAME trigger (not a second, inconsistent
 * algorithm) with two more blocks, mirroring the same priority rules
 * src/lib/approvalHierarchy.ts already uses for a live verify action
 * (resolveExecutiveReviewerId for the team_leader -> executive edge,
 * resolveReviewerForTier('engineer', ...) for the executive -> engineer
 * edge). Completed history (status, who verified it, when, comment) is never
 * touched by either new block — only assigned_reviewer_id/assigned_engineer_id
 * for the currently-pending next stage.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const cwd = process.cwd();

function read(relativePath: string): string {
  return readFileSync(resolve(cwd, relativePath), "utf-8");
}

describe("sync_pending_expenses_on_supervisor_change — level_1/level_2 pending-next-stage follow-up (SQL)", () => {
  const migration = read(
    "supabase/migrations/20260812140000_sync_pending_next_stage_on_supervisor_change.sql",
  );

  it("reproduces the original never-yet-verified block verbatim, unchanged", () => {
    expect(migration).toContain(
      'e.status IN (\'submitted\', \'edited\', \'under_review\')',
    );
    expect(migration).toContain(
      "e.approval_tier IS NULL OR e.approval_tier IN ('team_leader', 'executive')",
    );
  });

  it("resyncs level_1_verified rows waiting at Level 2, without touching status", () => {
    expect(migration).toContain("e.status = 'level_1_verified'");
    expect(migration).toContain("e.approval_tier = 'executive'");
    // The UPDATE SET clause for this block (up to WHERE) must never assign
    // to e.status — only the WHERE clause may reference it, to select rows.
    const block2 = migration.slice(
      migration.indexOf("Block 2:"),
      migration.indexOf("Block 3:"),
    );
    const setClause = block2.slice(block2.indexOf("SET"), block2.indexOf("WHERE"));
    expect(setClause).not.toMatch(/\bstatus\s*=/);
  });

  it("resyncs level_2_verified rows waiting at the engineer/manager stage, without touching status", () => {
    expect(migration).toContain("e.status = 'level_2_verified'");
    expect(migration).toContain("e.approval_tier = 'engineer'");
    const block3 = migration.slice(migration.indexOf("Block 3:"));
    const setClause = block3.slice(block3.indexOf("SET"), block3.indexOf("WHERE"));
    expect(setClause).not.toMatch(/\bstatus\s*=/);
  });

  it("mirrors resolveExecutiveReviewerId's priority for the Level 2 reviewer: new supervisor if executive, else that supervisor's own supervisor if executive, else the team's executive", () => {
    expect(migration).toContain("v_new_supervisor_role = 'executive' THEN NEW.reporting_engineer_id");
    expect(migration).toContain("v_new_supervisor_role = 'team_leader' THEN (");
    expect(migration).toContain("om.role = 'executive'");
    expect(migration).toContain(
      "v_new_executive := COALESCE(v_new_executive, v_team.executive_user_id);",
    );
  });

  it("mirrors resolveReviewerForTier('engineer', ...)'s priority for the manager/engineer reviewer", () => {
    expect(migration).toContain(
      "v_new_supervisor_role IN ('engineer', 'admin') THEN NEW.reporting_engineer_id",
    );
    expect(migration).toContain(
      "v_new_engineer := COALESCE(v_new_engineer, v_team.manager_user_id, NEW.reporting_engineer_id);",
    );
  });

  it("blocks self-review on both new blocks", () => {
    expect(migration).toContain("v_new_executive IS NOT NULL AND v_new_executive <> NEW.user_id");
    expect(migration).toContain("v_new_engineer IS NOT NULL AND v_new_engineer <> NEW.user_id");
  });

  it("scopes every new lookup to the expense's own organization", () => {
    const block2and3 = migration.slice(migration.indexOf("Shared lookups"));
    expect(block2and3).toContain("om.organization_id = NEW.organization_id");
    expect(block2and3).toContain("t.organization_id = tm.organization_id");
    expect(block2and3).toContain("tm.organization_id = NEW.organization_id");
  });

  it("only uses active organization_memberships rows as candidates", () => {
    expect(migration).toContain("som.is_active = true");
  });

  it("is idempotent — only touches rows whose current assignment is provably stale", () => {
    const block2 = migration.slice(
      migration.indexOf("Block 2:"),
      migration.indexOf("Block 3:"),
    );
    expect(block2).toContain("e.assigned_reviewer_id IS DISTINCT FROM v_new_executive");
    const block3 = migration.slice(migration.indexOf("Block 3:"));
    expect(block3).toContain("e.assigned_reviewer_id IS DISTINCT FROM v_new_engineer");
  });

  it("writes a distinct, truthful audit_logs comment for each new block that names the tier and confirms history is unchanged", () => {
    expect(migration).toContain("Pending Level 2 (executive) reviewer reassigned");
    expect(migration).toContain("Level 1 history is unchanged");
    expect(migration).toContain("Pending manager/engineer reviewer reassigned");
    expect(migration).toContain("Level 1/Level 2 history is unchanged");
  });

  it("is additive — CREATE OR REPLACE, not DROP, and does not re-create the trigger unnecessarily", () => {
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION public.sync_pending_expenses_on_supervisor_change()",
    );
    expect(migration).not.toContain("DROP FUNCTION");
    expect(migration).not.toContain("CREATE TRIGGER");
  });
});
