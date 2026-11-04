import { describe, expect, it } from "vitest";
import {
  RECEIPT_OPTIMIZE,
  isOptimizableImage,
  optimizeReceiptImageWith,
  runExclusive,
  targetDimensions,
  type Decoded,
  type OptimizeDeps,
} from "@/lib/receiptImageOptimizer";

const MB = 1024 * 1024;

/** A deterministic stand-in for a camera frame: encoded size grows with pixel count and quality. */
function fakeDeps(opts: { width: number; height: number; bytesPerPixel?: number; failDecode?: boolean; hang?: boolean }) {
  const calls = { decode: 0, encode: [] as Array<{ w: number; h: number; q: number }>, closed: 0 };
  const k = opts.bytesPerPixel ?? 0.3;
  const deps: OptimizeDeps = {
    now: () => Date.now(),
    async decode() {
      calls.decode++;
      if (opts.hang) return new Promise<Decoded>(() => undefined);
      if (opts.failDecode) throw new Error("cannot decode");
      return { width: opts.width, height: opts.height, source: {}, close: () => void calls.closed++ };
    },
    async encode(_d, w, h, q) {
      calls.encode.push({ w, h, q });
      return new Blob([new Uint8Array(Math.round(w * h * q * k))], { type: "image/jpeg" });
    },
  };
  return { deps, calls };
}

const photo = (mb: number, name = "IMG_0001.jpg", type = "image/jpeg") =>
  new File([new Uint8Array(Math.round(mb * MB))], name, { type });

describe("targetDimensions", () => {
  it("scales the long edge down, preserving aspect ratio", () => {
    expect(targetDimensions(4032, 3024, 2560)).toEqual({ width: 2560, height: 1920 });
    expect(targetDimensions(3024, 4032, 2560)).toEqual({ width: 1920, height: 2560 });
  });
  it("NEVER upscales", () => {
    expect(targetDimensions(1200, 900, 2560)).toEqual({ width: 1200, height: 900 });
  });
});

describe("optimizeReceiptImageWith: large phone photos are accepted and shrunk, never rejected", () => {
  it.each([5, 10, 15, 20, 30, 45])("a %i MB 12 MP camera photo is accepted and becomes a small receipt", async (mb) => {
    const { deps } = fakeDeps({ width: 4032, height: 3024 });
    const r = await optimizeReceiptImageWith(photo(mb), deps);
    expect(r.optimized).toBe(true);
    expect(r.reason).toBe("optimized");
    expect(r.outputBytes).toBeLessThan(r.originalBytes);
    expect(r.outputBytes).toBeLessThanOrEqual(RECEIPT_OPTIMIZE.storageCeilingBytes);
    expect(Math.max(r.width!, r.height!)).toBeLessThanOrEqual(RECEIPT_OPTIMIZE.maxLongEdge);
    expect(r.file.type).toBe("image/jpeg");
    expect(r.file.name).toBe("IMG_0001.jpg");
  });

  it("a 48 MP frame (8064x6048, 32 MB) is scaled to 2560 on the long edge", async () => {
    const { deps } = fakeDeps({ width: 8064, height: 6048 });
    const r = await optimizeReceiptImageWith(photo(32), deps);
    expect(r.optimized).toBe(true);
    expect([r.width, r.height]).toEqual([2560, 1920]);
    expect(r.originalWidth).toBe(8064);
  });

  it("quality starts high (0.85) and stops at the first step that is small enough", async () => {
    const { deps, calls } = fakeDeps({ width: 4032, height: 3024, bytesPerPixel: 0.2 });
    const r = await optimizeReceiptImageWith(photo(12), deps);
    expect(r.quality).toBe(0.85);
    expect(calls.encode).toHaveLength(1);
  });

  it("steps quality down (not dimensions) before shrinking a legible 2560 px image", async () => {
    const { deps, calls } = fakeDeps({ width: 4032, height: 3024, bytesPerPixel: 0.9 });
    const r = await optimizeReceiptImageWith(photo(14), deps);
    expect(calls.encode.map((c) => c.q).slice(0, 3)).toEqual([0.85, 0.8, 0.76]);
    expect(calls.encode.slice(0, 4).every((c) => c.w === 2560)).toBe(true);
    expect(r.quality).toBeGreaterThanOrEqual(0.72);
  });

  it("never goes below the minimum readable size unless the storage ceiling forces it", async () => {
    const { deps } = fakeDeps({ width: 4032, height: 3024, bytesPerPixel: 0.9 });
    const r = await optimizeReceiptImageWith(photo(14), deps);
    expect(Math.max(r.width!, r.height!)).toBeGreaterThanOrEqual(RECEIPT_OPTIMIZE.minLongEdge);
    expect(r.outputBytes).toBeLessThanOrEqual(RECEIPT_OPTIMIZE.storageCeilingBytes);
  });

  it("forces extra shrinking only when the result would not fit the storage ceiling", async () => {
    const { deps } = fakeDeps({ width: 4032, height: 3024, bytesPerPixel: 4 });
    const r = await optimizeReceiptImageWith(photo(40), deps);
    if (r.optimized) {
      expect(r.outputBytes).toBeLessThanOrEqual(RECEIPT_OPTIMIZE.storageCeilingBytes);
    } else {
      expect(r.reason).toBe("too_large_after_optimization");
    }
  });
});

