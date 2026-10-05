import { supabase } from "@/integrations/supabase/client";
import { fetchProfilesByUserIds } from "@/lib/supabaseInQuery";

export interface OrganizationUserRow {
  user_id: string;
  name: string;
  email: string;
  employee_id?: string | null;
  balance: number;
  role: string;
}

export type UserManagementListRow = OrganizationUserRow & {
  is_active: boolean;
  deactivated_at?: string | null;
  assigned_engineer_name?: string;
  cashier_assigned_engineer_name?: string;
  cashier_assigned_location_id?: string;
  cashier_assigned_location_name?: string;
  assigned_cashier_name?: string;
  cashier_assigned_engineer_id?: string;
  reporting_engineer_id?: string;
  team_id?: string;
  team_name?: string;
};

function isSchemaMismatchError(error: unknown): boolean {
  const e = error as { code?: string; message?: string; status?: number };
  if (!e) return false;
  if (e.code === "42703" || e.code === "PGRST204") return true;
  const msg = String(e.message ?? "").toLowerCase();
  if (msg.includes("does not exist") || msg.includes("could not find")) return true;
  return e.status === 400;
}

/** Active roles for every member in an org — one short query (no giant user_id=in URL). */
export async function fetchOrgMembershipRolesMap(
  organizationId: string,
): Promise<Record<string, string>> {
  let { data: rolesRows, error: rolesErr } = await supabase
    .from("organization_memberships")
    .select("user_id, role")
    .eq("organization_id", organizationId)
    .eq("is_active", true);

  if (rolesErr && isSchemaMismatchError(rolesErr)) {
    const retry = await supabase
      .from("organization_memberships")
      .select("user_id, role")
      .eq("organization_id", organizationId);
    rolesRows = retry.data;
    rolesErr = retry.error;
  }

  if (rolesErr) throw rolesErr;

  const rolesById: Record<string, string> = {};
  for (const row of rolesRows || []) {
    rolesById[row.user_id] = row.role;
  }
  return rolesById;
}

/**
 * Load org users the same way as User Management: profiles for the org, then
 * organization_memberships roles (default "employee" when missing).
 */
export async function fetchOrganizationUsers(
  organizationId: string,
): Promise<OrganizationUserRow[]> {
  const withEmployeeId = "user_id, name, email, employee_id, balance";
  const withoutEmployeeId = "user_id, name, email, balance";

  let { data: profiles, error: profilesError } = await supabase
    .from("profiles")
    .select(withEmployeeId)
    .eq("organization_id", organizationId)
    .order("name", { ascending: true });

  if (profilesError && isSchemaMismatchError(profilesError)) {
    const retry = await supabase
      .from("profiles")
      .select(withoutEmployeeId)
      .eq("organization_id", organizationId)
      .order("name", { ascending: true });
    profiles = retry.data as typeof profiles;
    profilesError = retry.error;
  }

  if (profilesError) throw profilesError;

  const rolesById = await fetchOrgMembershipRolesMap(organizationId);

  return (profiles || []).map((p) => ({
    user_id: p.user_id,
    name: String(p.name ?? "").trim(),
    email: String(p.email ?? "").trim(),
    employee_id: "employee_id" in p ? (p.employee_id ?? null) : null,
    balance: Number(p.balance ?? 0),
    role: rolesById[p.user_id] || "employee",
  }));
}

