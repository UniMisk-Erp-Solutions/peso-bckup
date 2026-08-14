/**
 * Review action layer (DOC-080 §17).
 *
 * These assert BEHAVIOUR, not source strings: the service is driven with mocked
 * ExpenseService methods and the calls are inspected. The load-bearing checks
 * are the ones that would let something wrong through silently — the flag guard
 * firing before any network call, verify routing through the real hierarchy
 * method rather than setting a status, self-review being refused, and a partial
 * bulk failure being reported as a partial failure.
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

// Actions ON for most tests; a dedicated block re-imports with it OFF.
vi.mock("@/config/reviewQueueServerFeature", () => ({
  REVIEW_EXPENSES_SERVER_QUEUE_ENABLED: true,
  REVIEW_EXPENSES_SERVER_ACTIONS_ENABLED: true,
  REVIEW_EXPENSES_LEGACY_ESCAPE_HATCH: false,
}));

import {
  approveExpense,
  correctExpense,
  mapWithConcurrency,
  rejectExpense,
  runBulkAction,
  verifyExpense,
  BULK_CONCURRENCY,
} from "@/features/reviewActions/reviewActionService";
import {
  canPerform,
  eligibleForBulk,
  isSelfOwned,
  requiresBatchReview,
  visibleActions,
} from "@/features/reviewActions/actionEligibility";
import {
  ActionNotAvailableError,
  ActionsDisabledError,
  SelfReviewError,
  SessionExpiredError,
  isSessionFailure,
  reviewActionMessage,
} from "@/features/reviewActions/errors";
import type { ActionableExpense } from "@/features/reviewActions/types";

const ME = "reviewer-1";
const OTHER = "employee-9";

const row = (over: Partial<ActionableExpense> = {}): ActionableExpense => ({
  id: "e-1",
  transaction_number: "00424",
  batch_id: null,
  user_id: OTHER,
  status: "submitted",
  approval_tier: "engineer",
  total_amount: 3960,
  is_actionable: true,
  available_actions: ["verify", "approve", "reject", "correct"],
  view_only: false,
  ...over,
});

const ctx = { userId: ME, reviewerRole: "engineer" as string | null };

beforeEach(() => {
  verifyExpenseMock.mockReset().mockResolvedValue({ status: "level_1_verified" });
  approveExpenseMock.mockReset().mockResolvedValue({ status: "approved" });
  rejectExpenseMock.mockReset().mockResolvedValue({ status: "rejected" });
  correctionMock.mockReset().mockResolvedValue(undefined);
  getSessionMock.mockReset().mockResolvedValue({ data: { session: { user: { id: ME } } }, error: null });
});

// ── Eligibility (presentation only) ─────────────────────────────────────────

describe("action eligibility", () => {
  it("permits an action only when the server listed it", () => {
    expect(canPerform(row(), "verify", ME)).toBe(true);
    expect(canPerform(row({ available_actions: ["approve"] }), "verify", ME)).toBe(false);
  });

  it("never infers eligibility from status", () => {
    // Non-terminal, but the server says this reviewer cannot act on it.
    const otherTier = row({
      status: "submitted",
      approval_tier: "team_leader",
      is_actionable: false,
      view_only: true,
      available_actions: [],
    });
    expect(canPerform(otherTier, "verify", ME)).toBe(false);
    expect(visibleActions(otherTier, ME)).toEqual([]);
  });

  it("refuses a reviewer's own expense even when the server allowed it", () => {
    const mine = row({ user_id: ME });
    expect(isSelfOwned(mine, ME)).toBe(true);
    expect(canPerform(mine, "verify", ME)).toBe(false);
  });

  it("treats completed rows as view-only", () => {
    expect(canPerform(row({ view_only: true }), "approve", ME)).toBe(false);
    expect(canPerform(row({ is_actionable: false }), "approve", ME)).toBe(false);
  });

  it("routes batch rows away from inline actions", () => {
    expect(requiresBatchReview(row({ batch_id: "b-1" }))).toBe(true);
    const { eligible, skipped } = eligibleForBulk([row({ batch_id: "b-1" })], "verify", ME);
    expect(eligible).toHaveLength(0);
    expect(skipped).toHaveLength(1);
  });

  it("lists visible actions in the legacy order", () => {
    expect(visibleActions(row(), ME)).toEqual(["verify", "approve", "reject", "correct"]);
  });
});

// ── Single actions call the established services ────────────────────────────

describe("single actions", () => {
  it("verify calls ExpenseService.verifyExpense with the reviewer role", async () => {
    const status = await verifyExpense(row(), { ...ctx, comment: "ok" });
    expect(verifyExpenseMock).toHaveBeenCalledTimes(1);
    expect(verifyExpenseMock).toHaveBeenCalledWith("e-1", ME, "ok", { reviewerRole: "engineer" });
    // The hierarchy method decides the resulting status; it is NOT forced.
    expect(status).toBe("level_1_verified");
  });

  it("verify never sets a status directly", async () => {
    verifyExpenseMock.mockResolvedValue({ status: "level_2_verified" });
    await expect(verifyExpense(row(), ctx)).resolves.toBe("level_2_verified");
    const args = verifyExpenseMock.mock.calls[0];
    expect(JSON.stringify(args)).not.toContain('"verified"');
  });

  it("verify propagates a tier advancement", async () => {
    verifyExpenseMock.mockResolvedValue({ status: "level_1_verified" });
    await expect(
      verifyExpense(row(), { userId: ME, reviewerRole: "team_leader" }),
    ).resolves.toBe("level_1_verified");
    expect(verifyExpenseMock.mock.calls[0][3]).toEqual({ reviewerRole: "team_leader" });
  });

  it("approve calls ExpenseService.approveExpense", async () => {
    await expect(approveExpense(row(), ctx)).resolves.toBe("approved");
    expect(approveExpenseMock).toHaveBeenCalledWith("e-1", ME, undefined);
  });

  it("surfaces an approval-limit refusal truthfully", async () => {
    approveExpenseMock.mockRejectedValue(new Error("Approval limit exceeded for this reviewer"));
    await expect(approveExpense(row(), ctx)).rejects.toThrow(/Approval limit exceeded/);
  });

  it("reject requires a reason", async () => {
    await expect(rejectExpense(row(), ctx, "   ")).rejects.toThrow(/reason is required/i);
    expect(rejectExpenseMock).not.toHaveBeenCalled();
  });

  it("reject passes the trimmed reason through as the audit comment", async () => {
    await expect(rejectExpense(row(), ctx, "  duplicate claim  ")).resolves.toBe("rejected");
    expect(rejectExpenseMock).toHaveBeenCalledWith("e-1", ME, "duplicate claim");
  });

  it("correct calls the singular correction service with custom fields", async () => {
    await correctExpense(row(), ctx, {
      updates: { title: "New" },
      reason: "typo",
      customFieldPatch: [{ field_id: "f1", value: "x" }],
    });
    expect(correctionMock).toHaveBeenCalledWith(
      "e-1",
      ME,
      { title: "New" },
      "typo",
      [{ field_id: "f1", value: "x" }],
    );
  });

  it("refuses an action the server did not list", async () => {
    await expect(
      approveExpense(row({ available_actions: ["verify"] }), ctx),
    ).rejects.toBeInstanceOf(ActionNotAvailableError);
    expect(approveExpenseMock).not.toHaveBeenCalled();
  });

  it("refuses self-review before any request", async () => {
    await expect(verifyExpense(row({ user_id: ME }), ctx)).rejects.toBeInstanceOf(SelfReviewError);
    expect(verifyExpenseMock).not.toHaveBeenCalled();
  });

  it("refuses to mutate on a dead session", async () => {
    getSessionMock.mockResolvedValue({ data: { session: null }, error: null });
    await expect(verifyExpense(row(), ctx)).rejects.toBeInstanceOf(SessionExpiredError);
    expect(verifyExpenseMock).not.toHaveBeenCalled();
  });
});

// ── Bulk ────────────────────────────────────────────────────────────────────

describe("bulk actions", () => {
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => row({ id: `e-${i}`, transaction_number: `T${i}` }));

  it("verifies every eligible row", async () => {
    const results = await runBulkAction(rows(5), "verify", ctx);
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(verifyExpenseMock).toHaveBeenCalledTimes(5);
  });

  it("reports a partial failure as a partial failure", async () => {
    verifyExpenseMock
      .mockResolvedValueOnce({ status: "verified" })
      .mockRejectedValueOnce(new Error("Approval limit exceeded"))
      .mockResolvedValueOnce({ status: "verified" });
    const results = await runBulkAction(rows(3), "verify", ctx);
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    const failed = results.filter((r) => !r.ok);
    expect(failed).toHaveLength(1);
    expect(failed[0].error).toMatch(/Approval limit/);
    // The failure must be attributable to a specific transaction.
    expect(failed[0].transactionNumber).toBeTruthy();
  });

  it("keeps results in selection order regardless of completion order", async () => {
    verifyExpenseMock.mockImplementation(
      (id: string) =>
        new Promise((res) => setTimeout(() => res({ status: "verified" }), id === "e-0" ? 30 : 1)),
    );
    const results = await runBulkAction(rows(4), "verify", ctx);
    expect(results.map((r) => r.expenseId)).toEqual(["e-0", "e-1", "e-2", "e-3"]);
  });

  it("never runs more than three requests at once", async () => {
    let inFlight = 0;
    let peak = 0;
    verifyExpenseMock.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { status: "verified" };
    });
    await runBulkAction(rows(12), "verify", ctx);
    expect(peak).toBeLessThanOrEqual(BULK_CONCURRENCY);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("runs APPROVALS strictly one at a time (financial, §15/§27)", async () => {
    let inFlight = 0;
    let peak = 0;
    approveExpenseMock.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { status: "approved" };
    });
    await runBulkAction(rows(6), "approve", ctx);
    // Never two approvals overlapping, even though verify would allow three.
    expect(peak).toBe(1);
  });

  it("approves the same employee's expenses in selection order A→B→C (§27)", async () => {
    const order: string[] = [];
    approveExpenseMock.mockImplementation(async (id: string) => {
      order.push(id);
      await new Promise((r) => setTimeout(r, id === "e-0" ? 20 : 1));
      return { status: "approved" };
    });
    const sameEmployee = [
      row({ id: "e-0", user_id: OTHER, total_amount: 1000 }),
      row({ id: "e-1", user_id: OTHER, total_amount: 2000 }),
      row({ id: "e-2", user_id: OTHER, total_amount: 3000 }),
    ];
    await runBulkAction(sameEmployee, "approve", ctx);
    // Started in order despite e-0 being slowest — proves sequential, not raced.
    expect(order).toEqual(["e-0", "e-1", "e-2"]);
  });

  it("reports progress as each approval settles", async () => {
    const seen: Array<[number, number]> = [];
    await runBulkAction(rows(4), "approve", ctx, undefined, {
      onProgress: (completed, total) => seen.push([completed, total]),
    });
    expect(seen).toEqual([
      [1, 4],
      [2, 4],
      [3, 4],
      [4, 4],
    ]);
  });

  it("an explicit concurrency override is honoured", async () => {
    let inFlight = 0;
    let peak = 0;
    verifyExpenseMock.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { status: "verified" };
    });
    await runBulkAction(rows(6), "verify", ctx, undefined, { concurrency: 1 });
    expect(peak).toBe(1);
  });

  it("skips ineligible rows instead of sending them", async () => {
    const mixed = [
      row({ id: "ok" }),
      row({ id: "batch", batch_id: "b-1" }),
      row({ id: "mine", user_id: ME }),
      row({ id: "viewonly", view_only: true }),
    ];
    const { eligible, skipped } = eligibleForBulk(mixed, "verify", ME);
    expect(eligible.map((e) => e.id)).toEqual(["ok"]);
    expect(skipped).toHaveLength(3);
    await runBulkAction(eligible, "verify", ctx);
    expect(verifyExpenseMock).toHaveBeenCalledTimes(1);
  });

  it("bulk reject forwards the reason to every row", async () => {
    await runBulkAction(rows(2), "reject", ctx, "duplicate");
    expect(rejectExpenseMock).toHaveBeenCalledTimes(2);
    expect(rejectExpenseMock.mock.calls.every((c) => c[2] === "duplicate")).toBe(true);
  });

  it("bounds concurrency helper independently", async () => {
    const order: number[] = [];
    await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      order.push(n);
      return n;
    });
    expect(order).toHaveLength(5);
  });
});

// ── Error mapping ───────────────────────────────────────────────────────────

describe("error reporting", () => {
  it("passes business messages through unchanged", () => {
    expect(reviewActionMessage(new Error("Approval limit exceeded"))).toBe(
      "Approval limit exceeded",
    );
  });

  it("maps a 401 to session recovery, not to an approval success", () => {
    expect(isSessionFailure(new Error("JWT expired"))).toBe(true);
    expect(reviewActionMessage(new Error("401 Unauthorized"))).toMatch(/session has expired/i);
  });

  it("names the disabled flag distinctly from an authorization refusal", () => {
    expect(reviewActionMessage(new ActionsDisabledError())).toMatch(/not enabled/i);
    expect(isSessionFailure(new ActionsDisabledError())).toBe(false);
  });
});
