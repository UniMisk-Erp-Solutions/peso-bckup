import { describe, expect, it } from "vitest";
import {
  allowedSupervisorRolesFor,
  roleShowsImmediateSupervisor,
} from "@/lib/immediateSupervisor";

describe("immediateSupervisor", () => {
  it("employee may report to team leader, executive, or manager when tiers enabled", () => {
    expect(
      allowedSupervisorRolesFor("employee", {
        teamLeaderTierEnabled: true,
        executiveTierEnabled: true,
      }),
    ).toEqual(["team_leader", "executive", "engineer"]);
  });

  it("employee cannot report to team leader when tier disabled", () => {
    expect(
      allowedSupervisorRolesFor("employee", {
        teamLeaderTierEnabled: false,
        executiveTierEnabled: true,
      }),
    ).toEqual(["executive", "engineer"]);
  });

  it("team leader may report to executive or manager only", () => {
    expect(
      allowedSupervisorRolesFor("team_leader", {
        teamLeaderTierEnabled: true,
        executiveTierEnabled: true,
      }),
    ).toEqual(["executive", "engineer"]);
  });

  it("executive may report to manager only", () => {
    expect(roleShowsImmediateSupervisor("executive")).toBe(true);
    expect(
      allowedSupervisorRolesFor("executive", {
        teamLeaderTierEnabled: true,
        executiveTierEnabled: true,
      }),
    ).toEqual(["engineer"]);
  });
});
