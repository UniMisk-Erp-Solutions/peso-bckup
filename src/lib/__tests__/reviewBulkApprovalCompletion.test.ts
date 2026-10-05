import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "src/pages/EngineerReview.tsx"), "utf8");

describe("EngineerReview bulk approval completion lifecycle", () => {
  it("treats the approval warning as one-shot instead of retaining a replayable dialog", () => {
    const runner = source.slice(
      source.indexOf("const runBulkApproval = async"),
      source.indexOf("const classifySelection ="),
    );
    expect(runner).toMatch(
      /if \(options\?\.closeDialog !== false\) \{[\s\S]*?setApprovalWarning\(null\);[\s\S]*?setBulkActionLoading\(true\)/,
    );
    expect(source).not.toContain("closeDialog: false");
  });

  it("evicts terminal rows, clears settled batch selections, and awaits the fresh page/count", () => {
    expect(source).toContain("retainUnsettledSelectionKeys(");
    expect(source).toContain("evictSettledReviewRows(settledExpenseIds)");
    expect(source).toMatch(
      /try \{\s*await refreshCurrentReviewQuery\(\);\s*\} finally \{\s*setBulkActionLoading\(false\);/,
    );
  });

  it("reports a replayed already-approved row as completed rather than failed", () => {
    expect(source).toContain("if (isAlreadyApprovedError(error))");
    expect(source).toContain("`${alreadyCompleted} already completed`");
  });

  it("relocates a filtered queue when approval removes its old last page", () => {
    expect(source).toMatch(
      /if \(page > resolvedTotalPages\) \{[\s\S]*?return fetchServerPageInternal\(resolvedTotalPages, options\);/,
    );
  });
});
