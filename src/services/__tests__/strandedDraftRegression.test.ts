/**
 * DOC-148 stranded-draft regression suite (source-level guards). Behaviour is covered in
 * submitAttemptReuse.test.ts / batchSubmitRetry.test.ts and in the SQL acceptance + concurrency tests.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf-8").replace(/\r\n/g, "\n");
const form = read("src/pages/ExpenseForm.tsx");
const batchForm = read("src/pages/ExpenseBatchForm.tsx");
const service = read("src/services/ExpenseService.ts");
const draftLib = read("src/lib/expenseFormDraft.ts");
const reuseLib = read("src/lib/submitAttemptReuse.ts");
const m1 = read("supabase/migrations/20261025100000_stranded_draft_submit_flow_v1.sql");
const m2 = read("supabase/migrations/20261026100000_server_side_submission_identity_v1.sql");

describe("ExpenseForm legacy submit: identity is the server's", () => {
  const start = form.indexOf("// DOC-148 (1/2) PREFLIGHT");
  const legacy = form.slice(start, form.indexOf("const isResubmission", start));

  it("asks the server's validator BEFORE any row is created", () => {
    expect(start).toBeGreaterThan(-1);
    expect(legacy.indexOf("preflightExpenseSubmission")).toBeLessThan(legacy.indexOf("resolveOrCreateExpense"));
    expect(legacy).toContain("throw new SubmissionPreflightError(pre.issues)");
  });

  it("creates/reuses the row ONLY through the server resolver (no client insert, no remembered row id)", () => {
    expect(legacy).toContain("ExpenseService.resolveOrCreateExpense(");
    expect(legacy).not.toContain("ExpenseService.createExpense(");
    expect(form).not.toContain("inFlightExpenseIdRef");
    expect(legacy).toContain("{ clientSubmissionId: clientSubmissionIdRef.current }");
  });

  it("does not depend on sessionStorage for correctness", () => {
    expect(legacy).not.toMatch(/(session|local)Storage\.(get|set|remove)Item/);
    expect(reuseLib).not.toMatch(/(session|local)Storage\.(get|set|remove)Item/);
  });

  it("the logical id travels with the browser's recoverable form and is restored from it", () => {
    expect(draftLib).toContain("clientSubmissionId?: string;");
    expect(form).toContain("clientSubmissionId: clientSubmissionIdRef.current,");
    expect(form).toContain("if (draft.clientSubmissionId) clientSubmissionIdRef.current = draft.clientSubmissionId;");
    expect(legacy).toContain("flushExpenseDraftNow();");
  });

  it("a NEW logical id is minted after success, on form clear and when a trashed row is reported", () => {
    expect(form).toMatch(/resetExpenseFormState = useCallback\(\(\) => \{\n\s+clientSubmissionIdRef\.current = newClientSubmissionId\(\);/);
    expect(legacy).toContain("clientSubmissionIdRef.current = newClientSubmissionId(); // the next Submit is a NEW logical expense");
    expect(legacy).toContain('decision === "recycled"');
  });

  it("does not submit an already-submitted row again and never reports success while still draft", () => {
    expect(legacy).toContain("shouldRunSubmit(statusBeforeSubmit)");
    expect(legacy).toContain("isSubmittedStatus(");
    expect(legacy).toContain('attempt.how === "already_past_draft"');
  });

  it("continuing a legacy draft assigns it an id, never inferred", () => {
    expect(form).toContain("ExpenseService.claimClientSubmissionId(id, newClientSubmissionId())");
  });

  it("keeps the submit lock (double click) and the MicroLink atomic route", () => {
    expect(form).toContain("if (isSavingRef.current)");
    expect(form).toContain("if (usesAtomicSubmissionV1(effectiveOrganizationId))");
  });
});

describe("ExpenseService batch: server identity, visible link errors", () => {
  it("no inline unchecked batch_id UPDATE and no client-side batch insert remain", () => {
    expect(service).not.toContain(".update({ batch_id: batchId })");
    const i = service.indexOf("static async submitExpenseBatch");
    const body = service.slice(i, i + 12000);
    expect(body).not.toContain('.from("expense_batches")\n      .insert(');
    expect(body).toContain("this.resolveOrCreateBatch(");
    expect(body).toContain("this.resolveOrCreateExpense(");
    expect(body).not.toContain("this.createExpense(");
  });

  it("all lines are preflighted before the batch row is resolved", () => {
    const pre = service.indexOf("preflightExpenseSubmission(organizationId");
    const res = service.indexOf("await this.resolveOrCreateBatch(organizationId");
    expect(pre).toBeGreaterThan(-1);
    expect(pre).toBeLessThan(res);
  });

  it("the batch form carries a stable clientBatchId and offers Retry failed lines", () => {
    expect(batchForm).toContain("const clientBatchIdRef = useRef<string>(crypto.randomUUID());");
    expect(batchForm).toContain("clientBatchId: clientBatchIdRef.current,");
    expect(batchForm).toContain("Retry failed lines");
    expect(batchForm).toMatch(/if \(failed === 0\) \{\n\s+clientBatchIdRef\.current = crypto\.randomUUID\(\);/);
  });
});

describe("migrations", () => {
  it("part 1 whitelists exactly 7 columns and touches no policy", () => {
    expect(m1).toContain("ARRAY['title','destination','trip_start','trip_end','purpose','category','total_amount']");
    expect(m1).not.toMatch(/CREATE POLICY|DROP POLICY|ALTER POLICY/);
  });
  it("part 2 is additive: nullable columns, partial unique indexes, three RPCs, no policy, no backfill, MicroLink untouched", () => {
    expect(m2).toContain("ADD COLUMN IF NOT EXISTS client_submission_id uuid;");
    expect(m2).toContain("ADD COLUMN IF NOT EXISTS client_batch_id      uuid;");
    expect(m2).toContain("CREATE UNIQUE INDEX IF NOT EXISTS expenses_client_submission_uidx");
    expect(m2).toContain("WHERE client_submission_id IS NOT NULL;");
    expect(m2).toContain("ON CONFLICT (organization_id, user_id, client_submission_id) WHERE client_submission_id IS NOT NULL DO NOTHING");
    expect(m2).not.toMatch(/CREATE POLICY|DROP POLICY|ALTER POLICY/);
    expect(m2).not.toMatch(/\bUPDATE public\.expenses SET client_submission_id\b(?![^;]*WHERE id = e\.id)/);
    expect(m2).not.toMatch(/DROP FUNCTION/);
    expect(m2).not.toMatch(/_microlink_|submit_microlink/);
    for (const fn of ["resolve_or_create_expense_v1", "resolve_or_create_expense_batch_v1", "claim_client_submission_id_v1"]) {
      expect(m2).toContain(`REVOKE ALL ON FUNCTION public.${fn}`);
    }
  });
  it("the resolver never accepts status/user/org/approval fields and derives line ids server-side", () => {
    expect(m2).toContain("ARRAY['title','destination','trip_start','trip_end','purpose','category','total_amount']");
    expect(m2).toContain("md5(p_client_batch_id::text || ':' || p_line_index::text)::uuid");
  });
  it("updateExpense uses the narrow draft RPC", () => {
    expect(service).toContain('rpc("update_own_draft_expense_v1"');
  });
});
