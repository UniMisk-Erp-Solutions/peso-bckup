import { describe, expect, it } from "vitest";
import { ORGANIZATION_FEATURE_KEYS } from "@/lib/organizationFeatureKeys";
import { isPathBlockedForAccountantCashier } from "@/lib/routeAccess";

function resolveCapabilities(input: {
  userRole: string | null;
  isAccountantCashier: boolean;
  featureEnabled: boolean;
}) {
  const isCashier = input.userRole === "cashier";
  const isAccountant =
    isCashier && input.isAccountantCashier && input.featureEnabled;
  return {
    isOperationalCashier: isCashier && !isAccountant,
    canAccessReports: input.userRole === "admin" || isAccountant,
    canWriteCashierOps: isCashier && !isAccountant,
  };
}

describe("cashier accountant capabilities", () => {
  it("exposes feature key", () => {
    expect(ORGANIZATION_FEATURE_KEYS.cashier_accountant_mode).toBe(
      "cashier_accountant_mode",
    );
  });

  it("operational cashier when flag is false", () => {
    const caps = resolveCapabilities({
      userRole: "cashier",
      isAccountantCashier: false,
      featureEnabled: true,
    });
    expect(caps.isOperationalCashier).toBe(true);
    expect(caps.canWriteCashierOps).toBe(true);
    expect(caps.canAccessReports).toBe(false);
  });

  it("accountant cashier is read-only and can access reports", () => {
    const caps = resolveCapabilities({
      userRole: "cashier",
      isAccountantCashier: true,
      featureEnabled: true,
    });
    expect(caps.isOperationalCashier).toBe(false);
    expect(caps.canWriteCashierOps).toBe(false);
    expect(caps.canAccessReports).toBe(true);
  });

  it("ignores accountant flag when feature is off", () => {
    const caps = resolveCapabilities({
      userRole: "cashier",
      isAccountantCashier: true,
      featureEnabled: false,
    });
    expect(caps.isOperationalCashier).toBe(true);
    expect(caps.canAccessReports).toBe(false);
  });

  it("admin can always access reports", () => {
    const caps = resolveCapabilities({
      userRole: "admin",
      isAccountantCashier: false,
      featureEnabled: false,
    });
    expect(caps.canAccessReports).toBe(true);
  });
});

describe("accountant cashier route access", () => {
  it("blocks operational cashier paths", () => {
    expect(isPathBlockedForAccountantCashier("/balances")).toBe(true);
    expect(isPathBlockedForAccountantCashier("/cashier/transactions")).toBe(true);
    expect(isPathBlockedForAccountantCashier("/expenses/new")).toBe(true);
    expect(isPathBlockedForAccountantCashier("/admin/expenses")).toBe(true);
  });

  it("allows read-only expense detail, reports, and transfer history paths", () => {
    expect(isPathBlockedForAccountantCashier("/expenses/abc-123")).toBe(false);
    expect(isPathBlockedForAccountantCashier("/admin/reports")).toBe(false);
    expect(isPathBlockedForAccountantCashier("/accountant/expenses")).toBe(false);
    expect(isPathBlockedForAccountantCashier("/cash-transfer-history")).toBe(false);
  });

  it("blocks expense edit routes", () => {
    expect(isPathBlockedForAccountantCashier("/expenses/abc-123/edit")).toBe(true);
  });
});
