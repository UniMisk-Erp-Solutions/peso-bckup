import { supabase } from "@/integrations/supabase/client";

// Origin of the active (self-hosted) Supabase project, derived from the build-time env.
const ACTIVE_SUPABASE_ORIGIN = (() => {
  const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined) || "";
  try {
    return url ? new URL(url).origin : "";
  } catch {
    return "";
  }
})();

// Any legacy Supabase cloud host (e.g. the retired kqlqirdneocivumdjtvx.supabase.co project)
// must resolve to the active self-hosted project — the files now live there at the same path.
const LEGACY_SUPABASE_HOST = /https?:\/\/[a-z0-9-]+\.supabase\.co/gi;

/**
 * Rewrite any legacy Supabase cloud host in a receipt/attachment URL to the active project host.
 * Already-local URLs are returned unchanged. The database is never modified — rewrite-on-read.
 */
export function normalizeReceiptUrl(url?: string | null): string {
  if (!url) return "";
  if (!ACTIVE_SUPABASE_ORIGIN) return url;
  return url.replace(LEGACY_SUPABASE_HOST, ACTIVE_SUPABASE_ORIGIN);
}

/** Normalize stored attachment paths/URLs to a public receipts URL on the current project. */
export function normalizeReceiptPublicUrl(url: string): string {
  const raw = normalizeReceiptUrl(url).trim();
  if (!raw) return raw;

  try {
    if (raw.startsWith("http://") || raw.startsWith("https://")) {
      if (raw.includes("/storage/v1/object/public/receipts/")) {
        const key =
          raw.split("/storage/v1/object/public/receipts/")[1]?.split("?")[0] || "";
        if (key) {
          return supabase.storage.from("receipts").getPublicUrl(decodeURIComponent(key)).data
            .publicUrl;
        }
      }

      const expenseAttachmentsIdx = raw.indexOf("/storage/v1/object/public/expense-attachments/");
      if (expenseAttachmentsIdx !== -1) {
        const key = raw.substring(
          expenseAttachmentsIdx + "/storage/v1/object/public/expense-attachments/".length,
        );
        return supabase.storage.from("receipts").getPublicUrl(key.split("?")[0]).data.publicUrl;
      }

      if (raw.includes("/storage/v1/object/sign/")) {
        const urlObj = new URL(raw);
        const pathMatch = urlObj.pathname.match(/\/storage\/v1\/object\/sign\/receipts\/(.+)/);
        if (pathMatch) {
          const key = decodeURIComponent(pathMatch[1].split("?")[0]);
          return supabase.storage.from("receipts").getPublicUrl(key).data.publicUrl;
        }
      }

      return raw.split("?")[0];
    }

    if (raw.startsWith("receipts/")) {
      const key = raw.slice("receipts/".length).split("?")[0];
      return supabase.storage.from("receipts").getPublicUrl(key).data.publicUrl;
    }
    if (raw.startsWith("expense-attachments/")) {
      const key = raw.slice("expense-attachments/".length).split("?")[0];
      return supabase.storage.from("receipts").getPublicUrl(key).data.publicUrl;
    }

    return supabase.storage.from("receipts").getPublicUrl(raw.split("?")[0]).data.publicUrl;
  } catch {
    return raw;
  }
}

/** Rewrite legacy cloud storage URLs to the active Supabase project (e.g. self-hosted). */
export function normalizeLogoPublicUrl(url: string | null | undefined): string | null {
  const raw = normalizeReceiptUrl(url).trim();
  if (!raw) return null;

  try {
    if (raw.includes("/storage/v1/object/public/organization-logos/")) {
      const key =
        raw.split("/storage/v1/object/public/organization-logos/")[1]?.split("?")[0] || "";
      if (key) {
        return supabase.storage.from("organization-logos").getPublicUrl(decodeURIComponent(key))
          .data.publicUrl;
      }
    }
    if (raw.startsWith("organization-logos/")) {
      const key = raw.slice("organization-logos/".length).split("?")[0];
      return supabase.storage.from("organization-logos").getPublicUrl(key).data.publicUrl;
    }
    return raw.split("?")[0];
  } catch {
    return raw;
  }
}

