import { describe, it, expect } from "vitest";
import {
  validateBatchLines,
  validateBatchSharedContext,
  validateBatchAttachments,
  lineRequiresReceipt,
  batchLineTotal,
  type BatchLineInput,
} from "@/lib/expenseBatchValidation";
import { DEFAULT_BASE_FIELD_CONFIG } from "@/lib/expenseFormConfig";

const baseLine = (overrides: Partial<BatchLineInput> = {}): BatchLineInput => ({
  clientId: "a",
  title: "Taxi",
  amount: 100,
  category: "travel",
  ...overrides,
});

describe("expenseBatchValidation", () => {
  describe("validateBatchLines", () => {
    it("requires at least two lines", () => {
      const result = validateBatchLines([baseLine()]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toMatch(/at least 2/i);
    });

    it("accepts valid lines", () => {
      const result = validateBatchLines([
        baseLine({ clientId: "1" }),
        baseLine({ clientId: "2", title: "Meal", amount: 50 }),
      ]);
      expect(result).toEqual({ ok: true });
    });

    it("rejects non-positive amounts", () => {
      const result = validateBatchLines([
        baseLine({ clientId: "1" }),
        baseLine({ clientId: "2", amount: 0 }),
      ]);
      expect(result.ok).toBe(false);
    });
  });

  describe("validateBatchSharedContext", () => {
    it("blocks future expense dates", () => {
      const future = new Date();
      future.setFullYear(future.getFullYear() + 1);
      const result = validateBatchSharedContext(
        { expenseDate: future },
        DEFAULT_BASE_FIELD_CONFIG,
      );
      expect(result.ok).toBe(false);
    });
  });

  describe("validateBatchAttachments", () => {
    it("requires per-line receipt when amount exceeds threshold", () => {
      const result = validateBatchAttachments({
        lines: [baseLine({ amount: 100, tempReceiptFilenames: [] })],
        attachmentLimit: 50,
        mode: "per_line",
        sharedTempFilenames: [],
      });
      expect(result.ok).toBe(false);
    });

    it("allows submit when receipt provided", () => {
      const result = validateBatchAttachments({
        lines: [baseLine({ amount: 100, tempReceiptFilenames: ["a.jpg"] })],
        attachmentLimit: 50,
        mode: "per_line",
        sharedTempFilenames: [],
      });
      expect(result).toEqual({ ok: true });
    });
  });

  describe("validateBatchLines category", () => {
    it("requires category per line when org marks it required", () => {
      const fields = {
        ...DEFAULT_BASE_FIELD_CONFIG,
        category: { ...DEFAULT_BASE_FIELD_CONFIG.category, is_required: true },
      };
      const result = validateBatchLines(
        [baseLine(), baseLine({ clientId: "b", category: "" })],
        fields,
      );
      expect(result.ok).toBe(false);
    });
  });

  describe("helpers", () => {
    it("lineRequiresReceipt compares to limit", () => {
      expect(lineRequiresReceipt(51, 50)).toBe(true);
      expect(lineRequiresReceipt(50, 50)).toBe(false);
    });

    it("batchLineTotal sums amounts", () => {
      expect(
        batchLineTotal([
          baseLine({ amount: 100 }),
          baseLine({ clientId: "b", amount: 25.5 }),
        ]),
      ).toBe(125.5);
    });
  });
});
