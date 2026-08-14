/**
 * Batch Review — executive tier could never batch-verify (debug/6456-supervisor-auth-runtime,
 * 2026-08-12, discovered during Production browser QA).
 *
 * Root cause: hierarchyReviewerActionsForExpense (shared by both team_leader and
 * executive on the Batch Review page) only ever returned ["reject", "verify"] for
 * status IN (submitted, edited) — the team_leader's own trigger statuses. It never
 * recognized level_1_verified, which is the status an EXECUTIVE must act on for
 * Level 2. The parallel case for the engineer/manager tier (level_2_verified ->
 * [reject, approve]) was added in 937a957 but the executive-tier equivalent one
 * level earlier was missed.
 *
 * Effect confirmed live: on the dedicated Batch Review page, an executive selecting
 * level_1_verified batch lines saw "0 eligible expenses" and could not Verify —
 * while the single-expense review dialog, which reads eligibility from the server's
 * available_actions instead of this hardcoded map, correctly allowed the identical
 * action on the identical expense. A live A/B on Production QA data (expense 00098
 * single vs 00099/00100 batch, same reviewer, same status) reproduced this exactly.
 */
import { describe, it, expect } from "vitest";
import {
  actionsForExpenseByRole,
  expensesEligibleForBatchAction,
  hierarchyReviewerActionsForExpense,
  type BatchReviewExpenseRow,
} from "@/lib/batchExpenseReview";

describe("hierarchyReviewerActionsForExpense — executive tier can batch-verify level_1_verified", () => {
  it("allows an executive to verify a level_1_verified row", () => {
    expect(hierarchyReviewerActionsForExpense("level_1_verified", "executive")).toEqual([
      "reject",
      "verify",
    ]);
  });

  it("does not allow a team_leader to verify a level_1_verified row (already past their tier)", () => {
    expect(hierarchyReviewerActionsForExpense("level_1_verified", "team_leader")).toEqual([]);
  });

  it("still allows a team_leader to verify submitted/edited rows (Level 1, unchanged)", () => {
    expect(hierarchyReviewerActionsForExpense("submitted", "team_leader")).toEqual([
      "reject",
      "verify",
    ]);
    expect(hierarchyReviewerActionsForExpense("edited", "team_leader")).toEqual([
      "reject",
      "verify",
    ]);
  });

  it("still allows an executive to verify submitted/edited rows (no regression)", () => {
    expect(hierarchyReviewerActionsForExpense("submitted", "executive")).toEqual([
      "reject",
      "verify",
    ]);
  });

  it("offers nothing on terminal statuses for either role", () => {
    expect(hierarchyReviewerActionsForExpense("approved", "executive")).toEqual([]);
    expect(hierarchyReviewerActionsForExpense("rejected", "team_leader")).toEqual([]);
  });
});

describe("actionsForExpenseByRole — routes role correctly into the hierarchy-reviewer branch", () => {
  it("routes executive + level_1_verified to verify (single-vs-batch parity)", () => {
    expect(actionsForExpenseByRole("level_1_verified", 100, "executive", 5000)).toEqual([
      "reject",
      "verify",
    ]);
  });
});

describe("expensesEligibleForBatchAction — batch selection now matches single-expense eligibility", () => {
  const baseRow: BatchReviewExpenseRow = {
    id: "exp-1",
    title: "QA Batch Line",
    category: "Food",
    purpose: null,
    destination: "QA Test",
    trip_start: "2026-08-12",
    total_amount: 1,
    status: "level_1_verified",
    user_id: "employee-1",
    user_name: "QA Employee",
    user_email: "qa@example.com",
  };

  it("includes a level_1_verified batch line as eligible for verify by an executive", () => {
    const eligible = expensesEligibleForBatchAction([baseRow], "verify", "executive", 5000);
    expect(eligible.map((e) => e.id)).toEqual(["exp-1"]);
  });

  it("excludes the same line for a team_leader (not their tier anymore)", () => {
    const eligible = expensesEligibleForBatchAction([baseRow], "verify", "team_leader", 5000);
    expect(eligible).toEqual([]);
  });
});