/** Detect PDF attachments for inline preview (iframe) vs image preview. */
export function isPdfAttachment(url: string, contentType?: string | null): boolean {
  const ct = (contentType || "").toLowerCase();
  if (ct.includes("pdf")) return true;
  const path = url.split("?")[0].toLowerCase();
  return path.endsWith(".pdf");
}

export function isImageAttachment(url: string, contentType?: string | null): boolean {
  const ct = (contentType || "").toLowerCase();
  if (ct.startsWith("image/")) return true;
  const path = url.split("?")[0].toLowerCase();
  return /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|heif)$/.test(path);
}

const HEIC_MIMES = new Set([
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
]);

/**
 * HEIC/HEIF is an iPhone-default photo format that no Chromium or Firefox build can
 * decode in an <img>. Uploads have been converted to JPEG since `uploadCompression.ts`
 * landed, but two populations of raw HEIC remain reachable from the preview:
 *   a) receipts uploaded before that conversion existed, and
 *   b) uploads where conversion failed — that path deliberately stores the ORIGINAL
 *      file (`failureReason: "heic-convert-failed"`) rather than dropping the receipt.
 * Both must be converted at read time or they render as a broken image.
 */
export function isHeicAttachment(url: string, contentType?: string | null): boolean {
  const ct = (contentType || "").toLowerCase().split(";")[0].trim();
  if (HEIC_MIMES.has(ct)) return true;
  const path = url.split("?")[0].toLowerCase();
  return /\.(heic|heif)$/.test(path);
}

// ISO-BMFF brands that mean "HEIF-family still image". Sniffing the bytes matters because
// storage frequently hands these back as `application/octet-stream` (the DB content_type is
// whatever the browser guessed at upload, and for .heic that is routinely empty), so neither
// the extension nor the recorded MIME can be relied on alone.
const HEIC_FTYP_BRANDS = new Set([
  "heic",
  "heix",
  "heim",
  "heis",
  "hevc",
  "hevx",
  "hevm",
  "hevs",
  "mif1",
  "msf1",
]);

/**
 * Read the first `length` bytes of a blob.
 *
 * `Blob.arrayBuffer()` is the direct route and exists in every browser this app targets,
 * but jsdom does not implement it — without the FileReader fallback the sniff below would
 * silently answer "not HEIC" under test while working in production, which is exactly the
 * kind of gap that lets a regression through unnoticed.
 */
async function readBlobHeadBytes(blob: Blob, length: number): Promise<Uint8Array> {
  const head = blob.slice(0, length);

  if (typeof head.arrayBuffer === "function") {
    return new Uint8Array(await head.arrayBuffer());
  }

  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read attachment header"));
    reader.readAsArrayBuffer(head);
  });
}

async function blobLooksLikeHeic(blob: Blob): Promise<boolean> {
  try {
    const header = await readBlobHeadBytes(blob, 16);
    if (header.length < 12) return false;
    const ascii = (start: number, end: number) =>
      String.fromCharCode(...Array.from(header.subarray(start, end)));
    if (ascii(4, 8) !== "ftyp") return false;
    return HEIC_FTYP_BRANDS.has(ascii(8, 12).toLowerCase());
  } catch {
    return false;
  }
}

const HEIC_DECODE_TIMEOUT_MS = 20_000;

/**
 * Settle to `null` rather than hanging, whatever the wrapped promise does.
 *
 * Non-negotiable here: `heic2any` can leave its promise permanently pending (see
 * `isDynamicCodeAllowed`), and an unbounded await in the resolver freezes the preview
 * dialog on its loading spinner with no way out — the failure this guards against was
 * observed in production, not hypothesised.
 */
function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    const finish = (value: T | null) => {
      clearTimeout(timer);
      resolve(value);
    };
    promise.then(finish, () => finish(null));
  });
}

