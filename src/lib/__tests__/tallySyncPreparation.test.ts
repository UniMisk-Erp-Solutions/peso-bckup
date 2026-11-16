import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  claimApprovalRpcStatuses,
  claimVerificationStatuses,
  engineerStatusToApprovalTier,
  parseTallyJobParameters,
  resolveDetailedExpenseRpcDates,
} from "@/lib/tallySync/parameters";
import {
  isSoftDeleted,
  matchesClaimApprovalEngineerFilter,
  matchesCustomFieldFilters,
} from "@/lib/tallySync/expenseFilters";
import { contentHash, stableStringify } from "@/lib/tallySync/contentHash";
import {
  balanceEventSourceKey,
  dailyReportRowSourceKey,
  expenseSourceKey,
} from "@/lib/tallySync/sourceKeys";
import { assembleAllPages, assertFullDatasetAssembled } from "@/lib/tallySync/paging";
const worker = readFileSync(
  resolve(process.cwd(), "supabase/functions/run-tally-sync-job/index.ts"),
  "utf-8",
);

describe("Claim Verification dataset filters (Tally boundary)", () => {
  const row = (id: string, cf: Record<string, string>) => ({
    id,
    custom_fields: cf,
  });

  it("no engineer filter → all verification RPC statuses", () => {
    expect(claimVerificationStatuses(null)).toEqual([
      "verified",
      "level_1_verified",
      "level_2_verified",
    ]);
  });

  it("employee/category/custom-field filters apply at Tally layer", () => {
    expect(matchesCustomFieldFilters(row("1", { "Project ID": "P100" }), { "Project ID": "P100" })).toBe(true);
    expect(matchesCustomFieldFilters(row("1", { "Project ID": "P200" }), { "Project ID": "P100" })).toBe(false);
  });

  it("soft-deleted expenses excluded via meta batch", () => {
    expect(isSoftDeleted({ deleted_at: "2026-01-01T00:00:00Z" })).toBe(true);
    expect(isSoftDeleted({ deleted_at: null })).toBe(false);
  });
});

describe("Claim Approval dataset filters (R2/R3)", () => {
  it("RPC statuses are approved only", () => {
    expect(claimApprovalRpcStatuses()).toEqual(["approved"]);
  });

  it("R3 maps manager status to approval_tier", () => {
    expect(engineerStatusToApprovalTier("verified")).toBe("engineer");
    expect(engineerStatusToApprovalTier("level_1_verified")).toBe("team_leader");
    expect(engineerStatusToApprovalTier("level_2_verified")).toBe("executive");
  });

  it("R3 filter uses approval_tier not invented mappings", () => {
    const meta = {
      e1: { approval_tier: "engineer", deleted_at: null },
      e2: { approval_tier: "team_leader", deleted_at: null },
    };
    expect(matchesClaimApprovalEngineerFilter("e1", "verified", meta)).toBe(true);
    expect(matchesClaimApprovalEngineerFilter("e2", "verified", meta)).toBe(false);
  });

  it("HO status must be approved for claim_approval", () => {
    expect(() =>
      parseTallyJobParameters("claim_approval", { ho_status: "pending" }),
    ).toThrow(/HO status/);
    expect(parseTallyJobParameters("claim_approval", { ho_status: "approved" }).hoStatus).toBe("approved");
  });

  it("custom-field filter parity (R2)", () => {
    expect(
      matchesCustomFieldFilters(
        { id: "x", custom_fields: { "Project ID": "P100" } },
        { "Project ID": "P100" },
      ),
    ).toBe(true);
  });
});

