import { describe, expect, it } from "vitest";
import { shouldUseServerFallback } from "@/lib/uploadCompression";

describe("uploadCompression helpers", () => {
  it("uses fallback when compressed output exceeds budget", () => {
    const should = shouldUseServerFallback(
      {
        outputFile: new File(["abc"], "a.jpg", { type: "image/jpeg" }),
        originalName: "a.jpg",
        mimeType: "image/jpeg",
        originalSize: 3000000,
        compressedSize: 2100000,
        ratio: 0.7,
        strategy: "image-basic",
        iterations: 1,
        warnings: [],
        timedOut: false,
        failed: false,
      },
      1000000
    );
    expect(should).toBe(true);
  });

  it("does not use fallback when file is within budget", () => {
    const should = shouldUseServerFallback(
      {
        outputFile: new File(["abc"], "a.jpg", { type: "image/jpeg" }),
        originalName: "a.jpg",
        mimeType: "image/jpeg",
        originalSize: 300000,
        compressedSize: 200000,
        ratio: 0.66,
        strategy: "image-basic",
        iterations: 1,
        warnings: [],
        timedOut: false,
        failed: false,
      },
      1000000
    );
    expect(should).toBe(false);
  });
});