/**
 * Can this document compile code from a string?
 *
 * `heic2any` decodes inside a blob Worker whose libheif glue calls `new Function`. The
 * production CSP is
 *   script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com
 * with no 'unsafe-eval', so that call throws EvalError INSIDE the worker: the worker dies
 * without posting a result and heic2any's promise never settles or rejects. Probing once
 * up front means a blocked document skips the decoder entirely rather than downloading its
 * ~1.35 MB chunk and then waiting out the timeout on every single HEIC preview.
 *
 * 'wasm-unsafe-eval' would NOT lift this — it permits WebAssembly compilation, not
 * `new Function`.
 *
 * Deliberately not memoised: the probe costs microseconds and runs at most once per HEIC
 * preview, whereas a cached module-level answer is hidden order-dependent state.
 */
function isDynamicCodeAllowed(): boolean {
  try {
    new Function("");
    return true;
  } catch {
    return false;
  }
}

/**
 * Does this browser decode the format natively? Safari and iOS do decode HEIC, so they
 * need no conversion at all — and this path costs nothing on browsers that don't.
 */
async function browserDecodesNatively(blob: Blob): Promise<boolean> {
  if (typeof createImageBitmap !== "function") return false;
  try {
    const bitmap = await createImageBitmap(blob);
    bitmap.close?.();
    return true;
  } catch {
    return false;
  }
}

/** Mirrors `DERIVED_PREFIX` in `supabase/functions/convert-heic`. */
const DERIVED_PREFIX = "derived";
const SERVER_CONVERT_TIMEOUT_MS = 45_000;

/**
 * Rendition extensions, in probe order.
 *
 * JPEG first and always: renditions created before the server could emit WebP must stay
 * valid, so a legacy `.jpg` is never bypassed. WebP exists because the deployment runs
 * `IMGPROXY_AUTO_WEBP=true`, so the transformation's output format is decided by content
 * negotiation and cannot be assumed — the function stores whichever it actually received,
 * under the matching extension and content type.
 */
const DERIVED_EXTENSIONS = ["jpg", "webp"] as const;

export function derivedRenditionPath(
  storagePath: string,
  ext: (typeof DERIVED_EXTENSIONS)[number] = "jpg",
): string {
  return `${DERIVED_PREFIX}/${storagePath}.${ext}`;
}

/**
 * Fetch an existing server-side rendition. These are plain public object GETs — no function
 * invocation — so once a receipt has been converted every later view costs nothing beyond a
 * cacheable request.
 */
async function fetchDerivedRendition(storagePath: string): Promise<Blob | null> {
  for (const ext of DERIVED_EXTENSIONS) {
    try {
      const url = supabase.storage
        .from(RECEIPT_BUCKET)
        .getPublicUrl(derivedRenditionPath(storagePath, ext)).data.publicUrl;
      const response = await fetch(url, { credentials: "omit", mode: "cors" });
      if (!response.ok) continue;
      const blob = await response.blob();
      if (blob.size > 0) return blob;
    } catch {
      // Try the next extension; a network failure on one probe is not a verdict.
    }
  }
  return null;
}

/**
 * Ask the `convert-heic` edge function to produce the rendition, then read it back.
 *
 * Bounded, like every other decode path here: an unreachable or not-yet-deployed function
 * must degrade to the `unsupported` state, never leave the dialog spinning.
 */
/**
 * The rendition identity the browser trusts.
 *
 * NOT the function's `public_url`. `getPublicUrl()` inside the Edge Runtime resolves
 * against that runtime's `SUPABASE_URL`, which on this self-hosted deployment is the
 * INTERNAL Docker address `http://supabase-kong:8000`. That host does not exist for a
 * browser, so fetching the returned URL verbatim fails — even though the rendition was
 * created correctly and is publicly readable. The symptom is subtle: the first open of a
 * freshly converted receipt fails, and a later reopen succeeds because the direct
 * `derived/` probe never involved the function's URL at all.
 *
 * The object key is host-independent, so the browser rebuilds the URL with its own
 * configured client and never has to know or trust the server's idea of its own origin.
 */
function isValidDerivedStoragePath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const path = value.trim();
  if (!path.startsWith(`${DERIVED_PREFIX}/`)) return false;
  // A path is an object key, never a URL, and never escapes the derived prefix.
  if (path.includes("://") || path.includes("..")) return false;
  return /\.(jpg|webp)$/.test(path);
}

