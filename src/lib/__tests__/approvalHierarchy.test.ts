import { describe, expect, it } from "vitest";
import {
  adjustStartTierForSubmitterRole,
  buildHierarchyFlags,
  canRoleActOnExpense,
  canRoleApprove,
  isAdminApprovableStatus,
  resolveExecutiveReviewerId,
  resolveInitialAssignment,
  resolveNextTierAfterVerify,
} from "@/lib/approvalHierarchy";

describe("approvalHierarchy", () => {
  it("buildHierarchyFlags requires master for sub-tiers", () => {
    expect(
      buildHierarchyFlags({
        approval_hierarchy: true,
        hierarchy_team_leader: true,
        hierarchy_executive: false,
      }).hierarchy_team_leader,
    ).toBe(true);
    expect(
      buildHierarchyFlags({
        approval_hierarchy: false,
        hierarchy_team_leader: true,
      }).hierarchy_team_leader,
    ).toBe(false);
  });

  it("team_leader and executive cannot approve", () => {
    expect(canRoleApprove("team_leader")).toBe(false);
    expect(canRoleApprove("executive")).toBe(false);
    expect(canRoleApprove("engineer")).toBe(true);
  });

  it("isAdminApprovableStatus includes hierarchy intermediate statuses", () => {
    expect(isAdminApprovableStatus("verified")).toBe(true);
    expect(isAdminApprovableStatus("level_1_verified")).toBe(true);
    expect(isAdminApprovableStatus("level_2_verified")).toBe(true);
    expect(isAdminApprovableStatus("approved")).toBe(false);
  });

  it("resolveInitialAssignment uses team leader when enabled", () => {
    const flags = buildHierarchyFlags({
      approval_hierarchy: true,
      hierarchy_team_leader: true,
      hierarchy_executive: false,
    });
    const assignment = resolveInitialAssignment({
      flags,
      team: {
        id: "t1",
        name: "A",
        routing_mode: "full",
        team_leader_user_id: "tl-1",
        executive_user_id: null,
        manager_user_id: "mgr-1",
      },
      reportingEngineerId: "eng-1",
    });
    expect(assignment.approval_tier).toBe("team_leader");
    expect(assignment.assigned_reviewer_id).toBe("tl-1");
  });

  it("skip_to_manager bypasses TL and exec", () => {
    const flags = buildHierarchyFlags({
      approval_hierarchy: true,
      hierarchy_team_leader: true,
      hierarchy_executive: true,
    });
    const assignment = resolveInitialAssignment({
      flags,
      team: {
        id: "t1",
        name: "B",
        routing_mode: "skip_to_manager",
        team_leader_user_id: "tl-1",
        executive_user_id: "ex-1",
        manager_user_id: "mgr-1",
      },
      reportingEngineerId: null,
    });
    expect(assignment.approval_tier).toBe("engineer");
    expect(assignment.assigned_engineer_id).toBe("mgr-1");
  });

  it("uses immediate supervisor as team leader when no team assignment", () => {
    const flags = buildHierarchyFlags({
      approval_hierarchy: true,
      hierarchy_team_leader: true,
      hierarchy_executive: false,
    });
    const assignment = resolveInitialAssignment({
      flags,
      team: null,
      reportingEngineerId: "tl-direct",
      reportingSupervisorRole: "team_leader",
    });
    expect(assignment.approval_tier).toBe("team_leader");
    expect(assignment.assigned_reviewer_id).toBe("tl-direct");
  });

  it("team leader submitter skips own tier", () => {
    const flags = buildHierarchyFlags({
      approval_hierarchy: true,
      hierarchy_team_leader: true,
      hierarchy_executive: false,
    });
    const assignment = resolveInitialAssignment({
      flags,
      team: {
        id: "t1",
        name: "A",
        routing_mode: "full",
        team_leader_user_id: "tl-1",
        executive_user_id: null,
        manager_user_id: "mgr-1",
      },
      reportingEngineerId: "mgr-1",
      submitterRole: "team_leader",
    });
    expect(assignment.approval_tier).toBe("engineer");
    expect(assignment.assigned_reviewer_id).toBe("mgr-1");
  });

  it("adjustStartTierForSubmitterRole skips executive for executive submitter", () => {
    const flags = buildHierarchyFlags({
      approval_hierarchy: true,
      hierarchy_team_leader: true,
      hierarchy_executive: true,
    });
    expect(
      adjustStartTierForSubmitterRole("team_leader", "executive", flags),
    ).toBe("engineer");
  });

  it("team leader may act when only assigned as managing engineer", () => {
    expect(
      canRoleActOnExpense(
        "team_leader",
        "team_leader",
        null,
        "tl-1",
        "tl-1",
      ),
    ).toBe(true);
  });

  // A persisted final-tier assignment cannot override role authorization.
  // Historical rows may contain the immediate Executive here even though the
  // reporting chain's engineer-role Manager is the real final approver.
  it("an executive assigned at the terminal engineer tier is still denied", () => {
    expect(
      canRoleActOnExpense("executive", "engineer", "exec-1", "exec-1", "exec-1"),
    ).toBe(false);
  });

  it("a team leader assigned at the terminal engineer tier is also denied", () => {
    expect(
      canRoleActOnExpense("team_leader", "engineer", "tl-1", "tl-1", "tl-1"),
    ).toBe(false);
  });

  it("an executive who is NOT assigned to this expense at all is still rejected", () => {
    expect(
      canRoleActOnExpense("executive", "engineer", "other-1", "exec-1", "other-1"),
    ).toBe(false);
  });

  it("an executive verifying at their OWN tier is unaffected by the engineer-tier bypass", () => {
    expect(
      canRoleActOnExpense("executive", "executive", "exec-1", "exec-1", "exec-1"),
    ).toBe(true);
  });

  it("a genuine engineer assigned at the engineer tier still works exactly as before", () => {
    expect(
      canRoleActOnExpense("engineer", "engineer", "mgr-1", "mgr-1", "mgr-1"),
    ).toBe(true);
  });

  it("Level 2 routes to team leader immediate superior (executive)", () => {
    const flags = buildHierarchyFlags({
      approval_hierarchy: true,
      hierarchy_team_leader: true,
      hierarchy_executive: true,
    });
    const next = resolveNextTierAfterVerify("team_leader", {
      flags,
      team: {
        id: "t1",
        name: "A",
        routing_mode: "full",
        team_leader_user_id: "tl-1",
        executive_user_id: null,
        manager_user_id: "mgr-1",
      },
      reportingEngineerId: "tl-1",
      reportingSupervisorRole: "team_leader",
      verifierSupervisorId: "ex-boss",
      verifierSupervisorRole: "executive",
    });
    expect(next.approval_tier).toBe("executive");
    expect(next.assigned_reviewer_id).toBe("ex-boss");
    expect(next.assigned_engineer_id).toBe("mgr-1");
  });

  it("resolveExecutiveReviewerId prefers verifier supervisor over team executive", () => {
    const flags = buildHierarchyFlags({
      approval_hierarchy: true,
      hierarchy_team_leader: true,
      hierarchy_executive: true,
    });
    const id = resolveExecutiveReviewerId({
      flags,
      team: {
        id: "t1",
        name: "A",
        routing_mode: "full",
        team_leader_user_id: "tl-1",
        executive_user_id: "ex-team",
        manager_user_id: "mgr-1",
      },
      reportingEngineerId: "tl-1",
      reportingSupervisorRole: "team_leader",
      verifierSupervisorId: "ex-direct",
      verifierSupervisorRole: "executive",
    });
    expect(id).toBe("ex-direct");
  });

  it("resolveExecutiveReviewerId prefers immediate supervisor executive over team executive", () => {
    const id = resolveExecutiveReviewerId({
      flags: buildHierarchyFlags({
        approval_hierarchy: true,
        hierarchy_team_leader: true,
        hierarchy_executive: true,
      }),
      team: {
        id: "t1",
        name: "A",
        routing_mode: "full",
        team_leader_user_id: "tl-1",
        executive_user_id: "ex-team",
        manager_user_id: "mgr-1",
      },
      reportingEngineerId: "ex-direct",
      reportingSupervisorRole: "executive",
    });
    expect(id).toBe("ex-direct");
  });

  it("supervisor team leader wins over team-assigned team leader", () => {
    const flags = buildHierarchyFlags({
      approval_hierarchy: true,
      hierarchy_team_leader: true,
      hierarchy_executive: false,
    });
    const assignment = resolveInitialAssignment({
      flags,
      team: {
        id: "t1",
        name: "A",
        routing_mode: "full",
        team_leader_user_id: "tl-team",
        executive_user_id: null,
        manager_user_id: "mgr-1",
      },
      reportingEngineerId: "tl-supervisor",
      reportingSupervisorRole: "team_leader",
    });
    expect(assignment.assigned_reviewer_id).toBe("tl-supervisor");
  });

  it("manager tier prefers supervisor engineer over team manager", () => {
    const flags = buildHierarchyFlags({
      approval_hierarchy: true,
      hierarchy_team_leader: false,
      hierarchy_executive: false,
    });
    const assignment = resolveInitialAssignment({
      flags,
      team: {
        id: "t1",
        name: "B",
        routing_mode: "skip_to_manager",
        team_leader_user_id: null,
        executive_user_id: null,
        manager_user_id: "mgr-team",
      },
      reportingEngineerId: "mgr-supervisor",
      reportingSupervisorRole: "engineer",
    });
    expect(assignment.approval_tier).toBe("engineer");
    expect(assignment.assigned_reviewer_id).toBe("mgr-supervisor");
  });

  it("executive tier keeps managing engineer on assigned_engineer_id for manager visibility", () => {
    const flags = buildHierarchyFlags({
      approval_hierarchy: true,
      hierarchy_team_leader: true,
      hierarchy_executive: true,
    });
    const next = resolveNextTierAfterVerify("team_leader", {
      flags,
      team: {
        id: "t1",
        name: "A",
        routing_mode: "full",
        team_leader_user_id: "tl-1",
        executive_user_id: "ex-team",
        manager_user_id: "mgr-1",
      },
      reportingEngineerId: "tl-1",
      reportingSupervisorRole: "team_leader",
      verifierSupervisorId: "ex-direct",
      verifierSupervisorRole: "executive",
      managingEngineerId: "mgr-1",
    });
    expect(next.approval_tier).toBe("executive");
    expect(next.assigned_reviewer_id).toBe("ex-direct");
    expect(next.assigned_engineer_id).toBe("mgr-1");
  });

  it("advance from executive to manager at engineer tier", () => {
    const flags = buildHierarchyFlags({
      approval_hierarchy: true,
      hierarchy_team_leader: true,
      hierarchy_executive: true,
    });
    const next = resolveNextTierAfterVerify("executive", {
      flags,
      team: {
        id: "t1",
        name: "A",
        routing_mode: "full",
        team_leader_user_id: "tl-1",
        executive_user_id: "ex-1",
        manager_user_id: "mgr-1",
      },
      reportingEngineerId: null,
      managingEngineerId: "mgr-1",
    });
    expect(next.approval_tier).toBe("engineer");
    expect(next.assigned_reviewer_id).toBe("mgr-1");
    expect(next.assigned_engineer_id).toBe("mgr-1");
  });

  it("advance from team_leader to engineer when exec disabled", () => {
    const flags = buildHierarchyFlags({
      approval_hierarchy: true,
      hierarchy_team_leader: true,
      hierarchy_executive: false,
    });
    const next = resolveNextTierAfterVerify("team_leader", {
      flags,
      team: {
        id: "t1",
        name: "A",
        routing_mode: "full",
        team_leader_user_id: "tl-1",
        executive_user_id: null,
        manager_user_id: "mgr-1",
      },
      reportingEngineerId: null,
    });
    expect(next.approval_tier).toBe("engineer");
    expect(next.assigned_reviewer_id).toBe("mgr-1");
  });
});
