import { describe, expect, it } from "vitest";
import { canRoleSubmitOwnExpenses } from "@/hooks/useCanSubmitOwnExpenses";

describe("canRoleSubmitOwnExpenses", () => {
  it("allows hierarchy reviewers to submit their own expenses", () => {
    expect(canRoleSubmitOwnExpenses("executive", null)).toBe(true);
    expect(canRoleSubmitOwnExpenses("team_leader", null)).toBe(true);
  });

  it("allows standard submitter roles", () => {
    expect(canRoleSubmitOwnExpenses("employee", null)).toBe(true);
    expect(canRoleSubmitOwnExpenses("engineer", null)).toBe(true);
    expect(canRoleSubmitOwnExpenses("admin", null)).toBe(true);
  });

  it("gates cashiers on org setting", () => {
    expect(canRoleSubmitOwnExpenses("cashier", false)).toBe(false);
    expect(canRoleSubmitOwnExpenses("cashier", true)).toBe(true);
  });

  it("denies unknown roles", () => {
    expect(canRoleSubmitOwnExpenses("master_admin", null)).toBe(false);
    expect(canRoleSubmitOwnExpenses(null, null)).toBe(false);
  });
});
