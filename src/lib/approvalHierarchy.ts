import { ORGANIZATION_FEATURE_KEYS } from "@/lib/organizationFeatureKeys";
import { employeeIdFromSyntheticEmail } from "@/lib/personIdentitySearch";
import type { OrganizationIdentityPolicy } from "@/lib/organizationIdentityMode";

export type ApprovalTier = "team_leader" | "executive" | "engineer" | "admin";

export type TeamRoutingMode = "full" | "skip_to_manager" | "skip_to_admin";

export type HierarchyAppRole =
  | "admin"
  | "engineer"
  | "employee"
  | "cashier"
  | "team_leader"
  | "executive";

export type RoleLabels = Partial<
  Record<"employee" | "team_leader" | "executive" | "engineer" | "admin", string>
>;

export const DEFAULT_ROLE_LABELS: Required<RoleLabels> = {
  employee: "Employee",
  team_leader: "Team Leader",
  executive: "Executive",
  engineer: "Manager",
  admin: "Admin",
};

export type HierarchyFeatureFlags = {
  approval_hierarchy: boolean;
  hierarchy_team_leader: boolean;
  hierarchy_executive: boolean;
};

export type TeamContext = {
  id: string;
  name: string;
  routing_mode: TeamRoutingMode;
  team_leader_user_id: string | null;
  executive_user_id: string | null;
  manager_user_id: string | null;
};

export type ExpenseAssignment = {
  approval_tier: ApprovalTier | null;
  assigned_reviewer_id: string | null;
  assigned_engineer_id: string | null;
};

export function buildHierarchyFlags(
  featureFlags: Record<string, boolean>,
): HierarchyFeatureFlags {
  const master = !!featureFlags[ORGANIZATION_FEATURE_KEYS.approval_hierarchy];
  return {
    approval_hierarchy: master,
    hierarchy_team_leader:
      master && !!featureFlags[ORGANIZATION_FEATURE_KEYS.hierarchy_team_leader],
    hierarchy_executive:
      master && !!featureFlags[ORGANIZATION_FEATURE_KEYS.hierarchy_executive],
  };
}

export function isHierarchyEnabled(flags: HierarchyFeatureFlags): boolean {
  return flags.approval_hierarchy;
}

export function isHierarchyTierEnabled(
  flags: HierarchyFeatureFlags,
  tier: "team_leader" | "executive",
): boolean {
  if (!flags.approval_hierarchy) return false;
  if (tier === "team_leader") return flags.hierarchy_team_leader;
  return flags.hierarchy_executive;
}

/** Ordered tiers that may appear in routing (engineer/admin always possible at end). */
export function getEnabledTiers(flags: HierarchyFeatureFlags): ApprovalTier[] {
  const tiers: ApprovalTier[] = [];
  if (flags.hierarchy_team_leader) tiers.push("team_leader");
  if (flags.hierarchy_executive) tiers.push("executive");
  tiers.push("engineer", "admin");
  return tiers;
}

export function tierToMembershipRole(tier: ApprovalTier): HierarchyAppRole {
  if (tier === "team_leader") return "team_leader";
  if (tier === "executive") return "executive";
  if (tier === "engineer") return "engineer";
  return "admin";
}

export function membershipRoleToTier(role: string): ApprovalTier | null {
  if (role === "team_leader") return "team_leader";
  if (role === "executive") return "executive";
  if (role === "engineer") return "engineer";
  if (role === "admin") return "admin";
  return null;
}

export function getRoleLabel(
  role: keyof RoleLabels | string,
  labels?: RoleLabels | null,
): string {
  const key = role as keyof RoleLabels;
  return labels?.[key]?.trim() || DEFAULT_ROLE_LABELS[key] || role;
}

export type UserManagementSearchFields = {
  name: string;
  email: string;
  role: string;
  employee_id?: string | null;
};

/**
 * All Users table / hierarchy search.
 *
 * Pass `identityPolicy` (from `resolveOrganizationIdentityPolicy`) to suppress
 * email searching in employee-ID-only organizations.  When omitted the old
 * all-fields behavior is preserved for callers that have not yet been updated.
 */
export function userMatchesManagementSearch(
  user: UserManagementSearchFields,
  search: string,
  roleLabels?: RoleLabels | null,
  identityPolicy?: OrganizationIdentityPolicy | null,
): boolean {
  const q = search.trim().toLowerCase();
  if (!q) return true;

  const roleKey = user.role.toLowerCase();
  const roleLabel = getRoleLabel(user.role, roleLabels).toLowerCase();
  const roleKeySpaced = roleKey.replace(/_/g, " ");

  // Name — always searched
  if (user.name.toLowerCase().includes(q)) return true;

  // Role — always searched
  if (roleKey.includes(q) || roleKeySpaced.includes(q) || roleLabel.includes(q)) return true;

  // Employee ID
  const shouldSearchId = !identityPolicy || identityPolicy.includeEmployeeIdInSearch;
  if (shouldSearchId && user.employee_id && String(user.employee_id).toLowerCase().includes(q)) {
    return true;
  }

  // Synthetic email fallback: only the extracted ID portion, never the full email
  if (identityPolicy?.allowSyntheticEmployeeIdFallback && user.email) {
    const extracted = employeeIdFromSyntheticEmail(user.email);
    if (extracted && extracted.toLowerCase().includes(q)) return true;
  }

  // Real email — only when the policy includes it (or no policy supplied → legacy behavior)
  const shouldSearchEmail = !identityPolicy || identityPolicy.includeEmailInSearch;
  if (shouldSearchEmail && user.email.toLowerCase().includes(q)) return true;

  return false;
}

