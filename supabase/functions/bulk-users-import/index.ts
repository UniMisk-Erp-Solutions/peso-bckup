import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const DEFAULT_SYNTHETIC_EMAIL_DOMAIN = "users.unimisk.com";

function generateSyntheticUserEmail(params: {
  organizationId: string;
  employeeIdPart: string;
  orgSubdomain: string | null;
}): string {
  const domain =
    String(Deno.env.get("SYNTHETIC_EMAIL_DOMAIN") || "").trim() ||
    DEFAULT_SYNTHETIC_EMAIL_DOMAIN;
  const slug = (params.orgSubdomain || params.organizationId.replace(/-/g, "").slice(0, 12))
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 32) || "org";
  const emp =
    params.employeeIdPart
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 32) || "user";
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  return `emp.${slug}.${emp}.${suffix}@${domain}`;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type UserRole = "admin" | "engineer" | "employee" | "cashier" | "team_leader" | "executive";
type UserRow = {
  name?: string;
  email?: string;
  employee_id?: string;
  role?: UserRole;
  position?: string;
  password?: string;
  assigned_manager_email?: string;
  immediate_supervisor_email?: string;
  immediate_supervisor_employee_id?: string;
  location?: string;
  team_name?: string;
};

function supervisorEmailFromRow(row: UserRow): string {
  return normalize(row.immediate_supervisor_email || row.assigned_manager_email) || "";
}

function supervisorEmployeeIdFromRow(row: UserRow): string {
  return normalizeEmployeeId(row.immediate_supervisor_employee_id) || "";
}

function normalizeEmployeeId(value: string | undefined | null): string {
  return String(value || "").trim().toLowerCase();
}

function resolveAuthEmailForRow(
  row: UserRow,
  ctx: {
    employeeIdLoginEnabled: boolean;
    organizationId: string;
    orgSubdomain: string | null;
  },
): { email: string; employeeId: string | null; error?: string } {
  const employeeId = normalizeEmployeeId(row.employee_id) || null;
  const providedEmail = normalize(row.email);

  if (providedEmail) {
    if (!EMAIL_REGEX.test(providedEmail)) {
      return { email: providedEmail, employeeId, error: "invalid email format" };
    }
    return { email: providedEmail, employeeId };
  }

  if (!ctx.employeeIdLoginEnabled) {
    return { email: "", employeeId, error: "email is required for this organization" };
  }

  if (!employeeId) {
    return { email: "", employeeId, error: "employee_id is required when email is omitted" };
  }

  return {
    email: generateSyntheticUserEmail({
      organizationId: ctx.organizationId,
      employeeIdPart: employeeId,
      orgSubdomain: ctx.orgSubdomain,
    }),
    employeeId,
  };
}

function allowedSupervisorRoles(
  subRole: string,
  flags: { teamLeader: boolean; executive: boolean },
): string[] {
  if (subRole === "employee") {
    const roles: string[] = [];
    if (flags.teamLeader) roles.push("team_leader");
    if (flags.executive) roles.push("executive");
    roles.push("engineer");
    return roles;
  }
  if (subRole === "team_leader") {
    const roles = ["engineer"];
    if (flags.executive) roles.unshift("executive");
    return roles;
  }
  if (subRole === "executive") return ["engineer"];
  return [];
}
type Body = {
  organization_id?: string;
  dry_run?: boolean;
  skip_welcome_email?: boolean;
  link_supervisors_only?: boolean;
  sync_passwords_only?: boolean;
  row_offset?: number;
  rows?: UserRow[];
};
const MAX_ROWS = 500;
/** Supabase Auth minimum; Microlink CSV uses 7-char passwords like vis.123 */
const MIN_BULK_IMPORT_PASSWORD_LENGTH = 6;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_SIGNIN_URL = "https://pesowise.unimisk.com/auth";
const USER_LIMIT_ERROR =
  "The user limit for this organization has been reached. Please remove some existing users or contact us to upgrade your plan.";