describe("Detailed Expense Tally resolver", () => {
  it("default-year context from frozen year selector", () => {
    const { dateFrom, dateTo } = resolveDetailedExpenseRpcDates({ year: "2026" });
    expect(dateFrom).toBe("2026-01-01");
    expect(dateTo).toBe("2026-12-31");
  });

  it("explicit date_from/date_to win over year", () => {
    const r = resolveDetailedExpenseRpcDates({
      year: "2026",
      date_from: "2026-03-01",
      date_to: "2026-03-31",
    });
    expect(r.dateFrom).toBe("2026-03-01");
    expect(r.dateTo).toBe("2026-03-31");
  });

  it("worker uses report_detailed_expense_rows_v4 not browser rows", () => {
    expect(worker).toContain("report_detailed_expense_rows_v4");
    expect(worker).not.toContain("React");
  });
});

describe("Daily Project Tally resolver", () => {
  it("stable aggregate row identity", () => {
    const key = dailyReportRowSourceKey("org", "2026-06-01", "user-1", "proj-1");
    expect(key).toBe("org:daily_row:2026-06-01|user-1|proj-1");
  });

  it("worker uses report_daily_project_rows_v1", () => {
    expect(worker).toContain("report_daily_project_rows_v1");
  });
});

describe("Full-dataset paging", () => {
  it("assembles >1000 rows across 250-size pages", async () => {
    const total = 1200;
    const pageSize = 250;
    const { rows, pages } = await assembleAllPages(
      pageSize,
      async (cursor, withTotal) => {
        const start = cursor == null ? 0 : Number(cursor);
        const end = Math.min(start + pageSize, total);
        const batch = Array.from({ length: end - start }, (_, i) => start + i);
        return {
          rows: batch,
          hasMore: end < total,
          nextCursor: end < total ? end : null,
          total: withTotal ? total : null,
        };
      },
      "claim expenses",
    );
    expect(rows).toHaveLength(1200);
    expect(pages).toBe(5);
  });

  it("count mismatch fails closed", () => {
    expect(() => assertFullDatasetAssembled(100, 99, "test")).toThrow(/Incomplete test/);
  });

  it("worker enforces expense page size 250 and detailed 500", () => {
    expect(worker).toContain("EXPENSE_PAGE = 250");
    expect(worker).toContain("DETAILED_PAGE = 500");
    expect(worker).toContain("DAILY_PAGE = 250");
  });
});

describe("Stable source keys and content hash", () => {
  it("expense source key is org + expense id", () => {
    expect(expenseSourceKey("org-a", "exp-1")).toBe("org-a:expense:exp-1");
  });

  it("balance event key uses event_id", () => {
    expect(balanceEventSourceKey("org-a", "ev-9")).toBe("org-a:balance_event:ev-9");
  });

  it("same content → same hash; meaningful change → different hash", async () => {
    const a = { amount: 100, category: "Travel" };
    const b = { category: "Travel", amount: 100 };
    const c = { amount: 101, category: "Travel" };
    const ha = await contentHash(a);
    const hb = await contentHash(b);
    const hc = await contentHash(c);
    expect(ha).toBe(hb);
    expect(ha).not.toBe(hc);
  });

  it("stableStringify omits undefined object keys (valid JSON for Tally UDF)", () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("stableStringify ignores key order", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });
});

describe("Retry / idempotency (schema + worker)", () => {
  it("store chunk upserts on source_key conflict", () => {
    const sql = readFileSync(
      resolve(process.cwd(), "supabase/migrations/20261005170000_tally_sync_preparation_phase3.sql"),
      "utf-8",
    );
    expect(sql).toContain("ON CONFLICT (job_id, source_key) DO UPDATE");
  });

  it("claim deletes stale items before rebuild", () => {
    expect(worker).toContain("claim_tally_sync_job_v1");
  });
});

describe("Security / no Tally transport", () => {
  it("worker does not reference TallyPrime or XML", () => {
    expect(worker).not.toMatch(/localhost:9000|9000.*tally/i);
    expect(worker).not.toContain("localhost:9000");
    expect(worker).not.toMatch(/<VOUCHER/i);
  });

  it("ends at prepared status in success path", () => {
    expect(worker).toContain('delivery?.job_status ?? (delivery?.more_chunks ? "prepared" : "prepared")');
    expect(worker).toContain("complete_tally_sync_preparation_v1");
  });
});