export function canRoleApprove(role: string): boolean {
  return role === "engineer" || role === "admin";
}

/** Expense statuses an org admin may approve from (skips hierarchy tier requirements). */
export const ADMIN_APPROVABLE_STATUSES = [
  "submitted",
  "edited",
  "verified",
  "level_1_verified",
  "level_2_verified",
] as const;

export type AdminApprovableStatus = (typeof ADMIN_APPROVABLE_STATUSES)[number];

export function isAdminApprovableStatus(status: string): status is AdminApprovableStatus {
  return (ADMIN_APPROVABLE_STATUSES as readonly string[]).includes(status);
}

export function canRoleVerifyAtTier(role: string, tier: ApprovalTier | null): boolean {
  if (!tier) return role === "engineer" || role === "admin";
  if (tier === "team_leader") return role === "team_leader";
  if (tier === "executive") return role === "executive";
  if (tier === "engineer") return role === "engineer";
  return role === "admin";
}

export function canRoleActOnExpense(
  role: string,
  tier: ApprovalTier | null,
  assignedReviewerId: string | null,
  userId: string,
  assignedEngineerId?: string | null,
): boolean {
  if (role === "admin" && tier === "admin") return true;

  const isReviewer = assignedReviewerId === userId;
  const isManagingEngineer = assignedEngineerId === userId;
  if (!isReviewer && !isManagingEngineer) return false;

  if (!tier) {
    return (
      (role === "team_leader" || role === "executive") && isManagingEngineer
    );
  }

  if (isReviewer && canRoleVerifyAtTier(role, tier)) return true;

  if (isManagingEngineer) {
    if (canRoleVerifyAtTier(role, tier)) return true;
    if (role === "team_leader" && tier === "team_leader") return true;
    if (role === "executive" && tier === "executive") return true;
  }

  return false;
}

export type ResolveAssignmentInput = {
  flags: HierarchyFeatureFlags;
  team: TeamContext | null;
  reportingEngineerId: string | null;
  /** Membership role of reportingEngineerId when set (enables direct supervisor routing). */
  reportingSupervisorRole?: string | null;
  /** Submitter membership role — skips routing to their own tier (TL/exec cannot approve self). */
  submitterRole?: string | null;
  /** First active admin user id for admin-tier queue when unassigned */
  fallbackAdminUserId?: string | null;
  /** Who the verifying team leader reports to (Level 2 = TL's immediate superior). */
  verifierSupervisorId?: string | null;
  verifierSupervisorRole?: string | null;
  /** Submitter's supervisor's supervisor (employee → TL → executive chain). */
  supervisorReportingEngineerId?: string | null;
  supervisorReportingRole?: string | null;
  /** Manager (engineer) who keeps visibility while expense is at TL/executive tiers. */
  managingEngineerId?: string | null;
};

/** Level 2 reviewer after team leader verification (must be executive-capable). */
export function resolveExecutiveReviewerId(input: ResolveAssignmentInput): string | null {
  const {
    team,
    reportingEngineerId,
    reportingSupervisorRole,
    verifierSupervisorId,
    verifierSupervisorRole,
    supervisorReportingEngineerId,
    supervisorReportingRole,
  } = input;

  if (verifierSupervisorRole === "executive" && verifierSupervisorId) {
    return verifierSupervisorId;
  }

  if (reportingSupervisorRole === "executive" && reportingEngineerId) {
    return reportingEngineerId;
  }

  if (supervisorReportingRole === "executive" && supervisorReportingEngineerId) {
    return supervisorReportingEngineerId;
  }

  if (team?.executive_user_id) {
    return team.executive_user_id;
  }

  return null;
}

function resolveManagingEngineerForAssignment(
  input: ResolveAssignmentInput,
): string | null {
  if (input.managingEngineerId) return input.managingEngineerId;
  return resolveReviewerForTier("engineer", input);
}

function assignmentForTier(
  tier: ApprovalTier,
  reviewerId: string | null,
  input: ResolveAssignmentInput,
): ExpenseAssignment {
  if (tier === "admin") {
    return {
      approval_tier: "admin",
      assigned_reviewer_id: null,
      assigned_engineer_id: null,
    };
  }

  const managingEngineerId = resolveManagingEngineerForAssignment(input);

  return {
    approval_tier: tier,
    assigned_reviewer_id: reviewerId,
    assigned_engineer_id:
      tier === "engineer"
        ? reviewerId
        : managingEngineerId ?? reviewerId,
  };
}

