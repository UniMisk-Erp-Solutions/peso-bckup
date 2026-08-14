/**
 * DOC-087 — feature-key registration and translation coverage.
 *
 * `npm run i18n:check` cannot run in this environment (Node refuses the .ts
 * script — a pre-existing, unrelated failure), so the new keys are verified
 * explicitly here instead of being assumed covered.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  MASTER_ADMIN_FEATURE_DEFINITIONS,
  ORGANIZATION_FEATURE_KEYS,
} from "@/lib/organizationFeatureKeys";
import { isOrganizationFeatureActive } from "@/lib/orgFeatureGates";

const cwd = process.cwd();
const LOCALES = ["en", "hi", "gu"] as const;

function readLocale(locale: string, ns: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(cwd, `src/locales/${locale}/${ns}.json`), "utf-8"));
}

describe("employee_transfer_history feature key", () => {
  it("is registered in ORGANIZATION_FEATURE_KEYS", () => {
    expect(ORGANIZATION_FEATURE_KEYS.employee_transfer_history).toBe(
      "employee_transfer_history",
    );
  });

  it("appears exactly once in MASTER_ADMIN_FEATURE_DEFINITIONS", () => {
    const defs = MASTER_ADMIN_FEATURE_DEFINITIONS.filter(
      (d) => d.key === ORGANIZATION_FEATURE_KEYS.employee_transfer_history,
    );
    expect(defs).toHaveLength(1);
    expect(defs[0]!.labelKey).toBe("features.employeeTransferHistory");
    expect(defs[0]!.requiresSubdomain).toBe(false);
  });

  it("defaults to OFF when the organization has no feature row", () => {
    const ctx = {
      featureFlags: {},
      isTenantHost: false,
      tenantHostOrgId: null,
      organizationId: "org-1",
    };
    expect(
      isOrganizationFeatureActive(
        ORGANIZATION_FEATURE_KEYS.employee_transfer_history,
        ctx,
      ),
    ).toBe(false);
  });

  it("is OFF when the row exists but is disabled", () => {
    const ctx = {
      featureFlags: { employee_transfer_history: false },
      isTenantHost: false,
      tenantHostOrgId: null,
      organizationId: "org-1",
    };
    expect(
      isOrganizationFeatureActive(
        ORGANIZATION_FEATURE_KEYS.employee_transfer_history,
        ctx,
      ),
    ).toBe(false);
  });

  it("is ON only when explicitly enabled — no subdomain requirement", () => {
    const ctx = {
      featureFlags: { employee_transfer_history: true },
      isTenantHost: false,
      tenantHostOrgId: null,
      organizationId: "org-1",
    };
    expect(
      isOrganizationFeatureActive(
        ORGANIZATION_FEATURE_KEYS.employee_transfer_history,
        ctx,
      ),
    ).toBe(true);
  });
});

const PAGE_KEYS = [
  "pageTitle",
  "pageDescription",
  "currentBalance",
  "lastCredit",
  "recentCredits",
  "amountCredited",
  "paymentMethod",
  "creditedBy",
  "sourceBank",
  "date",
  "bankTransfer",
  "cash",
  "notRecorded",
  "systemCredit",
  "noCredits",
  "noLastCredit",
  "loadError",
  "retry",
  "expenseHistoryNote",
  "viewBalanceHistory",
];

describe.each(LOCALES)("translations — %s", (locale) => {
  it("has every transfers:balanceHistory key, non-empty", () => {
    const ns = readLocale(locale, "transfers");
    const block = ns.balanceHistory as Record<string, unknown>;
    expect(block, `transfers.json for '${locale}' must have balanceHistory`).toBeDefined();

    for (const key of PAGE_KEYS) {
      expect(typeof block[key], `balanceHistory.${key} missing in '${locale}'`).toBe(
        "string",
      );
      expect((block[key] as string).trim().length).toBeGreaterThan(0);
    }
  });

  it("has the nav label", () => {
    const nav = readLocale(locale, "nav");
    expect(typeof nav.balanceHistory).toBe("string");
    expect((nav.balanceHistory as string).trim().length).toBeGreaterThan(0);
  });

  it("has the Master Admin feature label", () => {
    const master = readLocale(locale, "master");
    const features = master.features as Record<string, unknown>;
    expect(typeof features.employeeTransferHistory).toBe("string");
    expect((features.employeeTransferHistory as string).trim().length).toBeGreaterThan(0);
  });

  it("is actually translated, not an English copy", () => {
    if (locale === "en") return;
    const en = readLocale("en", "transfers").balanceHistory as Record<string, string>;
    const loc = readLocale(locale, "transfers").balanceHistory as Record<string, string>;
    // "PesoWise" appears in both by design; the surrounding copy must differ.
    expect(loc.pageTitle).not.toBe(en.pageTitle);
    expect(loc.noCredits).not.toBe(en.noCredits);
  });
});

const OLD_MONEY_KEYS = [
  "greetingMorning",
  "greetingAfternoon",
  "greetingEvening",
  "overview",
  "subtitle",
  "record",
  "transactions",
  "avgExpense",
  "approvedRate",
  "largest",
  "netPosition",
  "balanceHistory",
  "availableBalance",
  "spendVsLastMonth",
  "spent",
  "approved",
  "submitted",
  "barsAriaLabel",
  "monthlySpend",
  "available",
  "approvedWithAmount",
  "pendingWithAmount",
  "whereItWent",
  "total",
  "noSpending",
  "wallet",
  "lastDebit",
  "recentActivity",
  "history",
  "expenseFallback",
  "noRecentActivity",
  "memberFallback",
];

describe.each(LOCALES)("Old Money dashboard translations — %s", (locale) => {
  it("has every dashboard:oldMoney key, non-empty", () => {
    const block = readLocale(locale, "dashboard").oldMoney as Record<string, unknown>;
    expect(block, `dashboard.json for '${locale}' must have oldMoney`).toBeDefined();

    for (const key of OLD_MONEY_KEYS) {
      expect(typeof block[key], `oldMoney.${key} missing in '${locale}'`).toBe("string");
      expect((block[key] as string).trim().length).toBeGreaterThan(0);
    }
  });

  it("keeps interpolation placeholders intact", () => {
    const block = readLocale(locale, "dashboard").oldMoney as Record<string, string>;
    expect(block.spendVsLastMonth).toContain("{{pct}}");
    expect(block.approvedWithAmount).toContain("{{amount}}");
    expect(block.pendingWithAmount).toContain("{{amount}}");
  });

  it("is actually translated, not an English copy", () => {
    if (locale === "en") return;
    const en = readLocale("en", "dashboard").oldMoney as Record<string, string>;
    const loc = readLocale(locale, "dashboard").oldMoney as Record<string, string>;
    for (const key of ["netPosition", "monthlySpend", "recentActivity", "noSpending"]) {
      expect(loc[key], `oldMoney.${key} untranslated in '${locale}'`).not.toBe(en[key]);
    }
  });
});

describe("page copy avoids over-claiming", () => {
  it("never calls itself a complete ledger or statement", () => {
    const page = readFileSync(
      resolve(cwd, "src/pages/EmployeeBalanceHistory.tsx"),
      "utf-8",
    );
    const en = JSON.stringify(readLocale("en", "transfers").balanceHistory);
    for (const banned of [
      "Complete Account Ledger",
      "Full Balance Ledger",
      "Complete Transaction Statement",
    ]) {
      expect(page).not.toContain(banned);
      expect(en).not.toContain(banned);
    }
  });

  it("tells the employee where deductions live", () => {
    const en = readLocale("en", "transfers").balanceHistory as Record<string, string>;
    expect(en.expenseHistoryNote.toLowerCase()).toContain("expense");
  });
});
