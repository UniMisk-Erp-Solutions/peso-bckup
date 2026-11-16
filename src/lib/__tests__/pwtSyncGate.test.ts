import { describe, expect, it } from "vitest";
import { isPwtSyncEnabled } from "@/lib/pwtSyncGate";
import {
  MASTER_ADMIN_FEATURE_DEFINITIONS,
  ORGANIZATION_FEATURE_KEYS,
} from "@/lib/organizationFeatureKeys";

const withFlags = (on: string[]) => (key: string) => on.includes(key);

describe("isPwtSyncEnabled", () => {
  it("is off when the company feature is off, even if the build has the integration", () => {
    expect(isPwtSyncEnabled(withFlags([]), true)).toBe(false);
  });

  it("is off when the build lacks the integration, even if the company feature is on", () => {
    expect(isPwtSyncEnabled(withFlags([ORGANIZATION_FEATURE_KEYS.tally_integration]), false)).toBe(false);
  });

  it("is on only when both the build and the company feature are on", () => {
    expect(isPwtSyncEnabled(withFlags([ORGANIZATION_FEATURE_KEYS.tally_integration]), true)).toBe(true);
  });

  it("does not react to unrelated company features", () => {
    expect(isPwtSyncEnabled(withFlags([ORGANIZATION_FEATURE_KEYS.historical_balance_v2]), true)).toBe(false);
  });
});

describe("tally_integration feature definition", () => {
  it("is listed in Master Admin for every company, with no subdomain requirement", () => {
    const def = MASTER_ADMIN_FEATURE_DEFINITIONS.find((d) => d.key === "tally_integration");
    expect(def).toBeDefined();
    expect(def?.requiresSubdomain).toBe(false);
    expect(def?.labelKey).toBe("features.tallyIntegration");
  });
});
