import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const form = readFileSync("src/pages/ExpenseForm.tsx", "utf-8");
const upload = readFileSync("src/components/FileUpload.tsx", "utf-8");
const msgs = readFileSync("src/lib/submitFailureMessages.ts", "utf-8");

describe("PWA submit wiring (source contract)", () => {
  it("Submit goes through the one-shot unknown-outcome reconcile wrapper", () => {
    expect(form).toMatch(/submitWithReconcile\(\{/);
    expect(form).toMatch(/const saveExpenseOnce = async/);
    expect(form).toMatch(/isUnknownOutcomeError\(error\) && !autoReconcileUsedRef\.current/);
  });

  it("taps are ignored while a recovery check is in flight (no double work)", () => {
    expect(form).toMatch(/if \(reconcilingRef\.current \|\| isSavingRef\.current\) return;/);
  });

  it("the recovery waits for the app to be foregrounded", () => {
    expect(form).toMatch(/await waitUntilPageVisible\(15000\)/);
  });

  it("the submit path has no client-side AbortController or hard timeout that could cut a request short", () => {
    const submitBody = form.slice(form.indexOf("const saveExpenseOnce"), form.indexOf("const saveExpense = async"));
    expect(submitBody).not.toMatch(/AbortController|Promise\.race|signal:/);
  });

  it("the old broad 'timeout|timed out' => connection dropped mapping is gone", () => {
    expect(msgs).not.toMatch(/timeout\|timed out/);
  });

  it("upload shows a slow state and records content-free timings", () => {
    expect(upload).toMatch(/Upload is taking longer than expected/);
    expect(upload).toMatch(/recordSubmitMetric\("upload_start"/);
    expect(upload).toMatch(/recordSubmitMetric\("upload_done"/);
    expect(upload).toMatch(/clearTimeout\(slowTimer\)/);
  });

  it("the misleading 'compressed' upload label is gone", () => {
    expect(readFileSync("src/locales/en/common.json", "utf-8")).not.toMatch(/Uploading compressed file/);
  });
});

describe("large phone photos are optimized before upload, never rejected", () => {
  it("there is NO arbitrary client-side rejection of an original over 10 MB", () => {
    expect(upload).not.toMatch(/MAX_FILE_SIZE/);
    expect(upload).not.toMatch(/must be 10 MB or smaller/);
    expect(upload).not.toMatch(/file\.size > 10 \* 1024 \* 1024/);
  });

  it("the optimizer runs BEFORE the storage upload, once, and the optimized File is what is uploaded", () => {
    const optimize = upload.indexOf("optimizeReceiptImage(file)");
    const send = upload.indexOf(".upload(uploadPath, uploadSource");
    expect(optimize).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(optimize);
    expect(upload).toMatch(/const uploadSource = prep\.file;/);
  });

  it("a retry re-uses the optimized file and never compresses it a second time", () => {
    expect(upload).toMatch(/failedRetryFile = uploadSource;/);
    expect(upload).toMatch(/alreadyPreparedResult\(failedUpload\.file\)/);
  });

  it("the optimized file (not the original) is what is registered, cached and sized for Submit", () => {
    expect(upload).toMatch(/const fileToUpload = uploadSource;/);
    expect(upload).toMatch(/filename: uploadSource\.name/);
  });

  it("an image that still cannot fit storage gets a precise reason, via uploadBlockedMessage", () => {
    expect(upload).toMatch(/const blocked = uploadBlockedMessage\(prep\);/);
  });

  it("stage labels are shown: preparing / compressing / uploading", () => {
    expect(upload).toMatch(/Compressing photo…/);
    expect(upload).toMatch(/Preparing photo…/);
    expect(upload).toMatch(/uploadFile\.uploading/);
  });

  it("files are processed one at a time (bounded concurrency) while the previous one uploads", () => {
    expect(upload).toMatch(/startPrepare|prepared\.get|preparing\.get/);
  });
});

describe("fewer sequential round trips on the normal path (safe eliminations only)", () => {
  it("a row this press just created is known to be a draft: no pre-submit status read", () => {
    expect(form).toMatch(/if \(attempt\.how === "created"\) \{\s*statusBeforeSubmit = "draft";/);
  });

  it("a reused row is still re-read before submitting (an earlier attempt may have submitted it)", () => {
    expect(form).toMatch(/else \{\s*const \{ data: beforeSubmit \} = await supabase/);
  });

  it("the post-submit status comes from the row submitExpense returned; the extra read is only a fallback", () => {
    expect(form).toMatch(/const submittedRow = await ExpenseService\.submitExpense\(newExpense\.id, user\.id, \{/);
    expect(form).toMatch(/if \(!isSubmittedStatus\(statusAfterSubmit\)\) \{\s*const \{ data: afterSubmit \}/);
  });

  it("success is still never reported unless the row is past draft", () => {
    expect(form).toMatch(/if \(!isSubmittedStatus\(statusAfterSubmit\)\) \{\s*throw new Error\("The expense is still a draft after submitting/);
  });
});

describe("Submit overlaps independent reads with the first steps of the same press", () => {
  it("the submitter context starts loading BEFORE preflight, and Submit receives it", () => {
    const load = form.indexOf("ExpenseService.loadSubmitContext(organizationId, user.id)");
    const preflight = form.indexOf("await ExpenseService.preflightExpenseSubmission(");
    expect(load).toBeGreaterThan(-1);
    expect(load).toBeLessThan(preflight);
    expect(form).toMatch(/submitExpense\(newExpense\.id, user\.id, \{\s*context: await submitContextPromise,/);
  });

  it("a failed early load falls back to the normal path (never blocks Submit)", () => {
    expect(form).toMatch(/loadSubmitContext\(organizationId, user\.id\)\.catch\(\(\) => null\)/);
  });

  it("total size and live-bill count come from ONE attachments read", () => {
    expect(form).toMatch(/const liveCount = await enforceMaxAttachmentSize\(newExpense\.id\);/);
    expect(form).not.toMatch(/await expenseHasPersistedAttachments\(\s*newExpense\.id,\s*organizationId,\s*\);\s*if \(!hasPersisted\)/);
  });
});
