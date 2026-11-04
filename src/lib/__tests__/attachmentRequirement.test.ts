import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { billRequiredMessage, formatThreshold, isBillRequired, isBillRequiredError } from "@/lib/attachmentRequirement";

describe("bill threshold boundary (threshold 499)", () => {
  it.each([
    [499, false], [499.0, false], ["499.00", false], [100, false], [0, false],
    [499.01, true], [500, true], [800, true], [1200, true], ["800", true],
  ])("amount %s -> bill required: %s", (amount, expected) => {
    expect(isBillRequired(amount as number, 499)).toBe(expected);
  });
  it("no configured threshold means no requirement; garbage never requires", () => {
    expect(isBillRequired(100000, null)).toBe(false);
    expect(isBillRequired(100000, undefined)).toBe(false);
    expect(isBillRequired(Number.NaN, 499)).toBe(false);
  });
  it("is exact in paise (no float drift)", () => {
    expect(isBillRequired(0.1 + 0.2, 0.3)).toBe(false);
    expect(isBillRequired(499.004, 499)).toBe(false);
  });
});

describe("message", () => {
  it("uses the configured threshold, exactly like the database message", () => {
    expect(billRequiredMessage(499)).toBe("Bill photos are required for expenses above ₹499. Please upload at least one receipt or bill before submitting.");
    expect(formatThreshold("499.00")).toBe("499");
    expect(formatThreshold(499.5)).toBe("499.5");
    expect(formatThreshold(50)).toBe("50");
  });
  it("recognises the refusal from any layer", () => {
    expect(isBillRequiredError(new Error(billRequiredMessage(499)))).toBe(true);
    expect(isBillRequiredError({ message: "x", hint: "attachment_required" })).toBe(true);
    expect(isBillRequiredError(new Error("something else"))).toBe(false);
  });
  it("the SQL message and the client message are the same sentence", () => {
    const sql = readFileSync(resolve(process.cwd(), "supabase/migrations/20261028100000_attachment_requirement_on_submit_v1.sql"), "utf-8");
    expect(sql).toContain("Bill photos are required for expenses above ₹%. Please upload at least one receipt or bill before submitting.");
  });
});

describe("source guards (DOC-150)", () => {
  const form = readFileSync(resolve(process.cwd(), "src/pages/ExpenseForm.tsx"), "utf-8").replace(/\r\n/g, "\n");
  const sql = readFileSync(resolve(process.cwd(), "supabase/migrations/20261028100000_attachment_requirement_on_submit_v1.sql"), "utf-8");

  it("the form's 'does a bill exist' query ignores soft-deleted attachments (the 2026-10-02 incident)", () => {
    const i = form.indexOf('.from("attachments")\n              .select("id")\n              .eq("expense_id", id)');
    expect(i).toBeGreaterThan(-1);
    expect(form.slice(i, i + 220)).toContain('.is("deleted_at", null)');
  });
  it("an existing draft/rejected expense gets its new bill photos linked BEFORE the submit", () => {
    const link = form.indexOf("3a'. Existing draft/rejected expense");
    const submit = form.indexOf("// 3b. THE submit. One request.");
    expect(link).toBeGreaterThan(-1);
    expect(link).toBeLessThan(submit);
    expect(form).toContain("const linkBillsBeforeSubmit =");
  });
  it("uses the shared threshold helper", () => {
    expect(form).toContain("isBillRequired(expenseAmount, currentAttachmentLimit)");
    expect(form).not.toContain("expenseAmount > currentAttachmentLimit");
  });
  it("the database rule is a DEFERRED constraint trigger on INSERT and on the status transition only", () => {
    expect(sql).toContain("CREATE CONSTRAINT TRIGGER validate_attachment_on_submit_insert");
    expect(sql).toContain("CREATE CONSTRAINT TRIGGER validate_attachment_on_submit_update");
    expect(sql).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(sql).toContain("WHEN (NEW.status = 'submitted' AND OLD.status IS DISTINCT FROM NEW.status)");
    expect(sql).toContain("a.deleted_at IS NULL");
    expect(sql).toContain("a.expense_id = p_expense_id");
  });
  it("it does not touch approval routing, MicroLink RPCs, or any existing row", () => {
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.(submit_microlink|_persist_microlink|save_microlink|update_microlink)/);
    expect(sql).not.toMatch(/\bUPDATE public\.expenses\b|\bDELETE FROM\b|\bINSERT INTO public\.attachments\b/);
  });
});