type ConvertHeicSuccess = {
  ok: true;
  cached: boolean;
  storage_path: string;
  public_url?: string;
  content_type?: "image/jpeg" | "image/webp";
  width?: number;
  height?: number;
};

/**
 * Validate the function's reply at RUNTIME rather than trusting a TypeScript cast — the
 * response crosses a network boundary, so its shape is an assumption until checked.
 */
function readConvertHeicResponse(
  raw: unknown,
): { storagePath: string | null; legacyUrl: string | null } | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Partial<ConvertHeicSuccess>;
  if (data.ok !== true) return null;

  const storagePath = isValidDerivedStoragePath(data.storage_path) ? data.storage_path : null;
  const legacyUrl = typeof data.public_url === "string" ? data.public_url : null;
  if (!storagePath && !legacyUrl) return null;
  return { storagePath, legacyUrl };
}

async function fetchRenditionBlob(url: string): Promise<Blob | null> {
  try {
    const response = await fetch(url, { credentials: "omit", mode: "cors" });
    if (!response.ok) return null;
    const blob = await response.blob();
    return blob.size > 0 ? blob : null;
  } catch {
    return null;
  }
}

/**
 * Ask the `convert-heic` edge function to produce the rendition, then read it back.
 *
 * Bounded, like every other decode path here: an unreachable or not-yet-deployed function
 * must degrade to the `unsupported` state, never leave the dialog spinning.
 */
async function requestServerRendition(storagePath: string): Promise<Blob | null> {
  const invoked = await settleWithin(
    supabase.functions.invoke("convert-heic", { body: { storage_path: storagePath } }),
    SERVER_CONVERT_TIMEOUT_MS,
  );
  if (!invoked || invoked.error) return null;

  const parsed = readConvertHeicResponse(invoked.data);
  if (!parsed) return null;

  // Preferred: the object key, resolved against the BROWSER's Supabase origin.
  if (parsed.storagePath) {
    const url = supabase.storage.from(RECEIPT_BUCKET).getPublicUrl(parsed.storagePath).data
      .publicUrl;
    const blob = await fetchRenditionBlob(url);
    if (blob) return blob;
  }

  // Backward compatibility for a reply that carries only a URL. The KEY is extracted and the
  // URL rebuilt from the browser's origin — the supplied origin is discarded, so an internal
  // Docker host is handled and a foreign host cannot be fetched.
  //
  // Deliberately not `normalizeReceiptPublicUrl`: that helper returns its input unchanged
  // when it cannot find a receipts object key, which would turn any URL the function
  // returned into a fetch. Requiring a extractable `derived/` key fails closed instead.
  if (parsed.legacyUrl) {
    const key = extractReceiptStoragePath(parsed.legacyUrl);
    if (isValidDerivedStoragePath(key)) {
      const url = supabase.storage.from(RECEIPT_BUCKET).getPublicUrl(key).data.publicUrl;
      return fetchRenditionBlob(url);
    }
  }

  return null;
}

/** Decode a HEIC/HEIF blob to JPEG so an <img> can render it. Null when decoding fails. */
async function convertHeicBlobToJpeg(blob: Blob): Promise<Blob | null> {
  if (!isDynamicCodeAllowed()) return null;

  const converted = await settleWithin(
    (async () => {
      const heic2anyModule = await import("heic2any");
      const heic2any = heic2anyModule.default;
      // heic2any returns Blob[] for multi-image (burst / live photo) containers.
      return (await heic2any({
        blob,
        toType: "image/jpeg",
        quality: 0.9,
      })) as Blob | Blob[];
    })(),
    HEIC_DECODE_TIMEOUT_MS,
  );

  if (!converted) return null;
  const first = Array.isArray(converted) ? converted[0] : converted;
  return first instanceof Blob && first.size > 0 ? first : null;
}

