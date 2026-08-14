import { describe, expect, it } from "vitest";
import { isAllowedUploadFile, resolveUploadMimeType } from "@/lib/uploadMimeType";

describe("resolveUploadMimeType", () => {
  it("keeps a valid declared MIME type", () => {
    const file = new File(["x"], "receipt.pdf", { type: "application/pdf" });
    expect(resolveUploadMimeType(file)).toBe("application/pdf");
  });

  it("infers MIME from extension when type is empty (iOS camera)", () => {
    const file = new File(["x"], "photo.heic", { type: "" });
    expect(resolveUploadMimeType(file)).toBe("image/heic");
  });

  it("defaults camera captures without extension to jpeg", () => {
    const file = new File(["x"], "image", { type: "" });
    expect(resolveUploadMimeType(file)).toBe("image/jpeg");
    expect(isAllowedUploadFile(file)).toBe(true);
  });

  it("normalizes image/jpg", () => {
    const file = new File(["x"], "a.jpg", { type: "image/jpg" });
    expect(resolveUploadMimeType(file)).toBe("image/jpeg");
  });
});