function resolveReviewerForTier(
  tier: ApprovalTier,
  input: ResolveAssignmentInput,
): string | null {
  const {
    team,
    reportingEngineerId,
    reportingSupervisorRole,
    fallbackAdminUserId,
  } = input;

  if (tier === "team_leader") {
    const supervisorTl =
      reportingSupervisorRole === "team_leader" ? reportingEngineerId : null;
    return supervisorTl ?? team?.team_leader_user_id ?? null;
  }
  if (tier === "executive") {
    return resolveExecutiveReviewerId(input);
  }
  if (tier === "engineer") {
    const managerFromSupervisor =
      reportingSupervisorRole === "engineer" || reportingSupervisorRole === "admin"
        ? reportingEngineerId
        : null;
    return managerFromSupervisor ?? team?.manager_user_id ?? reportingEngineerId ?? null;
  }
  return fallbackAdminUserId ?? null;
}

function firstTierAfterSkip(
  flags: HierarchyFeatureFlags,
  team: TeamContext | null,
): ApprovalTier {
  if (team?.routing_mode === "skip_to_admin") return "admin";
  if (team?.routing_mode === "skip_to_manager") return "engineer";
  const enabled = getEnabledTiers(flags);
  return enabled[0] ?? "engineer";
}

/** Do not route an expense to the submitter's own hierarchy tier. */
export function adjustStartTierForSubmitterRole(
  startTier: ApprovalTier,
  submitterRole: string | null | undefined,
  flags: HierarchyFeatureFlags,
): ApprovalTier {
  const submitterTier = membershipRoleToTier(submitterRole ?? "");
  if (!submitterTier || submitterTier === "admin") return startTier;

  const order = getEnabledTiers(flags);
  const startIdx = order.indexOf(startTier);
  const submitterIdx = order.indexOf(submitterTier);
  if (submitterIdx < 0) return startTier;

  const nextIdx = Math.max(startIdx < 0 ? 0 : startIdx, submitterIdx + 1);
  return order[nextIdx] ?? "admin";
}

/** Walk enabled tiers starting at `startTier` to find next tier with a resolvable reviewer. */
function findNextResolvableTier(
  input: ResolveAssignmentInput,
  startTier: ApprovalTier,
): ExpenseAssignment {
  const order = getEnabledTiers(input.flags);
  const startIdx = order.indexOf(startTier);
  for (let i = Math.max(0, startIdx); i < order.length; i++) {
    const tier = order[i];
    const reviewerId = resolveReviewerForTier(tier, input);
    if (tier === "admin" || reviewerId) {
      return assignmentForTier(tier, reviewerId, input);
    }
  }
  return assignmentForTier("admin", null, input);
}

/** Engineer (manager) who owns this expense through the hierarchy chain (for RLS / reporting). */
export function resolveManagingEngineerId(
  input: ResolveAssignmentInput,
): string | null {
  const assignment = findNextResolvableTier(input, "engineer");
  if (assignment.approval_tier === "engineer" && assignment.assigned_reviewer_id) {
    return assignment.assigned_reviewer_id;
  }
  return null;
}

export function resolveInitialAssignment(
  input: ResolveAssignmentInput,
): ExpenseAssignment {
  const {
    flags,
    team,
    reportingEngineerId,
    reportingSupervisorRole,
    submitterRole,
    fallbackAdminUserId,
  } = input;
  if (!flags.approval_hierarchy) {
    return {
      approval_tier: null,
      assigned_reviewer_id: null,
      assigned_engineer_id: reportingEngineerId,
    };
  }

  const startTier = adjustStartTierForSubmitterRole(
    firstTierAfterSkip(flags, team),
    submitterRole,
    flags,
  );
  return findNextResolvableTier(input, startTier);
}

export function resolveNextTierAfterVerify(
  currentTier: ApprovalTier,
  input: ResolveAssignmentInput,
): ExpenseAssignment {
  const { flags } = input;
  const order = getEnabledTiers(flags);
  const idx = order.indexOf(currentTier);
  const nextTier = order[idx + 1];

  if (!nextTier) {
    return assignmentForTier("admin", null, input);
  }

  if (currentTier === "team_leader" && nextTier === "executive" && flags.hierarchy_executive) {
    const executiveId = resolveExecutiveReviewerId(input);
    if (executiveId) {
      return assignmentForTier("executive", executiveId, input);
    }
  }

  if (currentTier === "executive" && nextTier === "engineer") {
    const managerId = resolveReviewerForTier("engineer", input);
    if (managerId) {
      return assignmentForTier("engineer", managerId, input);
    }
  }

  return findNextResolvableTier(input, nextTier);
}

/** Clear hierarchy fields on reject resubmit path */
export function clearHierarchyOnReject(): ExpenseAssignment {
  return {
    approval_tier: null,
    assigned_reviewer_id: null,
    assigned_engineer_id: null,
  };
}