/** Object key inside the `receipts` bucket from a stored URL or path. */
export function extractReceiptStoragePath(fileUrl: string): string | null {
  if (!fileUrl?.trim()) return null;
  const raw = fileUrl.trim();

  try {
    if (raw.startsWith("http://") || raw.startsWith("https://")) {
      const u = new URL(raw);
      const publicReceipts = "/object/public/receipts/";
      const publicLegacy = "/object/public/expense-attachments/";
      const signedReceipts = "/object/sign/receipts/";

      if (u.pathname.includes(publicReceipts)) {
        const key = u.pathname.split(publicReceipts)[1] || "";
        return decodeURIComponent(key.split("?")[0] || "") || null;
      }
      if (u.pathname.includes(publicLegacy)) {
        const key = u.pathname.split(publicLegacy)[1] || "";
        return decodeURIComponent(key.split("?")[0] || "") || null;
      }
      if (u.pathname.includes(signedReceipts)) {
        const key = u.pathname.split(signedReceipts)[1] || "";
        return decodeURIComponent(key.split("?")[0] || "") || null;
      }
    }
  } catch {
    // fall through to path-style parsing
  }

  if (raw.startsWith("receipts/")) {
    return raw.slice("receipts/".length).split("?")[0] || null;
  }
  if (raw.startsWith("expense-attachments/")) {
    return raw.slice("expense-attachments/".length).split("?")[0] || null;
  }

  if (!raw.includes("://") && !raw.startsWith("/")) {
    return raw.split("?")[0] || null;
  }

  return null;
}

function receiptFileNameFromStoragePath(storagePath: string): string {
  return storagePath.split("/").filter(Boolean).pop() || storagePath;
}

async function fetchBlobFromPublicReceiptUrl(
  publicUrl: string,
  fileUrl: string,
  contentType?: string | null,
): Promise<Blob | null> {
  try {
    const response = await fetch(publicUrl, { credentials: "omit", mode: "cors" });
    if (!response.ok) return null;
    const blob = await response.blob();
    if (isPdfAttachment(fileUrl, contentType) && blob.type !== "application/pdf") {
      return new Blob([await blob.arrayBuffer()], { type: "application/pdf" });
    }
    return blob;
  } catch {
    return null;
  }
}

// Receipts live in the public `receipts` bucket. (The legacy `expense-attachments`
// bucket is mapped to `receipts` at the URL level by extractReceiptStoragePath.)
const RECEIPT_BUCKET = "receipts";

// Session negative-cache: once a receipt URL fails every candidate, remember it so we
// never re-request it on re-render/scroll. This is what prevents a page full of orphaned
// (genuinely-missing) receipts from firing the same 400s dozens of times. In-memory only;
// a page reload clears it, so a later-restored file recovers naturally.
const KNOWN_MISSING_RECEIPTS = new Set<string>();

/** True if this receipt URL already failed to resolve this session (skip the network). */
export function isReceiptKnownMissing(fileUrl?: string | null): boolean {
  if (!fileUrl) return false;
  return KNOWN_MISSING_RECEIPTS.has(normalizeReceiptUrl(fileUrl));
}

async function loadReceiptBlobFromStoragePath(
  bucket: string,
  storagePath: string,
  fileUrl: string,
  contentType?: string | null,
): Promise<Blob | null> {
  const publicUrl = supabase.storage.from(bucket).getPublicUrl(storagePath).data.publicUrl;
  const publicBlob = await fetchBlobFromPublicReceiptUrl(publicUrl, fileUrl, contentType);
  if (publicBlob) return publicBlob;

  const { data, error } = await supabase.storage.from(bucket).download(storagePath);
  if (!error && data) {
    if (isPdfAttachment(fileUrl, contentType) && data.type !== "application/pdf") {
      return new Blob([await data.arrayBuffer()], { type: "application/pdf" });
    }
    return data;
  }

  const { data: signed, error: signError } = await supabase.storage
    .from(bucket)
    .createSignedUrl(storagePath, 3600);
  if (!signError && signed?.signedUrl) {
    return fetchBlobFromPublicReceiptUrl(signed.signedUrl, fileUrl, contentType);
  }

  return null;
}

