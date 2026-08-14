import { describe, it, expect } from "vitest";
import {
  resolveOrganizationIdentityPolicy,
  getPersonSearchPlaceholderKey,
} from "@/lib/organizationIdentityMode";

describe("resolveOrganizationIdentityPolicy", () => {
  it("1. employee_id_login=false → email_only", () => {
    const p = resolveOrganizationIdentityPolicy(false, false);
    expect(p.mode).toBe("email_only");
    expect(p.employeeIdEnabled).toBe(false);
    expect(p.includeEmailInSearch).toBe(true);
    expect(p.includeEmployeeIdInSearch).toBe(false);
    expect(p.emailIsUserFacing).toBe(true);
    expect(p.allowSyntheticEmployeeIdFallback).toBe(false);
  });

  it("2. employee_id_login=true, user_email_auto=false → employee_id_and_email", () => {
    const p = resolveOrganizationIdentityPolicy(true, false);
    expect(p.mode).toBe("employee_id_and_email");
    expect(p.employeeIdEnabled).toBe(true);
    expect(p.includeEmailInSearch).toBe(true);
    expect(p.includeEmployeeIdInSearch).toBe(true);
    expect(p.emailIsUserFacing).toBe(true);
    expect(p.allowSyntheticEmployeeIdFallback).toBe(false);
  });

  it("3. employee_id_login=true, user_email_auto=true → employee_id_only", () => {
    const p = resolveOrganizationIdentityPolicy(true, true);
    expect(p.mode).toBe("employee_id_only");
    expect(p.employeeIdEnabled).toBe(true);
    expect(p.includeEmailInSearch).toBe(false);
    expect(p.includeEmployeeIdInSearch).toBe(true);
    expect(p.emailIsUserFacing).toBe(false);
    expect(p.showEmailInIdentitySubline).toBe(false);
    expect(p.allowSyntheticEmployeeIdFallback).toBe(true);
  });

  it("17. employee_id_login=false ignores userEmailAuto value", () => {
    // user_email_auto without employee_id_login still means email_only
    const p = resolveOrganizationIdentityPolicy(false, true);
    expect(p.mode).toBe("email_only");
  });
});

describe("getPersonSearchPlaceholderKey", () => {
  it("email_only → nameEmail key", () => {
    const p = resolveOrganizationIdentityPolicy(false, false);
    expect(getPersonSearchPlaceholderKey(p)).toBe("common:searchPlaceholder.nameEmail");
  });

  it("email_only with role → nameEmailRole key", () => {
    const p = resolveOrganizationIdentityPolicy(false, false);
    expect(getPersonSearchPlaceholderKey(p, { includeRole: true })).toBe(
      "common:searchPlaceholder.nameEmailRole",
    );
  });

  it("employee_id_and_email → nameEmployeeIdEmail key", () => {
    const p = resolveOrganizationIdentityPolicy(true, false);
    expect(getPersonSearchPlaceholderKey(p)).toBe(
      "common:searchPlaceholder.nameEmployeeIdEmail",
    );
  });

  it("employee_id_only → nameEmployeeId key", () => {
    const p = resolveOrganizationIdentityPolicy(true, true);
    expect(getPersonSearchPlaceholderKey(p)).toBe("common:searchPlaceholder.nameEmployeeId");
  });
});
