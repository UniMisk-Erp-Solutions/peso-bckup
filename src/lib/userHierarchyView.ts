import { userMatchesManagementSearch, type RoleLabels } from "@/lib/approvalHierarchy";

export type HierarchyUserRow = {
  user_id: string;
  name: string;
  email: string;
  balance: number;
  role: string;
  reporting_engineer_id?: string;
  assigned_engineer_name?: string;
  cashier_assigned_engineer_name?: string;
  cashier_assigned_location_id?: string;
  cashier_assigned_location_name?: string;
};

export type HierarchyTeamLeaderNode = {
  user: HierarchyUserRow;
  employees: HierarchyUserRow[];
};

export type HierarchyExecutiveNode = {
  user: HierarchyUserRow;
  teamLeaders: HierarchyTeamLeaderNode[];
  employees: HierarchyUserRow[];
};

export type HierarchyEngineerNode = {
  engineer: HierarchyUserRow & {
    cashierCount: number;
    employeeCount: number;
    teamLeaderCount: number;
    executiveCount: number;
  };
  cashiers: HierarchyUserRow[];
  teamLeaders: HierarchyTeamLeaderNode[];
  executives: HierarchyExecutiveNode[];
  employees: HierarchyUserRow[];
};

export type UserHierarchyViewData = {
  hierarchyByLocation: Array<{
    location: { id: string; name: string };
    cashiers: HierarchyUserRow[];
    engineers: HierarchyEngineerNode[];
  }>;
  unassignedEngineers: HierarchyEngineerNode[];
  unassignedCashiers: HierarchyUserRow[];
  unassignedEmployees: HierarchyUserRow[];
  unassignedTeamLeaders: HierarchyUserRow[];
  unassignedExecutives: HierarchyUserRow[];
  admins: HierarchyUserRow[];
  totalEngineers: number;
  totalCashiers: number;
  totalEmployees: number;
  totalTeamLeaders: number;
  totalExecutives: number;
};

function directReports(
  users: HierarchyUserRow[],
  supervisorId: string,
  roles: string[],
): HierarchyUserRow[] {
  return users.filter(
    (u) => roles.includes(u.role) && u.reporting_engineer_id === supervisorId,
  );
}

function buildTeamLeaderNodes(
  users: HierarchyUserRow[],
  supervisorId: string,
): HierarchyTeamLeaderNode[] {
  return directReports(users, supervisorId, ["team_leader"]).map((tl) => ({
    user: tl,
    employees: directReports(users, tl.user_id, ["employee"]),
  }));
}

function buildExecutiveNodes(
  users: HierarchyUserRow[],
  supervisorId: string,
  teamLeaderTierEnabled: boolean,
): HierarchyExecutiveNode[] {
  return directReports(users, supervisorId, ["executive"]).map((ex) => ({
    user: ex,
    teamLeaders: teamLeaderTierEnabled
      ? buildTeamLeaderNodes(users, ex.user_id)
      : [],
    employees: directReports(users, ex.user_id, ["employee"]),
  }));
}

function countEmployeesUnderEngineer(node: Omit<HierarchyEngineerNode, "engineer">): number {
  let n = node.employees.length;
  for (const tl of node.teamLeaders) n += tl.employees.length;
  for (const ex of node.executives) {
    n += ex.employees.length;
    for (const tl of ex.teamLeaders) n += tl.employees.length;
  }
  return n;
}

function buildEngineerNode(
  engineer: HierarchyUserRow,
  users: HierarchyUserRow[],
  engineerLocations: Record<string, string>,
  teamLeaderTierEnabled: boolean,
  executiveTierEnabled: boolean,
): HierarchyEngineerNode {
  const engineerLocationId = engineerLocations[engineer.user_id];
  const allCashiers: HierarchyUserRow[] = [];

  if (engineerLocationId) {
    allCashiers.push(
      ...users.filter(
        (u) =>
          u.role === "cashier" &&
          u.cashier_assigned_location_id === engineerLocationId,
      ),
    );
  }

  if (allCashiers.length === 0) {
    allCashiers.push(
      ...users.filter(
        (u) =>
          u.role === "cashier" &&
          (u.cashier_assigned_engineer_id === engineer.user_id ||
            (u.cashier_assigned_engineer_id === undefined &&
              u.cashier_assigned_engineer_name === engineer.name)),
      ),
    );
  }

  const cashiers = allCashiers
    .filter(
      (cashier, index, self) =>
        index === self.findIndex((c) => c.user_id === cashier.user_id),
    )
    .slice(0, 1);

  const teamLeaders = teamLeaderTierEnabled
    ? buildTeamLeaderNodes(users, engineer.user_id)
    : [];
  const executives = executiveTierEnabled
    ? buildExecutiveNodes(users, engineer.user_id, teamLeaderTierEnabled)
    : [];
  const employees = directReports(users, engineer.user_id, ["employee"]);

  const base = { cashiers, teamLeaders, executives, employees };
  const employeeCount = countEmployeesUnderEngineer(base);

  return {
    ...base,
    engineer: {
      ...engineer,
      cashierCount: cashiers.length,
      employeeCount,
      teamLeaderCount: teamLeaders.length,
      executiveCount: executives.length,
    },
  };
}

