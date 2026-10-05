import { describe, expect, it } from "vitest";
import { pickCurrentMembership } from "@/lib/currentMembership";

const orgA = { organization_id: "org-a", role: "admin" };
const orgB = { organization_id: "org-b", role: "employee" };

describe("pickCurrentMembership (multi-membership role/organization resolution)", () => {
  it("returns the membership for the CURRENT organization when a user has two active memberships", () => {
    expect(pickCurrentMembership([orgA, orgB], "org-a")?.role).toBe("admin");
    expect(pickCurrentMembership([orgB, orgA], "org-a")?.role).toBe("admin");
  });

  it("switching the current organization switches the resolved role", () => {
    expect(pickCurrentMembership([orgA, orgB], "org-b")?.role).toBe("employee");
  });

  it("falls back to the first row only when no current organization is known or it has no match", () => {
    expect(pickCurrentMembership([orgA, orgB], null)?.role).toBe("admin");
    expect(pickCurrentMembership([orgB, orgA], "org-unknown")?.role).toBe("employee");
  });

  it("returns null for no memberships and works for the single-membership common case", () => {
    expect(pickCurrentMembership([], "org-a")).toBeNull();
    expect(pickCurrentMembership(null, "org-a")).toBeNull();
    expect(pickCurrentMembership([orgB], "org-b")?.role).toBe("employee");
  });
});
