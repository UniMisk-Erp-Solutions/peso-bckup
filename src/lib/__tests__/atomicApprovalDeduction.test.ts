/**
 * DOC-089 — atomic expense approval + balance deduction.
 *
 * SCOPE NOTE — read before trusting these results.
 * No Docker or reachable Supabase exists in this environment, so the SQL
 * assertions below are STATIC contract checks over the migration text. They
 * prove the shipped function contains (and omits) the right things. They are
 * NOT a live execution, and in particular the CONCURRENCY guarantee in §39 of
 * the brief is NOT proven at runtime here — row locking can only be observed
 * against a real database. That proof must happen during the Cursor rollout
 * (deployment PHASE 5). Nothing in this file should be read as evidence that
 * two simultaneous approvals were actually executed.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";

const MIGRATIONS = resolve(process.cwd(), "supabase/migrations");
const MIGRATION_FILE = "20260808140000_atomic_expense_approval_balance_deduction.sql";
const V1_FILE = "20260702120000_expense_review_admin_approve_rpc.sql";

const raw = readFileSync(resolve(MIGRATIONS, MIGRATION_FILE), "utf-8");
const sql = raw
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

/** Just the V2 function body. */
const v2Body = sql.slice(
  sql.indexOf("CREATE OR REPLACE FUNCTION public.review_approve_expense_v2"),
  sql.indexOf("REVOKE ALL ON FUNCTION public.review_approve_expense_v2"),
);

describe("migration hygiene", () => {
  it("uses a valid, non-colliding 14-digit version", () => {
    expect(MIGRATION_FILE).toMatch(/^\d{14}_[a-z0-9_]+\.sql$/);
    const version = MIGRATION_FILE.slice(0, 14);
    const same = readdirSync(MIGRATIONS).filter(
      (f) => /^\d{14}_/.test(f) && f.slice(0, 14) === version,
    );
    expect(same).toEqual([MIGRATION_FILE]);
  });

  it("is additive: no historical balance or expense is mutated", () => {
    // The only UPDATE permitted is the profiles balance write inside V2.
    const updates = sql.match(/UPDATE\s+public\.\w+/gi) ?? [];
    expect(updates).toEqual(["UPDATE public.profiles"]);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(sql).not.toMatch(/\bDROP\s+FUNCTION\b/i);
    expect(sql).not.toMatch(/\bALTER\s+TABLE\s+public\.(profiles|expenses)\b/i);
  });

  it("performs no historical repair", () => {
    // 'historical_repair' may appear only as an allowed CHECK value / comment,
    // never as an INSERT that writes one.
    expect(sql).not.toMatch(/INSERT[\s\S]{0,400}'historical_repair'/i);
  });

  it("does not touch transfer history or balance transfers", () => {
    expect(sql).not.toMatch(/cash_transfer_history/i);
    expect(sql).not.toMatch(/balance_transfer/i);
  });
});

describe("V1 is left untouched (rollout compatibility)", () => {
  it("does not redefine or drop review_approve_expense", () => {
    expect(sql).not.toMatch(/CREATE\s+(OR REPLACE\s+)?FUNCTION\s+public\.review_approve_expense\s*\(/);
    expect(sql).not.toMatch(/DROP\s+FUNCTION[^;]*review_approve_expense\s*\(/);
  });

  it("still contains no balance logic in the V1 migration", () => {
    // Guards against someone "fixing" V1 later, which would double-deduct for
    // any stale client still running the browser-side write.
    const v1 = readFileSync(resolve(MIGRATIONS, V1_FILE), "utf-8");
    const v1Fn = v1.slice(
      v1.indexOf("CREATE OR REPLACE FUNCTION public.review_approve_expense("),
      v1.indexOf("REVOKE ALL ON FUNCTION public.review_admin_verify_expense"),
    );
    expect(v1Fn).not.toMatch(/UPDATE\s+public\.profiles/i);
    expect(v1Fn).not.toMatch(/\bbalance\b/i);
  });
});

describe("V2 signature and hardening", () => {
  it("is SECURITY DEFINER, VOLATILE, with a pinned search_path", () => {
    expect(v2Body).toMatch(/SECURITY DEFINER/);
    expect(v2Body).toMatch(/\bVOLATILE\b/);
    expect(v2Body).toMatch(/SET search_path = public/);
  });

  it("accepts only the expense id and a comment", () => {
    const sig = v2Body.slice(0, v2Body.indexOf("RETURNS jsonb"));
    expect(sig).toContain("p_expense_id uuid");
    expect(sig).toContain("p_comment    text DEFAULT NULL");
    // No approver, employee, org, amount, balance or role may be caller-supplied.
    expect(sig).not.toMatch(/p_user_id|p_approver|p_employee|p_organization|p_amount|p_balance|p_role/);
  });

  it("derives the caller from auth.uid()", () => {
    expect(v2Body).toMatch(/v_uid\s+uuid\s*:=\s*auth\.uid\(\)/);
    expect(v2Body).toMatch(/IF v_uid IS NULL THEN\s*\n\s*RAISE EXCEPTION 'Not authenticated'/);
  });

  it("revokes PUBLIC and anon, granting only authenticated", () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.review_approve_expense_v2\(uuid, text\) FROM PUBLIC;/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.review_approve_expense_v2\(uuid, text\) FROM anon;/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.review_approve_expense_v2\(uuid, text\) TO authenticated;/);
  });
});

