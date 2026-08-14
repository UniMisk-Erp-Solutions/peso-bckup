/**
 * Sign-in identifier mode derivation.
 *
 * Regression under test: the Auth page used `isTenantHost && tenantEmployeeIdLoginEnabled`,
 * which reported "email only" while the tenant was still loading AND when the feature
 * RPC failed. Employee ID 5003 was then rejected with "Enter your email address (include @)".
 */
import { describe, it, expect } from "vitest";
import {
  acceptsEmployeeId,
  blocksSubmit,
  offersRetry,
  resolveTenantSignInMode,
  showsEmailOnlyLabel,
  showsEmployeeIdLabel,
} from "@/lib/tenantSignInMode";

const tenant = {
  isTenantHost: true,
  tenantResolutionStatus: "resolved",
  tenantFeatureStatus: "resolved",
  tenantEmployeeIdLoginEnabled: true,
} as const;

describe("resolveTenantSignInMode", () => {
  it("treats the apex as email sign-in", () => {
    expect(
      resolveTenantSignInMode({
        isTenantHost: false,
        tenantResolutionStatus: "idle",
        tenantFeatureStatus: "idle",
        tenantEmployeeIdLoginEnabled: false,
      }),
    ).toBe("apex_email");
  });

  it("reports loading while the organization is still resolving", () => {
    expect(
      resolveTenantSignInMode({ ...tenant, tenantResolutionStatus: "loading" }),
    ).toBe("loading");
    expect(resolveTenantSignInMode({ ...tenant, tenantResolutionStatus: "idle" })).toBe("loading");
  });

  it("reports loading while the employee-login feature is still resolving", () => {
    expect(resolveTenantSignInMode({ ...tenant, tenantFeatureStatus: "loading" })).toBe("loading");
  });

  it("does NOT show an email-only label while loading", () => {
    const mode = resolveTenantSignInMode({ ...tenant, tenantFeatureStatus: "loading" });
    expect(showsEmailOnlyLabel(mode)).toBe(false);
    expect(showsEmployeeIdLabel(mode)).toBe(false);
  });

  it("shows Employee ID or Email when the tenant resolves with the feature enabled", () => {
    const mode = resolveTenantSignInMode(tenant);
    expect(mode).toBe("employee_or_email");
    expect(showsEmployeeIdLabel(mode)).toBe(true);
    expect(acceptsEmployeeId(mode)).toBe(true);
    expect(blocksSubmit(mode)).toBe(false);
  });

  it("shows email-only when the feature is explicitly disabled", () => {
    const mode = resolveTenantSignInMode({ ...tenant, tenantEmployeeIdLoginEnabled: false });
    expect(mode).toBe("tenant_email_only");
    expect(showsEmailOnlyLabel(mode)).toBe(true);
    expect(acceptsEmployeeId(mode)).toBe(false);
  });

  it("does not claim the feature is disabled when its RPC fails", () => {
    const mode = resolveTenantSignInMode({
      ...tenant,
      tenantFeatureStatus: "error",
      tenantEmployeeIdLoginEnabled: false,
    });
    expect(mode).toBe("unavailable");
    expect(showsEmailOnlyLabel(mode)).toBe(false);
    expect(offersRetry(mode)).toBe(true);
  });

  it("offers Retry when organization resolution fails", () => {
    const mode = resolveTenantSignInMode({ ...tenant, tenantResolutionStatus: "error" });
    expect(mode).toBe("unavailable");
    expect(offersRetry(mode)).toBe(true);
    expect(blocksSubmit(mode)).toBe(true);
  });

  it("distinguishes a missing subdomain record from a failed lookup", () => {
    expect(resolveTenantSignInMode({ ...tenant, tenantResolutionStatus: "not_found" })).toBe(
      "not_configured",
    );
    expect(resolveTenantSignInMode({ ...tenant, tenantResolutionStatus: "error" })).toBe(
      "unavailable",
    );
  });
});
