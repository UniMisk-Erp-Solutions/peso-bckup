import { describe, expect, it } from "vitest";
import { ORGANIZATION_FEATURE_KEYS } from "@/lib/organizationFeatureKeys";

describe("transfer_recipient_acceptance feature key", () => {
  it("is registered for master admin gating", () => {
    expect(ORGANIZATION_FEATURE_KEYS.transfer_recipient_acceptance).toBe(
      "transfer_recipient_acceptance",
    );
  });
});
