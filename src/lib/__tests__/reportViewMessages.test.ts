import { describe, it, expect } from "vitest";
import {
  classifyReportViewError,
  reportDownloadErrorMessage,
  reportViewErrorMessage,
} from "@/lib/reportViewMessages";

describe("reportViewMessages", () => {
  it("classifies expired, permission and generic failures", () => {
    expect(classifyReportViewError(new Error("report not found"))).toBe("expired");
    expect(classifyReportViewError(new Error("not permitted to view this report"))).toBe("not_permitted");
    expect(classifyReportViewError(new Error("socket hang up"))).toBe("failed");
    expect(classifyReportViewError(undefined)).toBe("failed");
  });

  it("never returns raw backend text", () => {
    for (const k of ["expired", "not_permitted", "failed"] as const) {
      expect(reportViewErrorMessage(k)).not.toMatch(/42\d{3}|ERRCODE|_v\d/);
    }
    expect(reportDownloadErrorMessage(new Error("Object not found"))).toMatch(/expired/);
    expect(reportDownloadErrorMessage(new Error("boom 500"))).not.toMatch(/500|boom/);
  });
});
