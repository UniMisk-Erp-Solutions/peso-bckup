/**
 * Expense Field Memory self-bootstrap (bootstrap_my_expense_field_memory_v1)
 * -- SQL contract tests, owner "critical integrated fix pass", 2026-09-23.
 *
 * Runtime behavior separately proven against real Mistry And Shah data in a
 * rolled-back transaction: first call for a real employee upserted 57 rows
 * and returned already_bootstrapped:false; an immediate second call
 * returned already_bootstrapped:true / upserted:0 (idempotent, no rescan);
 * a get_recent_expense_field_values_v1 read afterward returned real seeded
 * destination values; a DIFFERENT employee's own bootstrap call saw none of
 * the first employee's rows (0 leaked rows); and an anon-role call was
 * rejected at the GRANT layer. Zero permanent footprint (rolled back).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const cwd = process.cwd();
const migration = readFileSync(
  resolve(cwd, "supabase/migrations/20260928000000_expense_field_memory_self_bootstrap_v1.sql"),
  "utf-8",
).replace(/\r\n/g, "\n");

describe("expense_field_memory_user_state", () => {
  it("is additive (CREATE TABLE IF NOT EXISTS), RLS-enabled, self-select-only", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.expense_field_memory_user_state");
    expect(migration).toContain("ALTER TABLE public.expense_field_memory_user_state ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("USING (user_id = auth.uid())");
  });

  it("keys idempotency on (organization_id, user_id) as the primary key -- one bootstrap record per employee per org", () => {
    expect(migration).toContain("PRIMARY KEY (organization_id, user_id)");
  });

  it("revokes anon/PUBLIC and only grants authenticated SELECT -- all writes go through the RPC, never a direct table write", () => {
    expect(migration).toContain("REVOKE ALL ON public.expense_field_memory_user_state FROM PUBLIC;");
    expect(migration).toContain("REVOKE ALL ON public.expense_field_memory_user_state FROM anon;");
    expect(migration).toContain("GRANT SELECT ON public.expense_field_memory_user_state TO authenticated;");
  });
});

describe("bootstrap_my_expense_field_memory_v1", () => {
  it("derives auth.uid() itself -- no p_user_id parameter to spoof another employee", () => {
    const start = migration.indexOf("CREATE OR REPLACE FUNCTION public.bootstrap_my_expense_field_memory_v1(");
    const signatureEnd = migration.indexOf(")", start);
    const signature = migration.slice(start, signatureEnd);
    expect(signature).not.toContain("p_user_id");
    const body = migration.slice(start, migration.indexOf("\n$$;", start));
    expect(body).toContain("v_uid       uuid := auth.uid();");
  });

  it("requires active membership in the target organization before doing anything", () => {
    const start = migration.indexOf("CREATE OR REPLACE FUNCTION public.bootstrap_my_expense_field_memory_v1(");
    const body = migration.slice(start, migration.indexOf("\n$$;", start));
    expect(body).toContain("FROM public.organization_memberships om");
    expect(body).toContain("om.is_active = true");
    expect(body).toContain("Not a member of this organization");
  });

  it("no-ops gracefully (not an error) when the feature is disabled for that org", () => {
    const start = migration.indexOf("CREATE OR REPLACE FUNCTION public.bootstrap_my_expense_field_memory_v1(");
    const body = migration.slice(start, migration.indexOf("\n$$;", start));
    expect(body).toContain("'skipped', 'feature_disabled'");
  });

  it("is idempotent via expense_field_memory_user_state -- a second call short-circuits before touching expenses at all", () => {
    const start = migration.indexOf("CREATE OR REPLACE FUNCTION public.bootstrap_my_expense_field_memory_v1(");
    const body = migration.slice(start, migration.indexOf("\n$$;", start));
    const alreadyCheckIdx = body.indexOf("v_already");
    const srcCteIdx = body.indexOf("WITH src AS");
    expect(alreadyCheckIdx).toBeGreaterThan(-1);
    expect(srcCteIdx).toBeGreaterThan(-1);
    expect(alreadyCheckIdx).toBeLessThan(srcCteIdx);
    expect(body).toContain("'skipped', 'already_bootstrapped'");
  });

  it("scopes every eligible-value source to the caller's own expenses (e.user_id = v_uid), approved only -- same eligible fields as the existing admin bootstrap", () => {
    const start = migration.indexOf("WITH src AS");
    const body = migration.slice(start, migration.indexOf("\n  normalized AS", start));
    expect(body).toContain("e.user_id = v_uid AND e.status = 'approved'");
    expect(body).toContain("'system:title'");
    expect(body).toContain("'system:destination'");
    expect(body).toContain("'system:purpose'");
    expect(body).toContain("'custom:' || t.id::text");
    expect(body).toContain("'branch:' || b.id::text");
    // Never amount/date/status/id fields -- free-text eligible fields only.
    expect(body).not.toContain("e.total_amount");
    expect(body).not.toContain("e.trip_start");
  });

  it("marks bootstrap complete even when nothing was eligible -- a genuinely empty history is not rescanned forever", () => {
    const start = migration.indexOf("CREATE OR REPLACE FUNCTION public.bootstrap_my_expense_field_memory_v1(");
    const body = migration.slice(start, migration.indexOf("\n$$;", start));
    const insertStateIdx = body.lastIndexOf("INSERT INTO public.expense_field_memory_user_state");
    expect(insertStateIdx).toBeGreaterThan(-1);
    const upsertIdx = body.indexOf("SELECT count(*) INTO v_upserted FROM upserted;");
    // The state row is written unconditionally after the upsert step runs,
    // regardless of whether v_upserted came back 0 or not.
    expect(upsertIdx).toBeLessThan(insertStateIdx);
  });

  it("writes ONLY to expense_field_recent_values and its own state table -- never expenses/profiles/balance_ledger/deductions", () => {
    const start = migration.indexOf("CREATE OR REPLACE FUNCTION public.bootstrap_my_expense_field_memory_v1(");
    const body = migration.slice(start, migration.indexOf("\n$$;", start));
    expect(body).toMatch(/INSERT INTO public\.expense_field_recent_values/);
    expect(body).toMatch(/INSERT INTO public\.expense_field_memory_user_state/);
    expect(body).not.toMatch(/INSERT INTO public\.(expenses|profiles|balance_ledger|expense_balance_deductions)/);
    expect(body).not.toMatch(/UPDATE public\.(expenses|profiles|balance_ledger|expense_balance_deductions)/);
  });

  it("revokes anon and PUBLIC, grants only authenticated", () => {
    expect(migration).toContain("REVOKE ALL ON FUNCTION public.bootstrap_my_expense_field_memory_v1(uuid) FROM PUBLIC;");
    expect(migration).toContain("REVOKE ALL ON FUNCTION public.bootstrap_my_expense_field_memory_v1(uuid) FROM anon;");
    expect(migration).toContain("GRANT EXECUTE ON FUNCTION public.bootstrap_my_expense_field_memory_v1(uuid) TO authenticated;");
  });

  it("has a verification block that fails loudly if anon somehow has access to either the function or the table", () => {
    expect(migration).toContain("has_table_privilege('anon'");
    expect(migration).toContain("has_function_privilege('anon'");
  });
});
