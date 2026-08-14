import { describe, expect, it } from "vitest";
import { validateTransferRejectionReason } from "@/lib/balanceTransferOfferValidation";

describe("validateTransferRejectionReason", () => {
  it("rejects empty or too-short reasons", () => {
    expect(validateTransferRejectionReason("").valid).toBe(false);
    expect(validateTransferRejectionReason("  ").valid).toBe(false);
    expect(validateTransferRejectionReason("no").valid).toBe(false);
  });

  it("accepts reasons with at least 3 characters", () => {
    expect(validateTransferRejectionReason("Not now").valid).toBe(true);
    expect(validateTransferRejectionReason("  Wrong project  ").valid).toBe(true);
  });
});