export function buildUserHierarchyView(
  users: HierarchyUserRow[],
  locations: Array<{ id: string; name: string }>,
  engineerLocations: Record<string, string>,
  options: { teamLeaderTierEnabled: boolean; executiveTierEnabled: boolean },
): UserHierarchyViewData {
  const engineerUsers = users.filter((u) => u.role === "engineer");
  const locationHierarchy: Record<string, HierarchyEngineerNode[]> = {};
  const unassignedEngineers: HierarchyEngineerNode[] = [];

  engineerUsers.forEach((engineer) => {
    const node = buildEngineerNode(
      engineer,
      users,
      engineerLocations,
      options.teamLeaderTierEnabled,
      options.executiveTierEnabled,
    );
    const locationId = engineerLocations[engineer.user_id];
    if (!locationId) {
      unassignedEngineers.push(node);
    } else {
      if (!locationHierarchy[locationId]) locationHierarchy[locationId] = [];
      locationHierarchy[locationId].push(node);
    }
  });

  const locationCashiers: Record<string, HierarchyUserRow[]> = {};
  users
    .filter((u) => u.role === "cashier" && u.cashier_assigned_location_id)
    .forEach((cashier) => {
      const locationId = cashier.cashier_assigned_location_id!;
      if (!locationCashiers[locationId]) locationCashiers[locationId] = [];
      locationCashiers[locationId].push(cashier);
    });

  const hierarchyByLocation = locations
    .map((location) => {
      const engineers = locationHierarchy[location.id] || [];
      const locationCashierIds = new Set(
        (locationCashiers[location.id] || []).map((c) => c.user_id),
      );
      return {
        location,
        cashiers: locationCashiers[location.id] || [],
        engineers: engineers.map((eng) => ({
          ...eng,
          cashiers: eng.cashiers.filter((c) => !locationCashierIds.has(c.user_id)),
        })),
      };
    })
    .filter((loc) => loc.engineers.length > 0 || loc.cashiers.length > 0);

  const hasSupervisor = (u: HierarchyUserRow) => Boolean(u.reporting_engineer_id);

  return {
    hierarchyByLocation,
    unassignedEngineers,
    unassignedCashiers: users.filter(
      (u) =>
        u.role === "cashier" &&
        !u.cashier_assigned_engineer_name &&
        !u.cashier_assigned_location_id,
    ),
    unassignedEmployees: users.filter(
      (u) => u.role === "employee" && !hasSupervisor(u),
    ),
    unassignedTeamLeaders: options.teamLeaderTierEnabled
      ? users.filter((u) => u.role === "team_leader" && !hasSupervisor(u))
      : [],
    unassignedExecutives: options.executiveTierEnabled
      ? users.filter((u) => u.role === "executive" && !hasSupervisor(u))
      : [],
    admins: users.filter((u) => u.role === "admin"),
    totalEngineers: engineerUsers.length,
    totalCashiers: users.filter((u) => u.role === "cashier").length,
    totalEmployees: users.filter((u) => u.role === "employee").length,
    totalTeamLeaders: options.teamLeaderTierEnabled
      ? users.filter((u) => u.role === "team_leader").length
      : 0,
    totalExecutives: options.executiveTierEnabled
      ? users.filter((u) => u.role === "executive").length
      : 0,
  };
}

export function hierarchyNodeMatchesSearch(
  item: HierarchyEngineerNode,
  search: string,
  roleLabels?: RoleLabels | null,
): boolean {
  const personMatch = (u: HierarchyUserRow) =>
    userMatchesManagementSearch(
      { name: u.name, email: u.email, role: u.role },
      search,
      roleLabels,
    );

  if (personMatch(item.engineer)) return true;
  if (item.cashiers.some(personMatch)) return true;
  if (item.employees.some(personMatch)) return true;
  if (item.teamLeaders.some((tl) => personMatch(tl.user) || tl.employees.some(personMatch)))
    return true;
  if (
    item.executives.some(
      (ex) =>
        personMatch(ex.user) ||
        ex.employees.some(personMatch) ||
        ex.teamLeaders.some((tl) => personMatch(tl.user) || tl.employees.some(personMatch)),
    )
  ) {
    return true;
  }
  return false;
}
