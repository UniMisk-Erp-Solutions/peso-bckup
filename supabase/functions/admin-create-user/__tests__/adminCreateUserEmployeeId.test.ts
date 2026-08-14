/**
 * Issue 3 fix (debug/6456-supervisor-auth-runtime, 2026-08-12): employee
 * 2417 (Nitin Parmar, MicroLink) was entered in Create User but
 * profiles.employee_id ended up null, while the API reported success.
 *
 * Root cause, confirmed read-only against Production: admin-create-user
 * discarded the result of `.from("profiles").update(profileUpdate)...` —
 * no error check, no verification, immediate `success: true` regardless.
 * Live data showed the real cost: 8 "Nitin Parmar" profiles in MicroLink —
 * the FIRST (2026-08-11 11:55:19) has employee_id='2417' correctly
 * persisted; the other 7 (created over the following ~17 hours, each with a
 * real auth.users row and a real organization_memberships row, per the
 * owner retrying after each apparent failure) all have employee_id=''
 * because the org-scoped unique index on (organization_id, employee_id)
 * rejected each subsequent write and the function never noticed.
 *
 * This is a Deno edge function (esm.sh imports), not part of the Node/
 * vitest-executable app, and this repo has no existing Deno-function test
 * runner — so, matching the established pattern for untestable-in-process
 * SQL migrations in this codebase, these are source guards proving the
 * deployed logic has the exact shape verified against the live incident:
 * the profile-update result is checked, a duplicate Employee ID is caught
 * (ideally before any auth user is even created) with a clean 409, a
 * verification-mismatch or zero-row update is treated as failure, and a
 * failure after auth-user creation rolls back ONLY the account this
 * invocation just created.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const cwd = process.cwd();

function read(relativePath: string): string {
  return readFileSync(resolve(cwd, relativePath), "utf-8");
}

describe("admin-create-user — employee_id write is verified, not discarded", () => {
  const fn = read("supabase/functions/admin-create-user/index.ts");

  it("pre-checks for a duplicate Employee ID in this organization before creating any auth user", () => {
    const preCheckIndex = fn.indexOf("Pre-check the Employee ID");
    const createUserIndex = fn.indexOf("serviceClient.auth.admin.createUser");
    expect(preCheckIndex).toBeGreaterThan(-1);
    expect(createUserIndex).toBeGreaterThan(-1);
    expect(preCheckIndex).toBeLessThan(createUserIndex);
    expect(fn).toContain('.eq("organization_id", organizationId)');
    expect(fn).toContain('.eq("employee_id", employeeId)');
  });

  it("checks the result of the profiles.employee_id update instead of discarding it", () => {
    expect(fn).not.toMatch(
      /await serviceClient\s*\n?\s*\.from\("profiles"\)\s*\n?\s*\.update\(profileUpdate\)\s*\n?\s*\.eq\("user_id", userId\);/,
    );
    expect(fn).toContain("const { data: updatedProfile, error: profileUpdateError }");
    expect(fn).toContain(".select(\"user_id, employee_id\")");
  });

  it("treats a zero-row update or an employee_id that didn't actually persist as failure, not success", () => {
    expect(fn).toContain("const employeeIdPersisted =");
    expect(fn).toContain("!employeeId || updatedProfile?.employee_id === employeeId");
    expect(fn).toContain(
      "if (profileUpdateError || !updatedProfile || !employeeIdPersisted) {",
    );
  });

  it("rolls back only the auth user THIS invocation just created on a profile-write failure", () => {
    const rollbackSection = fn.slice(
      fn.indexOf("if (profileUpdateError || !updatedProfile"),
      fn.indexOf("return jsonResponse(", fn.indexOf("if (profileUpdateError || !updatedProfile")),
    );
    expect(rollbackSection).toContain("serviceClient.auth.admin.deleteUser(userId)");
  });

  it("returns a clean, understandable 409 conflict for a duplicate Employee ID, not a generic 500", () => {
    expect(fn).toContain("isDuplicateEmployeeId");
    expect(fn).toContain("already exists in this organization");
    expect(fn).toContain("isDuplicateEmployeeId ? 409 : 400");
  });

  it("never returns success while employee_id was requested but not confirmed persisted", () => {
    const successBlockIndex = fn.lastIndexOf("success: true");
    const employeeIdPersistedCheckIndex = fn.indexOf("const employeeIdPersisted =");
    expect(employeeIdPersistedCheckIndex).toBeGreaterThan(-1);
    expect(successBlockIndex).toBeGreaterThan(employeeIdPersistedCheckIndex);
    // The success response now echoes the persisted employee_id so the
    // caller can verify what was actually saved, not just trust a boolean.
    expect(fn).toContain("employee_id: updatedProfile.employee_id ?? null");
  });

  it("still checks the existing email-uniqueness and organization-membership-failure rollback paths (no regression)", () => {
    expect(fn).toContain('"An account with this email already exists"');
    expect(fn).toContain("await serviceClient.auth.admin.deleteUser(userId).catch(() => undefined);");
    expect(fn).toContain("assign_user_to_organization");
  });
});