export type LoadAttachmentBlobOptions = {
  /** Expense owner / uploader id — used to try `{userId}/file` and `temp/{userId}/file`. */
  fallbackTempUserId?: string | null;
  /** Expense id — used to try `{expenseId}/file` when the stored path points elsewhere. */
  fallbackExpenseId?: string | null;
};

/**
 * Lean candidate keys: the stored path (now host-rewritten to local, resolves on the
 * first try for any file that exists), plus the two historically-real fallbacks.
 * Kept small on purpose: extra speculative paths just multiply failed requests for the
 * receipts that are genuinely missing, so only paths this app actually writes are tried.
 *
 * The two real shapes (see FileUpload.tsx + moveTempFilesToExpense):
 *   draft upload      → `temp/{userId}/{file}`
 *   after submit/move → `{expenseId}/{file}`
 *
 * Both directions can go stale:
 *   a) stored `{expenseId}/file` but the move never ran → still in `temp/{userId}/file`
 *   b) stored `temp/{userId}/file` but the move DID run and `file_url` was never
 *      updated → the bytes are at `{expenseId}/file`
 *
 * (b) was previously unreachable: the `temp/` fallback was skipped for paths already
 * starting with `temp/`, and `fallbackExpenseId` was documented but never read, so the
 * only candidate tried was the stale temp path. Confirmed in production — attachment
 * rows pointing at `temp/22ba24a5-…/f.png` whose object lives at `361fbbcc-…/f.png`.
 */
function candidateReceiptPaths(storagePath: string, options?: LoadAttachmentBlobOptions): string[] {
  const filename = receiptFileNameFromStoragePath(storagePath);
  const userId = options?.fallbackTempUserId?.trim();
  const expenseId = options?.fallbackExpenseId?.trim();
  const storedIsTemp = storagePath.startsWith("temp/");

  const candidates = [
    storagePath,
    // (a) permanent path recorded, file never moved out of temp
    userId && !storedIsTemp ? `temp/${userId}/${filename}` : null,
    // (b) temp path recorded, file already moved to the expense folder
    expenseId && storedIsTemp ? `${expenseId}/${filename}` : null,
  ].filter((p): p is string => Boolean(p));

  return Array.from(new Set(candidates));
}

export type LoadedAttachment = {
  blob: Blob;
  /**
   * The candidate key the bytes were actually found at — NOT necessarily the stored one,
   * since `candidateReceiptPaths` recovers from stale temp/expense paths. Server-side
   * renditions must key off this, or they would be filed against a path holding nothing.
   */
  storagePath: string | null;
};

export async function loadAttachmentForPreview(
  fileUrl: string,
  contentType?: string | null,
  options?: LoadAttachmentBlobOptions,
): Promise<LoadedAttachment | null> {
  const cacheKey = normalizeReceiptUrl(fileUrl);
  if (cacheKey && KNOWN_MISSING_RECEIPTS.has(cacheKey)) return null;

  const storagePath = extractReceiptStoragePath(fileUrl);
  if (storagePath) {
    const candidates = candidateReceiptPaths(storagePath, options);
    for (const candidate of candidates) {
      const blob = await loadReceiptBlobFromStoragePath(
        RECEIPT_BUCKET,
        candidate,
        fileUrl,
        contentType,
      );
      if (blob) return { blob, storagePath: candidate };
    }
    if (cacheKey) KNOWN_MISSING_RECEIPTS.add(cacheKey);
    return null;
  }

  if (fileUrl.startsWith("http://") || fileUrl.startsWith("https://")) {
    const blob = await fetchBlobFromPublicReceiptUrl(
      normalizeReceiptUrl(fileUrl),
      fileUrl,
      contentType,
    );
    if (!blob && cacheKey) KNOWN_MISSING_RECEIPTS.add(cacheKey);
    return blob ? { blob, storagePath: null } : null;
  }

  return null;
}

export async function loadAttachmentBlobForPreview(
  fileUrl: string,
  contentType?: string | null,
  options?: LoadAttachmentBlobOptions,
): Promise<Blob | null> {
  return (await loadAttachmentForPreview(fileUrl, contentType, options))?.blob ?? null;
}