async function resolveAdminOrg(client: any, callerId: string, requestedOrgId?: string) {
  const { data, error } = await client
    .from("organization_memberships")
    .select("organization_id")
    .eq("user_id", callerId)
    .eq("role", "admin")
    .eq("is_active", true);
  if (error || !data?.length) throw new Error("Only organization admins can run bulk imports.");
  if (requestedOrgId) {
    const allowed = data.some((m: any) => m.organization_id === requestedOrgId);
    if (!allowed) throw new Error("You are not an admin of the requested organization.");
    return requestedOrgId;
  }
  return data[0].organization_id as string;
}

function randomPassword(): string {
  return `Pw!${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}aA1`;
}

function resolveImportPassword(raw: string | undefined): {
  password?: string;
  error?: string;
  generated?: boolean;
} {
  const value = String(raw || "").trim();
  if (!value) {
    return { password: randomPassword(), generated: true };
  }
  if (value.length < MIN_BULK_IMPORT_PASSWORD_LENGTH) {
    return {
      error: `password must be at least ${MIN_BULK_IMPORT_PASSWORD_LENGTH} characters (got ${value.length})`,
    };
  }
  return { password: value };
}

async function sendAccountCreatedEmail(params: {
  supabaseUrl: string;
  serviceRoleKey: string;
  name: string;
  email: string;
  password: string;
}) {
  const signInUrl = String(Deno.env.get("APP_SIGNIN_URL") || DEFAULT_SIGNIN_URL).trim();
  if (!signInUrl) return;

  const token = String(Deno.env.get("EMAIL_FUNCTION_TOKEN") || "").trim();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    apikey: params.serviceRoleKey,
    Authorization: token ? `Bearer ${token}` : `Bearer ${params.serviceRoleKey}`,
  };

  const response = await fetch(`${params.supabaseUrl}/functions/v1/send-account-created-email`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: params.name,
      email: params.email,
      password: params.password,
      sign_in_url: signInUrl,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`send-account-created-email failed (${response.status}): ${body}`);
  }
}

function normalize(value: string | undefined | null): string {
  return String(value || "").trim().toLowerCase();
}

function resolveRole(row: UserRow): UserRole | null {
  if (row.role) return row.role;
  const p = normalize(row.position);
  if (p === "admin" || p === "administrator") return "admin";
  if (p === "engineer" || p === "manager") return "engineer";
  if (p === "employee" || p === "staff" || p === "user") return "employee";
  if (p === "cashier") return "cashier";
  if (p === "team_leader" || p === "team leader" || p === "teamleader") return "team_leader";
  if (p === "executive" || p === "exec") return "executive";
  return null;
}

type OrgMemberIndex = {
  byEmployeeId: Map<string, string>;
  byEmail: Map<string, string>;
  roleByUserId: Map<string, string>;
  nameByUserId: Map<string, string>;
  employeeIdByUserId: Map<string, string>;
  hasActiveMembership: (userId: string) => boolean;
  register: (userId: string, email: string, employeeId: string | null | undefined, role: string, name?: string) => void;
};

function formatSupervisorLabel(
  orgIndex: OrgMemberIndex,
  userId: string,
): string {
  const name = orgIndex.nameByUserId.get(userId) || "Unknown";
  const role = orgIndex.roleByUserId.get(userId) || "unknown";
  const empId = orgIndex.employeeIdByUserId.get(userId);
  return empId ? `${name} (${role}, id=${empId})` : `${name} (${role})`;
}

