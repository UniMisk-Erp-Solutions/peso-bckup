/**
 * Receipt photo optimization: ONE pass, on the device, BEFORE upload.
 *
 * Why: phone cameras produce 3-30+ MB originals (a 48 MP iPhone Pro frame is 8064x6048). Uploading those raw
 * made the bill upload slow, made every later copy of the file slow, and the `receipts` bucket refuses objects over
 * 10 MiB. Users must never be told "this photo is too large": a big original is accepted, decoded once, scaled down
 * only if it is larger than needed, re-encoded with an adaptive quality ladder, and the optimized File is the only
 * thing that is uploaded, cached and finalized afterwards (it is never decoded or compressed a second time).
 *
 * These are ACCOUNTING DOCUMENTS. The long edge never drops below 1600 px (the final ladder step for oversized
 * results goes to 1200 px only to stay under the storage ceiling), quality never drops below 0.72, small images are
 * left untouched, nothing is ever upscaled, and PDFs are never touched.
 */

export const RECEIPT_OPTIMIZE = {
  /** Longest side of the optimized image (receipt text stays legible when zoomed). */
  maxLongEdge: 2560,
  /** Do not go below this unless the storage ceiling forces it. */
  minLongEdge: 1600,
  /** Absolute floor, only used when a result still would not fit the storage ceiling. */
  hardMinLongEdge: 1200,
  /** JPEG quality ladder: stop at the first step that is already small enough. */
  qualityLadder: [0.85, 0.8, 0.76, 0.72] as readonly number[],
  /** "Small enough": comfortably fast to upload on a mobile network. Stop encoding as soon as a step reaches it. */
  targetBytes: 1.5 * 1024 * 1024,
  /** Still acceptable without shrinking the dimensions further (legibility is preferred over a smaller file). */
  acceptBytes: 3 * 1024 * 1024,
  /** Images at or below this are uploaded untouched (no decode, no re-encode). */
  skipBelowBytes: 400 * 1024,
  /** `receipts` bucket limit is 10 MiB; keep headroom. */
  storageCeilingBytes: 9.5 * 1024 * 1024,
  /** Pathological-file guard: refuse to even try to decode anything bigger. */
  maxSourceBytes: 150 * 1024 * 1024,
  /** Decode/encode watchdog so a stuck decode can never spin forever. */
  timeoutMs: 30000,
} as const;

export type OptimizeReason =
  | "optimized"
  | "not_image"
  | "already_small"
  | "no_gain"
  | "decode_failed"
  | "timeout"
  | "source_too_large"
  | "too_large_after_optimization";

export type OptimizeResult = {
  file: File;
  optimized: boolean;
  reason: OptimizeReason;
  originalBytes: number;
  outputBytes: number;
  originalWidth: number | null;
  originalHeight: number | null;
  width: number | null;
  height: number | null;
  quality: number | null;
  /** Wall time spent in decode + encode (ms). */
  ms: number;
  attempts: number;
};

export type Decoded = {
  width: number;
  height: number;
  /** Opaque handle the encoder draws from. */
  source: unknown;
  close(): void;
};

export type OptimizeDeps = {
  decode(file: File): Promise<Decoded>;
  encode(decoded: Decoded, width: number, height: number, quality: number): Promise<Blob>;
  now(): number;
};

export type OptimizeOptions = Partial<{
  maxLongEdge: number;
  minLongEdge: number;
  qualityLadder: readonly number[];
  targetBytes: number;
  acceptBytes: number;
  skipBelowBytes: number;
  storageCeilingBytes: number;
  maxSourceBytes: number;
  timeoutMs: number;
}>;

const HEIC_TYPES = new Set(["image/heic", "image/heif"]);
const RASTER_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp", "image/heic", "image/heif"]);

export function isOptimizableImage(file: Pick<File, "type" | "name">): boolean {
  const type = (file.type || "").toLowerCase();
  if (type) return RASTER_TYPES.has(type);
  return /\.(jpe?g|png|webp|heic|heif)$/i.test(file.name || "");
}

function isHeic(file: Pick<File, "type" | "name">): boolean {
  const type = (file.type || "").toLowerCase();
  return HEIC_TYPES.has(type) || /\.(heic|heif)$/i.test(file.name || "");
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("optimize-timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function jpegName(name: string): string {
  const base = (name || "receipt").replace(/\.[^.]+$/, "") || "receipt";
  return `${base}.jpg`;
}

/** Longest side after scaling DOWN only (never upscale). */
export function targetDimensions(width: number, height: number, maxLongEdge: number): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= maxLongEdge) return { width, height };
  const scale = maxLongEdge / long;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * Pure orchestration (testable with injected decode/encode). Never throws: every failure is returned as a
 * result whose `file` is the untouched original, so the caller decides what is acceptable.
 */
