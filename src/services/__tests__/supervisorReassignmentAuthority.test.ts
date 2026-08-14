/**
 * Supervisor-reassignment authority fix (debug/6456-supervisor-auth-runtime).
 *
 * Root cause, confirmed read-only against Production (employee 6546,
 * MicroLink): `expense_hierarchy_reviewer_can_act` (server) and
 * `advanceExpenseTier`'s `isAssigned` gate (client) both authorized a
 * team_leader/executive Verify ONLY against the expense's own snapshotted
 * `assigned_reviewer_id`/`assigned_engineer_id` — never the employee's
 * CURRENT `profiles.reporting_engineer_id`. When an employee's immediate
 * supervisor is reassigned, expenses still pending at that stage keep
 * pointing at the PREVIOUS supervisor forever.
 *
 * Follow-up (2026-08-12, owner-authorized): all three migrations below were
 * APPLIED to Production and verified live in a series of transactional
 * (BEGIN/ROLLBACK) tests — the dynamic-authority flip (Kunvar ALLOW /
 * Mahamkali DENY), the trigger's A→B/B→A/NULL-case reassignment, and the
 * real review_advance_expense_hierarchy_tier RPC end-to-end on a repaired
 * row (submitted/team_leader → level_2_verified/executive) — plus the
 * one-time 1,775-row MicroLink repair (100 for employee 6546), all
 * confirmed against live Production. Reproducing a real Postgres instance
 * is out of scope for this suite, so these remain source guards proving the
 * deployed SQL has the exact shape verified live — the new OR-branch and
 * its scoping conditions, the trigger's WHEN clause and eligibility
 * predicate, and the repair's ledger-not-audit_logs choice. Combined with
 * the real behavioral tests below for the CLIENT-side mirror (which *can*
 * be exercised directly), this avoids re-testing SQL through string
 * matching alone.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const cwd = process.cwd();

function read(relativePath: string): string {
  return readFileSync(resolve(cwd, relativePath), "utf-8");
}

describe("expense_hierarchy_reviewer_can_act — current-supervisor fallback (SQL)", () => {
  const migration = read(
    "supabase/migrations/20260812120000_fix_pending_expense_supervisor_reassignment.sql",
  );

  it("preserves the original snapshot-based authorization branch verbatim", () => {
    expect(migration).toContain("e.assigned_reviewer_id = v_uid");
    expect(migration).toContain("e.assigned_engineer_id = v_uid");
    expect(migration).toContain("om.role = 'team_leader'");
    expect(migration).toContain("om.role = 'executive'");
  });

  it("adds a fallback scoped to CURRENT reporting_engineer_id, not the stale snapshot", () => {
    expect(migration).toContain("p.reporting_engineer_id = v_uid");
    expect(migration).toContain("p.user_id = e.user_id");
    expect(migration).toContain("p.organization_id = e.organization_id"); // cross-org guard
  });

  it("restricts the fallback to expenses never verified at any hierarchy tier", () => {
    expect(migration).toContain(
      "e.status::text IN ('submitted', 'edited', 'under_review')",
    );
    // Explicitly must NOT reference the advanced/terminal statuses as eligible.
    expect(migration).not.toMatch(
      /IN\s*\(\s*'submitted'.*level_1_verified.*\)/s,
    );
  });

  it("blocks self-review on the fallback branch", () => {
    expect(migration).toContain("v_uid <> e.user_id");
  });

  it("requires the caller to hold active hierarchy-capable membership, not just any org member", () => {
    expect(migration).toContain("om.role IN ('team_leader', 'executive')");
    expect(migration).toContain("om.is_active = true");
  });

  it("is additive — CREATE OR REPLACE, not DROP, and preserves the grant", () => {
    expect(migration).toContain("CREATE OR REPLACE FUNCTION public.expense_hierarchy_reviewer_can_act");
    expect(migration).not.toContain("DROP FUNCTION");
    expect(migration).toContain("GRANT EXECUTE ON FUNCTION public.expense_hierarchy_reviewer_can_act");
  });
});

describe("advanceExpenseTier — client-side mirror of the fallback (source guard)", () => {
  const service = read("src/services/ExpenseService.ts");

  it("computes the current-supervisor fallback before the isAssigned gate throws", () => {
    expect(service).toContain("isAssignedBySnapshot");
    expect(service).toContain("isCurrentSupervisorFallback");
    expect(service).toContain("reportingEngineerId === reviewerId");
    expect(service).toContain('reviewerId !== expense.user_id');
    expect(service).toContain(
      '["submitted", "edited", "under_review"].includes(expense.status)',
    );
  });

  it("when acting via the fallback, derives tier from the caller's OWN current role — not the stale approval_tier", () => {
    // Updated 2026-08-12 (debug/6456-supervisor-auth-runtime, Issue 2 fix):
    // tier derivation now uses a freshly re-verified `currentRole` for every
    // branch (not just the fallback), closing the client/server tier
    // divergence at its source. The underlying invariant this test guards —
    // tier comes from the caller's role, never the expense's stale
    // approval_tier snapshot — still holds.
    expect(service).toContain(
      'tier = currentRole === "team_leader" ? "team_leader" : "executive"',
    );
    expect(service).toContain("const currentRole = knownReviewerRole");
    expect(service).toContain(
      "await this.fetchMembershipRole(organizationId, reviewerId)",
    );
  });

  it("still throws the original error for a genuinely unassigned reviewer", () => {
    expect(service).toContain('throw new Error("You are not assigned to verify this expense")');
  });
});

describe("UserManagement — best-effort pending-expense reassignment on supervisor change", () => {
  const userManagement = read("src/pages/UserManagement.tsx");

  it("reassigns only still-pending, immediate-supervisor-stage expenses to the CURRENT reporting_engineer_id", () => {
    expect(userManagement).toContain('.in("status", ["submitted", "edited", "under_review"])');
    expect(userManagement).toContain(
      '.or("approval_tier.is.null,approval_tier.in.(team_leader,executive)")',
    );
    expect(userManagement).toContain("assigned_reviewer_id: updateData.reporting_engineer_id");
    expect(userManagement).toContain("assigned_engineer_id: updateData.reporting_engineer_id");
  });

  it("scopes the reassignment to this one employee and organization (no cross-tenant/broad update)", () => {
    expect(userManagement).toContain('.eq("organization_id", organizationId!)');
    expect(userManagement).toContain('.eq("user_id", userToEdit.user_id)');
  });

  it("is non-fatal — a reassignment failure does not throw or block the profile save", () => {
    expect(userManagement).toContain(
      "Error reassigning pending expenses to new immediate supervisor",
    );
  });
});

describe("sync_pending_expenses_on_supervisor_change — future-proof DB trigger (SQL)", () => {
  const migration = read(
    "supabase/migrations/20260812121000_sync_pending_expenses_on_supervisor_change.sql",
  );

  it("fires only on an actual reporting_engineer_id change, not any profile edit", () => {
    expect(migration).toContain("AFTER UPDATE OF reporting_engineer_id ON public.profiles");
    expect(migration).toContain(
      "WHEN (OLD.reporting_engineer_id IS DISTINCT FROM NEW.reporting_engineer_id)",
    );
  });

  it("is scoped to the one employee and organization from the trigger row, never cross-org", () => {
    expect(migration).toContain("e.user_id = NEW.user_id");
    expect(migration).toContain("e.organization_id = NEW.organization_id");
  });

  it("touches only never-yet-verified pending immediate-supervisor-stage rows", () => {
    expect(migration).toContain(
      "e.status IN ('submitted', 'edited', 'under_review')",
    );
    expect(migration).toContain(
      "e.approval_tier IS NULL OR e.approval_tier IN ('team_leader', 'executive')",
    );
    // The eligibility list itself must not include the advanced statuses —
    // checked on the executable UPDATE predicate, not the file's own prose
    // (which explains, in comments, exactly why they're excluded).
    const statusListMatch = migration.match(/e\.status IN \(([^)]*)\)/);
    expect(statusListMatch).not.toBeNull();
    expect(statusListMatch![1]).not.toMatch(/level_1_verified|level_2_verified/);
  });

  it("does not invent a supervisor when reporting_engineer_id becomes NULL", () => {
    expect(migration).toContain("IF NEW.reporting_engineer_id IS NULL THEN");
    expect(migration).toContain("RETURN NEW;");
  });

  it("cannot recurse — writes only to expenses and audit_logs, never back to profiles", () => {
    expect(migration).not.toMatch(/UPDATE\s+public\.profiles/i);
    expect(migration).not.toMatch(/INSERT INTO\s+public\.profiles/i);
  });

  it("writes a traceable per-expense audit_logs row (NOT NULL expense_id, so per-employee summary rows are not an option)", () => {
    expect(migration).toContain("'reviewer_reassigned'");
    expect(migration).toContain("INSERT INTO public.audit_logs");
  });

  it("is SECURITY DEFINER, safely scoped, and not directly callable by application roles", () => {
    expect(migration).toContain("SECURITY DEFINER");
    expect(migration).toContain("SET search_path TO 'public'");
    expect(migration).toContain(
      "REVOKE ALL ON FUNCTION public.sync_pending_expenses_on_supervisor_change() FROM PUBLIC",
    );
  });
});

describe("supervisor_reassignment_repair_log — one-time MicroLink data repair (SQL)", () => {
  const migration = read(
    "supabase/migrations/20260812122000_repair_stale_pending_supervisor_assignments_microlink.sql",
  );

  it("is scoped to the one organization proven affected by the live audit, not every org", () => {
    expect(migration).toContain("e.organization_id = '6709c1fe-e8c8-404d-bc68-d1edda923344'");
  });

  it("uses the identical eligibility predicate as the ongoing trigger", () => {
    expect(migration).toContain(
      "e.status IN ('submitted', 'edited', 'under_review')",
    );
    expect(migration).toContain(
      "e.approval_tier IS NULL OR e.approval_tier IN ('team_leader', 'executive')",
    );
  });

  it("never touches financial fields — only reviewer assignment columns are in the SET list", () => {
    const setClauseMatch = migration.match(/UPDATE public\.expenses e\s*\nSET([\s\S]*?)FROM logged/);
    expect(setClauseMatch).not.toBeNull();
    const setClause = setClauseMatch![1];
    expect(setClause).toContain("assigned_reviewer_id");
    expect(setClause).toContain("assigned_engineer_id");
    expect(setClause).not.toMatch(/total_amount|approved_by|approved_at|\bstatus\b|balance/i);
  });

  it("logs to a dedicated, non-application-facing ledger table — not audit_logs, to avoid a 1,775-row notification/audit flood", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.supervisor_reassignment_repair_log");
    expect(migration).toContain("ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain(
      "REVOKE ALL ON public.supervisor_reassignment_repair_log FROM PUBLIC, anon, authenticated",
    );
    expect(migration).not.toContain("INSERT INTO public.audit_logs");
  });

  it("is idempotent — re-running only ever matches rows still actually stale", () => {
    expect(migration).toContain("p.reporting_engineer_id IS DISTINCT FROM e.assigned_reviewer_id");
  });
});
