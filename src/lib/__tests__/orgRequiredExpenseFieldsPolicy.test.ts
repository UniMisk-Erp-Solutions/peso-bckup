/**
 * Organization-level mandatory expense fields.
 *
 * Two things are guarded here:
 *   1. the client can recognise and present the server's policy rejection
 *      (§J/§K) without string-matching an error message;
 *   2. the migration keeps the contract the acceptance matrix was proven
 *      against — no organization name hardcoded in the mechanism, enforcement
 *      only on a transition into `submitted`, no DML against business tables,
 *      and no second trigger competing with DOC-117's.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ORG_REQUIRED_FIELDS_ERROR_CODE,
  formatApiError,
  isOrgRequiredFieldsError,
} from "../formatApiError";

const MIG_DIR = join(process.cwd(), "supabase", "migrations");
const MECHANISM = readFileSync(
  join(MIG_DIR, "20260907120000_organization_required_expense_fields.sql"),
  "utf8",
);
const ENABLEMENT = readFileSync(
  join(MIG_DIR, "20260907121000_enable_project_fields_policy_for_microlink.sql"),
  "utf8",
);

/** The shape supabase-js hands back for a PostgreSQL RAISE with USING. */
const policyError = {
  code: "PW001",
  message: "Required project details are incomplete.",
  details: "Missing: Project ID, Project Name.",
  hint: "Complete the required project details before submitting this expense.",
};

describe("client presentation of the policy rejection", () => {
  it("recognises the policy error by its stable SQLSTATE, not by message text", () => {
    expect(ORG_REQUIRED_FIELDS_ERROR_CODE).toBe("PW001");
    expect(isOrgRequiredFieldsError(policyError)).toBe(true);
  });

  it("does not mistake an ordinary constraint violation for the policy error", () => {
    expect(isOrgRequiredFieldsError({ code: "23514", message: "check violation" })).toBe(false);
    expect(isOrgRequiredFieldsError({ code: "P0001", message: "some raise" })).toBe(false);
    expect(isOrgRequiredFieldsError(new Error("boom"))).toBe(false);
    expect(isOrgRequiredFieldsError(null)).toBe(false);
  });

  it("tells the user WHICH project details are missing, not just that some are", () => {
    const shown = formatApiError(policyError);
    expect(shown).toContain("Required project details are incomplete.");
    expect(shown).toContain("Project ID");
    expect(shown).toContain("Project Name");
  });

  it("still formats every other error exactly as before", () => {
    expect(formatApiError(new Error("network down"))).toBe("network down");
    expect(formatApiError({ message: "plain message" })).toBe("plain message");
    expect(formatApiError({ details: "only details" })).toBe("only details");
    expect(formatApiError({ hint: "only hint" })).toBe("only hint");
    expect(formatApiError("a string")).toBe("a string");
    expect(formatApiError(undefined, "fallback")).toBe("fallback");
  });

  it("degrades gracefully when the policy error carries no details", () => {
    expect(formatApiError({ code: "PW001", message: "Required project details are incomplete." }))
      .toBe("Required project details are incomplete.");
  });
});

