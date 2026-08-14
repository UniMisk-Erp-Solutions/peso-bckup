/**
 * Drift guard for the Manager-override deduction block (DOC-080 §6).
 *
 * review_approve_expense_manager_override_v1 intentionally inlines the SAME
 * balance-deduction machinery as review_approve_expense_v2 instead of refactoring
 * the live financial function (which would materially increase risk). These
 * assertions fail if the override drifts from V2's proven lock/deduction
 * semantics, so the two cannot silently diverge.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const cwd = process.cwd();
const v2 = readFileSync(
  resolve(cwd, "supabase/migrations/20260808140000_atomic_expense_approval_balance_deduction.sql"),
  "utf-8",
);
const override = readFileSync(
  resolve(cwd, "supabase/migrations/20260810160000_manager_override_approve_prepared.sql"),
  "utf-8",
);

// Whitespace-normalized so incidental formatting differences do not matter —
// only the semantic financial operations are compared.
const ws = (s: string) => s.replace(/\s+/g, " ").trim();
const v2n = ws(v2);
const overriden = ws(override);

// The load-bearing financial operations both functions MUST share (semantically).
const SHARED_FINANCIAL_STATEMENTS = [
  // Lock the single matching profile (organization AND user), never LIMIT 1.
  "SELECT COALESCE(p.balance, 0) INTO v_balance_before",
  "WHERE p.organization_id = v_org_id AND p.user_id = v_employee_id FOR UPDATE;",
  // Balance arithmetic in SQL against the locked row, RETURNING the new balance.
  "SET balance = COALESCE(balance, 0) - v_amount,",
  "RETURNING balance INTO v_balance_after;",
  // Zero-row balance UPDATE is fatal (the original incident).
  "RAISE EXCEPTION 'Balance update affected no row; approval rolled back';",
  // One deduction row per expense; UNIQUE(expense_id) makes double-deduction impossible.
  "INSERT INTO public.expense_balance_deductions (",
  "v_amount, v_balance_before, v_balance_after, 'approval'",
];

describe("Manager override financial parity with V2", () => {
  for (const stmt of SHARED_FINANCIAL_STATEMENTS) {
    it(`both functions contain: ${stmt.slice(0, 48)}…`, () => {
      const needle = ws(stmt);
      expect(v2n).toContain(needle);
      expect(overriden).toContain(needle);
    });
  }

  it("override retains the engineer-only + scope + limit + no-self + non-terminal guards", () => {
    expect(override).toContain("Manager override is available to engineers only");
    expect(override).toContain("public.expense_manager_can_review(e, v_uid)");
    expect(override).toContain("engineer_approval_limit");
    expect(override).toContain("You cannot approve your own expense");
    expect(override).toContain("IF e.status IN ('approved', 'rejected', 'paid') THEN");
  });

  it("override does NOT delegate to V1 (its tier gate is what is being bypassed)", () => {
    expect(override).not.toContain("public.review_approve_expense(p_expense_id");
  });
});
