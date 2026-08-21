import { describe, expect, it } from "vitest";
import { waitingReasonLabel } from "@/lib/reviewWaitingReason";

describe("waitingReasonLabel — DOC-098 Part 9", () => {
  it("labels a team_leader-tier row", () => {
    expect(waitingReasonLabel({ approval_tier: "team_leader", status: "submitted" })).toBe(
      "Waiting for Team Leader",
    );
  });

  it("labels an executive-tier row", () => {
    expect(waitingReasonLabel({ approval_tier: "executive", status: "submitted" })).toBe(
      "Waiting for Executive",
    );
  });

  it("labels an engineer-tier row as Manager review", () => {
    expect(waitingReasonLabel({ approval_tier: "engineer", status: "level_2_verified" })).toBe(
      "Waiting for Manager review",
    );
  });

  it("labels an admin-tier row", () => {
    expect(waitingReasonLabel({ approval_tier: "admin", status: "level_2_verified" })).toBe(
      "Waiting for Admin",
    );
  });

  it("prefers approval_tier over status when both are present", () => {
    // A row with tier=team_leader and status=level_1_verified is still
    // waiting for the NEXT step, which the tier already names authoritatively.
    expect(
      waitingReasonLabel({ approval_tier: "team_leader", status: "level_1_verified" }),
    ).toBe("Waiting for Team Leader");
  });

  it("falls back to Executive when tier is null but status shows level_1_verified", () => {
    expect(waitingReasonLabel({ approval_tier: null, status: "level_1_verified" })).toBe(
      "Waiting for Executive",
    );
  });

  it("falls back to a generic label when neither tier nor a recognized status is available", () => {
    expect(waitingReasonLabel({ approval_tier: null, status: "submitted" })).toBe(
      "Waiting for previous verification",
    );
    expect(waitingReasonLabel({})).toBe("Waiting for previous verification");
  });

  it("is case-insensitive on approval_tier", () => {
    expect(waitingReasonLabel({ approval_tier: "TEAM_LEADER" })).toBe("Waiting for Team Leader");
  });
});
