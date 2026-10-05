import { describe, expect, it } from "vitest";
import {
  canOwnerEditExpenseStatus,
  canOwnerHardDeleteExpenseStatus,
  canOwnerTrashExpenseStatus,
  canOwnerWithdrawExpenseStatus,
} from "@/lib/expenseEditRules";

describe("canOwnerTrashExpenseStatus (DOC-129)", () => {
  it("allows draft — both never-submitted and withdrawn-back-to-draft", () => {
    expect(canOwnerTrashExpenseStatus("draft")).toBe(true);
  });

  it("refuses submitted — must withdraw first, never combines the two actions", () => {
    expect(canOwnerTrashExpenseStatus("submitted")).toBe(false);
  });

  it("refuses every reviewed/terminal status", () => {
    for (const status of [
      "under_review",
      "verified",
      "level_1_verified",
      "level_2_verified",
      "approved",
      "rejected",
      "paid",
      "edited",
    ]) {
      expect(canOwnerTrashExpenseStatus(status)).toBe(false);
    }
  });

  it("refuses null/undefined", () => {
    expect(canOwnerTrashExpenseStatus(null)).toBe(false);
    expect(canOwnerTrashExpenseStatus(undefined)).toBe(false);
  });
});

describe("canOwnerHardDeleteExpenseStatus", () => {
  it("allows only draft", () => {
    expect(canOwnerHardDeleteExpenseStatus("draft")).toBe(true);
  });

  it("refuses every other status, matching the draft-only owner DELETE RLS policy", () => {
    for (const status of [
      "submitted",
      "under_review",
      "verified",
      "level_1_verified",
      "level_2_verified",
      "approved",
      "rejected",
      "paid",
      "edited",
    ]) {
      expect(canOwnerHardDeleteExpenseStatus(status)).toBe(false);
    }
  });

  it("refuses null/undefined", () => {
    expect(canOwnerHardDeleteExpenseStatus(null)).toBe(false);
    expect(canOwnerHardDeleteExpenseStatus(undefined)).toBe(false);
  });
});

describe("canOwnerWithdrawExpenseStatus", () => {
  it("allows only submitted", () => {
    expect(canOwnerWithdrawExpenseStatus("submitted")).toBe(true);
  });

  it("refuses draft (nothing to withdraw) and every reviewed/terminal status", () => {
    for (const status of [
      "draft",
      "under_review",
      "verified",
      "level_1_verified",
      "level_2_verified",
      "approved",
      "rejected",
      "paid",
      "edited",
    ]) {
      expect(canOwnerWithdrawExpenseStatus(status)).toBe(false);
    }
  });

  it("refuses null/undefined", () => {
    expect(canOwnerWithdrawExpenseStatus(null)).toBe(false);
    expect(canOwnerWithdrawExpenseStatus(undefined)).toBe(false);
  });
});

describe("canOwnerHardDeleteExpenseStatus and canOwnerWithdrawExpenseStatus are mutually exclusive", () => {
  it("never both true for the same status", () => {
    const statuses = [
      "draft",
      "submitted",
      "under_review",
      "verified",
      "level_1_verified",
      "level_2_verified",
      "approved",
      "rejected",
      "paid",
      "edited",
      null,
      undefined,
    ];
    for (const status of statuses) {
      expect(canOwnerHardDeleteExpenseStatus(status) && canOwnerWithdrawExpenseStatus(status)).toBe(false);
    }
  });
});

// Existing behaviour, unchanged by DOC-128 — kept here so a future edit to
// this file can't silently regress it without a failing test.
describe("canOwnerEditExpenseStatus (unchanged)", () => {
  it("allows draft, submitted and rejected", () => {
    expect(canOwnerEditExpenseStatus("draft")).toBe(true);
    expect(canOwnerEditExpenseStatus("submitted")).toBe(true);
    expect(canOwnerEditExpenseStatus("rejected")).toBe(true);
  });

  it("refuses edited, approved and paid", () => {
    expect(canOwnerEditExpenseStatus("edited")).toBe(false);
    expect(canOwnerEditExpenseStatus("approved")).toBe(false);
    expect(canOwnerEditExpenseStatus("paid")).toBe(false);
  });
});