export function createPreviewObjectUrl(blob: Blob, contentType?: string | null): string {
  const isPdf = isPdfAttachment("", contentType) || blob.type.includes("pdf");
  const type = isPdf ? "application/pdf" : blob.type || "application/octet-stream";
  if (blob.type === type) return URL.createObjectURL(blob);
  return URL.createObjectURL(new Blob([blob], { type }));
}

export async function resolvePdfPreviewObjectUrl(
  fileUrl: string,
  contentType?: string | null,
  options?: LoadAttachmentBlobOptions,
): Promise<string | null> {
  const blob = await loadAttachmentBlobForPreview(fileUrl, contentType, options);
  if (!blob) return null;
  return createPreviewObjectUrl(blob, contentType);
}

/**
 * `missing`     — the bytes are not in storage (orphaned attachment row).
 * `unsupported` — the bytes ARE here, but this browser cannot decode them into an <img>.
 *
 * Keeping these apart is the whole point: the dialog used to collapse both into
 * "This file is no longer available in storage", which told a user staring at a
 * perfectly intact HEIC receipt that their file had been lost during migration.
 */
export type ImagePreviewStatus = "ok" | "missing" | "unsupported";

export type ImagePreviewSource = {
  status: ImagePreviewStatus;
  /** Renderable source for <img>. Only set when status === "ok". */
  objectUrl: string | null;
  /** The untouched original, always set when the file exists — for download / new tab. */
  originalObjectUrl: string | null;
};

export async function resolveImagePreviewSource(
  fileUrl: string,
  contentType?: string | null,
  options?: LoadAttachmentBlobOptions,
): Promise<ImagePreviewSource> {
  const loaded = await loadAttachmentForPreview(fileUrl, contentType, options);
  if (!loaded) return { status: "missing", objectUrl: null, originalObjectUrl: null };

  const { blob, storagePath } = loaded;
  const originalObjectUrl = createPreviewObjectUrl(blob, contentType);

  const heic = isHeicAttachment(fileUrl, contentType) || (await blobLooksLikeHeic(blob));
  if (!heic) return { status: "ok", objectUrl: originalObjectUrl, originalObjectUrl };

  // Safari and iOS decode HEIC themselves — hand them the original and skip every decoder,
  // which is both faster and the only client-side path that works when eval is barred.
  if (await browserDecodesNatively(blob)) {
    return { status: "ok", objectUrl: originalObjectUrl, originalObjectUrl };
  }

  // Server-side rendition. Tried before the in-browser decoder because under the production
  // CSP that decoder cannot run at all, and because a rendition already on disk is the
  // cheapest source available — a plain cacheable GET with no function invocation.
  if (storagePath) {
    const cached = await fetchDerivedRendition(storagePath);
    if (cached) {
      return { status: "ok", objectUrl: URL.createObjectURL(cached), originalObjectUrl };
    }

    const converted = await requestServerRendition(storagePath);
    if (converted) {
      return { status: "ok", objectUrl: URL.createObjectURL(converted), originalObjectUrl };
    }
  }

  const jpeg = await convertHeicBlobToJpeg(blob);
  if (!jpeg) {
    // Nothing could decode it: the server function is unavailable and CSP bars
    // `new Function` (or the file is corrupt). The bytes are still intact, so hand back the
    // original for download / new tab and let the caller say so — never "this file is gone".
    return { status: "unsupported", objectUrl: null, originalObjectUrl };
  }

  return {
    status: "ok",
    objectUrl: URL.createObjectURL(jpeg),
    originalObjectUrl,
  };
}

export async function resolveImagePreviewObjectUrl(
  fileUrl: string,
  contentType?: string | null,
  options?: LoadAttachmentBlobOptions,
): Promise<string | null> {
  const result = await resolveImagePreviewSource(fileUrl, contentType, options);
  if (result.status === "ok") return result.objectUrl;
  // Nothing renderable came back, so the caller will never hold the original — revoke it
  // here rather than leaking one object URL per failed preview.
  if (result.originalObjectUrl?.startsWith("blob:")) {
    URL.revokeObjectURL(result.originalObjectUrl);
  }
  return null;
}