export async function optimizeReceiptImageWith(
  file: File,
  deps: OptimizeDeps,
  options: OptimizeOptions = {},
): Promise<OptimizeResult> {
  const o = { ...RECEIPT_OPTIMIZE, ...options };
  const t0 = deps.now();
  const base = (reason: OptimizeReason, extra: Partial<OptimizeResult> = {}): OptimizeResult => ({
    file,
    optimized: false,
    reason,
    originalBytes: file.size,
    outputBytes: file.size,
    originalWidth: null,
    originalHeight: null,
    width: null,
    height: null,
    quality: null,
    ms: deps.now() - t0,
    attempts: 0,
    ...extra,
  });

  if (!isOptimizableImage(file)) return base("not_image");
  if (file.size > o.maxSourceBytes) return base("source_too_large");
  const heic = isHeic(file);
  // Small camera/screenshot files are fine as they are. HEIC is always converted: JPEG opens everywhere.
  if (!heic && file.size <= o.skipBelowBytes) return base("already_small");

  let decoded: Decoded | null = null;
  try {
    decoded = await withTimeout(deps.decode(file), o.timeoutMs);
  } catch (e) {
    return base((e as Error)?.message === "optimize-timeout" ? "timeout" : "decode_failed");
  }

  try {
    const { width: ow, height: oh } = decoded;
    let edge = Math.min(o.maxLongEdge, Math.max(ow, oh));
    let attempts = 0;
    let best: { blob: Blob; w: number; h: number; q: number } | null = null;

    // Candidate long edges, largest first. The edge only shrinks when quality alone could not reach an acceptable size.
    const edges: number[] = [];
    for (let e = edge; e >= o.hardMinLongEdge; e = Math.floor(e * 0.85)) {
      edges.push(e);
      if (e <= o.hardMinLongEdge) break;
    }
    if (edges.length === 0) edges.push(edge);

    outer: for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      const dims = targetDimensions(ow, oh, e);
      for (const q of o.qualityLadder) {
        attempts += 1;
        const blob = await withTimeout(deps.encode(decoded, dims.width, dims.height, q), o.timeoutMs);
        best = { blob, w: dims.width, h: dims.height, q };
        if (blob.size <= o.targetBytes) break outer; // small enough: stop at the highest quality that gets here
      }
      if (!best) break;
      if (best.blob.size <= o.acceptBytes) break; // acceptable: keep the larger, more legible size
      const next = edges[i + 1];
      // Below the readable floor (minLongEdge) only the storage ceiling may force another shrink.
      if (best.blob.size <= o.storageCeilingBytes && (next === undefined || next < o.minLongEdge)) break;
    }

    if (!best) return base("decode_failed", { originalWidth: ow, originalHeight: oh, attempts });

    const jpeg = best.blob;
    // A re-encode that is not meaningfully smaller than an already-fine JPEG is not an improvement.
    if (!heic && jpeg.size >= file.size * 0.95 && file.size <= o.storageCeilingBytes) {
      return base("no_gain", { originalWidth: ow, originalHeight: oh, width: best.w, height: best.h, attempts });
    }
    if (jpeg.size > o.storageCeilingBytes) {
      return base("too_large_after_optimization", {
        originalWidth: ow,
        originalHeight: oh,
        width: best.w,
        height: best.h,
        quality: best.q,
        outputBytes: jpeg.size,
        attempts,
      });
    }

    const out = new File([jpeg], jpegName(file.name), { type: "image/jpeg", lastModified: Date.now() });
    return {
      file: out,
      optimized: true,
      reason: "optimized",
      originalBytes: file.size,
      outputBytes: out.size,
      originalWidth: ow,
      originalHeight: oh,
      width: best.w,
      height: best.h,
      quality: best.q,
      ms: deps.now() - t0,
      attempts,
    };
  } catch (e) {
    return base((e as Error)?.message === "optimize-timeout" ? "timeout" : "decode_failed");
  } finally {
    try {
      decoded?.close();
    } catch {
      /* ignore */
    }
  }
}

/** A file that was already prepared (e.g. a retry after a failed upload): passed through, never re-encoded. */
export function alreadyPreparedResult(file: File): OptimizeResult {
  return {
    file,
    optimized: false,
    reason: "already_small",
    originalBytes: file.size,
    outputBytes: file.size,
    originalWidth: null,
    originalHeight: null,
    width: null,
    height: null,
    quality: null,
    ms: 0,
    attempts: 0,
  };
}

