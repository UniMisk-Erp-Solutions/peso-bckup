/**
 * Detailed Expense V4 balance-consistency fix -- SQL contract tests, owner
 * "final accounting-consistency fix", 2026-09-23.
 *
 * Runtime behavior separately proven against real Patidar Production data
 * in rolled-back transactions (zero permanent footprint): coverage
 * unchanged (0 missing/extra/duplicate expense IDs, all-time), 0 row-
 * arithmetic failures across all 3,024 rows, 0 rows with Debit > 0 and
 * Opening == Closing, all 14 employees with activity reconcile to their
 * current profiles.balance to the cent (via sum-of-deltas, robust to
 * same-day ordering), 20/20 legacy sample and 20/20 modern sample proofs,
 * and the 3 seeded duplicate-deduction rows render with their proven
 * amounts and correct running-balance impact. See
 * Documentations MD/detailed-expense-report-preview.md for the full record.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const cwd = process.cwd();
const migration = readFileSync(
  resolve(cwd, "supabase/migrations/20260929000000_detailed_expense_v4_balance_reconciliation.sql"),
  "utf-8",
).replace(/\r\n/g, "\n");

describe("report_historical_reconciliation_events", () => {
  it("is additive, RLS-enabled, worker/service_role only -- no client access at all", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.report_historical_reconciliation_events");
    expect(migration).toContain("ALTER TABLE public.report_historical_reconciliation_events ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("REVOKE ALL ON public.report_historical_reconciliation_events FROM PUBLIC;");
    expect(migration).toContain("REVOKE ALL ON public.report_historical_reconciliation_events FROM anon, authenticated;");
    expect(migration).toContain("GRANT SELECT ON public.report_historical_reconciliation_events TO service_role;");
  });

  it("constrains event_type to a closed, generic set -- no Patidar-specific or employee-specific type", () => {
    expect(migration).toContain("CHECK (event_type IN ('duplicate_deduction_error', 'historical_balance_adjustment'))");
  });

  it("requires a non-null note (provenance) and a confidence marker on every row -- never silent, unlabeled history", () => {
    expect(migration).toContain("note                      text NOT NULL");
    expect(migration).toContain("CHECK (confidence IN ('proven', 'conditional'))");
  });
});

describe("_balance_event_label_v3 extension (additive only)", () => {
  it("adds labels for the two new report-only event types without changing any existing label", () => {
    expect(migration).toContain("WHEN 'historical_opening_balance'      THEN 'Historical Opening Balance'");
    expect(migration).toContain("WHEN 'duplicate_deduction_error'       THEN 'Duplicate Deduction (Historical)'");
    // Every pre-existing mapping is repeated verbatim -- CREATE OR REPLACE
    // with the full original CASE list, not a partial/appended one that
    // could accidentally drop a mapping some other caller depends on.
    expect(migration).toContain("WHEN 'expense_deduction'               THEN 'Expense Deduction'");
    expect(migration).toContain("WHEN 'cash_transfer_in'                THEN 'Cash Transfer'");
    expect(migration).toContain("WHEN 'opening_credit'                  THEN 'Opening Balance Credit'");
  });
});

describe("report_detailed_expense_rows_v4 -- corrected balance model", () => {
  it("gives every expense (legacy or modern) a REAL balance-affecting delta -- no more zero-delta workaround", () => {
    const start = migration.indexOf("expense_events AS");
    const body = migration.slice(start, migration.indexOf("\n  ),\n  reconciliation_events AS", start));
    expect(body).toContain("(-e.total_amount)                                            AS amount_delta");
    expect(body).not.toContain("CASE WHEN ebd.id IS NOT NULL THEN -ebd.expense_amount ELSE 0::numeric END");
  });

  it("still tags modern_deduction_present per row -- diagnostic only, no longer decides the delta", () => {
    const start = migration.indexOf("expense_events AS");
    const body = migration.slice(start, migration.indexOf("\n  ),\n  reconciliation_events AS", start));
    expect(body).toContain("(ebd.id IS NOT NULL)                                         AS modern_deduction_present");
  });

  it("still sources every expense from `expenses` directly, LEFT JOINed to expense_balance_deductions -- a legacy expense is never excluded", () => {
    const start = migration.indexOf("expense_events AS");
    const body = migration.slice(start, migration.indexOf("\n  ),\n  reconciliation_events AS", start));
    expect(body).toContain("FROM public.expenses e");
    expect(body).toContain("e.status = 'approved'");
    expect(body).toContain("LEFT JOIN public.expense_balance_deductions ebd");
  });

  it("business date remains trip_start", () => {
    const start = migration.indexOf("expense_events AS");
    const body = migration.slice(start, migration.indexOf("\n  ),\n  reconciliation_events AS", start));
    expect(body).toContain("e.trip_start::timestamptz");
  });

  it("unions in reconciliation_events (independently-proven historical facts) alongside expense and non-expense events", () => {
    const start = migration.indexOf("\n  events AS (");
    const body = migration.slice(start, migration.indexOf("),", start));
    expect(body).toContain("FROM non_expense_events");
    expect(body).toContain("FROM expense_events");
    expect(body).toContain("FROM reconciliation_events");
  });

  it("reconciliation_events reads report_historical_reconciliation_events, scoped by organization and (optionally) user_ids, exactly like every other event source", () => {
    const start = migration.indexOf("reconciliation_events AS");
    const body = migration.slice(start, migration.indexOf("\n  ),\n  events AS", start));
    expect(body).toContain("FROM public.report_historical_reconciliation_events r");
    expect(body).toContain("r.organization_id = p_organization_id");
    expect(body).toContain("p_user_ids IS NULL OR r.user_id = ANY (p_user_ids)");
  });

  it("computes an explicit, report-only historical_opening_balance row per employee instead of a hidden baseline term", () => {
    const start = migration.indexOf("opening_balance_events AS");
    const body = migration.slice(start, migration.indexOf("\n  ),\n  all_events AS", start));
    expect(body).toContain("'historical_opening_balance'::text");
    expect(body).toContain("(COALESCE(p.balance, 0) - t.total_delta)");
    expect(body).toContain("Report-only: never written to any accounting table");
  });

  it("dates the opening-balance row one day before the employee's earliest known event, so it always sorts first", () => {
    const start = migration.indexOf("opening_balance_events AS");
    const body = migration.slice(start, migration.indexOf("\n  ),\n  all_events AS", start));
    expect(body).toContain("(ee.earliest_at - interval '1 day')");
  });

  it("the running balance is a plain SUM() over the full event stream (opening row included) -- no separate baseline term added on top", () => {
    const runningStart = migration.indexOf("running AS (");
    const body = migration.slice(runningStart, migration.indexOf("),", runningStart));
    expect(body).toContain("SUM(o.amount_delta) OVER (PARTITION BY o.user_id ORDER BY o.rn)");
    expect(body).not.toContain("baseline_before");
  });

  it("never drops a real expense/reconciliation/opening row from the display filter for having a real (non-zero) delta", () => {
    const start = migration.indexOf("windowed AS");
    const body = migration.slice(start, migration.indexOf("),", start));
    expect(body).toContain("r.event_type = 'expense_deduction' OR r.amount_delta <> 0");
  });

  it("worker/service_role only -- explicit REVOKE from PUBLIC/anon AND authenticated", () => {
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

  it("never writes to any accounting table -- report reconstruction only", () => {
    expect(migration).not.toMatch(/INSERT INTO public\.(expenses|profiles|balance_ledger|expense_balance_deductions|cash_transfer_history)\b/);
    expect(migration).not.toMatch(/UPDATE public\.(expenses|profiles|balance_ledger|expense_balance_deductions|cash_transfer_history)\b/);
  });
});

describe("seeded Patidar duplicate-deduction facts (data, not SQL logic)", () => {
  it("seeds exactly the 3 amounts proven by the 2026-09-20 forensic audit, as data rows -- never as hardcoded SQL conditionals", () => {
    const start = migration.indexOf("INSERT INTO public.report_historical_reconciliation_events");
    const body = migration.slice(start, migration.indexOf("ON CONFLICT DO NOTHING;", start));
    expect(body).toContain("-487.00");
    expect(body).toContain("-2000.00");
    expect(body).toContain("-3738.00");
    expect(body).toContain("'01090'");
    expect(body).toContain("'01162'");
    expect(body).toContain("'01267'");
    // No conditional SQL logic keyed on an org/employee id anywhere in the
    // function body itself -- only in this trailing data INSERT.
    const fnStart = migration.indexOf("CREATE OR REPLACE FUNCTION public.report_detailed_expense_rows_v4(");
    const fnBody = migration.slice(fnStart, migration.indexOf("$fn$;", fnStart));
    expect(fnBody).not.toContain("496fb7f7-d789-44c9-9be8-675ddf186302");
  });

  it("wording never claims the org-wide reset script was proven to have executed", () => {
    expect(migration.toLowerCase()).not.toMatch(/reset script.{0,40}(executed|ran|run)\b/);
    expect(migration).not.toContain("org-wide reset script executed");
  });

  it("is idempotent (ON CONFLICT DO NOTHING) and verified by the migration's own count check", () => {
    expect(migration).toContain("ON CONFLICT DO NOTHING;");
    expect(migration).toContain("expected exactly 3 seeded reconciliation events for Patidar");
  });
});

describe("verification block", () => {
  it("fails loudly if anon or authenticated somehow gets access to the new table or function", () => {
    expect(migration).toContain("has_table_privilege('anon', 'public.report_historical_reconciliation_events', 'SELECT')");
    expect(migration).toContain("has_table_privilege('authenticated', 'public.report_historical_reconciliation_events', 'SELECT')");
    expect(migration).toContain("has_function_privilege('anon', 'public.report_detailed_expense_rows_v4");
  });
});