describe("authorization is delegated, not reimplemented", () => {
  it("calls V1 inside the same transaction", () => {
    expect(v2Body).toMatch(/v_v1\s*:=\s*public\.review_approve_expense\(p_expense_id, p_comment\)/);
  });

  it("does not duplicate V1's authorization rules", () => {
    // If these reappeared in V2 the two copies could drift apart.
    expect(v2Body).not.toMatch(/expense_manager_can_review/);
    expect(v2Body).not.toMatch(/engineer_approval_limit/);
    expect(v2Body).not.toMatch(/level_2_verified/);
  });

  it("aborts when V1 does not report success", () => {
    expect(v2Body).toMatch(/RAISE EXCEPTION 'Approval failed'/);
  });

  it("re-reads the expense after V1 rather than trusting pre-approval state", () => {
    expect(v2Body).toMatch(/SELECT \* INTO e FROM public\.expenses WHERE id = p_expense_id;/);
    expect(v2Body).toMatch(/IF e\.status <> 'approved' THEN/);
  });
});

describe("locking", () => {
  it("locks the expense row", () => {
    expect(v2Body).toMatch(
      /SELECT \* INTO e\s*\n\s*FROM public\.expenses\s*\n\s*WHERE id = p_expense_id\s*\n\s*FOR UPDATE;/,
    );
  });

  it("locks exactly the one employee profile, not the organization", () => {
    expect(v2Body).toMatch(
      /SELECT COALESCE\(p\.balance, 0\) INTO v_balance_before[\s\S]*?WHERE p\.organization_id = v_org_id\s*\n\s*AND p\.user_id = v_employee_id\s*\n\s*FOR UPDATE;/,
    );
  });

  it("rejects an already-approved expense before locking the profile", () => {
    const dupIdx = v2Body.indexOf("already approved");
    // Anchor on the assignment, not the DECLARE line for the same variable.
    const profileLockIdx = v2Body.indexOf(
      "FOR UPDATE;",
      v2Body.indexOf("INTO v_balance_before"),
    );
    expect(dupIdx).toBeGreaterThan(-1);
    expect(profileLockIdx).toBeGreaterThan(-1);
    expect(dupIdx).toBeLessThan(profileLockIdx);
  });
});

describe("strict profile resolution (§16)", () => {
  it("scopes by organization AND user", () => {
    expect(v2Body).toMatch(/WHERE p\.organization_id = v_org_id\s*\n\s*AND p\.user_id = v_employee_id/);
  });

  it("never uses LIMIT 1 to pick a profile", () => {
    expect(v2Body).not.toMatch(/LIMIT 1/i);
  });

  it("fails closed on zero matching profiles", () => {
    expect(v2Body).toMatch(/IF v_profile_count = 0 THEN[\s\S]{0,200}RAISE EXCEPTION/);
  });

  it("fails closed on more than one matching profile", () => {
    expect(v2Body).toMatch(/ELSIF v_profile_count > 1 THEN[\s\S]{0,200}RAISE EXCEPTION/);
  });

  it("refuses to deduct when the expense has no organization", () => {
    expect(v2Body).toMatch(/IF v_org_id IS NULL THEN[\s\S]{0,160}RAISE EXCEPTION/);
  });
});

describe("atomic balance arithmetic (§18)", () => {
  it("subtracts in SQL against the locked row", () => {
    expect(v2Body).toMatch(/SET balance\s*=\s*COALESCE\(balance, 0\) - v_amount/);
  });

  it("scopes the balance UPDATE by organization AND user", () => {
    expect(v2Body).toMatch(
      /UPDATE public\.profiles[\s\S]*?WHERE organization_id = v_org_id\s*\n\s*AND user_id = v_employee_id/,
    );
  });

  it("reads the committed balance back via RETURNING", () => {
    expect(v2Body).toMatch(/RETURNING balance INTO v_balance_after/);
  });

  it("treats a zero-row balance UPDATE as fatal", () => {
    // The precise failure that caused the incident: a silent no-op write.
    expect(v2Body).toMatch(/IF v_balance_after IS NULL THEN[\s\S]{0,220}RAISE EXCEPTION/);
  });

  it("permits negative balances", () => {
    // No guard rejecting a negative result, and the audit branches on it.
    expect(v2Body).not.toMatch(/IF v_balance_after < 0 THEN\s*\n\s*RAISE EXCEPTION/);
    expect(v2Body).toMatch(/CASE WHEN v_balance_after < 0/);
  });
});

