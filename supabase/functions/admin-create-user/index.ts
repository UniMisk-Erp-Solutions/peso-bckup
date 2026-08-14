import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsPreflightResponse, jsonResponse } from "../_shared/cors.ts";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ALLOWED_ROLES = new Set([
  "admin",
  "engineer",
  "employee",
  "cashier",
  "team_leader",
  "executive",
]);

type CreateUserBody = {
  organization_id?: string;
  email?: string;
  password?: string;
  name?: string;
  role?: string;
  employee_id?: string;
};

function getServiceClient() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Server misconfiguration: missing Supabase service credentials");
  }
  return createClient(supabaseUrl, serviceRoleKey);
}

async function assertCallerIsOrgAdmin(
  serviceClient: ReturnType<typeof createClient>,
  callerId: string,
  organizationId: string,
): Promise<void> {
  const { data, error } = await serviceClient
    .from("organization_memberships")
    .select("organization_id")
    .eq("user_id", callerId)
    .eq("organization_id", organizationId)
    .eq("role", "admin")
    .eq("is_active", true)
    .maybeSingle();

  if (error || !data) {
    throw new Error("Only organization administrators can create users");
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return corsPreflightResponse();
  }

  try {
    if (req.method !== "POST") {
      return jsonResponse({ success: false, error: "Method not allowed" }, 405);
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return jsonResponse({ success: false, error: "Missing authorization token" }, 401);
    }

    const jwt = authHeader.replace("Bearer ", "");
    let body: CreateUserBody;
    try {
      body = (await req.json()) as CreateUserBody;
    } catch {
      return jsonResponse({ success: false, error: "Invalid JSON body" }, 400);
    }

    const organizationId = String(body.organization_id || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const name = String(body.name || "").trim().slice(0, 120);
    const role = String(body.role || "").trim();
    const employeeId = body.employee_id
      ? String(body.employee_id).trim().toLowerCase()
      : null;

    if (!organizationId) {
      return jsonResponse({ success: false, error: "organization_id is required" }, 400);
    }

    if (!email || !EMAIL_REGEX.test(email)) {
      return jsonResponse({ success: false, error: "A valid email is required" }, 400);
    }

    if (!name) {
      return jsonResponse({ success: false, error: "name is required" }, 400);
    }

    if (!ALLOWED_ROLES.has(role)) {
      return jsonResponse({ success: false, error: "Invalid role" }, 400);
    }

    if (password.length < 8) {
      return jsonResponse(
        { success: false, error: "Password must be at least 8 characters" },
        400,
      );
    }

    const serviceClient = getServiceClient();

    const { data: authUserData, error: authUserError } = await serviceClient.auth.getUser(jwt);
    if (authUserError || !authUserData.user) {
      return jsonResponse({ success: false, error: "Invalid or expired token" }, 401);
    }

    await assertCallerIsOrgAdmin(serviceClient, authUserData.user.id, organizationId);

    const { data: existingProfile } = await serviceClient
      .from("profiles")
      .select("user_id")
      .eq("email", email)
      .maybeSingle();

    if (existingProfile?.user_id) {
      return jsonResponse(
        { success: false, error: "An account with this email already exists" },
        409,
      );
    }

    // Pre-check the Employee ID for a conflict BEFORE creating any auth user
    // or membership — profiles.employee_id is unique per organization
    // (idx_profiles_organization_employee_id_unique), so catching this early
    // avoids the create-then-roll-back cycle for the common case.
    if (employeeId) {
      const { data: existingEmployeeId } = await serviceClient
        .from("profiles")
        .select("user_id")
        .eq("organization_id", organizationId)
        .eq("employee_id", employeeId)
        .maybeSingle();

      if (existingEmployeeId?.user_id) {
        return jsonResponse(
          {
            success: false,
            error: "An employee with this Employee ID already exists in this organization",
          },
          409,
        );
      }
    }

    const { data: created, error: createError } = await serviceClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        name,
        organization_id: organizationId,
      },
    });

    if (createError || !created.user?.id) {
      const message = createError?.message || "Failed to create user";
      const status =
        message.includes("already registered") || message.includes("already exists")
          ? 409
          : 400;
      return jsonResponse({ success: false, error: message }, status);
    }

    const userId = created.user.id;

    const { error: assignError } = await serviceClient.rpc("assign_user_to_organization", {
      p_user_id: userId,
      p_organization_id: organizationId,
      p_role: role,
    });

    if (assignError) {
      await serviceClient.auth.admin.deleteUser(userId).catch(() => undefined);
      return jsonResponse(
        {
          success: false,
          error: assignError.message || "Failed to add user to organization",
        },
        400,
      );
    }

    const profileUpdate: Record<string, string> = { name };
    if (employeeId) {
      profileUpdate.employee_id = employeeId;
    }

    // Unlike the earlier best-effort patterns this replaced, the result of
    // this write is never discarded: a failed or zero-row profile update
    // must not report success while requested metadata (especially
    // employee_id) silently never got persisted. Mirrors the pattern already
    // used by bulk-users-import for the same write.
    const { data: updatedProfile, error: profileUpdateError } = await serviceClient
      .from("profiles")
      .update(profileUpdate)
      .eq("user_id", userId)
      .select("user_id, employee_id")
      .maybeSingle();

    const employeeIdPersisted =
      !employeeId || updatedProfile?.employee_id === employeeId;

    if (profileUpdateError || !updatedProfile || !employeeIdPersisted) {
      // Only clean up the account THIS invocation just created — never an
      // existing, unrelated user. Mirrors the assign_user_to_organization
      // failure path above.
      await serviceClient.auth.admin.deleteUser(userId).catch(() => undefined);

      const isDuplicateEmployeeId =
        profileUpdateError?.code === "23505" ||
        profileUpdateError?.message?.toLowerCase().includes("duplicate") ||
        profileUpdateError?.message?.toLowerCase().includes("employee_id");

      return jsonResponse(
        {
          success: false,
          error: isDuplicateEmployeeId
            ? "An employee with this Employee ID already exists in this organization"
            : profileUpdateError?.message ||
              "Failed to save the new employee's profile details; user creation was rolled back",
        },
        isDuplicateEmployeeId ? 409 : 400,
      );
    }

    return jsonResponse({
      success: true,
      user: {
        id: userId,
        email: created.user.email ?? email,
        employee_id: updatedProfile.employee_id ?? null,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    if (message.includes("misconfiguration")) {
      return jsonResponse({ success: false, error: message }, 500);
    }
    const status = message.includes("administrators") ? 403 : 500;
    return jsonResponse({ success: false, error: message }, status);
  }
});
