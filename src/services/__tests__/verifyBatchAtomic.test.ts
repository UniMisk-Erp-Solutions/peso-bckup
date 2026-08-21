/**
 * DOC-098 — ExpenseService.verifyBatchAtomic client wiring.
 *
 * These tests prove the CLIENT-SIDE contract the atomic batch RPC depends
 * on: only a batch id and comment ever leave the browser (no expense-id
 * list, no next-tier/reviewer/engineer routing parameters -- the DOC-098
 * same-day security revision removed those entirely, since routing must be
 * server-derived, never client-supplied), the caller's role gates who may
 * call it at all, and the RPC's structured {ok:true}/{blocked}/
 * {batch_not_found} response is mapped into ExpenseService's typed
 * BatchVerifyResult without losing detail. The RPC's own authorization/
 * routing-derivation/atomicity/audit behavior is proven separately via live
 * BEGIN/ROLLBACK transactional tests against Production (DOC-098, including
 * tamper scenarios R1-R7).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";

const ORG_ID = "org-1";
const REVIEWER_ID = "reviewer-1";
const BATCH_ID = "batch-1";

function buildSupabaseMock(opts: { reviewerRole: string; rpcResult: unknown }) {
  const rpc = vi.fn(() => Promise.resolve({ data: opts.rpcResult, error: null }));
  const from = vi.fn((table: string) => {
    const chain: any = {
      select: vi.fn(() => chain),
      eq: vi.fn(() => chain),
      in: vi.fn(() => chain),
      order: vi.fn(() => chain),
      limit: vi.fn(() => chain),
      maybeSingle: vi.fn(() => Promise.resolve({ data: chain.__singleData ?? null, error: null })),
      then: (resolve: any, reject: any) =>
        Promise.resolve({ data: chain.__listData ?? [], error: null }).then(resolve, reject),
    };

    if (table === "organization_memberships") {
      chain.__singleData = { organization_id: ORG_ID, role: opts.reviewerRole, is_active: true };
      chain.__listData = [chain.__singleData];
    } else {
      chain.__listData = [];
      chain.__singleData = null;
    }
    return chain;
  });

  return { from, rpc };
}

/** Fresh ExpenseService bound to a freshly-mocked supabase client (matches
 * the pattern used by advanceExpenseTierRoleAuthority.test.ts). */
async function loadService(opts: Parameters<typeof buildSupabaseMock>[0]) {
  const mock = buildSupabaseMock(opts);
  vi.doMock("@/integrations/supabase/client", () => ({ supabase: mock }));
  vi.resetModules();
  const { ExpenseService } = await import("@/services/ExpenseService");
  return { ExpenseService, mock };
}

describe("ExpenseService.verifyBatchAtomic", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("rejects a caller whose role is neither team_leader nor executive, without calling the RPC", async () => {
    const { ExpenseService, mock } = await loadService({ reviewerRole: "engineer", rpcResult: null });

    await expect(
      ExpenseService.verifyBatchAtomic(BATCH_ID, REVIEWER_ID, undefined, {
        reviewerRole: "engineer",
      }),
    ).rejects.toThrow(/team leaders and executives/i);
    expect(mock.rpc).not.toHaveBeenCalled();
  });

  it("calls the RPC with ONLY batch id and comment -- no expense ids, no routing parameters", async () => {
    const { ExpenseService, mock } = await loadService({
      reviewerRole: "executive",
      rpcResult: { ok: true, batch_id: BATCH_ID, verified_count: 1, transactions: [] },
    });

    await ExpenseService.verifyBatchAtomic(BATCH_ID, REVIEWER_ID, "test comment", {
      reviewerRole: "executive",
    });

    expect(mock.rpc).toHaveBeenCalledTimes(1);
    expect(mock.rpc).toHaveBeenCalledWith("review_verify_batch_atomic_v1", {
      p_batch_id: BATCH_ID,
      p_comment: "test comment",
    });
    const [, args] = mock.rpc.mock.calls[0];
    // DOC-098 security revision: none of these client-supplied routing
    // parameters exist anymore -- there is nothing left to tamper with.
    expect(args).not.toHaveProperty("p_expense_ids");
    expect(args).not.toHaveProperty("p_next_approval_tier");
    expect(args).not.toHaveProperty("p_next_assigned_reviewer_id");
    expect(args).not.toHaveProperty("p_next_assigned_engineer_id");
  });

  it("maps a batch_not_found RPC response (server-side, not a client pre-check)", async () => {
    const { ExpenseService, mock } = await loadService({
      reviewerRole: "executive",
      rpcResult: { ok: false, code: "batch_not_found", batch_id: BATCH_ID },
    });

    const result = await ExpenseService.verifyBatchAtomic(BATCH_ID, REVIEWER_ID, undefined, {
      reviewerRole: "executive",
    });
    expect(result).toEqual({ ok: false, batchId: BATCH_ID, code: "batch_not_found" });
    expect(mock.rpc).toHaveBeenCalledTimes(1);
  });

  it("maps a successful RPC response into a typed BatchVerifyResult", async () => {
    const { ExpenseService } = await loadService({
      reviewerRole: "executive",
      rpcResult: {
        ok: true,
        batch_id: BATCH_ID,
        verified_count: 2,
        transactions: [
          {
            transaction_number: "00042",
            employee_id: "6356",
            status_before: "submitted",
            status_after: "level_2_verified",
            tier_before: "executive",
            tier_after: "engineer",
          },
        ],
      },
    });

    const result = await ExpenseService.verifyBatchAtomic(BATCH_ID, REVIEWER_ID, undefined, {
      reviewerRole: "executive",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verifiedCount).toBe(2);
      expect(result.transactions).toEqual([
        {
          transactionNumber: "00042",
          employeeId: "6356",
          statusBefore: "submitted",
          statusAfter: "level_2_verified",
          tierBefore: "executive",
          tierAfter: "engineer",
        },
      ]);
    }
  });

  it("maps a blocked RPC response into structured per-transaction blockers, never an aggregate-only shape", async () => {
    const { ExpenseService } = await loadService({
      reviewerRole: "team_leader",
      rpcResult: {
        ok: false,
        code: "batch_verification_blocked",
        batch_id: BATCH_ID,
        blockers: [
          {
            expense_id: "e2",
            transaction_number: "03198",
            employee_id: "6356",
            status: "draft",
            approval_tier: "team_leader",
            reason: "wrong_status_for_team_leader_tier",
          },
        ],
      },
    });

    const result = await ExpenseService.verifyBatchAtomic(BATCH_ID, REVIEWER_ID, undefined, {
      reviewerRole: "team_leader",
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "batch_verification_blocked") {
      expect(result.blockers).toEqual([
        {
          expenseId: "e2",
          transactionNumber: "03198",
          employeeId: "6356",
          status: "draft",
          approvalTier: "team_leader",
          reason: "wrong_status_for_team_leader_tier",
        },
      ]);
    } else {
      throw new Error("expected batch_verification_blocked");
    }
  });
});
