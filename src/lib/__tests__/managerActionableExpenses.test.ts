import { describe, expect, it } from "vitest";
import {
  computeManagerQueueReady,
  isSkippedHierarchyTier,
} from "@/lib/managerActionableExpenses";

describe("managerActionableExpenses", () => {
  it("treats submitted engineer-tier expenses as manager-ready", () => {
    expect(
      computeManagerQueueReady(
        { status: "submitted", approval_tier: "engineer" },
        new Set(),
        true,
      ),
    ).toBe(true);
  });

  it("treats team_leader tier as skipped when TL feature is off", () => {
    expect(
      isSkippedHierarchyTier("team_leader", true, {
        teamLeaderTierEnabled: false,
        executiveTierEnabled: false,
      }),
    ).toBe(true);

    expect(
      computeManagerQueueReady(
        { status: "submitted", approval_tier: "team_leader" },
        new Set(),
        true,
        { teamLeaderTierEnabled: false, executiveTierEnabled: false },
      ),
    ).toBe(true);
  });

  it("keeps team_leader tier blocking when TL feature is on", () => {
    expect(
      computeManagerQueueReady(
        { status: "submitted", approval_tier: "team_leader" },
        new Set(),
        true,
        { teamLeaderTierEnabled: true, executiveTierEnabled: false },
      ),
    ).toBe(false);
  });

  it("treats legacy submitted expenses as manager-ready without hierarchy", () => {
    expect(
      computeManagerQueueReady(
        { status: "submitted", approval_tier: "team_leader" },
        new Set(),
        false,
      ),
    ).toBe(true);
  });
});
