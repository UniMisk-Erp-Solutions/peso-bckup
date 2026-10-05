import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = path.resolve(
  process.cwd(),
  "supabase/migrations/20260902120000_review_canonical_manager_approval_ready.sql",
);
const sql = fs.readFileSync(migrationPath, "utf8");

const helperStart = sql.indexOf(
  "CREATE OR REPLACE FUNCTION public._review_manager_normal_approval_ready_v1",
);
const mutationStart = sql.indexOf("CREATE OR REPLACE FUNCTION public.review_approve_expense(");
const previewStart = sql.indexOf(
  "CREATE OR REPLACE FUNCTION public.review_preview_approval_targets_v1(",
);
const helperBody = sql.slice(helperStart, mutationStart);
const mutationBody = sql.slice(mutationStart, previewStart);
const previewBody = sql.slice(previewStart);

describe("canonical normal Manager approval migration", () => {
  it("defines one active, organization-scoped Manager authorization + stage gate", () => {
    expect(helperBody).toMatch(/om\.organization_id = e\.organization_id/);
    expect(helperBody).toMatch(/om\.role = 'engineer'/);
    expect(helperBody).toMatch(/om\.is_active = true/);
    expect(helperBody).toMatch(/manager_expense_visible_to_user\(e, p_user_id\)/);
    expect(helperBody).toMatch(/e\.approval_tier NOT IN \('team_leader', 'executive'\)/);
    expect(helperBody).toMatch(/'submitted', 'edited', 'level_2_verified'/);
  });

  it("makes both preview and mutation delegate their normal Manager decision to that helper", () => {
    expect(mutationBody).toMatch(/IF NOT public\._review_manager_normal_approval_ready_v1\(e, v_uid\)/);
    expect(previewBody).toMatch(/public\._review_manager_normal_approval_ready_v1\(/);
    expect(previewBody).toMatch(/manager_normal_approval_ready/);
  });

  it("keeps approval-limit classification separate and Manager Override untouched", () => {
    expect(mutationBody).toMatch(/engineer_approval_limit/);
    expect(previewBody).not.toMatch(/review_approve_expense_manager_override_v1/);
  });

  it("does not mass-rewrite routing metadata or workflow state", () => {
    const topLevelBeforeFunctions = sql.slice(0, helperStart);
    expect(topLevelBeforeFunctions).not.toMatch(/UPDATE\s+public\.expenses/i);
    expect(sql).not.toMatch(/SET\s+assigned_(?:reviewer|engineer)_id/i);
  });

  it("keeps the internal helper unexposed and public RPC grants narrow", () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\._review_manager_normal_approval_ready_v1[\s\S]*FROM authenticated;/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.review_preview_approval_targets_v1\(uuid, uuid\[\]\) FROM anon;/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.review_preview_approval_targets_v1\(uuid, uuid\[\]\) TO authenticated;/);
  });
});
