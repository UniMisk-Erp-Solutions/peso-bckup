/**
 * Detailed Expense V4 (report_detailed_expense_rows_v4) -- SQL contract
 * tests for the FIRST migration, "critical integrated fix pass", 2026-09-23.
 *
 * IMPORTANT: report_detailed_expense_rows_v4's LIVE behavior is now defined
 * by the LATER 20260929000000_detailed_expense_v4_balance_reconciliation.sql
 * migration (CREATE OR REPLACE, same signature) -- see
 * detailedExpenseV4BalanceReconciliationMigration.test.ts for its contract.
 * That later migration made legacy expenses debit the running balance for
 * real (this file's own zero-delta approach was a deliberately cautious
 * FIRST pass, superseded once a completed forensic audit proved the old
 * software really did debit them). The tests below cover only the
 * architectural properties that remain true of both migrations: V3 reuse,
 * direct-from-`expenses` sourcing, no duplication, business date, additive/
 * read-only/security posture.
 *
 * The migration cannot be executed locally (no Postgres here), so its shape
 * is guarded on the authored source, matching the convention used elsewhere
 * in this suite. Coverage was separately proven against real Patidar
 * Production data in rolled-back transactions: 0 missing approved-expense
 * IDs (2026 AND all-time), 0 duplicate expense IDs -- see
 * Documentations MD/detailed-expense-report-preview.md.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const cwd = process.cwd();
const migration = readFileSync(
  resolve(cwd, "supabase/migrations/20260926000000_detailed_expense_rows_v4.sql"),
  "utf-8",
).replace(/\r\n/g, "\n");

describe("report_detailed_expense_rows_v4", () => {
  it("is additive -- V3 and its shared event-constructor helper are asserted to still exist, never dropped or edited", () => {
    expect(migration).toContain("CREATE OR REPLACE FUNCTION public.report_detailed_expense_rows_v4(");
    expect(migration).toContain("report_balance_timeline_rows_v3(uuid, uuid[], date, date, jsonb, integer, boolean)");
    expect(migration).toContain("_balance_timeline_events_v3(uuid, uuid[])");
    expect(migration).toContain("must not have been dropped");
  });

  it("reuses _balance_timeline_events_v3 for every non-expense event -- never re-derives the balance_ledger/hidden-pair logic", () => {
    const start = migration.indexOf("non_expense_events AS");
    const body = migration.slice(start, migration.indexOf("),", start));
    expect(body).toContain("FROM public._balance_timeline_events_v3(p_organization_id, p_user_ids)");
    expect(body).toContain("WHERE event_type <> 'expense_deduction'");
  });

  it("sources expense rows directly from public.expenses -- APPROVED + valid profile, not conditioned on expense_balance_deductions existing", () => {
    const start = migration.indexOf("expense_events AS");
    const body = migration.slice(start, migration.indexOf("\n  ),\n  events AS", start));
    expect(body).toContain("FROM public.expenses e");
    expect(body).toContain("JOIN public.profiles pr");
    expect(body).toContain("e.status = 'approved'");
    expect(body).toContain("e.deleted_at IS NULL");
    expect(body).toContain("LEFT JOIN public.expense_balance_deductions ebd");
    // The LEFT JOIN is the whole point -- a legacy expense (ebd.id IS NULL)
    // must still produce a row, never be excluded by an INNER JOIN/EXISTS gate.
    expect(body).not.toMatch(/JOIN\s+public\.expense_balance_deductions[\s\S]{0,20}ON[\s\S]{0,60}\s+WHERE/);
  });

  it("never duplicates a modern expense -- exactly one row per expenses.id regardless of whether a deduction record exists", () => {
    const start = migration.indexOf("expense_events AS");
    const body = migration.slice(start, migration.indexOf("\n  ),\n  events AS", start));
    // Exactly one SELECT ... FROM public.expenses in the whole expense_events
    // CTE -- a second, independent expense-sourced SELECT would be the
    // duplication bug this migration exists to avoid re-introducing.
    expect((body.match(/FROM public\.expenses e\b/g) ?? []).length).toBe(1);
  });

  it("business date is trip_start, never approved_at or created_at, for every expense row", () => {
    const start = migration.indexOf("expense_events AS");
    const body = migration.slice(start, migration.indexOf("\n  ),\n  events AS", start));
    expect(body).toContain("e.trip_start::timestamptz");
    expect(body).not.toContain("e.approved_at");
    expect(body).not.toContain("e.created_at");
  });

  it("Credit/Debit and the row's own amount_delta in the OUTPUT are built from amount_delta_display -- so a legacy row's real amount is still shown", () => {
    const start = migration.indexOf("rows_json AS");
    const body = migration.slice(start, migration.indexOf("FROM page pg", start));
    expect(body).toContain("'amount_delta',              pg.amount_delta_display");
    expect(body).toContain("pg.amount_delta_display > 0");
    expect(body).toContain("pg.amount_delta_display < 0");
  });

  it("a legacy expense row is never dropped by the display filter, unlike a genuinely zero-delta non-expense event", () => {
    const start = migration.indexOf("windowed AS");
    const body = migration.slice(start, migration.indexOf("),", start));
    expect(body).toContain("r.event_type = 'expense_deduction' OR r.amount_delta <> 0");
  });

  it("tags modern_deduction_present per row for diagnostics, without exposing it as a fabricated financial event", () => {
    expect(migration).toContain("modern_deduction_present");
    expect(migration).toContain("(ebd.id IS NOT NULL)");
  });

  it("resolves custom fields and batch_ref keyed by expense_id for every expense row -- legacy rows now get real custom-field values too, not just modern ones", () => {
    const customStart = migration.indexOf("custom AS");
    const customBody = migration.slice(customStart, migration.indexOf("rows_json AS", customStart));
    expect(customBody).toContain("_report_expense_custom_fields_v1(p_organization_id, (SELECT arr FROM exp_ids))");

    const rowsJsonStart = migration.indexOf("rows_json AS");
    const rowsJsonBody = migration.slice(rowsJsonStart, migration.indexOf("FROM page pg", rowsJsonStart));
    expect(rowsJsonBody).toContain("CASE WHEN pg.expense_id IS NULL THEN '{}'::jsonb");
    expect(rowsJsonBody).toContain("(SELECT map FROM custom) -> pg.expense_id::text");
  });

  it("worker/service_role only -- explicit REVOKE from PUBLIC/anon AND authenticated, no authorization of its own", () => {
    expect(migration).toContain(
      "REVOKE ALL ON FUNCTION public.report_detailed_expense_rows_v4(uuid, uuid[], date, date, jsonb, integer, boolean) FROM PUBLIC;",
    );
    expect(migration).toContain(
      "REVOKE ALL ON FUNCTION public.report_detailed_expense_rows_v4(uuid, uuid[], date, date, jsonb, integer, boolean) FROM anon, authenticated;",
    );
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION public.report_detailed_expense_rows_v4(uuid, uuid[], date, date, jsonb, integer, boolean) TO service_role;",
    );
  });

  it("has a verification block that fails loudly if anon OR authenticated somehow gets EXECUTE", () => {
    expect(migration).toContain("has_function_privilege('anon'");
    expect(migration).toContain("has_function_privilege('authenticated'");
    expect(migration).toContain("worker/service_role only)");
  });

  it("never writes to expenses, profiles, balance_ledger or expense_balance_deductions -- read-only report producer", () => {
    expect(migration).not.toMatch(/INSERT INTO public\.(expenses|profiles|balance_ledger|expense_balance_deductions)/);
    expect(migration).not.toMatch(/UPDATE public\.(expenses|profiles|balance_ledger|expense_balance_deductions)/);
  });
});
