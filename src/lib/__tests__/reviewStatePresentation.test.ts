import { describe, expect, it } from "vitest";
import {
  batchReviewState,
  reviewRowState,
  reviewStatePresentation,
} from "@/lib/reviewStatePresentation";

const ready = { isReadyNow: true, isTerminal: false };
const waiting = { isReadyNow: false, isTerminal: false };
const terminal = { isReadyNow: false, isTerminal: true };

describe("reviewRowState", () => {
  it("terminal wins over ready", () => {
    expect(reviewRowState({ isReadyNow: true, isTerminal: true })).toBe("completed");
  });
  it("ready when actionable and not terminal", () => {
    expect(reviewRowState({ isReadyNow: true, isTerminal: false })).toBe("ready");
  });
  it("waiting when visible but not yet ready", () => {
    expect(reviewRowState({ isReadyNow: false, isTerminal: false })).toBe("waiting");
  });
});

describe("reviewStatePresentation", () => {
  it("ready is blue and selectable", () => {
    const p = reviewStatePresentation("ready");
    expect(p.className).toContain("bg-blue-600");
    expect(p.selectable).toBe(true);
  });
  it("waiting is amber and selectable (visible-but-not-ready can still be selected)", () => {
    const p = reviewStatePresentation("waiting");
    expect(p.className).toContain("bg-amber-500");
    expect(p.selectable).toBe(true);
  });
  it("completed is neutral/grey and NOT selectable", () => {
    const p = reviewStatePresentation("completed");
    expect(p.variant).toBe("secondary");
    expect(p.selectable).toBe(false);
    expect(p.className).not.toContain("bg-blue-600");
    expect(p.className).not.toContain("bg-amber-500");
  });
});

describe("batchReviewState (child-based; §25 matrix)", () => {
  it("all terminal → completed (grey)", () => {
    expect(batchReviewState([terminal, terminal])).toBe("completed");
  });
  it("all waiting → waiting (amber) — the screenshot bug", () => {
    // A Manager viewing an executive-tier batch: every child non-terminal, none
    // ready. Old model called this 'all-done'/grey; correct is amber.
    expect(batchReviewState([waiting, waiting, waiting])).toBe("waiting");
  });
  it("waiting + terminal (no ready) → waiting (amber)", () => {
    expect(batchReviewState([waiting, terminal])).toBe("waiting");
  });
  it("ready + waiting → ready (blue)", () => {
    expect(batchReviewState([ready, waiting])).toBe("ready");
  });
  it("ready + terminal → ready (blue)", () => {
    expect(batchReviewState([ready, terminal])).toBe("ready");
  });
  it("all ready → ready (blue)", () => {
    expect(batchReviewState([ready, ready])).toBe("ready");
  });
  it("empty → completed", () => {
    expect(batchReviewState([])).toBe("completed");
  });
});
