/**
 * Real behavioral tests for Review Expenses' Month / relative-Time-Period
 * mutual exclusion (§14-22 of the month-filter hardening audit). These run
 * actual state transitions through src/lib/reviewDateMode.ts rather than
 * grepping EngineerReview.tsx's source text -- §33 explicitly requires
 * behavioral proof for this contract, since a source-text assertion cannot
 * prove a multi-step interaction never clobbers an unrelated draft.
 */
import { describe, it, expect } from "vitest";
import {
  initialReviewDateModeState,
  selectExpenseMonth,
  stageTimePeriodDraft,
  commitDraftTimePeriod,
  selectTimePeriodImmediate,
} from "../reviewDateMode";
import { ALL_MONTHS } from "../expenseMonthFilter";

describe("the reported BLOCKER: a stale draftTimePeriod must never wipe a later Month selection", () => {
  it("Past Month -> select August -> change Status only -> Search: August survives", () => {
    let s = initialReviewDateModeState();

    // 1. User applies "Past Month" (a relative time period) via Search.
    s = stageTimePeriodDraft(s, "month");
    s = commitDraftTimePeriod(s);
    expect(s.timePeriod).toBe("month");

    // 2. User selects exact Month "August 2026" -- applies immediately.
    s = selectExpenseMonth(s, "2026-08");
    expect(s.expenseMonth).toBe("2026-08");
    expect(s.timePeriod).toBe("all");
    expect(s.draftTimePeriod).toBe("all"); // the fix: never left stale

    // 3. User changes some OTHER draft field (modeled here as simply not
    // touching the Time Period draft at all) and presses Search.
    s = commitDraftTimePeriod(s);

    // August must still be selected -- this is the exact bug: without the
    // fix, a stale non-"all" draftTimePeriod from step 1 would wipe it here.
    expect(s.expenseMonth).toBe("2026-08");
  });

  it("reproduces the PRE-FIX bug shape directly: a draft that is never reset to 'all' on Month selection", () => {
    // This models the OLD handleExpenseMonthChange, which never touched
    // timePeriod/draftTimePeriod at all when Month was selected.
    type OldState = { timePeriod: string; expenseMonth: string; draftTimePeriod: string };
    let s: OldState = { timePeriod: "all", expenseMonth: ALL_MONTHS, draftTimePeriod: "all" };

    s = { ...s, draftTimePeriod: "month" };
    s = { ...s, timePeriod: s.draftTimePeriod, expenseMonth: s.draftTimePeriod !== "all" ? ALL_MONTHS : s.expenseMonth };
    expect(s.timePeriod).toBe("month");

    // OLD buggy Month handler: only sets expenseMonth, nothing else.
    s = { ...s, expenseMonth: "2026-08" };
    // draftTimePeriod is STILL "month" here -- never cleared.
    expect(s.draftTimePeriod).toBe("month");

    // Next Search commit (e.g. just to apply an unrelated Status change):
    s = { ...s, timePeriod: s.draftTimePeriod, expenseMonth: s.draftTimePeriod !== "all" ? ALL_MONTHS : s.expenseMonth };

    // This documents the bug: August is wiped even though the user only
    // meant to change something else.
    expect(s.expenseMonth).toBe(ALL_MONTHS);
  });
});

describe("§22 date-mode test matrix", () => {
  it("A: selecting an exact Month resets relative period to 'all' in both applied and draft state", () => {
    let s = initialReviewDateModeState();
    s = stageTimePeriodDraft(s, "week");
    s = commitDraftTimePeriod(s);
    s = selectExpenseMonth(s, "2026-08");
    expect(s).toEqual({ timePeriod: "all", expenseMonth: "2026-08", draftTimePeriod: "all" });
  });

  it("B: deliberately committing a relative period resets exact Month to All months (kept behavior)", () => {
    let s = initialReviewDateModeState();
    s = selectExpenseMonth(s, "2026-08");
    s = stageTimePeriodDraft(s, "year");
    s = commitDraftTimePeriod(s);
    expect(s.timePeriod).toBe("year");
    expect(s.expenseMonth).toBe(ALL_MONTHS);
  });

  it("C: committing a draft of 'all' leaves an already-selected Month untouched", () => {
    let s = initialReviewDateModeState();
    s = selectExpenseMonth(s, "2026-08");
    s = stageTimePeriodDraft(s, "all"); // no-op draft edit
    s = commitDraftTimePeriod(s);
    expect(s.expenseMonth).toBe("2026-08");
    expect(s.timePeriod).toBe("all");
  });

  it("D: after exact-month -> All months, no stale relative period reactivates", () => {
    let s = initialReviewDateModeState();
    s = stageTimePeriodDraft(s, "month");
    s = commitDraftTimePeriod(s);
    s = selectExpenseMonth(s, "2026-08"); // clears the relative period
    s = selectExpenseMonth(s, ALL_MONTHS); // back to All months
    expect(s.timePeriod).toBe("all");
    expect(s.draftTimePeriod).toBe("all");
  });

  it("E: rapid Month -> Month -> Month, each clears any staged relative-period draft", () => {
    let s = initialReviewDateModeState();
    s = stageTimePeriodDraft(s, "week"); // staged but not committed
    s = selectExpenseMonth(s, "2026-08");
    s = selectExpenseMonth(s, "2026-09");
    s = selectExpenseMonth(s, "2026-07");
    expect(s.expenseMonth).toBe("2026-07");
    expect(s.draftTimePeriod).toBe("all"); // the earlier staged "week" draft never survives a Month click
  });

  it("F: mobile selecting a relative period resets Month immediately (no Search needed)", () => {
    let s = initialReviewDateModeState();
    s = selectExpenseMonth(s, "2026-08");
    s = selectTimePeriodImmediate(s, "30d");
    expect(s.timePeriod).toBe("30d");
    expect(s.expenseMonth).toBe(ALL_MONTHS);
  });

  it("G: mobile selecting 'all' explicitly leaves an already-selected Month untouched", () => {
    let s = initialReviewDateModeState();
    s = selectExpenseMonth(s, "2026-08");
    s = selectTimePeriodImmediate(s, "all");
    expect(s.expenseMonth).toBe("2026-08");
  });

  it("H: mobile 7d/30d/3m/6m/1y all correctly enforce mutual exclusion with Month", () => {
    for (const v of ["7d", "30d", "3m", "6m", "1y"]) {
      let s = initialReviewDateModeState();
      s = selectExpenseMonth(s, "2026-08");
      s = selectTimePeriodImmediate(s, v);
      expect(s.expenseMonth).toBe(ALL_MONTHS);
      expect(s.timePeriod).toBe(v);
    }
  });

  it("I: an unsaved Status/Sort/custom-filter draft is never touched by any Month or Time-Period transition", () => {
    // Modeled by confirming the transitions here only ever mention
    // timePeriod/expenseMonth/draftTimePeriod fields -- there is no field in
    // ReviewDateModeState for status/sort/customFilters at all, so by
    // construction none of these functions can touch them. The real
    // EngineerReview.tsx wiring is checked by the narrow-per-field-effect
    // source-contract test in EngineerReview.dateModeHardening.test.ts.
    let s = initialReviewDateModeState();
    const keys = Object.keys(selectExpenseMonth(s, "2026-08"));
    expect(keys.sort()).toEqual(["draftTimePeriod", "expenseMonth", "timePeriod"]);
  });
});
