/**
 * Structural guards for the "removed attachments reappear after submit" fix.
 *
 * Every screen that keeps its own copy of the uploads MUST listen for
 * FileUpload's removal callback and MUST build the finalize list from the
 * attachments the employee can see. The behavioural proof is in
 * src/components/__tests__/FileUploadAttachmentRemoval.test.tsx; these guards
 * fail if a screen is rewired back to an append-only registry.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf-8");

describe("ExpenseForm", () => {
  const src = read("src/pages/ExpenseForm.tsx");

  it("listens for removals and forgets the file in every session registry", () => {
    expect(src).toContain("onAttachmentRemoved={handleAttachmentRemoved}");
    const handler = src.slice(src.indexOf("const handleAttachmentRemoved"), src.indexOf("const buildFileUploadSeed"));
    expect(handler).toContain("removeAttachmentFromSessionRegistries(");
    expect(handler).toContain("persistedAttachmentUrlsRef.current.delete(url)");
    expect(handler).toContain("formStateRef.current.attachments.filter");
    expect(handler).toContain("setAttachments(next)");
  });

  it("derives the finalize manifest from the visible attachments, never from the registry", () => {
    const body = src.slice(src.indexOf("const moveTempFilesToExpense"), src.indexOf("// Fetch recommended categories"));
    expect(body).toContain("buildFinalizeManifest(");
    expect(body).toContain("visibleUrls: allAttachmentUrls");
    expect(body).toContain("finalizeAndLinkReceipts(");
    // the append-only registry must not be the source of the manifest
    expect(body).not.toMatch(/Array\.from\(sessionTempFilenamesRef\.current\)/);
    expect(body).not.toContain("options?.attachmentUrls");
  });

  it("reconciles the draft's attachment rows in the attach-first flow", () => {
    const flow = src.slice(src.indexOf("attachFiles: async (expenseId)"), src.indexOf("// 3b. THE submit"));
    expect(flow).toContain("reconcileExpenseAttachments(");
    expect(flow).toContain("wantedNames: attached");
  });

  it("lists restored draft attachments in the upload component so they can be removed", () => {
    expect(src).toContain("seedAttachments={buildFileUploadSeed()}");
    const restore = src.slice(src.indexOf("const applyExpenseDraftFromStorage"), src.indexOf("const persistSubmittedSafetyCopy"));
    expect(restore).toContain("setFileUploadResetKey");
  });

  it("updates the canonical list synchronously when an upload completes", () => {
    expect(src).toContain("const nextAttachments = [...formStateRef.current.attachments, attachment.file_url]");
  });

  it("keeps the single-submit guard that prevents a concurrent double submit", () => {
    expect(src).toMatch(/if \(isSavingRef\.current\) \{\s*return;\s*\}/);
  });
});

describe("other screens that upload receipts", () => {
  it("AdminSubmitExpense drops a removed receipt from the pending list", () => {
    const src = read("src/pages/AdminSubmitExpense.tsx");
    expect(src).toContain("onAttachmentRemoved={(attachment) => {");
    expect(src).toContain("setPendingReceipts((prev) => prev.filter((r) => r.filename !== removedName))");
  });

  it("ExpenseBatchForm unregisters removed bills for lines and for the shared bill", () => {
    const src = read("src/pages/ExpenseBatchForm.tsx");
    expect(src).toContain("const unregisterTempUpload");
    expect(src).toContain("onReceiptRemove={unregisterLineReceipt}");
    expect(src).toContain("onRemove={(path) => unregisterLineReceipt(line.clientId, path)}");
    expect(src).toContain("unregisterTempUpload(path);");
  });

  it("BatchLineReceiptSection and BatchExpenseLinesTable forward removals", () => {
    expect(read("src/components/BatchLineReceiptSection.tsx")).toContain("onAttachmentRemoved={(attachment) => {");
    expect(read("src/components/BatchExpenseLinesTable.tsx")).toContain("onRemove={(path) => onReceiptRemove?.(line.clientId, path)}");
  });
});

describe("readers never show soft-deleted attachments", () => {
  it("ExpenseDetail filters rows with deleted_at set", () => {
    expect(read("src/pages/ExpenseDetail.tsx")).toContain(".filter((att) => !(att as { deleted_at?: string | null }).deleted_at)");
  });

  it.each([
    "src/pages/EngineerReview.tsx",
    "src/pages/AdminPanel.tsx",
    "src/components/BatchExpenseDetailCard.tsx",
    "src/pages/ExpenseForm.tsx",
    "src/components/FileUpload.tsx",
  ])("%s filters soft-deleted attachment rows", (file) => {
    const src = read(file);
    expect(src).toContain("{ deleted_at?: string | null }).deleted_at");
  });
});