describe("structured deduction evidence (§19-§20)", () => {
  it("creates the table with the agreed columns", () => {
    for (const col of [
      "organization_id",
      "expense_id",
      "employee_user_id",
      "approved_by",
      "expense_amount",
      "balance_before",
      "balance_after",
      "source",
      "created_at",
    ]) {
      expect(sql).toContain(col);
    }
  });

  it("enforces UNIQUE(expense_id) so an expense cannot be debited twice", () => {
    expect(sql).toMatch(/UNIQUE \(expense_id\)/);
  });

  it("constrains source to approval or historical_repair", () => {
    expect(sql).toMatch(/CHECK \(source IN \('approval', 'historical_repair'\)\)/);
  });

  it("writes the record with server-derived values only", () => {
    expect(v2Body).toMatch(/INSERT INTO public\.expense_balance_deductions/);
    expect(v2Body).toMatch(/v_amount, v_balance_before, v_balance_after, 'approval'/);
  });

  it("is RLS-protected and not client-writable", () => {
    expect(sql).toMatch(/ALTER TABLE public\.expense_balance_deductions ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/GRANT SELECT ON TABLE public\.expense_balance_deductions TO authenticated;/);
    expect(sql).not.toMatch(/GRANT[^;]*\b(INSERT|UPDATE|DELETE)\b[^;]*expense_balance_deductions/i);
    expect(sql).not.toMatch(/GRANT[^;]*ALL[^;]*expense_balance_deductions/i);
  });
});

describe("server-side truthful audit (§21-§22)", () => {
  it("writes expense_approved with organization_id", () => {
    expect(v2Body).toMatch(
      /INSERT INTO public\.audit_logs \(organization_id, expense_id, user_id, action, comment\)[\s\S]*?'expense_approved'/,
    );
  });

  it("builds the financial text from server values, not client input", () => {
    expect(v2Body).toMatch(/'Balance deducted: ' \|\| to_char\(v_amount/);
    expect(v2Body).toMatch(/'\. Balance before: ' \|\| to_char\(v_balance_before/);
    expect(v2Body).toMatch(/to_char\(v_balance_after/);
  });

  it("preserves the admin auto-verification audit", () => {
    expect(v2Body).toMatch(/'expense_verified'/);
    expect(v2Body).toMatch(/'Auto-verified by admin during approval'/);
  });

  it("computes auto-verify from the PRE-approval status", () => {
    expect(v2Body).toMatch(/v_prev_status IN \('submitted', 'edited'\)/);
  });

  it("writes the audit only after the balance is confirmed", () => {
    const balanceIdx = v2Body.indexOf("RETURNING balance INTO v_balance_after");
    const auditIdx = v2Body.indexOf("'expense_approved'");
    expect(balanceIdx).toBeGreaterThan(-1);
    expect(auditIdx).toBeGreaterThan(balanceIdx);
  });
});

describe("response contract (§23)", () => {
  it("returns before/deducted/after and the deduction record", () => {
    expect(v2Body).toMatch(/'before',\s*v_balance_before/);
    expect(v2Body).toMatch(/'deducted',\s*v_amount/);
    expect(v2Body).toMatch(/'after',\s*v_balance_after/);
    expect(v2Body).toMatch(/'record_id',\s*v_deduction_id/);
  });

  it("leaks no employee identity or credentials", () => {
    expect(v2Body).not.toMatch(/\bemail\b/i);
    expect(v2Body).not.toMatch(/to_jsonb\(p\)/);
    expect(v2Body).not.toMatch(/bank/i);
  });
});

describe("no engineer profile RLS was introduced (§36)", () => {
  it("this migration adds no policy on profiles", () => {
    expect(sql).not.toMatch(/CREATE POLICY[^;]*ON public\.profiles/i);
    expect(sql).not.toMatch(/ALTER TABLE public\.profiles/i);
  });

  it("no migration in the repo lets an ENGINEER act on another user's profile", () => {
    // The fix must be the SECURITY DEFINER RPC, never widened client RLS.
    //
    // Actor vs target matters here. The legitimate "Cashiers can update managed
    // profiles" policy mentions 'engineer' as the TARGET being managed
    // (`target_om.role = 'engineer'`) while the ACTOR is `om.role = 'cashier'`.
    // Only an actor-side engineer role would reintroduce the incident, so the
    // target-side clauses are stripped before checking.
    const offenders: string[] = [];
    for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql"))) {
      const body = readFileSync(resolve(MIGRATIONS, f), "utf-8");
      const policies = body.match(
        /CREATE POLICY[\s\S]*?ON public\.profiles FOR UPDATE[\s\S]*?(?=CREATE POLICY|CREATE TABLE|ALTER TABLE|COMMENT ON|GRANT |$)/gi,
      );
      if (!policies) continue;
      for (const p of policies) {
        const actorOnly = p.replace(/target_om\.role\s*=\s*'engineer'/gi, "");
        if (/\bom\.role\s*=\s*'engineer'/i.test(actorOnly)) {
          offenders.push(`${f}: ${p.slice(0, 90)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