describe("migration contract — generic mechanism", () => {
  it("hardcodes no organization name (§A)", () => {
    expect(MECHANISM).not.toMatch(/microlink/i);
  });

  it("creates the organization-scoped policy table (§B)", () => {
    expect(MECHANISM).toMatch(
      /CREATE TABLE IF NOT EXISTS public\.organization_required_expense_fields/i,
    );
    expect(MECHANISM).toMatch(/organization_id\s+uuid NOT NULL/i);
    expect(MECHANISM).toMatch(/template_id\s+uuid NOT NULL/i);
    expect(MECHANISM).toMatch(/required_branch_field_keys text\[\]/i);
    expect(MECHANISM).toMatch(/UNIQUE \(organization_id, template_id\)/i);
  });

  it("raises the stable, user-safe SQLSTATE rather than a bare constraint error (§K)", () => {
    expect(MECHANISM).toMatch(/ERRCODE = 'PW001'/);
    expect(MECHANISM).toMatch(/Required project details are incomplete\./);
    // no SQL, table names or ids leaked into the user-visible message
    expect(MECHANISM).not.toMatch(/USING ERRCODE[\s\S]{0,200}expense_form_field_values/);
  });

  it("treats blank and whitespace-only values as missing (§E)", () => {
    expect(MECHANISM).toMatch(/NULLIF\(btrim\(v\.field_value\), ''\)/);
    expect(MECHANISM).toMatch(/NULLIF\(btrim\(v2\.field_value\), ''\) IS NOT NULL/);
  });

  it("resolves dependent branches from the SELECTED option value, not the payload (§D)", () => {
    expect(MECHANISM).toMatch(/b\.parent_option_value = v_value/);
    expect(MECHANISM).toMatch(/b\.retired_at IS NULL/);
    expect(MECHANISM).toMatch(/b\.required OR b\.field_key = ANY \(r\.required_branch_field_keys\)/);
  });

  it("is a no-op for organizations that have not opted in (§H)", () => {
    expect(MECHANISM).toMatch(
      /IF NOT EXISTS \([\s\S]{0,220}organization_required_expense_fields[\s\S]{0,120}RETURN;/,
    );
  });

  it("routes BOTH enforcement points through one canonical rule (§9)", () => {
    expect(MECHANISM).toMatch(
      /CREATE OR REPLACE FUNCTION public\.validate_expense_submission_invariants_v1/,
    );
    // the status-transition wrapper delegates to it ...
    expect(MECHANISM).toMatch(
      /trg_validate_expense_custom_fields_on_submit[\s\S]{0,400}validate_expense_submission_invariants_v1/,
    );
    // ... and so does the value-mutation guard, so the two cannot drift apart
    expect(MECHANISM).toMatch(
      /trg_protect_required_fields_after_submission[\s\S]{0,1600}validate_expense_submission_invariants_v1/,
    );
    // DOC-117's own constraint triggers on public.expenses are NOT recreated
    expect(MECHANISM).not.toMatch(/CREATE CONSTRAINT TRIGGER[\s\S]{0,160}ON public\.expenses/i);
  });

  it("guards post-submission value mutation with a deferred constraint trigger (§8)", () => {
    expect(MECHANISM).toMatch(
      /CREATE CONSTRAINT TRIGGER protect_required_fields_after_submission[\s\S]{0,200}AFTER INSERT OR UPDATE OR DELETE ON public\.expense_form_field_values[\s\S]{0,120}DEFERRABLE INITIALLY DEFERRED/,
    );
  });

  it("resolves the owning expense from OLD on DELETE and both sides on a move (§10)", () => {
    expect(MECHANISM).toMatch(/IF TG_OP = 'DELETE' THEN[\s\S]{0,120}OLD\.expense_id/);
    expect(MECHANISM).toMatch(/OLD\.expense_id IS DISTINCT FROM NEW\.expense_id/);
  });

  it("protects the review/approval statuses and leaves the editing states alone (§7)", () => {
    expect(MECHANISM).toMatch(/CREATE OR REPLACE FUNCTION public\._expense_status_is_protected_v1/);
    for (const s of ["submitted", "under_review", "verified", "level_1_verified",
                     "level_2_verified", "approved", "paid"]) {
      expect(MECHANISM).toMatch(new RegExp(`'${s}'`));
    }
    // draft / rejected / edited must NOT appear in the protected list
    const list = MECHANISM.slice(
      MECHANISM.indexOf("_expense_status_is_protected_v1"),
      MECHANISM.indexOf("_expense_status_is_protected_v1") + 700,
    );
    expect(list).not.toMatch(/'draft'/);
    expect(list).not.toMatch(/'rejected'/);
    expect(list).not.toMatch(/'edited'/);
  });

  it("fails CLOSED when the mandatory branch configuration is missing or ambiguous (§16/§17)", () => {
    expect(MECHANISM).toMatch(/ERRCODE = 'PW002'/);
    expect(MECHANISM).toMatch(/Required project configuration is incomplete/);
    expect(MECHANISM).toMatch(/IF v_defs <> 1 THEN/);
  });

  it("keeps a policy alive when its template is deleted (§20)", () => {
    expect(MECHANISM).toMatch(
      /template_id[\s\S]{0,200}REFERENCES public\.expense_form_field_templates\(id\) ON DELETE RESTRICT/,
    );
  });

  it("picks a genuinely non-blank parent value even with duplicate rows (§21)", () => {
    expect(MECHANISM).toMatch(
      /WHERE v\.expense_id = p_expense_id[\s\S]{0,200}NULLIF\(btrim\(v\.field_value\), ''\) IS NOT NULL/,
    );
  });

  it("only ever runs on a transition into submitted (§F/§G)", () => {
    expect(MECHANISM).toMatch(/IF NEW\.status = 'submitted' THEN/);
  });

  it("performs no DML against business tables and no destructive DDL (§G)", () => {
    const businessTables = /(INSERT INTO|UPDATE|DELETE FROM)\s+public\.(expenses|expense_form_field_values|profiles|balance_ledger)/i;
    expect(MECHANISM).not.toMatch(businessTables);
    expect(MECHANISM).not.toMatch(/DROP TABLE|TRUNCATE|DROP COLUMN|ALTER TABLE public\.expenses/i);
  });

  it("does not expose the policy table or validator to the browser (§23)", () => {
    expect(MECHANISM).toMatch(/REVOKE ALL ON TABLE public\.organization_required_expense_fields FROM anon/);
    expect(MECHANISM).toMatch(/REVOKE ALL ON TABLE public\.organization_required_expense_fields FROM authenticated/);
    expect(MECHANISM).toMatch(
      /REVOKE ALL ON FUNCTION public\.validate_expense_org_required_fields_v1\(uuid\) FROM authenticated/,
    );
    expect(MECHANISM).toMatch(/SET search_path TO 'public'/);
  });
});

describe("migration contract — single-organization enablement", () => {
  it("addresses the organization by stable UUID, never by a mutable name (§A)", () => {
    expect(ENABLEMENT).toMatch(/'6709c1fe-e8c8-404d-bc68-d1edda923344'/);
    expect(ENABLEMENT).not.toMatch(/name\s*(=|ILIKE)\s*'microlink'/i);
  });

  it("addresses dependent fields by stable field_key, not display label (§C)", () => {
    expect(ENABLEMENT).toMatch(/ARRAY\['project_id', 'project_name'\]/);
  });

  it("refuses to install against a database missing the organization or template", () => {
    expect(ENABLEMENT).toMatch(/Refusing to enable: organization % does not exist/);
    expect(ENABLEMENT).toMatch(/Refusing to enable: template % does not belong/);
    expect(ENABLEMENT).toMatch(/Refusing to enable: dependent branch field_keys are not configured/);
  });

  it("enables exactly one organization and touches no business data (§H)", () => {
    const inserts = ENABLEMENT.match(/INSERT INTO/gi) ?? [];
    expect(inserts).toHaveLength(1);
    expect(ENABLEMENT).toMatch(/INSERT INTO public\.organization_required_expense_fields/);
    expect(ENABLEMENT).not.toMatch(/public\.(expenses|expense_form_field_values|profiles)/);
  });

  it("is re-runnable without duplicating the policy row", () => {
    expect(ENABLEMENT).toMatch(/ON CONFLICT \(organization_id, template_id\) DO UPDATE/);
  });
});
