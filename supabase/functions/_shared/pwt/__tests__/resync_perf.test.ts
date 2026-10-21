import { expect, it } from "vitest";
import { buildJobPlanFromNormalized, mergeNormalized, normalizeRows, DEFAULT_PWT_CONFIG } from "C:/Users/admin/Desktop/priyanshu intern/test project/peso-bckup-priyanshu/supabase/functions/_shared/pwt/index.ts";

// A RE-SYNC: every one of 12,609 expenses is already posted, so every row produces an ALREADY_POSTED notice.
it("planning a full re-sync is fast (no quadratic notice handling)", async () => {
  const org = "org-1";
  const rows = Array.from({ length: 12609 }, (_, i) => ({
    event_id: "ev" + i, expense_id: "e" + i, event_type: "expense_deduction", employee_code: String(1000 + (i % 300)), employee_name: "Emp " + (i % 300),
    category: i % 97 === 0 ? "" : "Food", debit: 10 + (i % 90), effective_date: "2026-08-05",
  }));
  const cfg = { ...DEFAULT_PWT_CONFIG };
  const norm = mergeNormalized([await normalizeRows(org, "detailed_expense", rows, cfg)]);
  const posted = new Set(norm.post.map((t) => t.sourceId));
  const t0 = Date.now();
  const plan = await buildJobPlanFromNormalized({ organizationId: org, jobId: "j", report: "detailed_expense", company: "Co", cfg, state: { postedSourceIds: posted, voucherCounts: {}, postedAmounts: {} }, revision: 1 }, norm);
  const ms = Date.now() - t0;
  console.log(`re-sync planning of 12,609 already-posted rows: ${ms} ms; issues ${plan.summary.issue_count}`);
  expect(plan.summary.posted_count).toBe(0);
  expect(plan.summary.issue_count).toBe(12609);
  expect(ms).toBeLessThan(1500);
});
