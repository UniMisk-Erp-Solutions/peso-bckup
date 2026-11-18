import { describe, expect, it } from "vitest";
import { isOrganizationBlocked } from "@/lib/orgBlocked";
import {
  MASTER_ADMIN_FEATURE_DEFINITIONS,
  ORGANIZATION_FEATURE_KEYS,
} from "@/lib/organizationFeatureKeys";

describe("isOrganizationBlocked (DOC-165)", () => {
  it("is false with no flag row (default off)", () => {
    expect(isOrganizationBlocked({}, "employee")).toBe(false);
    expect(isOrganizationBlocked(null, "admin")).toBe(false);
    expect(isOrganizationBlocked(undefined, "admin")).toBe(false);
  });

  it("is false when the flag is explicitly off", () => {
    expect(isOrganizationBlocked({ org_blocked: false }, "employee")).toBe(false);
  });

  it("is true for every non-master role when the flag is on", () => {
    for (const role of ["admin", "employee", "cashier", "engineer", "team_leader", "executive"]) {
      expect(isOrganizationBlocked({ org_blocked: true }, role)).toBe(true);
    }
  });

  it("never blocks the master admin", () => {
    expect(isOrganizationBlocked({ org_blocked: true }, "master_admin")).toBe(false);
  });

  it("ignores other flags", () => {
    expect(isOrganizationBlocked({ tally_integration: true }, "admin")).toBe(false);
  });

  it("is listed in Master Admin feature definitions", () => {
    expect(
      MASTER_ADMIN_FEATURE_DEFINITIONS.some((d) => d.key === ORGANIZATION_FEATURE_KEYS.org_blocked),
    ).toBe(true);
  });
});
