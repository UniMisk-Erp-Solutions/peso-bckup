/**
 * Source-content assertions against the actual, un-appliable SQL migration
 * and Edge Function — the same pattern this codebase already uses for
 * testing migrations/Edge Functions with no live database available
 * (e.g. reportExportWorker.test.ts). These prove structural invariants that
 * matter for correctness/security without executing SQL against a database.
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

function readRepoFile(relativePath: string): string {
  const cwd = process.cwd();
  return readFileSync(resolve(cwd, relativePath), "utf-8").replace(/\r\n/g, "\n");
}

const migration = readRepoFile(
  "supabase/migrations/20260828100000_admin_submit_expense_for_employee_v2.sql",
);
const auditRlsMigration = readRepoFile(
  "supabase/migrations/20260828110000_org_scoped_audit_logs_select.sql",
);
const finalizeEf = readRepoFile("supabase/functions/finalize-expense-receipts/index.ts");
const balanceDeductionMigration = readRepoFile(
  "supabase/migrations/20260808140000_atomic_expense_approval_balance_deduction.sql",
);
const reviewV1Migration = readRepoFile(
  "supabase/migrations/20260702120000_expense_review_admin_approve_rpc.sql",
);

describe("admin_submit_expense_for_employee_v2 — grant hygiene", () => {
  it("revokes PUBLIC and anon EXECUTE on both new RPCs before granting to authenticated", () => {
    const fnNames = ["admin_submit_expense_for_employee_v2", "admin_bulk_submit_expenses_v2"];
    for (const name of fnNames) {
      const fnBlockStart = migration.indexOf(`FUNCTION public.${name}(`);
      expect(fnBlockStart, `${name} definition not found`).toBeGreaterThanOrEqual(0);
      const nextFnStart = migration.indexOf("CREATE OR REPLACE FUNCTION", fnBlockStart + 1);
      const block = migration.slice(fnBlockStart, nextFnStart === -1 ? undefined : nextFnStart);
      expect(block, `${name} missing REVOKE FROM PUBLIC`).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\([^)]*\\)\\s*\\n?\\s*FROM PUBLIC`),
      );
      expect(block, `${name} missing REVOKE FROM anon`).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\([^)]*\\)\\s*\\n?\\s*FROM anon`),
      );
      expect(block, `${name} missing GRANT TO authenticated`).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\([^)]*\\)\\s*\\n?\\s*TO authenticated`),
      );
    }
  });

  it("both new RPCs are SECURITY DEFINER with search_path pinned to public", () => {
    for (const name of ["admin_submit_expense_for_employee_v2", "admin_bulk_submit_expenses_v2"]) {
      const fnStart = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
      expect(fnStart, `${name} not found`).toBeGreaterThanOrEqual(0);
      const signatureEnd = migration.indexOf("AS $fn$", fnStart);
      const signatureBlock = migration.slice(fnStart, signatureEnd);
      expect(signatureBlock, `${name} missing SECURITY DEFINER`).toMatch(/SECURITY DEFINER/);
      expect(signatureBlock, `${name} missing SET search_path = public`).toMatch(/SET search_path = public/);
    }
  });
});

describe("admin_submit_expense_for_employee_v2 — atomicity structure", () => {
  it("wraps the whole file in one BEGIN...COMMIT (single migration transaction)", () => {
    expect(migration.trim().startsWith("BEGIN;") || migration.includes("\nBEGIN;\n")).toBe(true);
    expect(migration.trim().endsWith("COMMIT;")).toBe(true);
  });

  it("never reimplements financial logic: no direct UPDATE of profiles.balance", () => {
    expect(migration).not.toMatch(/UPDATE\s+public\.profiles\s+SET\s+balance/i);
  });

  it("delegates status transitions to the canonical, unmodified approve/verify RPCs", () => {
    expect(migration).toMatch(/PERFORM public\.review_admin_verify_expense\(/);
    expect(migration).toMatch(/PERFORM public\.review_approve_expense_v2\(/);
  });

  it("delegates custom-field persistence to the existing atomic-write RPC, not a re-implementation", () => {
    expect(migration).toMatch(/public\.replace_expense_form_field_values\(/);
    // The validation logic itself (cross-org guards, duplicate detection) is
    // NOT duplicated here -- only the delegating call should appear.
    expect(migration).not.toMatch(/duplicate template_id in payload/);
  });

  it("the expense INSERT happens before the custom-field call, and both happen before any status transition", () => {
    const insertIdx = migration.indexOf("INSERT INTO public.expenses (");
    const customFieldIdx = migration.indexOf("public.replace_expense_form_field_values(v_expense_id");
    const verifyIdx = migration.indexOf("PERFORM public.review_admin_verify_expense(");
    const approveIdx = migration.indexOf("PERFORM public.review_approve_expense_v2(");
    expect(insertIdx).toBeGreaterThan(0);
    expect(customFieldIdx).toBeGreaterThan(insertIdx);
    expect(verifyIdx).toBeGreaterThan(customFieldIdx);
    expect(approveIdx).toBeGreaterThan(customFieldIdx);
  });

  it("records the idempotency key only after every other step, inside the same function body", () => {
    const idempotencyInsertIdx = migration.indexOf(
      "INSERT INTO public.admin_submit_expense_idempotency",
    );
    const approveIdx = migration.indexOf("PERFORM public.review_approve_expense_v2(");
    const auditIdx = migration.lastIndexOf("INSERT INTO public.audit_logs");
    expect(idempotencyInsertIdx).toBeGreaterThan(approveIdx);
    expect(idempotencyInsertIdx).toBeGreaterThan(auditIdx);
  });

  it("routing is computed from the employee's profile/membership, never the admin's", () => {
    // Every profile/membership lookup that feeds routing must be scoped to
    // p_employee_id, not v_admin_id.
    expect(migration).toMatch(
      /SELECT reporting_engineer_id INTO v_reporting_engineer\s*\n\s*FROM public\.profiles WHERE user_id = p_employee_id/,
    );
    expect(migration).toMatch(
      /FROM public\.team_members tm[\s\S]{0,120}WHERE tm\.user_id = p_employee_id/,
    );
  });

  it("segregation of duties: approving your own delegated submission writes a distinct, machine-searchable audit action", () => {
    expect(migration).toMatch(/'admin_submitted_and_approved_for_employee'/);
  });

  it("employee cannot equal admin (no self-submission through the delegated path)", () => {
    expect(migration).toMatch(/IF p_employee_id = v_admin_id THEN/);
  });

  it("cross-org employee ids fail closed: active membership in THIS organization is required", () => {
    expect(migration).toMatch(
      /WHERE user_id = p_employee_id AND organization_id = p_organization_id AND is_active = true/,
    );
  });
});

describe("admin_bulk_submit_expenses_v2 — per-row isolation and idempotency", () => {
  it("wraps each row in its own BEGIN/EXCEPTION block so one bad row cannot abort the batch", () => {
    const bulkFnStart = migration.indexOf("FUNCTION public.admin_bulk_submit_expenses_v2(");
    const block = migration.slice(bulkFnStart);
    expect(block).toMatch(/FOR v_row IN SELECT value FROM jsonb_array_elements\(p_rows\) LOOP/);
    expect(block).toMatch(/EXCEPTION WHEN OTHERS THEN/);
  });

  it("requires a client_operation_id per row and rejects rows missing one", () => {
    expect(migration).toMatch(/row is missing client_operation_id/);
  });

  it("treats zero and multiple employee matches as equally hard errors, never picks one silently", () => {
    expect(migration).toMatch(/no employee found with employee_id/);
    expect(migration).toMatch(/matches % different people/);
  });

  it("caps a single batch call at 250 rows", () => {
    expect(migration).toMatch(/jsonb_array_length\(p_rows\) > 250/);
  });
});

describe("MicroLink bulk import — financial rules (static audit, no live DB available)", () => {
  it("submitted/verified status never reaches the deduction call: only p_status='approved' invokes review_approve_expense_v2", () => {
    const fnStart = migration.indexOf("CREATE OR REPLACE FUNCTION public.admin_submit_expense_for_employee_v2(");
    const fnEnd = migration.indexOf("REVOKE ALL ON FUNCTION public.admin_submit_expense_for_employee_v2", fnStart);
    const body = migration.slice(fnStart, fnEnd);
    const transitionBlockStart = body.indexOf("IF p_status = 'verified' THEN");
    const transitionBlock = body.slice(transitionBlockStart, body.indexOf("END IF;", body.indexOf("v_final_status := 'approved';")));
    // 'verified' branch calls only review_admin_verify_expense.
    const verifiedBranch = transitionBlock.slice(0, transitionBlock.indexOf("ELSIF"));
    expect(verifiedBranch).toMatch(/PERFORM public\.review_admin_verify_expense\(/);
    expect(verifiedBranch).not.toMatch(/review_approve_expense_v2/);
    // 'approved' branch is the only one calling review_approve_expense_v2 (the
    // one and only path that touches expense_balance_deductions / profiles.balance).
    const approvedBranch = transitionBlock.slice(transitionBlock.indexOf("ELSIF"));
    expect(approvedBranch).toMatch(/PERFORM public\.review_approve_expense_v2\(/);
  });

  it("the default p_status is 'submitted', which triggers neither verify nor approve — zero balance effect", () => {
    expect(migration).toMatch(/p_status\s+text\s+DEFAULT 'submitted'/);
  });

  it("approved: exactly one row ever written to expense_balance_deductions per expense (UNIQUE(expense_id))", () => {
    expect(balanceDeductionMigration).toMatch(
      /CONSTRAINT expense_balance_deductions_expense_key UNIQUE \(expense_id\)/,
    );
    // Exactly one INSERT statement into the table in the whole migration.
    const insertMatches = balanceDeductionMigration.match(/INSERT INTO public\.expense_balance_deductions/g) ?? [];
    expect(insertMatches.length).toBe(1);
  });

  it("approved: balance_after is computed server-side as balance_before - expense.total_amount, in SQL", () => {
    expect(balanceDeductionMigration).toMatch(
      /UPDATE public\.profiles\s*\n\s*SET balance\s*=\s*COALESCE\(balance, 0\) - v_amount/,
    );
    expect(balanceDeductionMigration).toMatch(/v_amount\s*:=\s*COALESCE\(e\.total_amount, 0\);/);
  });

  it("re-approving an already-approved expense is rejected before any arithmetic (no double deduction via re-approval)", () => {
    // review_approve_expense_v2 re-checks status itself...
    const v2Start = balanceDeductionMigration.indexOf("CREATE OR REPLACE FUNCTION public.review_approve_expense_v2(");
    const v2Body = balanceDeductionMigration.slice(v2Start);
    expect(v2Body).toMatch(/IF e\.status = 'approved' THEN\s*\n\s*RAISE EXCEPTION 'This expense is already approved'/);
    // ...and delegates the authoritative decision to V1, which enforces the
    // same guard independently (defense in depth, not just a comment).
    expect(reviewV1Migration).toMatch(/IF e\.status = 'approved' THEN\s*\n\s*RAISE EXCEPTION 'This expense is already approved and cannot be updated'/);
  });

  it("no client-side balance arithmetic anywhere in the bulk-import UI/lib chain", () => {
    const uiLib = [
      readRepoFile("src/lib/bulkExpenseImportParse.ts"),
      readRepoFile("src/components/BulkExpenseImportPanel.tsx"),
      readRepoFile("src/lib/adminSubmitExpense.ts"),
    ].join("\n");
    expect(uiLib).not.toMatch(/balance\s*-\s*\w|-\s*amount|\.balance\s*=/i);
  });

  it("idempotency is a real DB-level uniqueness guarantee (PRIMARY KEY), not merely an app-side check", () => {
    expect(migration).toMatch(
      /PRIMARY KEY \(organization_id, admin_id, idempotency_key\)/,
    );
    // A replay (found + matching hash) returns BEFORE any INSERT/PERFORM that
    // could create a second expense or a second approval/deduction.
    const checkIdx = migration.indexOf("IF p_idempotency_key IS NOT NULL THEN\n    SELECT expense_id, request_hash");
    const returnIdx = migration.indexOf("RETURN jsonb_build_object(\n        'expense_id', v_existing_expense_id", checkIdx);
    const insertExpenseIdx = migration.indexOf("INSERT INTO public.expenses (", checkIdx);
    expect(checkIdx).toBeGreaterThan(0);
    expect(returnIdx).toBeGreaterThan(checkIdx);
    expect(insertExpenseIdx).toBeGreaterThan(returnIdx);
  });

  it("every bulk row requires its own client_operation_id, used as that row's idempotency key (no shared/batch-level key)", () => {
    const bulkFnStart = migration.indexOf("CREATE OR REPLACE FUNCTION public.admin_bulk_submit_expenses_v2(");
    const bulkFnBody = migration.slice(bulkFnStart);
    expect(bulkFnBody).toMatch(/IF v_client_op_id IS NULL THEN\s*\n\s*RAISE EXCEPTION 'row is missing client_operation_id'/);
    // The per-row idempotency key passed down is v_client_op_id, derived
    // fresh from EACH row's own payload (v_row->>'client_operation_id'),
    // never a single key shared across the whole batch call.
    const callStart = bulkFnBody.indexOf("public.admin_submit_expense_for_employee_v2(");
    const callArgs = bulkFnBody.slice(callStart, bulkFnBody.indexOf(");", callStart));
    expect(callArgs.trim().endsWith("v_client_op_id")).toBe(true);
    expect(migration).toMatch(/p_idempotency_key\s+text\s+DEFAULT NULL/);
  });
});

describe("org-scoped audit_logs SELECT fix — structural check", () => {
  it("the admin branch is scoped through organization_memberships, not a global has_role check", () => {
    const policyStart = auditRlsMigration.indexOf('CREATE POLICY "Users can view audit logs of viewable expenses"');
    const block = auditRlsMigration.slice(policyStart);
    expect(block).toMatch(/organization_memberships om/);
    expect(block).toMatch(/om\.organization_id = e\.organization_id/);
    expect(block).not.toMatch(/has_role\(auth\.uid\(\), 'admin'\)/);
  });

  it("owner and assigned-engineer branches are preserved unchanged", () => {
    expect(auditRlsMigration).toMatch(/e\.user_id = auth\.uid\(\)/);
    expect(auditRlsMigration).toMatch(/e\.assigned_engineer_id = auth\.uid\(\)/);
  });
});

describe("finalize-expense-receipts — admin-aware ownership check", () => {
  it("no longer filters the expense query by user_id (which silently produced EXPENSE_ACCESS_DENIED for admins)", () => {
    const selectIdx = finalizeEf.indexOf('.select("id, user_id, organization_id")');
    expect(selectIdx).toBeGreaterThan(0);
    const nextLines = finalizeEf.slice(selectIdx, selectIdx + 200);
    expect(nextLines).not.toMatch(/\.eq\("user_id", user\.id\)/);
  });

  it("authorizes exact owner OR an active admin membership of the expense's organization", () => {
    expect(finalizeEf).toMatch(/expense\.user_id === user\.id/);
    expect(finalizeEf).toMatch(/organization_memberships/);
    expect(finalizeEf).toMatch(/\.eq\("role", "admin"\)/);
    expect(finalizeEf).toMatch(/\.eq\("is_active", true\)/);
  });

  it("still returns EXPENSE_ACCESS_DENIED (403) when neither condition holds", () => {
    expect(finalizeEf).toMatch(/if \(!authorized\) \{/);
    expect(finalizeEf).toMatch(/"EXPENSE_ACCESS_DENIED"/);
  });
});
