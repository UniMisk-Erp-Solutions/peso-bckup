import imageCompression from "browser-image-compression";
import { PDFDocument } from "pdf-lib";

export type CompressionStrategy =
  | "image-basic"
  | "image-heic-convert"
  | "pdf-optimize"
  | "passthrough";

export type CompressionResult = {
  outputFile: File;
  originalName: string;
  mimeType: string;
  originalSize: number;
  compressedSize: number;
  ratio: number;
  strategy: CompressionStrategy;
  iterations: number;
  warnings: string[];
  timedOut: boolean;
  failed: boolean;
  failureReason?: string;
};

type CompressOptions = {
  targetBytes: number;
  absoluteCapBytes: number;
  signal?: AbortSignal;
  timeoutMs?: number;
};

const HEIC_MIMES = new Set(["image/heic", "image/heif"]);
const IMAGE_MIMES = new Set(["image/jpeg", "image/jpg", "image/png", "image/heic", "image/heif"]);

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("compression-timeout")), timeoutMs);
    promise
      .then((v) => {
        clearTimeout(t);
        resolve(v);
      })
      .catch((e) => {
        clearTimeout(t);
        reject(e);
      });
  });
}

function toFile(blob: Blob, fileName: string, type: string): File {
  return new File([blob], fileName, { type });
}

// Progressive passes: start near full quality, fall back to smaller/lower-quality on each
// retry so a constrained mobile device reliably produces output that fits the cap. We keep
// useWebWorker:false on purpose — the library's worker loads from a CDN that the production
// CSP blocks, so the work runs on the main thread. The retries (not a worker) are what make
// mobile reliable: each smaller target also compresses faster, dodging the timeout.
const IMAGE_PASSES: { maxWidthOrHeight: number; initialQuality: number }[] = [
  { maxWidthOrHeight: 2400, initialQuality: 0.82 },
  { maxWidthOrHeight: 1800, initialQuality: 0.62 },
  { maxWidthOrHeight: 1400, initialQuality: 0.5 },
  { maxWidthOrHeight: 1100, initialQuality: 0.42 },
];

async function compressImage(file: File, opts: CompressOptions): Promise<CompressionResult> {
  const warnings: string[] = [];
  const originalSize = file.size;
  let workingFile = file;
  let strategy: CompressionStrategy = "image-basic";

  if (HEIC_MIMES.has(file.type)) {
    try {
      const heic2anyModule = await import("heic2any");
      const heic2any = heic2anyModule.default;
      const convertedBlob = (await heic2any({
        blob: file,
        toType: "image/jpeg",
        quality: 0.82,
      })) as Blob;
      const convertedName = file.name.replace(/\.(heic|heif)$/i, ".jpg");
      workingFile = toFile(convertedBlob, convertedName, "image/jpeg");
      strategy = "image-heic-convert";
    } catch {
      return {
        outputFile: file,
        originalName: file.name,
        mimeType: file.type,
        originalSize,
        compressedSize: originalSize,
        ratio: 1,
        strategy,
        iterations: 0,
        warnings: ["HEIC conversion failed"],
        timedOut: false,
        failed: true,
        failureReason: "heic-convert-failed",
      };
    }
  }

  const target = Math.max(1, Math.min(opts.absoluteCapBytes, opts.targetBytes));
  const maxSizeMB = Math.max(0.05, target / (1024 * 1024));
  const timeoutMs = opts.timeoutMs ?? 25000;

  let best: File | null = null;
  let lastError: any = null;
  let passesRun = 0;

  for (const pass of IMAGE_PASSES) {
    passesRun += 1;
    try {
      const blob = await withTimeout(
        imageCompression(workingFile, {
          maxSizeMB,
          maxWidthOrHeight: pass.maxWidthOrHeight,
          useWebWorker: false,
          initialQuality: pass.initialQuality,
          signal: opts.signal,
        }),
        timeoutMs,
      );
      const candidate = toFile(blob, workingFile.name, blob.type || workingFile.type);
      if (!best || candidate.size < best.size) best = candidate;
      if (candidate.size <= target) break; // fits the cap — stop early
    } catch (e: any) {
      lastError = e;
      if (opts.signal?.aborted) break;
      // otherwise fall through to the next, more aggressive pass
    }
  }

  if (!best) {
    return {
      outputFile: file,
      originalName: file.name,
      mimeType: file.type,
      originalSize,
      compressedSize: file.size,
      ratio: 1,
      strategy,
      iterations: passesRun,
      warnings,
      timedOut: lastError?.message === "compression-timeout",
      failed: true,
      failureReason: lastError?.message || "image-compression-failed",
    };
  }

  const finalFile = best.size < workingFile.size ? best : workingFile;
  if (finalFile.size >= workingFile.size) warnings.push("compression-not-beneficial");
  if (finalFile.size > target) warnings.push("compression-above-target-best-effort");

  return {
    outputFile: finalFile,
    originalName: file.name,
    mimeType: finalFile.type,
    originalSize,
    compressedSize: finalFile.size,
    ratio: finalFile.size / Math.max(1, originalSize),
    strategy,
    iterations: passesRun,
    warnings,
    timedOut: false,
    failed: false,
  };
}

async function compressPdf(file: File, opts: CompressOptions): Promise<CompressionResult> {
  const warnings: string[] = [];
  const originalSize = file.size;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const pdf = await PDFDocument.load(bytes);
    const out = await withTimeout(
      pdf.save({
        useObjectStreams: true,
        addDefaultPage: false,
        updateFieldAppearances: false,
      }),
      opts.timeoutMs ?? 12000
    );
    const compressedFile = new File([out], file.name, { type: "application/pdf" });
    if (compressedFile.size >= file.size) {
      warnings.push("pdf-optimization-not-beneficial");
      return {
        outputFile: file,
        originalName: file.name,
        mimeType: file.type,
        originalSize,
        compressedSize: file.size,
        ratio: 1,
        strategy: "pdf-optimize",
        iterations: 1,
        warnings,
        timedOut: false,
        failed: false,
      };
    }
    return {
      outputFile: compressedFile,
      originalName: file.name,
      mimeType: compressedFile.type,
      originalSize,
      compressedSize: compressedFile.size,
      ratio: compressedFile.size / Math.max(1, originalSize),
      strategy: "pdf-optimize",
      iterations: 1,
      warnings,
      timedOut: false,
      failed: false,
    };
  } catch (e: any) {
    return {
      outputFile: file,
      originalName: file.name,
      mimeType: file.type,
      originalSize,
      compressedSize: file.size,
      ratio: 1,
      strategy: "pdf-optimize",
      iterations: 1,
      warnings,
      timedOut: e?.message === "compression-timeout",
      failed: true,
      failureReason: e?.message || "pdf-compression-failed",
    };
  }
}

export async function compressUploadFile(file: File, opts: CompressOptions): Promise<CompressionResult> {
  if (IMAGE_MIMES.has(file.type)) {
    return compressImage(file, opts);
  }
  if (file.type === "application/pdf") {
    return compressPdf(file, opts);
  }
  return {
    outputFile: file,
    originalName: file.name,
    mimeType: file.type,
    originalSize: file.size,
    compressedSize: file.size,
    ratio: 1,
    strategy: "passthrough",
    iterations: 0,
    warnings: ["unsupported-for-compression"],
    timedOut: false,
    failed: false,
  };
}

export function shouldUseServerFallback(result: CompressionResult, remainingBudgetBytes: number): boolean {
  if (result.compressedSize <= remainingBudgetBytes) return false;
  return result.failed || result.timedOut || result.compressedSize > remainingBudgetBytes;
}
