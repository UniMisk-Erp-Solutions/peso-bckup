import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const reportErrorMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/monitoring", () => ({ reportError: reportErrorMock }));

import { reportMicroLinkSubmitFailure, summarizeAttachmentTypes } from "@/lib/microlinkSubmitMonitoring";

beforeEach(() => reportErrorMock.mockReset());

describe("summarizeAttachmentTypes", () => {
  it("collapses content types to coarse, sorted, distinct kinds", () => {
    expect(summarizeAttachmentTypes(["application/pdf", "image/jpeg", "image/jpg", "image/png", "application/pdf"])).toBe(
      "jpeg,pdf,png",
    );
  });
  it("is 'none' when there are no attachments and ignores empty values", () => {
    expect(summarizeAttachmentTypes([])).toBe("none");
    expect(summarizeAttachmentTypes([null, undefined, ""])).toBe("none");
  });
  it("never echoes unknown types verbatim", () => {
    expect(summarizeAttachmentTypes(["application/x-secret-thing"])).toBe("other");
  });
});

describe("reportMicroLinkSubmitFailure", () => {
  it("tags the stage, org slug, attachment shape and error code -- and nothing identifying", () => {
    reportMicroLinkSubmitFailure("submit_not_submitted", new Error("replayed draft receipt"), {
      attachmentCount: 2,
      attachmentTypes: "pdf",
      errorCode: "PW409",
    });
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    const [err, ctx] = reportErrorMock.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect(ctx).toMatchObject({
      area: "expenses",
      operation: "microlink-submit-submit-not-submitted",
      errorCode: "PW409",
      severity: "error",
      tags: {
        flow: "microlink_atomic_submit",
        stage: "submit_not_submitted",
        org: "microlink",
        attachment_count: 2,
        attachment_types: "pdf",
      },
    });
    // no free-form extra payload: ids, amounts, filenames and URLs cannot ride along
    expect(ctx.extra).toBeUndefined();
    expect(JSON.stringify(ctx)).not.toMatch(/https?:|expense_id|user_id|amount|filename/i);
  });

  it("defaults to no attachments and error severity; stages map to stable operation names", () => {
    reportMicroLinkSubmitFailure("attach_receipts", new Error("x"));
    expect(reportErrorMock.mock.calls[0][1]).toMatchObject({
      operation: "microlink-submit-attach-receipts",
      severity: "error",
      tags: { attachment_count: 0, attachment_types: "none" },
    });
  });
});

describe("semantic mismatch (requested submit, got draft)", () => {
  it("carries only enumerated action/status tags and no free-form payload", () => {
    reportMicroLinkSubmitFailure("submit_not_submitted", new Error("x"), {
      requestedAction: "submit",
      receiptAction: "save_draft",
      actualStatus: "draft",
    });
    const ctx = reportErrorMock.mock.calls[0][1];
    expect(ctx.tags).toMatchObject({
      requested_action: "submit",
      receipt_action: "save_draft",
      actual_status: "draft",
    });
    expect(ctx.extra).toBeUndefined();
  });

  it("omits the semantic tags when none are supplied", () => {
    reportMicroLinkSubmitFailure("submit", new Error("x"));
    expect(reportErrorMock.mock.calls[0][1].tags).not.toHaveProperty("requested_action");
  });
});

describe("guard: the form reports every way the attach-first flow can leave a draft", () => {
  it("ExpenseForm calls the reporter for each failure stage", () => {
    // the draft/attach stages live in the extracted attach-first module
    const src =
      readFileSync(join(process.cwd(), "src/pages/ExpenseForm.tsx"), "utf8") +
      readFileSync(join(process.cwd(), "src/services/microlinkAttachFirstFlow.ts"), "utf8");
    for (const stage of ["draft_save", "attach_receipts", "submit", "submit_unconfirmed", "submit_not_submitted"]) {
      expect(src).toContain(`"${stage}"`);
    }
    expect(src).toMatch(/reportMicroLinkSubmitFailure\(/);
  });
});
