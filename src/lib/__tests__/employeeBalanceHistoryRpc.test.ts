/**
 * DOC-087 — security contract for `get_my_balance_transfer_history`.
 *
 * SCOPE NOTE: no Docker/local Supabase is available in this environment, so
 * these are static contract assertions over the migration SQL — they prove the
 * shipped definition contains (and omits) the right things. They are NOT a live
 * execution of the function against a database. Rows-actually-returned checks
 * belong to the manual test checklist in the DOC-087 doc.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";

const MIGRATIONS = resolve(process.cwd(), "supabase/migrations");
const MIGRATION_FILE = "20260808120000_employee_balance_transfer_history_rpc.sql";

const raw = readFileSync(resolve(MIGRATIONS, MIGRATION_FILE), "utf-8");

/** Migration body with SQL comments stripped, so assertions test code not prose. */
const sql = raw
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

/** Just the function body, between the $$ delimiters. */
const body = sql.slice(sql.indexOf("AS $$"), sql.lastIndexOf("$$;"));

describe("migration hygiene", () => {
  it("uses a valid 14-digit timestamp filename", () => {
    expect(MIGRATION_FILE).toMatch(/^\d{14}_[a-z0-9_]+\.sql$/);
  });

  it("does not collide with another migration version", () => {
    // Deliberately not "is the newest": later migrations are expected, and
    // asserting recency would break this suite every time one is added.
    // Uniqueness is the property that actually matters to the CLI runner.
    const version = MIGRATION_FILE.slice(0, 14);
    const sameVersion = readdirSync(MIGRATIONS).filter(
      (f) => /^\d{14}_/.test(f) && f.slice(0, 14) === version,
    );
    expect(sameVersion).toEqual([MIGRATION_FILE]);
  });

  it("does not mutate any financial data", () => {
    // No backfills, no balance edits, no row rewrites — this migration is
    // function definition + grants only.
    expect(sql).not.toMatch(/\bUPDATE\s+public\./i);
    expect(sql).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(sql).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(sql).not.toMatch(/\bALTER\s+TABLE\b/i);
  });

  it("does not widen cash_transfer_history RLS", () => {
    expect(sql).not.toMatch(/CREATE\s+POLICY/i);
    expect(sql).not.toMatch(/DROP\s+POLICY/i);
    expect(sql).not.toMatch(/ENABLE\s+ROW\s+LEVEL\s+SECURITY/i);
  });
});

describe("function hardening", () => {
  it("is SECURITY DEFINER with a pinned search_path", () => {
    expect(sql).toMatch(/SECURITY DEFINER/);
    expect(sql).toMatch(/SET search_path = public/);
  });

  it("is STABLE, not VOLATILE", () => {
    expect(sql).toMatch(/\bSTABLE\b/);
  });

  it("revokes PUBLIC and anon, granting only authenticated", () => {
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.get_my_balance_transfer_history\(uuid, integer, integer\) FROM PUBLIC;/,
    );
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.get_my_balance_transfer_history\(uuid, integer, integer\) FROM anon;/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.get_my_balance_transfer_history\(uuid, integer, integer\) TO authenticated;/,
    );
    // anon/service_role must not be granted execute.
    expect(sql).not.toMatch(/GRANT EXECUTE[^;]*TO[^;]*\banon\b/);
  });
});

describe("caller identity", () => {
  it("accepts no user-id parameter at all", () => {
    const signature = sql.slice(
      sql.indexOf("get_my_balance_transfer_history("),
      sql.indexOf("RETURNS TABLE"),
    );
    expect(signature).toContain("p_organization_id uuid");
    expect(signature).toContain("p_limit");
    expect(signature).toContain("p_offset");
    // No p_user_id / p_recipient_id / p_employee_id escape hatch.
    expect(signature).not.toMatch(/p_user_id|p_recipient_id|p_employee_id|p_uid/);
  });

  it("derives the caller from auth.uid()", () => {
    expect(body).toMatch(/v_uid\s+uuid\s*:=\s*auth\.uid\(\)/);
  });

  it("rejects an unauthenticated caller", () => {
    expect(body).toMatch(/IF v_uid IS NULL THEN\s*\n\s*RAISE EXCEPTION 'not_authenticated'/);
  });

  it("scopes rows to the caller as recipient", () => {
    expect(body).toMatch(/cth\.recipient_id\s*=\s*v_uid/);
    // recipient_id must never be compared against a parameter.
    expect(body).not.toMatch(/recipient_id\s*=\s*p_/);
  });

  it("scopes rows to the requested organization", () => {
    expect(body).toMatch(/cth\.organization_id\s*=\s*p_organization_id/);
  });
});