async function loadOrgMemberIndex(client: any, organizationId: string): Promise<OrgMemberIndex> {
  const byEmployeeId = new Map<string, string>();
  const byEmail = new Map<string, string>();
  const roleByUserId = new Map<string, string>();
  const nameByUserId = new Map<string, string>();
  const employeeIdByUserId = new Map<string, string>();
  const activeMembership = new Set<string>();

  const { data: profiles } = await client
    .from("profiles")
    .select("user_id, email, employee_id, name")
    .eq("organization_id", organizationId);

  for (const profile of profiles || []) {
    const userId = profile.user_id as string;
    if (profile.email) byEmail.set(normalize(profile.email), userId);
    const empId = normalizeEmployeeId(profile.employee_id);
    if (empId) {
      byEmployeeId.set(empId, userId);
      employeeIdByUserId.set(userId, empId);
    }
    if (profile.name) nameByUserId.set(userId, String(profile.name));
  }

  const { data: memberships } = await client
    .from("organization_memberships")
    .select("user_id, role, is_active")
    .eq("organization_id", organizationId);

  for (const row of memberships || []) {
    const userId = row.user_id as string;
    if (row.is_active === true) activeMembership.add(userId);
    roleByUserId.set(userId, String(row.role || ""));
  }

  return {
    byEmployeeId,
    byEmail,
    roleByUserId,
    nameByUserId,
    employeeIdByUserId,
    hasActiveMembership: (userId: string) => activeMembership.has(userId),
    register(
      userId: string,
      email: string,
      employeeId: string | null | undefined,
      role: string,
      name?: string,
    ) {
      activeMembership.add(userId);
      roleByUserId.set(userId, role);
      byEmail.set(normalize(email), userId);
      const empId = normalizeEmployeeId(employeeId);
      if (empId) {
        byEmployeeId.set(empId, userId);
        employeeIdByUserId.set(userId, empId);
      }
      if (name) nameByUserId.set(userId, name);
    },
  };
}

function resolveSupervisorUserId(
  supervisorEmail: string,
  supervisorEmployeeId: string,
  importedByEmail: Map<string, string>,
  importedByEmployeeId: Map<string, string>,
  orgIndex: OrgMemberIndex,
): string | undefined {
  if (supervisorEmail) {
    const key = normalize(supervisorEmail);
    return importedByEmail.get(key) || orgIndex.byEmail.get(key);
  }
  if (supervisorEmployeeId) {
    const key = normalizeEmployeeId(supervisorEmployeeId);
    return importedByEmployeeId.get(key) || orgIndex.byEmployeeId.get(key);
  }
  return undefined;
}

