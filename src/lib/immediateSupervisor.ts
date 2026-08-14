/** Roles that may have an immediate supervisor stored on profiles.reporting_engineer_id. */
export type ImmediateSupervisorSubordinateRole = "employee" | "team_leader" | "executive";

export function roleShowsImmediateSupervisor(
  role: string,
): role is ImmediateSupervisorSubordinateRole {
  return role === "employee" || role === "team_leader" || role === "executive";
}

export function allowedSupervisorRolesFor(
  subordinateRole: ImmediateSupervisorSubordinateRole,
  options: { teamLeaderTierEnabled: boolean; executiveTierEnabled: boolean },
): string[] {
  switch (subordinateRole) {
    case "employee": {
      const roles: string[] = [];
      if (options.teamLeaderTierEnabled) roles.push("team_leader");
      if (options.executiveTierEnabled) roles.push("executive");
      roles.push("engineer");
      return roles;
    }
    case "team_leader": {
      const roles: string[] = ["engineer"];
      if (options.executiveTierEnabled) roles.unshift("executive");
      return roles;
    }
    case "executive":
      return ["engineer"];
    default:
      return [];
  }
}

export function immediateSupervisorFieldLabel(
  subordinateRole: ImmediateSupervisorSubordinateRole,
): string {
  if (subordinateRole === "employee") return "Immediate supervisor";
  return "Immediate supervisor";
}

export function immediateSupervisorFieldHint(
  subordinateRole: ImmediateSupervisorSubordinateRole,
): string {
  if (subordinateRole === "employee") {
    return "Team leader, executive, or manager (only roles your organization has enabled). Used for expense routing.";
  }
  if (subordinateRole === "team_leader") {
    return "Executive or manager this team leader reports to.";
  }
  return "Manager this executive reports to.";
}

export function isImmediateSupervisorRequired(
  subordinateRole: string,
  requireOrgSetting: boolean,
): boolean {
  return requireOrgSetting && roleShowsImmediateSupervisor(subordinateRole);
}
