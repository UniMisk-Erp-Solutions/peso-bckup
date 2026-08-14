/**
 * Issue 2 fix (debug/6456-supervisor-auth-runtime, 2026-08-12): Production
 * screenshot showed "Batch review failed — Verify did not update status to
 * level_1_verified (database returned 'level_2_verified'). Run Supabase
 * migration 20260524260000..." — a misleading message, since that migration
 * was already live.
 *
 * Root cause, confirmed against the live review_advance_expense_hierarchy_tier
 * definition: the server independently derives v_is_tl/v_is_exec from the
 * caller's CURRENT organization_memberships role and decides the resulting
 * status from THAT alone — it does not trust the client's proposed
 * p_next_approval_tier for this decision. The client's `tier` variable,
 * however, was sometimes derived from the expense's possibly-stale
 * approval_tier snapshot (e.g. still 'team_leader' from when this reviewer
 * was assigned, even though their own role has since been changed to
 * executive) rather than the caller's actual current role — producing a
 * client-predicted status that disagreed with the server's authoritative
 * one, and, worse, an approval_tier written to the database for the wrong
 * tier the server actually processed.
 *
 * These tests prove: (1) a caller whose expense-snapshot tier is stale but
 * whose CURRENT role is genuinely different is no longer rejected by a false
 * mismatch — the server's actual outcome is accepted, not fought; (2) a
 * genuine no-op (server returns the expense unchanged) is still caught, with
 * an honest message, not the old misleading migration-name text.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { ExpenseService } from "@/services/ExpenseService";
import { supabase } from "@/integrations/supabase/client";

function readSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf-8");
}

const ORG_ID = "org-1";
const EMPLOYEE_ID = "employee-1";
const REVIEWER_ID = "reviewer-1";
const EXPENSE_ID = "expense-1";

function buildSupabaseMock(opts: {
  reviewerCurrentRole: string;
  serverReturnsStatus: "level_1_verified" | "level_2_verified" | "submitted";
}) {
  return {
    from: vi.fn((table: string) => {
      const chain: any = {
        select: vi.fn(() => chain),
        eq: vi.fn(() => chain),
        order: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        in: vi.fn(() => chain),
        insert: vi.fn(() => chain),
        update: vi.fn(() => chain),
        delete: vi.fn(() => chain),
        maybeSingle: vi.fn(() =>
          Promise.resolve({ data: chain.__singleData ?? null, error: null }),
        ),
        single: vi.fn(() =>
          Promise.resolve({ data: chain.__singleData ?? null, error: null }),
        ),
        then: (resolve: any, reject: any) =>
          Promise.resolve({ data: chain.__listData ?? [], error: null }).then(
            resolve,
            reject,
          ),
      };

      if (table === "organization_memberships") {
        chain.__singleData = {
          organization_id: ORG_ID,
          role: opts.reviewerCurrentRole,
          is_active: true,
        };
        chain.__listData = [chain.__singleData];
      } else if (table === "profiles") {
        chain.__singleData = { reporting_engineer_id: null, name: "Reviewer" };
        chain.__listData = [chain.__singleData];
      } else if (table === "organization_features") {
        chain.__listData = [];
      } else {
        chain.__listData = [];
        chain.__singleData = null;
      }

      return chain;
    }),
    rpc: vi.fn((fn: string) => {
      if (fn === "get_expense_review_head") {
        return Promise.resolve({
          data: {
            organization_id: ORG_ID,
            // The expense's own snapshot still says team_leader — stale
            // relative to the reviewer's CURRENT role in this scenario.
            status: "submitted",
            approval_tier: "team_leader",
            assigned_reviewer_id: REVIEWER_ID,
            assigned_engineer_id: REVIEWER_ID,
            user_id: EMPLOYEE_ID,
            title: "Test expense",
            total_amount: 100,
          },
          error: null,
        });
      }
      if (fn === "review_advance_expense_hierarchy_tier") {
        // The server is authoritative: regardless of what p_next_approval_tier
        // the client sent, it returns whatever status the caller's ACTUAL
        // current role produces.
        return Promise.resolve({
          data: {
            expense: {
              id: EXPENSE_ID,
              status: opts.serverReturnsStatus,
              approval_tier:
                opts.serverReturnsStatus === "level_1_verified"
                  ? "executive"
                  : opts.serverReturnsStatus === "level_2_verified"
                    ? "engineer"
                    : "team_leader",
              user_id: EMPLOYEE_ID,
              assigned_reviewer_id: REVIEWER_ID,
              assigned_engineer_id: REVIEWER_ID,
              organization_id: ORG_ID,
              title: "Test expense",
            },
          },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    }),
  };
}

describe("advanceExpenseTier — server-authoritative tier/status (post Issue-2 fix)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts the server's actual outcome when the caller's current role differs from the expense's stale approval_tier snapshot", async () => {
    vi.doMock("@/integrations/supabase/client", () => ({
      supabase: buildSupabaseMock({
        reviewerCurrentRole: "executive",
        serverReturnsStatus: "level_2_verified",
      }),
    }));
    vi.resetModules();
    const { ExpenseService: FreshService } = await import("@/services/ExpenseService");

    const result = await FreshService.verifyExpense(
      EXPENSE_ID,
      REVIEWER_ID,
      "Verified",
      { reviewerRole: "team_leader" }, // stale/known role passed by the caller
    );

    expect(result.status).toBe("level_2_verified");
  });

  it("still throws an honest error — not the old migration-name message — when the server genuinely does not advance the status", async () => {
    vi.doMock("@/integrations/supabase/client", () => ({
      supabase: buildSupabaseMock({
        reviewerCurrentRole: "executive",
        serverReturnsStatus: "submitted", // never actually moved
      }),
    }));
    vi.resetModules();
    const { ExpenseService: FreshService } = await import("@/services/ExpenseService");

    await expect(
      FreshService.verifyExpense(EXPENSE_ID, REVIEWER_ID, "Verified", {
        reviewerRole: "team_leader",
      }),
    ).rejects.toThrow(/did not advance/i);

    await expect(
      FreshService.verifyExpense(EXPENSE_ID, REVIEWER_ID, "Verified", {
        reviewerRole: "team_leader",
      }),
    ).rejects.not.toThrow(/20260524260000/);
  });
});

describe("ExpenseService.ts source guards — tier derivation and audit truthfulness", () => {
  it("derives tier from a freshly re-verified current role, not a caller-supplied stale role", () => {
    const service = readSource("src/services/ExpenseService.ts");
    expect(service).toContain("const currentRole = knownReviewerRole");
    expect(service).toContain(
      'tier = currentRole === "team_leader" ? "team_leader" : "executive"',
    );
  });

  it("no longer contains the misleading hard-coded migration-name error", () => {
    const service = readSource("src/services/ExpenseService.ts");
    expect(service).not.toContain("20260524260000_fix_hierarchy_verify_status_by_role");
  });

  it("derives the audit-log tier label from the server's actual returned status, not the pre-RPC client guess", () => {
    const service = readSource("src/services/ExpenseService.ts");
    expect(service).toContain(
      'updatedExpense.status === "level_1_verified" ? "team_leader" : "executive"',
    );
    expect(service).toContain("Verified at ${actualVerifiedTier} by ${reviewerName}");
  });
});
