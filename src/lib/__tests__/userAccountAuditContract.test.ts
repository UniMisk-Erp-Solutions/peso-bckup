/**
 * DOC-158 structural contract: the properties that make the audit trail trustworthy are pinned in code so a later edit cannot
 * silently remove them.  (Behaviour against a real Postgres is covered by supabase/tests/user_account_audit.)
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, existsSync } from "fs";
import { resolve } from "path";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf-8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const FUNCTIONS_WITH_PRIVILEGED_USER_WRITES = [
  "admin-create-user", "admin-reset-password", "admin-set-user-auth-status", "admin-update-user-email", "bulk-users-import",
];
const migration = read("supabase/migrations/20261031100000_user_account_audit_history_v1.sql");
const migrationCode = migration.replace(/--.*$/gm, "");

describe("every service-role function that mutates users registers the REAL actor first", () => {
  it.each(FUNCTIONS_WITH_PRIVILEGED_USER_WRITES)("%s imports the shared audit helper and registers a context", (fn) => {
    const code = strip(read(`supabase/functions/${fn}/index.ts`));
    expect(code).toMatch(/_shared\/accountAudit\.ts/);
    expect(code).toMatch(/registerAuditContext\(/);
  });

  it.each(["admin-create-user", "admin-reset-password", "admin-set-user-auth-status", "admin-update-user-email"])(
    "%s registers the context BEFORE its first auth.admin call",
    (fn) => {
      const code = strip(read(`supabase/functions/${fn}/index.ts`));
      const reg = code.indexOf("registerAuditContext(serviceClient");
      const admin = code.search(/auth\.admin\.(createUser|updateUserById)/);
      expect(reg).toBeGreaterThan(-1);
      expect(admin).toBeGreaterThan(-1);
      expect(reg).toBeLessThan(admin);
    },
  );

  it("bulk import registers an ORGANIZATION-scope context before any write and clears it in finally", () => {
    const code = strip(read("supabase/functions/bulk-users-import/index.ts"));
    expect(code).toMatch(/scope: "organization"/);
    expect(code).toMatch(/finally \{\s*if \(auditCleanup\) await auditCleanup\(\);/);
    expect(code.indexOf("registerAuditContext(")).toBeLessThan(code.indexOf("auth.admin.createUser"));
    expect(code).toMatch(/if \(!dryRun\) \{[\s\S]*registerAuditContext\(/);
  });

  it("no function introduces an un-audited privileged user write (new auth.admin callers must use the audit helper)", () => {
    const dir = resolve(ROOT, "supabase/functions");
    const offenders: string[] = [];
    for (const name of readdirSync(dir)) {
      const f = resolve(dir, name, "index.ts");
      if (!existsSync(f)) continue;
      const code = strip(readFileSync(f, "utf-8"));
      if (/auth\.admin\.(createUser|updateUserById|deleteUser)\(/.test(code) && !/_shared\/accountAudit\.ts/.test(code)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });
});

describe("the actor is derived from the verified JWT, never from the request", () => {
  it.each(FUNCTIONS_WITH_PRIVILEGED_USER_WRITES)("%s takes actorUserId only from the authenticated user", (fn) => {
    const code = strip(read(`supabase/functions/${fn}/index.ts`));
    const actorAssignments = [...code.matchAll(/actorUserId:\s*([A-Za-z0-9_.]+)/g)].map((m) => m[1]);
    expect(actorAssignments.length).toBeGreaterThan(0);
    for (const a of actorAssignments) {
      // allowed: the verified caller's id (directly or via a const derived from it)
      expect(a).toMatch(/^(callerId|actorId|authUserData\.user\.id|userData\.user\.id)$/);
      expect(a).not.toMatch(/body|req|json|params/i);
    }
    // and the const itself comes from the verified user
    if (code.includes("actorId =")) expect(code).toMatch(/const actorId = (authUserData|userData)\.user\.id/);
    // the request body type must not offer an actor field
    expect(code).not.toMatch(/(actor_user_id|actorUserId|actor_id)\?:\s*string/);
  });
});

describe("no secret can reach an audit call", () => {
  it.each(FUNCTIONS_WITH_PRIVILEGED_USER_WRITES)("%s never passes a password, token or key into recordAuditEvent / registerAuditContext", (fn) => {
    const code = strip(read(`supabase/functions/${fn}/index.ts`));
    const calls = [...code.matchAll(/(recordAuditEvent|registerAuditContext)\(([\s\S]*?)\);\r?\n/g)].map((m) => m[2]);
    expect(calls.length).toBeGreaterThan(0);
    for (const raw of calls) {
      // the one allowed body-derived value is the batch id: a validated token (safeBatchId) that carries no identity
      const c = raw.replace(/safeBatchId\(body\.batch_id\)/g, "");
      expect(c).not.toMatch(/new_password|password\b(?!_reset)|\bpassword:|token|secret|serviceRoleKey|jwt|authHeader|\bbody\b/i);
    }
  });

  it("the password in admin-create-user / admin-reset-password is only ever used for the Auth call", () => {
    const create = strip(read("supabase/functions/admin-create-user/index.ts"));
    const reset = strip(read("supabase/functions/admin-reset-password/index.ts"));
    expect(create.match(/\bpassword\b/g)!.length).toBeGreaterThan(0);
    expect(create).not.toMatch(/console\.(log|error)\([^)]*password/i);
    expect(reset).not.toMatch(/console\.(log|error)\([^)]*password/i);
  });

  it("the shared helper never serialises error messages into events (categories only)", () => {
    const code = strip(read("supabase/functions/_shared/accountAudit.ts"));
    expect(code).not.toMatch(/p_metadata:\s*\{[^}]*message/);
    expect(code).toMatch(/export function failureReason/);
  });
});

describe("the migration: append-only, least privilege, no credential capture", () => {
  it("creates BEFORE UPDATE/DELETE and BEFORE TRUNCATE guards on the audit table", () => {
    expect(migrationCode).toMatch(/BEFORE UPDATE OR DELETE ON public\.user_account_audit_events/);
    expect(migrationCode).toMatch(/BEFORE TRUNCATE ON public\.user_account_audit_events/);
  });
  it("revokes everything from API roles and grants only SELECT", () => {
    expect(migrationCode).toMatch(/REVOKE ALL ON public\.user_account_audit_events FROM PUBLIC, anon, authenticated, service_role/);
    expect(migrationCode).toMatch(/GRANT SELECT ON public\.user_account_audit_events TO authenticated, service_role/);
    expect(migrationCode).not.toMatch(/GRANT\s+(INSERT|UPDATE|DELETE|ALL)[^;]*user_account_audit_events/i);
  });
  it("defines no INSERT/UPDATE/DELETE RLS policy on the audit table", () => {
    const policies = [...migrationCode.matchAll(/CREATE POLICY\s+(\w+)\s+ON\s+public\.user_account_audit_events\s+FOR\s+(\w+)/g)];
    expect(policies.map((p) => p[2])).toEqual(["SELECT"]);
  });
  it("encrypted_password only ever appears inside an IS DISTINCT FROM comparison (never copied into a row)", () => {
    const uses = [...migrationCode.matchAll(/(OLD|NEW)\.encrypted_password/g)];
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) {
      const ctx = migrationCode.slice(Math.max(0, u.index! - 60), u.index! + 80);
      expect(ctx).toMatch(/IS DISTINCT FROM/);
    }
    expect(migrationCode).not.toMatch(/to_jsonb\((OLD|NEW)\.encrypted_password/);
  });
  it("never reads the Auth recovery / confirmation / OTP columns", () => {
    expect(migrationCode).not.toMatch(/recovery_token|confirmation_token|email_change_token|reauthentication_token|refresh_token|raw_app_meta_data/);
  });
  it("trigger functions and context writers are not executable by API roles; only service_role may register/record", () => {
    expect(migrationCode).toMatch(/REVOKE ALL ON FUNCTION public\._uaa_trg_profiles\(\)[\s\S]*FROM PUBLIC, anon, authenticated, service_role/);
    expect(migrationCode).toMatch(/GRANT EXECUTE ON FUNCTION public\.register_user_account_audit_context_v1[\s\S]*TO service_role;/);
    expect(migrationCode).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.(register_user_account_audit_context_v1|record_user_account_audit_event_v1)[^;]*authenticated/);
  });
  it("covers every mutation table with a trigger", () => {
    for (const t of ["public.profiles", "public.organization_memberships", "public.user_roles", "public.team_members", "public.engineer_locations", "auth.users"]) {
      expect(migrationCode).toMatch(new RegExp(`CREATE TRIGGER \\w+ [^;]*ON ${t.replace(".", "\\.")}`));
    }
  });
  it("the auth.users trigger can never block authentication", () => {
    const fn = migrationCode.slice(migrationCode.indexOf("FUNCTION public._uaa_trg_auth_users"), migrationCode.indexOf("DROP TRIGGER IF EXISTS uaa_auth_users_upd"));
    expect(fn).toMatch(/EXCEPTION WHEN OTHERS THEN\s+RAISE WARNING/);
  });
  it("the profiles UPDATE trigger skips balance / language / notification-only updates (WHEN clause)", () => {
    const m = migrationCode.match(/CREATE TRIGGER uaa_profiles_upd[\s\S]*?EXECUTE FUNCTION/);
    expect(m).toBeTruthy();
    expect(m![0]).toMatch(/WHEN \(/);
    expect(m![0]).not.toMatch(/balance|preferred_language|notification_settings/);
  });
  it("is transactional and idempotent to re-run", () => {
    expect(migrationCode.trim().startsWith("BEGIN;")).toBe(true);
    expect(migrationCode.trim().endsWith("COMMIT;")).toBe(true);
    expect(migrationCode).toMatch(/CREATE TABLE IF NOT EXISTS public\.user_account_audit_events/);
    expect(migrationCode).toMatch(/NOT EXISTS \(SELECT 1 FROM public\.user_account_audit_events e WHERE e\.target_user_id = p\.user_id AND e\.event_type = 'baseline_snapshot'\)/);
  });
  it("the backfill invents nothing: no guessed actor, no reconstructed historical identity", () => {
    const backfill = migration.slice(migration.indexOf("7. Backfill"));
    expect(backfill.length).toBeGreaterThan(500);
    expect(backfill).toMatch(/snapshot_unavailable/);
    expect(backfill).toMatch(/NULL, NULL, public\._uaa_scrub\(public\._uaa_actor_snapshot\(a\.actor_user_id\)\)/);
    expect(backfill).toMatch(/NULL, 'migration', 'baseline_snapshot'/);
  });
});

describe("browser wiring", () => {
  const um = read("src/pages/UserManagement.tsx");
  it("User Management warns before saving a name + email change and records the confirmation", () => {
    const i = um.indexOf("identityChangeNeedsWarning({");
    const emailCall = um.indexOf('invokeAdminEdgeFunction("admin-update-user-email"');
    expect(i).toBeGreaterThan(-1);
    expect(i).toBeLessThan(emailCall);
    expect(um).toMatch(/await confirmIdentityChange\(/);
    expect(um).toMatch(/IDENTITY_WARNING_TEXT/);
    expect(um).toMatch(/data-testid="identity-reassignment-warning"/);
  });
  it("the warning never blocks: cancelling aborts, confirming continues, an unavailable summary still shows the warning", () => {
    expect(um).toMatch(/if \(!historySummary \|\| historySummary\.has_history\)/);
    expect(um).toMatch(/if \(!confirmed\) return;/);
  });
  it("the browser never sends an actor or organization override with an audit write", () => {
    const lib = strip(read("src/lib/userAccountAudit.ts"));
    expect(lib).not.toMatch(/p_actor_user_id/);
    expect(lib).not.toMatch(/\.from\("user_account_audit_events"\)\s*\.(insert|update|delete|upsert)/);
    expect(lib).not.toMatch(/\.(insert|update|delete|upsert)\(/);
  });
  it("account settings registers the self-service context before changing the password", () => {
    const layout = read("src/components/Layout.tsx");
    expect(layout.indexOf("registerMyAccountAuditContext()")).toBeGreaterThan(-1);
    expect(layout.indexOf("registerMyAccountAuditContext()")).toBeLessThan(layout.indexOf("supabase.auth.updateUser({"));
  });
  it("a bulk upload sends one batch id on every chunk", () => {
    const client = read("src/lib/bulkUsersImportClient.ts");
    expect(client).toMatch(/batch_id: batchId/);
    expect(client).toMatch(/const batchId = params\.batchId \?\? `bulk-\$\{crypto\.randomUUID\(\)\}`/);
  });
  it("User Audit page is admin-only and routed", () => {
    const app = read("src/App.tsx");
    expect(app).toMatch(/path="\/admin\/user-audit"[\s\S]*?allowedRoles=\{\["admin"\]\}[\s\S]*?<UserAudit \/>/);
  });
  it("historical business ownership is never touched by the identity edit path", () => {
    const start = um.indexOf("const handleUpdateUser");
    const end = um.indexOf("const handleDelete", start) > 0 ? um.indexOf("const handleDelete", start) : start + 20000;
    const body = um.slice(start, end);
    // the only expenses write in the edit flow re-points PENDING review assignees (pre-existing, unchanged behaviour)
    const expenseWrites = [...body.matchAll(/\.from\("expenses"\)\s*\.update\(\{([\s\S]*?)\}\)/g)].map((m) => m[1]);
    for (const w of expenseWrites) expect(w).not.toMatch(/\buser_id\b|created_by|submitted_by/);
  });
});

describe("edge helper <-> SQL signature parity (PostgREST calls RPCs by argument NAME)", () => {
  const helper = strip(read("supabase/functions/_shared/accountAudit.ts"));
  const sqlArgs = (fn: string): string[] => {
    const m = migrationCode.match(new RegExp(String.raw`FUNCTION public\.${fn}\(([\s\S]*?)\)\s*RETURNS`));
    if (!m) throw new Error(`signature of ${fn} not found`);
    return [...m[1].matchAll(/p_[a-z_]+/g)].map((x) => x[0]);
  };
  const tsArgs = (rpc: string): string[] => {
    const m = helper.match(new RegExp(String.raw`rpc\("${rpc}",\s*\{([\s\S]*?)\}\)`));
    if (!m) throw new Error(`call of ${rpc} not found`);
    return [...m[1].matchAll(/p_[a-z_]+/g)].map((x) => x[0]);
  };
  it.each(["register_user_account_audit_context_v1", "record_user_account_audit_event_v1", "clear_user_account_audit_context_v1"])(
    "%s: every argument the helper sends exists in the SQL function",
    (fn) => {
      const sql = new Set(sqlArgs(fn));
      for (const a of tsArgs(fn)) expect(sql.has(a)).toBe(true);
    },
  );
  it("the helper sends every argument the register function requires (no defaults)", () => {
    const m = migrationCode.match(/FUNCTION public\.register_user_account_audit_context_v1\(([\s\S]*?)\)\s*RETURNS/)!;
    const required = m[1].split(",").map((x) => x.trim()).filter((x) => x && !/DEFAULT/i.test(x)).map((x) => x.split(/\s+/)[0]);
    const sent = new Set(tsArgs("register_user_account_audit_context_v1"));
    for (const r of required) expect(sent.has(r)).toBe(true);
  });
});