describe("authorisation gates", () => {
  it("requires an active membership in that organization", () => {
    expect(body).toContain("FROM   public.organization_memberships om");
    expect(body).toMatch(/om\.organization_id\s*=\s*p_organization_id/);
    expect(body).toMatch(/om\.user_id\s*=\s*v_uid/);
    expect(body).toMatch(/om\.is_active\s*=\s*true/);
    expect(body).toMatch(/IF v_role IS NULL THEN\s*\n\s*RAISE EXCEPTION 'not_authorized'/);
  });

  it("requires the employee role, rejecting every other role", () => {
    expect(body).toMatch(/IF v_role <> 'employee' THEN\s*\n\s*RAISE EXCEPTION 'not_authorized'/);
  });

  it("casts role to text (app_role enum comparison guard)", () => {
    expect(body).toMatch(/om\.role::text/);
  });

  it("checks the feature flag server-side and fails closed", () => {
    expect(body).toMatch(
      /IF NOT public\.org_feature_enabled\(p_organization_id, 'employee_transfer_history'\) THEN\s*\n\s*RAISE EXCEPTION 'feature_disabled'/,
    );
  });

  it("rejects a null organization id rather than scanning everything", () => {
    expect(body).toMatch(/IF p_organization_id IS NULL THEN\s*\n\s*RAISE EXCEPTION 'not_authorized'/);
  });
});

describe("pagination bounds", () => {
  it("clamps the limit to [1, 100]", () => {
    expect(body).toMatch(/v_limit\s*:=\s*LEAST\(GREATEST\(COALESCE\(p_limit, 25\), 1\), 100\)/);
  });

  it("clamps a negative offset to zero", () => {
    expect(body).toMatch(/v_offset\s*:=\s*GREATEST\(COALESCE\(p_offset, 0\), 0\)/);
  });

  it("applies LIMIT and OFFSET from the clamped values", () => {
    expect(body).toMatch(/LIMIT\s+v_limit/);
    expect(body).toMatch(/OFFSET\s+v_offset/);
    expect(body).not.toMatch(/LIMIT\s+p_limit/);
    expect(body).not.toMatch(/OFFSET\s+p_offset/);
  });

  it("orders newest first with a deterministic tie-breaker", () => {
    expect(body).toMatch(/ORDER BY cth\.transferred_at DESC, cth\.id DESC/);
  });

  it("returns a total_count scoped by the same WHERE clause", () => {
    expect(body).toMatch(/COUNT\(\*\) OVER \(\)\s+AS total_count/);
  });
});

describe("response contract — what employees receive", () => {
  const returns = sql.slice(sql.indexOf("RETURNS TABLE"), sql.indexOf("LANGUAGE plpgsql"));

  it("exposes exactly the agreed employee-safe columns", () => {
    const columns = returns
      .replace(/RETURNS TABLE\s*\(/, "")
      .replace(/\)\s*$/, "")
      .split(",")
      .map((c) => c.trim().split(/\s+/)[0])
      .filter(Boolean);

    expect(columns).toEqual([
      "id",
      "amount",
      "transferred_at",
      "payment_mode",
      "transfer_type",
      "credited_by_name",
      "source_bank_name",
      "total_count",
    ]);
  });

  it.each([
    "recipient_id",
    "transferrer_id",
    "transferrer_role",
    "recipient_role",
    "source_bank_account_id",
    "source_account_number_masked_snapshot",
    "source_account_holder_snapshot",
    "notes",
    "transferred_at_original",
    "transferred_at_edited_at",
    "transferred_at_edited_by",
    "date_edited",
  ])("never selects %s into the result", (column) => {
    expect(returns).not.toContain(column);
  });

  it("never touches auth.users or emails", () => {
    expect(sql).not.toMatch(/auth\.users/);
    expect(sql).not.toMatch(/\bemail\b/i);
    expect(sql).not.toMatch(/employee_id/);
  });

  it("resolves credited_by_name in one join, not per row", () => {
    // A single LEFT JOIN on profiles — no correlated per-row lookup, and no
    // reliance on the browser to fetch names.
    expect(body).toMatch(/LEFT JOIN public\.profiles creditor/);
    expect((body.match(/JOIN public\.profiles/g) ?? []).length).toBe(1);
    expect(body).toMatch(/creditor\.name AS credited_by_name/);
  });

  it("scopes the creditor join to the same organization", () => {
    expect(body).toMatch(/creditor\.organization_id\s*=\s*cth\.organization_id/);
  });
});

describe("client typing", () => {
  it("registers the RPC in the generated Supabase types", () => {
    const types = readFileSync(
      resolve(process.cwd(), "src/integrations/supabase/types.ts"),
      "utf-8",
    );
    expect(types).toContain("get_my_balance_transfer_history");
    // The typed Args must not offer a user id either.
    const block = types.slice(types.indexOf("get_my_balance_transfer_history"));
    const args = block.slice(0, block.indexOf("Returns:"));
    expect(args).not.toMatch(/p_user_id|p_recipient_id/);
  });

  it("does not silence the RPC typing with `as any`", () => {
    const hook = readFileSync(
      resolve(process.cwd(), "src/hooks/useEmployeeBalanceHistory.ts"),
      "utf-8",
    );
    expect(hook).not.toMatch(/as any/);
  });
});
