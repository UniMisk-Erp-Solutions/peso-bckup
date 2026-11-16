import { describe, expect, it } from "vitest";
import { isTerminalStatus, resolveTier, monthsBetween } from "./eligibility";

describe("archive eligibility", () => {
  it("honours terminal status lists", () => {
    expect(isTerminalStatus("paid", true, ["paid", "rejected"])).toBe(true);
    expect(isTerminalStatus("draft", true, ["paid", "rejected"])).toBe(false);
    expect(isTerminalStatus("draft", false, [])).toBe(true);
  });

  it("maps retention windows to tiers", () => {
    expect(resolveTier(6, 24, 60, 120)).toBe("hot");
    expect(resolveTier(30, 24, 60, 120)).toBe("warm");
    expect(resolveTier(100, 24, 60, 120)).toBe("cold");
  });

  it("computes month distance", () => {
    const a = new Date("2024-01-15");
    const b = new Date("2026-01-15");
    expect(monthsBetween(a, b)).toBe(24);
  });
});
