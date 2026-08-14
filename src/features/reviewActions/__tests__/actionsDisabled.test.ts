/**
 * The flag-off guarantee (DOC-080 §6).
 *
 * Separate file because the feature flag is a module constant resolved at import
 * time — it cannot be flipped inside the suite that imports it as true.
 *
 * The point being proven: with the flag off, ZERO mutation requests leave the
 * client. Not "the buttons are hidden" — hiding a control is a presentation
 * choice, and any code path that reached the service anyway would still mutate
 * Production. The guard runs before the network, so it holds even if a button
 * were rendered by mistake.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const verifyExpenseMock = vi.fn();
const approveExpenseMock = vi.fn();
const rejectExpenseMock = vi.fn();
const correctionMock = vi.fn();
const getSessionMock = vi.fn();

vi.mock("@/services/ExpenseService", () => ({
  ExpenseService: {
    verifyExpense: (...a: unknown[]) => verifyExpenseMock(...a),
    approveExpense: (...a: unknown[]) => approveExpenseMock(...a),
    rejectExpense: (...a: unknown[]) => rejectExpenseMock(...a),
    applySingularExpenseCorrection: (...a: unknown[]) => correctionMock(...a),
  },
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { getSession: () => getSessionMock() } },
}));

// The whole point of this file.
vi.mock("@/config/reviewQueueServerFeature", () => ({
  REVIEW_EXPENSES_SERVER_QUEUE_ENABLED: true,
  REVIEW_EXPENSES_SERVER_ACTIONS_ENABLED: false,
  REVIEW_EXPENSES_LEGACY_ESCAPE_HATCH: false,
}));

import {
  approveExpense,
  assertActionsEnabled,
  correctExpense,
  rejectExpense,
  runBulkAction,
  verifyExpense,
} from "@/features/reviewActions/reviewActionService";
import { ActionsDisabledError } from "@/features/reviewActions/errors";
import type { ActionableExpense } from "@/features/reviewActions/types";

const row: ActionableExpense = {
  id: "e-1",
  transaction_number: "00424",
  batch_id: null,
  user_id: "employee-9",
  status: "submitted",
  approval_tier: "engineer",
  total_amount: 100,
  // Deliberately fully eligible: only the flag should stop it.
  is_actionable: true,
  available_actions: ["verify", "approve", "reject", "correct"],
  view_only: false,
};

const ctx = { userId: "reviewer-1", reviewerRole: "engineer" };

beforeEach(() => {
  verifyExpenseMock.mockReset();
  approveExpenseMock.mockReset();
  rejectExpenseMock.mockReset();
  correctionMock.mockReset();
  getSessionMock.mockReset().mockResolvedValue({ data: { session: {} }, error: null });
});

describe("actions flag false", () => {
  it("throws before doing anything", () => {
    expect(() => assertActionsEnabled()).toThrow(ActionsDisabledError);
  });

  it.each([
    ["verify", () => verifyExpense(row, ctx)],
    ["approve", () => approveExpense(row, ctx)],
    ["reject", () => rejectExpense(row, ctx, "reason")],
    ["correct", () => correctExpense(row, ctx, { updates: { title: "x" } })],
  ])("%s issues zero mutation requests", async (_name, fn) => {
    await expect(fn()).rejects.toBeInstanceOf(ActionsDisabledError);
    expect(verifyExpenseMock).not.toHaveBeenCalled();
    expect(approveExpenseMock).not.toHaveBeenCalled();
    expect(rejectExpenseMock).not.toHaveBeenCalled();
    expect(correctionMock).not.toHaveBeenCalled();
  });

  it("does not even read the session", async () => {
    await expect(verifyExpense(row, ctx)).rejects.toBeInstanceOf(ActionsDisabledError);
    // The guard is the FIRST statement, so nothing downstream runs.
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it("bulk actions issue zero mutation requests", async () => {
    await expect(runBulkAction([row, row], "verify", ctx)).rejects.toBeInstanceOf(
      ActionsDisabledError,
    );
    expect(verifyExpenseMock).not.toHaveBeenCalled();
  });
});