describe("optimizeReceiptImageWith: things that must NOT be touched", () => {
  it("PDFs are never decoded or changed", async () => {
    const { deps, calls } = fakeDeps({ width: 1, height: 1 });
    const pdf = new File([new Uint8Array(8 * MB)], "invoice.pdf", { type: "application/pdf" });
    const r = await optimizeReceiptImageWith(pdf, deps);
    expect(r).toMatchObject({ optimized: false, reason: "not_image" });
    expect(r.file).toBe(pdf);
    expect(calls.decode).toBe(0);
  });

  it("small images are uploaded untouched with no decode at all", async () => {
    const { deps, calls } = fakeDeps({ width: 1000, height: 800 });
    const small = photo(0.3);
    const r = await optimizeReceiptImageWith(small, deps);
    expect(r).toMatchObject({ optimized: false, reason: "already_small" });
    expect(r.file).toBe(small);
    expect(calls.decode).toBe(0);
  });

  it("an image already at/below the target dimensions is not upscaled and not made bigger", async () => {
    const { deps } = fakeDeps({ width: 1600, height: 1200, bytesPerPixel: 1.2 });
    const orig = photo(2.2);
    const r = await optimizeReceiptImageWith(orig, deps);
    expect(r.width ?? 1600).toBe(1600);
    expect(r.outputBytes).toBeLessThanOrEqual(orig.size);
  });

  it("keeps the original when re-encoding is not a real improvement", async () => {
    const { deps } = fakeDeps({ width: 2000, height: 1500, bytesPerPixel: 0.25 });
    const orig = photo(0.6);
    const r = await optimizeReceiptImageWith(orig, deps);
    expect(r.optimized).toBe(false);
    expect(r.reason).toBe("no_gain");
    expect(r.file).toBe(orig);
  });

  it("refuses to even try a pathological source (generous cap)", async () => {
    const { deps, calls } = fakeDeps({ width: 100, height: 100 });
    const huge = { size: 200 * MB, type: "image/jpeg", name: "x.jpg" } as unknown as File;
    const r = await optimizeReceiptImageWith(huge, deps);
    expect(r.reason).toBe("source_too_large");
    expect(calls.decode).toBe(0);
  });
});

describe("HEIC / HEIF", () => {
  it("is converted to JPEG even when small (JPEG opens everywhere)", async () => {
    const { deps, calls } = fakeDeps({ width: 4032, height: 3024, bytesPerPixel: 0.1 });
    const heic = photo(2.5, "IMG_0002.HEIC", "image/heic");
    const r = await optimizeReceiptImageWith(heic, deps);
    expect(calls.decode).toBe(1);
    expect(r.optimized).toBe(true);
    expect(r.file.type).toBe("image/jpeg");
    expect(r.file.name).toBe("IMG_0002.jpg");
  });

  it("recognised by extension when the browser gives no MIME type", () => {
    expect(isOptimizableImage({ type: "", name: "a.heic" })).toBe(true);
    expect(isOptimizableImage({ type: "", name: "a.pdf" })).toBe(false);
  });

  it("when the browser cannot decode HEIC the original is returned untouched, never an exception or a hang", async () => {
    const { deps } = fakeDeps({ width: 1, height: 1, failDecode: true });
    const heic = photo(4, "IMG_0003.heic", "image/heic");
    const r = await optimizeReceiptImageWith(heic, deps);
    expect(r).toMatchObject({ optimized: false, reason: "decode_failed" });
    expect(r.file).toBe(heic);
  });
});

describe("failure handling: no infinite spinner", () => {
  it("a stuck decode times out and returns the original", async () => {
    const { deps } = fakeDeps({ width: 1, height: 1, hang: true });
    const orig = photo(6);
    const r = await optimizeReceiptImageWith(orig, deps, { timeoutMs: 40 });
    expect(r).toMatchObject({ optimized: false, reason: "timeout" });
    expect(r.file).toBe(orig);
  });

  it("the decoded image is always released", async () => {
    const { deps, calls } = fakeDeps({ width: 4032, height: 3024 });
    await optimizeReceiptImageWith(photo(8), deps);
    expect(calls.closed).toBe(1);
  });
});

describe("bounded concurrency", () => {
  it("runs at most ONE optimization at a time and keeps order, even if one fails", async () => {
    let running = 0;
    let peak = 0;
    const order: number[] = [];
    const task = (n: number, fail = false) => () =>
      (async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 15));
        order.push(n);
        running--;
        if (fail) throw new Error("boom");
        return n;
      })();
    const results = await Promise.allSettled([runExclusive(task(1)), runExclusive(task(2, true)), runExclusive(task(3)), runExclusive(task(4))]);
    expect(peak).toBe(1);
    expect(order).toEqual([1, 2, 3, 4]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled", "fulfilled"]);
  });
});
