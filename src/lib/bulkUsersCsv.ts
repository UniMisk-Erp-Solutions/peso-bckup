export type BulkUserCsvRole =
  | "admin"
  | "engineer"
  | "employee"
  | "cashier"
  | "team_leader"
  | "executive";

export type BulkUserCsvRow = {
  name: string;
  /** Omitted in employee-ID import mode; backend generates a synthetic auth email. */
  email?: string;
  employee_id?: string;
  role: BulkUserCsvRole;
  password: string;
  /** Immediate supervisor email (employee, team_leader, executive). */
  assigned_manager_email?: string;
  immediate_supervisor_email?: string;
  /** Immediate supervisor employee ID (employee-ID import mode). */
  immediate_supervisor_employee_id?: string;
  location?: string;
  team_name?: string;
};

export type ParseBulkUsersCsvOptions = {
  /** When true, employee_id is required and email is optional. */
  employeeIdLoginMode?: boolean;
};

export type BulkUsersCsvImportMode = "employee_id" | "email";

function getMappedHeaders(text: string): (keyof BulkUserCsvRow | "position" | "assigned_manager_employee_id" | null)[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  return parseCsvLine(lines[0]).map((h) => headerAliasMap[normalizeHeader(h)] || null);
}

/** Infer CSV shape from headers (employee-id template vs email template). */
export function detectBulkUsersCsvMode(text: string): BulkUsersCsvImportMode {
  const mapped = getMappedHeaders(text);
  const hasEmployeeId = mapped.includes("employee_id");
  const hasEmail = mapped.includes("email");
  if (hasEmployeeId && !hasEmail) return "employee_id";
  if (hasEmail) return "email";
  return "email";
}

const headerAliasMap: Record<
  string,
  | keyof BulkUserCsvRow
  | "position"
  | "assigned_manager_employee_id"
> = {
  name: "name",
  full_name: "name",
  employee_name: "name",
  email: "email",
  email_address: "email",
  employee_id: "employee_id",
  employeeid: "employee_id",
  emp_id: "employee_id",
  emp_code: "employee_id",
  employee_code: "employee_id",
  role: "role",
  position: "position",
  password: "password",
  assigned_manager: "assigned_manager_email",
  assigned_manager_email: "assigned_manager_email",
  manager_email: "assigned_manager_email",
  immediate_supervisor: "immediate_supervisor_email",
  immediate_supervisor_email: "immediate_supervisor_email",
  supervisor_email: "immediate_supervisor_email",
  immediate_supervisor_employee_id: "immediate_supervisor_employee_id",
  supervisor_employee_id: "immediate_supervisor_employee_id",
  manager_employee_id: "assigned_manager_employee_id",
  assigned_manager_employee_id: "assigned_manager_employee_id",
  location: "location",
  location_name: "location",
  team_name: "team_name",
  team: "team_name",
  teamname: "team_name",
};

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function normalizeEmployeeId(value: string | undefined): string {
  return String(value || "").trim().toLowerCase();
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let curr = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        curr += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      out.push(curr.trim());
      curr = "";
      continue;
    }
    curr += ch;
  }
  out.push(curr.trim());
  return out;
}

function mapPositionToRole(value: string): BulkUserCsvRole | null {
  const v = value.trim().toLowerCase();
  if (["admin", "administrator"].includes(v)) return "admin";
  if (["engineer", "manager"].includes(v)) return "engineer";
  if (["employee", "employees", "staff", "user"].includes(v)) return "employee";
  if (["cashier"].includes(v)) return "cashier";
  if (["team_leader", "team leader", "teamleader", "tl"].includes(v)) return "team_leader";
  if (["executive", "exec"].includes(v)) return "executive";
  return null;
}

export function parseBulkUsersCsv(
  text: string,
  options?: ParseBulkUsersCsvOptions,
): { rows: BulkUserCsvRow[]; errors: string[] } {
  const employeeIdLoginMode = options?.employeeIdLoginMode === true;
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) return { rows: [], errors: ["CSV is empty"] };

  const rawHeaders = parseCsvLine(lines[0]);
  const mappedHeaders = rawHeaders.map((h) => headerAliasMap[normalizeHeader(h)] || null);
  const errors: string[] = [];
  const rows: BulkUserCsvRow[] = [];

  for (let i = 1; i < lines.length; i += 1) {
    const values = parseCsvLine(lines[i]);
    const rowObj: Record<string, string> = {};
    mappedHeaders.forEach((key, idx) => {
      if (!key) return;
      if (key === "assigned_manager_employee_id") {
        rowObj.immediate_supervisor_employee_id =
          rowObj.immediate_supervisor_employee_id || (values[idx] || "").trim();
        return;
      }
      rowObj[key] = (values[idx] || "").trim();
    });

    const name = rowObj.name || "";
    const email = (rowObj.email || "").toLowerCase();
    const employeeId = normalizeEmployeeId(rowObj.employee_id);
    const password = rowObj.password || "";
    const resolvedRole = (rowObj.role as BulkUserCsvRole) || mapPositionToRole(rowObj.position || "") || null;

    if (employeeIdLoginMode) {
      if (!name || !employeeId || !password || !resolvedRole) {
        errors.push(
          `Row ${i + 1}: name, employee_id, role/position, and password are required (email is optional)`,
        );
        continue;
      }
    } else if (!name || !email || !password || !resolvedRole) {
      errors.push(`Row ${i + 1}: name, email, role/position, and password are required`);
      continue;
    }

    const supervisorEmail =
      rowObj.immediate_supervisor_email || rowObj.assigned_manager_email || undefined;
    const supervisorEmployeeId = normalizeEmployeeId(rowObj.immediate_supervisor_employee_id) || undefined;

    rows.push({
      name,
      email: email || undefined,
      employee_id: employeeId || undefined,
      password,
      role: resolvedRole,
      assigned_manager_email: supervisorEmail,
      immediate_supervisor_email: supervisorEmail,
      immediate_supervisor_employee_id: supervisorEmployeeId,
      location: rowObj.location || undefined,
      team_name: rowObj.team_name || undefined,
    });
  }

  return { rows, errors };
}

export function resolveManagerUserId(
  assignedManagerEmail: string | undefined,
  importedByEmail: Map<string, string>,
  existingByEmail: Map<string, string>,
): string | undefined {
  const exactEmail = String(assignedManagerEmail || "").trim().toLowerCase();
  if (!exactEmail) return undefined;
  return importedByEmail.get(exactEmail) || existingByEmail.get(exactEmail);
}

export function resolveSupervisorUserId(params: {
  supervisorEmail?: string;
  supervisorEmployeeId?: string;
  importedByEmail: Map<string, string>;
  existingByEmail: Map<string, string>;
  importedByEmployeeId: Map<string, string>;
  existingByEmployeeId: Map<string, string>;
}): string | undefined {
  const email = String(params.supervisorEmail || "").trim().toLowerCase();
  if (email) {
    const byEmail =
      params.importedByEmail.get(email) || params.existingByEmail.get(email);
    if (byEmail) return byEmail;
  }

  const employeeId = normalizeEmployeeId(params.supervisorEmployeeId);
  if (employeeId) {
    return (
      params.importedByEmployeeId.get(employeeId) ||
      params.existingByEmployeeId.get(employeeId)
    );
  }

  return undefined;
}