/** Storage refuses objects over 10 MiB (receipts bucket file_size_limit). */
export const RECEIPTS_BUCKET_LIMIT_BYTES = 10 * 1024 * 1024;

/** Plain-language reason a prepared file still cannot be uploaded, or null if it can. */
export function uploadBlockedMessage(result: OptimizeResult): string | null {
  const f = result.file;
  if (f.size <= RECEIPTS_BUCKET_LIMIT_BYTES) return null;
  const mb = (f.size / (1024 * 1024)).toFixed(1);
  if (!isOptimizableImage(f)) {
    return `This file is ${mb} MB. PDF bills can be up to 10 MB - please use a smaller PDF, or photograph the bill instead.`;
  }
  if (result.reason === "source_too_large") {
    return `This file is ${mb} MB, which is far larger than any phone photo. Please take the photo again.`;
  }
  if (result.reason === "decode_failed" || result.reason === "timeout") {
    return "This photo could not be prepared on this device. Please take it again, or choose a different photo.";
  }
  return "This photo could not be reduced enough to upload. Please retake it with the bill filling the frame.";
}

/* ------------------------------ browser implementation ------------------------------ */

type DrawSource = ImageBitmap | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas;

async function decodeInBrowser(file: File): Promise<Decoded> {
  if (typeof createImageBitmap === "function") {
    // EXIF orientation is applied by the decoder, so width/height are what the user sees.
    try {
      const bm = await createImageBitmap(file, { imageOrientation: "from-image" } as ImageBitmapOptions);
      return { width: bm.width, height: bm.height, source: bm, close: () => bm.close() };
    } catch {
      /* fall through to the next decoder */
    }
    try {
      const bm = await createImageBitmap(file);
      return { width: bm.width, height: bm.height, source: bm, close: () => bm.close() };
    } catch {
      /* fall through to <img> */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("img-decode-failed"));
    });
    if (!img.naturalWidth || !img.naturalHeight) throw new Error("img-decode-failed");
    return { width: img.naturalWidth, height: img.naturalHeight, source: img, close: () => undefined };
  } finally {
    // The element keeps the decoded pixels; the URL is only needed during decode.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function makeCanvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

async function canvasToJpeg(canvas: OffscreenCanvas | HTMLCanvasElement, quality: number): Promise<Blob> {
  if (typeof OffscreenCanvas !== "undefined" && canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type: "image/jpeg", quality });
  }
  return new Promise<Blob>((resolve, reject) => {
    (canvas as HTMLCanvasElement).toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob-null"))), "image/jpeg", quality);
  });
}

async function encodeInBrowser(decoded: Decoded, width: number, height: number, quality: number): Promise<Blob> {
  let src = decoded.source as DrawSource;
  let curW = decoded.width;
  let curH = decoded.height;
  const temps: Array<OffscreenCanvas | HTMLCanvasElement> = [];
  try {
    // Halve in steps when shrinking a lot: one huge single-step downscale aliases thin receipt text on some engines.
    while (curW / 2 >= width && curH / 2 >= height) {
      const w = Math.max(width, Math.floor(curW / 2));
      const h = Math.max(height, Math.floor(curH / 2));
      const c = makeCanvas(w, h);
      const cx = c.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
      if (!cx) throw new Error("no-2d-context");
      cx.imageSmoothingEnabled = true;
      cx.imageSmoothingQuality = "high";
      cx.drawImage(src as CanvasImageSource, 0, 0, w, h);
      temps.push(c);
      src = c;
      curW = w;
      curH = h;
    }
    const out = makeCanvas(width, height);
    const ctx = out.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) throw new Error("no-2d-context");
    ctx.fillStyle = "#ffffff"; // JPEG has no alpha: transparent PNGs become white, like paper
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src as CanvasImageSource, 0, 0, width, height);
    temps.push(out);
    return await canvasToJpeg(out, quality);
  } finally {
    for (const c of temps) {
      try {
        c.width = 0;
        c.height = 0;
      } catch {
        /* ignore */
      }
    }
  }
}

export const browserOptimizeDeps: OptimizeDeps = {
  decode: decodeInBrowser,
  encode: encodeInBrowser,
  now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
};

/* One image at a time: bounded memory on phones (a 48 MP decode is ~190 MB), while the previous file uploads. */
let queue: Promise<unknown> = Promise.resolve();

/** Runs `fn` after every earlier call has finished (max concurrency 1). A failure never blocks the queue. */
export function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn);
  queue = run.catch(() => undefined);
  return run;
}

export function optimizeReceiptImage(file: File, options?: OptimizeOptions): Promise<OptimizeResult> {
  return runExclusive(() => optimizeReceiptImageWith(file, browserOptimizeDeps, options));
}