/** Resolve imported row to org user_id (employee_id login or explicit email). */
function resolveImportedRowUserId(
  row: UserRow,
  orgIndex: OrgMemberIndex,
  importedByEmail: Map<string, string>,
  importedByEmployeeId: Map<string, string>,
): string | undefined {
  const employeeId = normalizeEmployeeId(row.employee_id);
  if (employeeId) {
    const fromImport = importedByEmployeeId.get(employeeId);
    if (fromImport) return fromImport;
    const fromOrg = orgIndex.byEmployeeId.get(employeeId);
    if (fromOrg) return fromOrg;
  }
  const email = normalize(row.email);
  if (email) {
    return importedByEmail.get(email) || orgIndex.byEmail.get(email);
  }
  return undefined;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ success: false, error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) throw new Error("Server misconfiguration");

    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) throw new Error("Missing authorization token");
    const jwt = authHeader.replace("Bearer ", "");

    const body = (await req.json()) as Body;
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (rows.length === 0) throw new Error("rows[] is required");
    if (rows.length > MAX_ROWS) throw new Error(`rows[] exceeds max allowed size (${MAX_ROWS})`);
    const rowOffset = Number.isFinite(body.row_offset) ? Math.max(0, Number(body.row_offset)) : 0;
    const skipWelcomeEmail = body.skip_welcome_email === true || rows.length > 15;

    const serviceClient = createClient(supabaseUrl, serviceRoleKey);
    const { data: authUserData, error: authUserError } = await serviceClient.auth.getUser(jwt);
    if (authUserError || !authUserData.user) throw new Error("Invalid or expired token");
    const organizationId = await resolveAdminOrg(serviceClient, authUserData.user.id, body.organization_id);
    const dryRun = body.dry_run === true;

    let hierarchyTeamLeader = false;
    let hierarchyExecutive = false;
    let employeeIdLoginEnabled = false;
    let teamsEnabled = false;
    const { data: featureRows } = await serviceClient
      .from("organization_features")
      .select("feature_key, enabled")
      .eq("organization_id", organizationId)
      .in("feature_key", [
        "approval_hierarchy",
        "hierarchy_team_leader",
        "hierarchy_executive",
        "employee_id_login",
        "teams_enabled",
      ]);
    const featureMap = new Map(
      (featureRows || []).map((r: { feature_key: string; enabled: boolean }) => [
        r.feature_key,
        r.enabled === true,
      ]),
    );
    const hierarchyMaster = featureMap.get("approval_hierarchy") === true;
    hierarchyTeamLeader =
      hierarchyMaster && featureMap.get("hierarchy_team_leader") === true;
    hierarchyExecutive =
      hierarchyMaster && featureMap.get("hierarchy_executive") === true;
    employeeIdLoginEnabled = featureMap.get("employee_id_login") === true;
    teamsEnabled = featureMap.get("teams_enabled") === true;

    if (body.sync_passwords_only === true) {
      const orgIndex = await loadOrgMemberIndex(serviceClient, organizationId);
      const importedByEmail = new Map(orgIndex.byEmail);
      const importedByEmployeeId = new Map(orgIndex.byEmployeeId);
      let updated = 0;
      let skipped = 0;
      const warnings: string[] = [];

      for (const row of rows) {
        const resolvedPassword = resolveImportPassword(row.password);
        if (!resolvedPassword.password) {
          skipped += 1;
          warnings.push(
            `password_skip:employee_id=${normalizeEmployeeId(row.employee_id) || "?"}:${resolvedPassword.error}`,
          );
          continue;
        }

        const userId = resolveImportedRowUserId(
          row,
          orgIndex,
          importedByEmail,
          importedByEmployeeId,
        );
        if (!userId) {
          skipped += 1;
          warnings.push(`password_skip:user_not_found:employee_id=${normalizeEmployeeId(row.employee_id) || "?"}`);
          continue;
        }

        if (dryRun) {
          updated += 1;
          warnings.push(`would_update_password:employee_id=${normalizeEmployeeId(row.employee_id) || "?"}`);
          continue;
        }

        const { error } = await serviceClient.auth.admin.updateUserById(userId, {
          password: resolvedPassword.password,
        });
        if (error) {
          skipped += 1;
          warnings.push(`password_update_failed:employee_id=${normalizeEmployeeId(row.employee_id) || "?"}:${error.message}`);
        } else {
          updated += 1;
        }
      }

      return new Response(
        JSON.stringify({
          success: true,
          organization_id: organizationId,
          sync_passwords_only: true,
          dry_run: dryRun,
          updated,
          skipped,
          total: rows.length,
          warnings,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (body.link_supervisors_only === true) {
      const orgIndex = await loadOrgMemberIndex(serviceClient, organizationId);
      const importedByEmail = new Map(orgIndex.byEmail);
      const importedByEmployeeId = new Map(orgIndex.byEmployeeId);
      let linked = 0;
      let skipped = 0;
      const warnings: string[] = [];

      for (const row of rows) {
        const role = resolveRole(row);
        if (!role) {
          skipped += 1;
          warnings.push(`skip:missing_role:employee_id=${normalizeEmployeeId(row.employee_id) || "?"}`);
          continue;
        }
        const userId = resolveImportedRowUserId(
          row,
          orgIndex,
          importedByEmail,
          importedByEmployeeId,
        );
        if (!userId) {
          skipped += 1;
          warnings.push(`skip:user_not_found:employee_id=${normalizeEmployeeId(row.employee_id) || "?"}`);
          continue;
        }

        const supervisorEmail = supervisorEmailFromRow(row);
        const supervisorEmployeeId = supervisorEmployeeIdFromRow(row);
        if (!supervisorEmail && !supervisorEmployeeId) continue;

        const managerId = resolveSupervisorUserId(
          supervisorEmail,
          supervisorEmployeeId,
          importedByEmail,
          importedByEmployeeId,
          orgIndex,
        );
        if (!managerId) {
          skipped += 1;
          warnings.push(
            supervisorEmail
              ? `supervisor_not_resolved:email=${supervisorEmail}`
              : `supervisor_not_resolved:employee_id=${supervisorEmployeeId}`,
          );
          continue;
        }

        if (role === "employee" || role === "team_leader" || role === "executive") {
          const supervisorRole = orgIndex.roleByUserId.get(managerId) || "";
          const allowed = allowedSupervisorRoles(role, {
            teamLeader: hierarchyTeamLeader,
            executive: hierarchyExecutive,
          });
          if (!allowed.includes(supervisorRole)) {
            skipped += 1;
            warnings.push(
              `supervisor_role_invalid:target=${formatSupervisorLabel(orgIndex, managerId)} ` +
                `(subordinate=${role} needs ${allowed.join(" or ")})`,
            );
            continue;
          }
          if (dryRun) {
            const via = supervisorEmail ? `email=${supervisorEmail}` : `employee_id=${supervisorEmployeeId}`;
            warnings.push(
              `would_link_supervisor:${via}->${formatSupervisorLabel(orgIndex, managerId)}`,
            );
            linked += 1;
            continue;
          }
          const { error } = await serviceClient
            .from("profiles")
            .update({ reporting_engineer_id: managerId })
            .eq("user_id", userId);
          if (error) {
            skipped += 1;
            warnings.push(`supervisor_link_failed:${error.message}`);
          } else {
            linked += 1;
          }
        } else if (role === "cashier") {
          if (dryRun) {
            warnings.push(`would_link_cashier_manager:employee_id=${supervisorEmployeeId || supervisorEmail}`);
            linked += 1;
            continue;
          }
          const { error } = await serviceClient
            .from("profiles")
            .update({ cashier_assigned_engineer_id: managerId })
            .eq("user_id", userId);
          if (error) {
            skipped += 1;
            warnings.push(`cashier_manager_link_failed:${error.message}`);
          } else linked += 1;
        }
      }

      return new Response(
        JSON.stringify({
          success: true,
          organization_id: organizationId,
          link_supervisors_only: true,
          dry_run: dryRun,
          linked,
          skipped,
          total: rows.length,
          warnings,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { data: organizationData, error: organizationError } = await serviceClient
      .from("organizations")
      .select("max_users, subdomain")
      .eq("id", organizationId)
      .maybeSingle();
    if (organizationError) throw new Error(`Failed to read organization limits: ${organizationError.message}`);

    const { count: activeMemberCount, error: activeCountError } = await serviceClient
      .from("organization_memberships")
      .select("user_id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("is_active", true);
    if (activeCountError) throw new Error(`Failed to read active member count: ${activeCountError.message}`);

    const orgMaxUsers =
      organizationData?.max_users === null || organizationData?.max_users === undefined
        ? null
        : Number(organizationData.max_users);
    const activeMembersBefore = Number(activeMemberCount || 0);
    let projectedActiveMembers = activeMembersBefore;

    type RowResult = {
      index: number;
      ok: boolean;
      email?: string;
      employee_id?: string;
      user_id?: string;
      action?: string;
      warnings?: string[];
      error?: string;
    };
    const results: RowResult[] = [];
    type Pass1Row = {
      index: number;
      email: string;
      employee_id?: string;
      role: UserRole;
      name: string;
      user_id: string;
      assigned_manager_email?: string;
      immediate_supervisor_employee_id?: string;
      location?: string;
    };
    const pass1: Pass1Row[] = [];
    const orgIndex = await loadOrgMemberIndex(serviceClient, organizationId);

    const emailContext = {
      employeeIdLoginEnabled,
      organizationId,
      orgSubdomain: (organizationData?.subdomain as string | null) ?? null,
    };

    // Pass 1: validate + create/lookup + assign role
    for (let i = 0; i < rows.length; i += 1) {
      const rowIndex = rowOffset + i;
      const row = rows[i];
      const name = String(row.name || "").trim().slice(0, 120);
      const role = resolveRole(row);
      const resolved = resolveAuthEmailForRow(row, emailContext);

      if (!name || !role || resolved.error) {
        results.push({
          index: rowIndex,
          ok: false,
          email: resolved.email || normalize(row.email),
          employee_id: resolved.employeeId || undefined,
          error: resolved.error || "name and role/position are required",
        });
        continue;
      }

      const email = resolved.email;
      const employeeId = resolved.employeeId;

      if (dryRun) {
        results.push({
          index: rowIndex,
          ok: true,
          email,
          employee_id: employeeId || undefined,
          action: "would_create_or_link",
          warnings: [],
        });
        pass1.push({
          index: rowIndex,
          email,
          employee_id: employeeId || undefined,
          role,
          name,
          user_id: `dry-run-${rowIndex}`,
          assigned_manager_email: supervisorEmailFromRow(row) || undefined,
          immediate_supervisor_employee_id: supervisorEmployeeIdFromRow(row) || undefined,
          location: String(row.location || "").trim() || undefined,
          team_name: String(row.team_name || "").trim() || undefined,
        });
        continue;
      }

      let userId: string | null = null;
      let existingMembership = false;
      let consumesNewSeat = false;
      let createdAuthUser = false;
      let finalPassword = "";

      if (employeeId && orgIndex.byEmployeeId.has(employeeId)) {
        userId = orgIndex.byEmployeeId.get(employeeId) || null;
      }
      if (!userId) {
        userId = orgIndex.byEmail.get(email) || null;
      }
      if (!userId && employeeId) {
        // Use limit(1)+order so duplicate profiles never cause a maybeSingle error;
        // keep the most-recently-created profile as the canonical one.
        const { data: byEmployeeIdRows } = await serviceClient
          .from("profiles")
          .select("user_id")
          .eq("organization_id", organizationId)
          .ilike("employee_id", employeeId)
          .order("created_at", { ascending: false })
          .limit(1);
        const byEmployeeId = byEmployeeIdRows?.[0] ?? null;
        if (byEmployeeId?.user_id) userId = byEmployeeId.user_id as string;
      }
      if (!userId) {
        const { data: byEmailRows } = await serviceClient
          .from("profiles")
          .select("user_id")
          .ilike("email", email)
          .order("created_at", { ascending: false })
          .limit(1);
        const byEmail = byEmailRows?.[0] ?? null;
        if (byEmail?.user_id) userId = byEmail.user_id as string;
      }

      if (userId) {
        existingMembership = orgIndex.hasActiveMembership(userId);
        consumesNewSeat = !existingMembership;
      } else {
        consumesNewSeat = true;
      }

      if (consumesNewSeat && orgMaxUsers !== null && projectedActiveMembers >= orgMaxUsers) {
        results.push({ index: rowIndex, ok: false, email, error: USER_LIMIT_ERROR });
        continue;
      }

      if (!userId) {
        const resolvedPassword = resolveImportPassword(row.password);
        if (!resolvedPassword.password) {
          results.push({
            index: rowIndex,
            ok: false,
            email,
            employee_id: employeeId || undefined,
            error: resolvedPassword.error || "password is required",
          });
          continue;
        }
        finalPassword = resolvedPassword.password;
        const { data: created, error: createError } = await serviceClient.auth.admin.createUser({
          email,
          password: finalPassword,
          email_confirm: true,
          user_metadata: { name, organization_id: organizationId },
        });
        if (createError || !created.user?.id) {
          const createMessage = createError?.message || "Failed to create auth user";
          // In some environments, org limit violations happen in DB triggers during auth user creation
          // and surface as a generic database error from GoTrue.
          if (
            createMessage.toLowerCase().includes("database error creating new user") &&
            orgMaxUsers !== null &&
            projectedActiveMembers >= orgMaxUsers
          ) {
            results.push({ index: rowIndex, ok: false, email, error: USER_LIMIT_ERROR });
          } else {
            results.push({ index: rowIndex, ok: false, email, error: createMessage });
          }
          continue;
        }
        userId = created.user.id;
        createdAuthUser = true;
      } else if (row.password) {
        const resolvedPassword = resolveImportPassword(row.password);
        if (!resolvedPassword.password) {
          results.push({
            index: rowIndex,
            ok: false,
            email,
            employee_id: employeeId || undefined,
            user_id: userId,
            error: resolvedPassword.error,
          });
          continue;
        }
        finalPassword = resolvedPassword.password;
        if (!dryRun) {
          const { error: passwordError } = await serviceClient.auth.admin.updateUserById(userId, {
            password: finalPassword,
          });
          if (passwordError) {
            results.push({
              index: rowIndex,
              ok: false,
              email,
              employee_id: employeeId || undefined,
              user_id: userId,
              error: `password update failed: ${passwordError.message}`,
            });
            continue;
          }
        }
      }
      if (!userId) {
        results.push({ index: rowIndex, ok: false, email, error: "Failed to resolve user id" });
        continue;
      }

      // 3) Assign to org using existing RPC (enforces limits)
      const { error: assignError } = await serviceClient.rpc("assign_user_to_organization", {
        p_user_id: userId,
        p_organization_id: organizationId,
        p_role: role,
      });
      if (assignError) {
        results.push({ index: rowIndex, ok: false, email, user_id: userId, error: assignError.message });
        continue;
      }

      if (consumesNewSeat) projectedActiveMembers += 1;

      // 4) Name + employee_id update — not best-effort: a failed write here means
      // the next import run won't find this user by employee_id and will create a duplicate.
      const profilePatch: Record<string, string> = { name };
      if (employeeId) profilePatch.employee_id = employeeId;
      const { error: profilePatchError } = await serviceClient
        .from("profiles")
        .update(profilePatch)
        .eq("user_id", userId);
      if (profilePatchError) {
        results.push({
          index: rowIndex,
          ok: false,
          email,
          employee_id: employeeId || undefined,
          user_id: userId,
          error: `profile_patch_failed: ${profilePatchError.message}`,
        });
        continue;
      }

      if (createdAuthUser && !skipWelcomeEmail) {
        try {
          await sendAccountCreatedEmail({
            supabaseUrl,
            serviceRoleKey,
            name,
            email,
            password: finalPassword,
          });
        } catch (emailError) {
          console.error("Failed to send account-created email from bulk import:", {
            email,
            error: emailError instanceof Error ? emailError.message : String(emailError),
          });
        }
      }

      orgIndex.register(userId as string, email, employeeId, role, name);

      const rowWarnings: string[] = [];
      if (!createdAuthUser && row.password && finalPassword) {
        rowWarnings.push(
          dryRun
            ? `would_update_password:employee_id=${employeeId || "?"}`
            : `password_updated:employee_id=${employeeId || "?"}`,
        );
      }

      results.push({
        index: rowIndex,
        ok: true,
        email,
        employee_id: employeeId || undefined,
        user_id: userId,
        action: createdAuthUser ? "assigned" : "updated",
        warnings: rowWarnings,
      });
      pass1.push({
        index: rowIndex,
        email,
        employee_id: employeeId || undefined,
        role,
        name,
        user_id: userId as string,
        assigned_manager_email: supervisorEmailFromRow(row) || undefined,
        immediate_supervisor_employee_id: supervisorEmployeeIdFromRow(row) || undefined,
        location: String(row.location || "").trim() || undefined,
        team_name: String(row.team_name || "").trim() || undefined,
      });
    }

    // Pass 2: resolve manager + optional location
    const importedByEmail = new Map<string, string>();
    const importedByEmployeeId = new Map<string, string>();
    pass1.forEach((r) => {
      importedByEmail.set(normalize(r.email), r.user_id);
      if (r.employee_id) importedByEmployeeId.set(normalizeEmployeeId(r.employee_id), r.user_id);
    });

    // Optional location lookup
    const { data: orgLocations } = await serviceClient
      .from("locations")
      .select("id, name")
      .eq("organization_id", organizationId);
    const locationsByName = new Map<string, string>((orgLocations || []).map((l: any) => [normalize(l.name), l.id]));

    const { data: orgTeams } = teamsEnabled
      ? await serviceClient
          .from("teams")
          .select("id, name")
          .eq("organization_id", organizationId)
      : { data: [] as { id: string; name: string }[] };
    const teamsByName = new Map<string, string>(
      (orgTeams || []).map((t: { id: string; name: string }) => [normalize(t.name), t.id]),
    );

    for (const row of pass1) {
      const result = results.find((r) => r.index === row.index);
      if (!result || !result.ok) continue;
      const warnings = result.warnings || [];

      const supervisorEmail = supervisorEmailFromRow(row);
      const supervisorEmployeeId = supervisorEmployeeIdFromRow(row);
      const subRolesWithSupervisor = ["employee", "team_leader", "executive"];

      let managerId: string | undefined = resolveSupervisorUserId(
        supervisorEmail,
        supervisorEmployeeId,
        importedByEmail,
        importedByEmployeeId,
        orgIndex,
      );

      if (supervisorEmail || supervisorEmployeeId) {
        if (!managerId) {
          warnings.push(
            supervisorEmail
              ? `supervisor_not_resolved:email=${supervisorEmail}`
              : `supervisor_not_resolved:employee_id=${supervisorEmployeeId}`,
          );
        } else if (subRolesWithSupervisor.includes(row.role)) {
          const supervisorRole = orgIndex.roleByUserId.get(managerId) || "";
          const allowed = allowedSupervisorRoles(row.role, {
            teamLeader: hierarchyTeamLeader,
            executive: hierarchyExecutive,
          });
          if (!allowed.includes(supervisorRole)) {
            warnings.push(
              `supervisor_role_invalid:target=${formatSupervisorLabel(orgIndex, managerId)} ` +
                `(subordinate=${row.role} needs ${allowed.join(" or ")})`,
            );
          } else if (!dryRun) {
            const { error: supervisorLinkError } = await serviceClient
              .from("profiles")
              .update({ reporting_engineer_id: managerId })
              .eq("user_id", row.user_id);
            if (supervisorLinkError) {
              warnings.push(`supervisor_link_failed:${supervisorLinkError.message}`);
            }
          } else {
            const via = supervisorEmail ? `email=${supervisorEmail}` : `employee_id=${supervisorEmployeeId}`;
            warnings.push(
              `would_link_supervisor:${via}->${formatSupervisorLabel(orgIndex, managerId)}`,
            );
          }
        } else if (row.role === "cashier") {
          if (!dryRun) {
            await serviceClient
              .from("profiles")
              .update({ cashier_assigned_engineer_id: managerId })
              .eq("user_id", row.user_id);
          } else {
            warnings.push(`would_link_cashier_manager:${managerId}`);
          }
        } else {
          warnings.push("supervisor_not_applicable_for_role");
        }
      }

      // Optional location handling
      if (row.location) {
        const locationId = locationsByName.get(normalize(row.location));
        if (!locationId) {
          warnings.push("location_not_found_skipped");
        } else if (!dryRun) {
          if (row.role === "cashier") {
            await serviceClient
              .from("profiles")
              .update({ cashier_assigned_location_id: locationId })
              .eq("user_id", row.user_id);
          } else if (row.role === "engineer") {
            await serviceClient
              .from("engineer_locations")
              .upsert(
                { engineer_id: row.user_id, location_id: locationId, organization_id: organizationId },
                { onConflict: "engineer_id,location_id" }
              );
          } else {
            warnings.push("location_provided_but_not_applicable_for_role");
          }
        } else {
          warnings.push(`would_link_location:${row.location}`);
        }
      }

      if (teamsEnabled && row.role === "employee" && row.team_name) {
        const teamId = teamsByName.get(normalize(String(row.team_name)));
        if (!teamId) {
          warnings.push(`team_not_found:${String(row.team_name).trim()}`);
        } else if (!dryRun) {
          await serviceClient
            .from("team_members")
            .delete()
            .eq("organization_id", organizationId)
            .eq("user_id", row.user_id);
          const { error: teamErr } = await serviceClient.from("team_members").insert({
            team_id: teamId,
            user_id: row.user_id,
            organization_id: organizationId,
          });
          if (teamErr) warnings.push(`team_link_failed:${teamErr.message}`);
        } else {
          warnings.push(`would_link_team:${String(row.team_name).trim()}`);
        }
      }

      result.warnings = warnings;
    }

    return new Response(
      JSON.stringify({
        success: true,
        organization_id: organizationId,
        employee_id_login_enabled: employeeIdLoginEnabled,
        max_users: orgMaxUsers,
        active_members_before: activeMembersBefore,
        active_members_after: projectedActiveMembers,
        dry_run: dryRun,
        total: rows.length,
        ok: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
        results,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return new Response(JSON.stringify({ success: false, error: message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