/** Full user list for User Management (roles, supervisors, cashiers, locations). */
export async function fetchUserManagementList(
  organizationId: string,
  rolesById?: Record<string, string>,
): Promise<UserManagementListRow[]> {
  const { data: profiles, error: profilesError } = await supabase
    .from("profiles")
    .select(
      "user_id, name, email, employee_id, balance, is_active, deactivated_at, reporting_engineer_id, cashier_assigned_engineer_id, cashier_assigned_location_id, assigned_cashier_id",
    )
    .eq("organization_id", organizationId);

  if (profilesError) throw profilesError;

  const roleMap =
    rolesById && Object.keys(rolesById).length > 0
      ? rolesById
      : await fetchOrgMembershipRolesMap(organizationId);

  const supervisorUserIds = [
    ...new Set(
      (profiles || [])
        .map((p) => p.reporting_engineer_id)
        .filter((id): id is string => id != null && id !== ""),
    ),
  ];
  const cashierEngineerIds = [
    ...new Set(
      (profiles || [])
        .map((p) => p.cashier_assigned_engineer_id)
        .filter((id): id is string => id != null && id !== ""),
    ),
  ];
  const allSupervisorLookupIds = [...new Set([...supervisorUserIds, ...cashierEngineerIds])];
  const assignedCashierIds = [
    ...new Set(
      (profiles || [])
        .map((p) => p.assigned_cashier_id)
        .filter((id): id is string => id != null && id !== ""),
    ),
  ];

  const supervisorProfiles = allSupervisorLookupIds.length
    ? ((await fetchProfilesByUserIds(
        supabase,
        organizationId,
        allSupervisorLookupIds,
        "user_id, name",
      )) as { user_id: string; name: string }[])
    : [];

  const supervisorNamesById: Record<string, string> = {};
  for (const ep of supervisorProfiles) {
    supervisorNamesById[ep.user_id] = ep.name;
  }

  const cashierProfiles = assignedCashierIds.length
    ? ((await fetchProfilesByUserIds(
        supabase,
        organizationId,
        assignedCashierIds,
        "user_id, name",
      )) as { user_id: string; name: string }[])
    : [];

  const cashierNamesById: Record<string, string> = {};
  for (const cp of cashierProfiles) {
    cashierNamesById[cp.user_id] = cp.name;
  }

  const cashierLocationIds = [
    ...new Set(
      (profiles || [])
        .map((p) => p.cashier_assigned_location_id)
        .filter((id): id is string => id != null && id !== ""),
    ),
  ];

  const locationNamesById: Record<string, string> = {};
  if (cashierLocationIds.length > 0) {
    const { data: locationData, error: locationError } = await supabase
      .from("locations")
      .select("id, name")
      .in("id", cashierLocationIds);
    if (!locationError && locationData) {
      for (const loc of locationData) {
        locationNamesById[loc.id] = loc.name;
      }
    }
  }

  const teamNameByUserId: Record<string, string> = {};
  const teamIdByUserId: Record<string, string> = {};
  const { data: teamMembers } = await supabase
    .from("team_members")
    .select("user_id, team_id")
    .eq("organization_id", organizationId);
  const memberTeamIds = [
    ...new Set(
      (teamMembers || [])
        .map((m) => m.team_id as string)
        .filter(Boolean),
    ),
  ];
  const teamNamesById: Record<string, string> = {};
  if (memberTeamIds.length > 0) {
    const { data: teamsData } = await supabase
      .from("teams")
      .select("id, name")
      .eq("organization_id", organizationId)
      .in("id", memberTeamIds);
    for (const t of teamsData || []) {
      teamNamesById[t.id as string] = String(t.name ?? "");
    }
  }
  for (const m of teamMembers || []) {
    const uid = m.user_id as string;
    const tid = m.team_id as string;
    teamIdByUserId[uid] = tid;
    teamNameByUserId[uid] = teamNamesById[tid] || "";
  }

  return (profiles || [])
    .filter((p) => Boolean(roleMap[p.user_id]))
    .map((p) => ({
    user_id: p.user_id,
    name: p.name || "",
    email: p.email || "",
    employee_id: p.employee_id ?? null,
    balance: Number(p.balance ?? 0),
    is_active: p.is_active !== false,
    deactivated_at: p.deactivated_at ?? null,
    role: roleMap[p.user_id] || "employee",
    assigned_engineer_name: p.reporting_engineer_id
      ? supervisorNamesById[p.reporting_engineer_id] || "Unknown"
      : undefined,
    cashier_assigned_engineer_name: p.cashier_assigned_engineer_id
      ? supervisorNamesById[p.cashier_assigned_engineer_id] || "Unknown"
      : undefined,
    cashier_assigned_location_id: p.cashier_assigned_location_id || undefined,
    cashier_assigned_location_name: p.cashier_assigned_location_id
      ? locationNamesById[p.cashier_assigned_location_id] || "Unknown"
      : undefined,
    assigned_cashier_name: p.assigned_cashier_id
      ? cashierNamesById[p.assigned_cashier_id] || "Unknown"
      : undefined,
    cashier_assigned_engineer_id: p.cashier_assigned_engineer_id || undefined,
    reporting_engineer_id: p.reporting_engineer_id || undefined,
    team_id: teamIdByUserId[p.user_id],
    team_name: teamNameByUserId[p.user_id] || undefined,
  }));
}
