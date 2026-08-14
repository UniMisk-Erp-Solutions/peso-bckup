import { describe, expect, it } from "vitest";
import { recoverTempFilenamesFromAttachmentUrls } from "@/lib/expenseAttachmentTempPaths";

describe("recoverTempFilenamesFromAttachmentUrls", () => {
  const userId = "11111111-2222-3333-4444-555555555555";

  it("recovers filename from temp receipt public URL", () => {
    const target = new Set<string>();
    const recovered = recoverTempFilenamesFromAttachmentUrls(
      userId,
      [
        `https://example.supabase.co/storage/v1/object/public/receipts/temp/${userId}/1700000000-abc.jpg`,
      ],
      target,
    );
    expect(recovered).toBe(1);
    expect(target.has("1700000000-abc.jpg")).toBe(true);
  });

  it("recovers filename from URL with query string", () => {
    const target = new Set<string>();
    const recovered = recoverTempFilenamesFromAttachmentUrls(
      userId,
      [
        `https://pesowise-supabase.unimisk.com/storage/v1/object/public/receipts/temp/${userId}/1778309135647-fasrkh9onvg.jpeg?t=123`,
      ],
      target,
    );
    expect(recovered).toBe(1);
    expect(target.has("1778309135647-fasrkh9onvg.jpeg")).toBe(true);
  });

  it("recovers filename from storage key path", () => {
    const target = new Set<string>();
    const recovered = recoverTempFilenamesFromAttachmentUrls(
      userId,
      [`temp/${userId}/1700000000-abc.jpg`],
      target,
    );
    expect(recovered).toBe(1);
    expect(target.has("1700000000-abc.jpg")).toBe(true);
  });

  it("ignores permanent expense paths", () => {
    const target = new Set<string>();
    const recovered = recoverTempFilenamesFromAttachmentUrls(
      userId,
      ["https://example.supabase.co/storage/v1/object/public/receipts/expense-id/file.jpg"],
      target,
    );
    expect(recovered).toBe(0);
    expect(target.size).toBe(0);
  });
});
