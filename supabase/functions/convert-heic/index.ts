/**
 * convert-heic — produce a browser-renderable rendition of a HEIC/HEIF receipt.
 *
 * WHY THIS EXISTS
 * HEIC is the iPhone camera default and no Chromium or Firefox build decodes it in an
 * <img>. The browser-side decoder cannot rescue that here either: `heic2any` decodes inside
 * a blob Worker whose libheif glue calls `new Function`, and the production CSP carries no
 * 'unsafe-eval', so the worker dies and its promise never settles.
 *
 * WHY THE DECODE IS NO LONGER DONE HERE
 * The first implementation decoded HEIC in this isolate with `heic-decode` and re-encoded
 * with `jpeg-js`. That architecture cannot work at any plausible memory limit. The
 * controlled receipt is 3768 × 5800 = 21.9 MP, which is 83 MB of RGBA before libheif's own
 * copy in the wasm heap and before the JPEG encoder's working buffers — against a 150 MB
 * per-worker cap. The supervisor OOM-killed the worker, which is why the caller saw a bare
 * 500 with no JSON body and none of the typed error codes ever appeared.
 *
 * Removing an extra frame copy narrowed the gap but could never close it: the
 * full-resolution decode inside a sandboxed JS heap IS the problem.
 *
 * Supabase Storage already fronts imgproxy, which decodes HEIC natively through
 * libvips/libheif — streaming, downscaling, and never materialising a full RGBA frame in a
 * JS heap. imgproxy's own log proved the capability is present: it measured the file and
 * rejected it on `IMGPROXY_MAX_SRC_RESOLUTION`, not on format support.
 *
 * So this function no longer decodes anything. It authorises the caller, validates the
 * path, asks Storage for a bounded rendition, and stores the bytes it gets back. Peak
 * memory here is now one compressed original plus one compressed rendition.
 *
 * NOT A GENERAL IMAGE CONVERTER. It accepts an object key inside the receipts bucket only
 * — never a URL — and refuses any input whose bytes are not actually HEIC. Without both
 * checks this would be an open conversion proxy pointed at arbitrary content.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

type ConvertHeicRequest = {
  /** Object key inside the receipts bucket, e.g. `<expenseId>/1782737966702-abc.heic`. */
  storage_path?: string;
};

type ConvertHeicResponse = {
  ok: boolean;
  public_url?: string;
  storage_path?: string;
  cached?: boolean;
  content_type?: string;
  width?: number;
  height?: number;
  errorCode?:
    | "UNAUTHORIZED"
    | "INVALID_PATH"
    | "NOT_FOUND"
    | "NOT_HEIC"
    | "INPUT_TOO_LARGE"
    | "TRANSFORM_FAILED"
    | "UPLOAD_FAILED"
    | "SERVER_ERROR";
  message?: string;
};

const BUCKET = "receipts";
const DERIVED_PREFIX = "derived";
const MAX_INPUT_BYTES = 50 * 1024 * 1024;
/** A rendition bounded at 2000px/q82 that exceeds this is not a receipt preview. */
const MAX_OUTPUT_BYTES = 15 * 1024 * 1024;

/** Bounded receipt-preview output. Large enough to read a bill, small enough to send. */
const TRANSFORM = { width: 2000, height: 2000, resize: "contain", quality: 82 } as const;

function json(status: number, body: ConvertHeicResponse): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * Structured, deliberately sparse logging. No Authorization header, no JWT, no service-role
 * key, no signed URL, no public URL, no employee or expense data. The storage path is
 * reduced to a short non-reversible digest so two log lines can be correlated without the
 * path itself — which identifies an expense and its owner — ever being written down.
 */
async function pathDigest(path: string): Promise<string> {
  try {
    const bytes = new TextEncoder().encode(path);
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(hash).slice(0, 6))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return "unknown";
  }
}

function logStage(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ fn: "convert-heic", ...fields }));
}

/**
 * Accept only a plain object key inside the bucket. Rejects absolute URLs, protocol
 * prefixes, parent traversal, absolute paths and anything already under the derived prefix
 * (which would let a caller nest renditions of renditions).
 */
function normalizeStoragePath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const path = raw.trim();
  if (!path || path.length > 1024) return null;
  if (path.includes("://") || path.startsWith("/") || path.startsWith("\\")) return null;
  if (path.split("/").some((segment) => segment === "." || segment === "..")) return null;
  if (path.startsWith(`${DERIVED_PREFIX}/`)) return null;
  return path;
}

/**
 * ISO-BMFF brands that mean "HEIF-family still image". Checked against the actual bytes,
 * because the recorded content_type for a .heic upload is routinely empty or
 * application/octet-stream and cannot be trusted as the gate.
 */
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

function looksLikeHeic(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const ascii = (start: number, end: number) =>
    String.fromCharCode(...Array.from(bytes.subarray(start, end)));
  if (ascii(4, 8) !== "ftyp") return false;
  return HEIC_FTYP_BRANDS.has(ascii(8, 12).toLowerCase());
}

/** Renditions are keyed off the original path, with the extension the bytes actually are. */
function derivedPathFor(storagePath: string, ext: "jpg" | "webp"): string {
  return `${DERIVED_PREFIX}/${storagePath}.${ext}`;
}

/**
 * `IMGPROXY_AUTO_WEBP=true` on this deployment, so the rendition format depends on content
 * negotiation and must never be assumed. Storing WebP bytes under `.jpg` with an
 * `image/jpeg` content type would produce an object every client mis-decodes.
 */
function extensionForContentType(contentType: string): "jpg" | "webp" | null {
  const ct = contentType.toLowerCase().split(";")[0].trim();
  if (ct === "image/jpeg" || ct === "image/jpg") return "jpg";
  if (ct === "image/webp") return "webp";
  return null;
}

function isHeicContentType(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  return ct.includes("heic") || ct.includes("heif");
}

Deno.serve(async (req) => {
  const startedAt = Date.now();
  const requestId = crypto.randomUUID();

  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return json(405, { ok: false, errorCode: "SERVER_ERROR", message: "Method not allowed" });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      return json(500, { ok: false, errorCode: "SERVER_ERROR", message: "Server misconfiguration" });
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return json(401, { ok: false, errorCode: "UNAUTHORIZED", message: "Missing authorization token" });
    }
    const jwt = authHeader.replace("Bearer ", "");

    const body = (await req.json()) as ConvertHeicRequest;
    const storagePath = normalizeStoragePath(body.storage_path);
    if (!storagePath) {
      return json(400, { ok: false, errorCode: "INVALID_PATH", message: "Invalid storage path" });
    }
    const pathRef = await pathDigest(storagePath);

    const serviceClient = createClient(supabaseUrl, serviceRoleKey);

    // Same gate as compress-upload: a valid user belonging to an active organization.
    const { data: authData, error: authError } = await serviceClient.auth.getUser(jwt);
    if (authError || !authData.user) {
      return json(401, { ok: false, errorCode: "UNAUTHORIZED", message: "Invalid token" });
    }
    const { data: membership } = await serviceClient
      .from("organization_memberships")
      .select("organization_id")
      .eq("user_id", authData.user.id)
      .eq("is_active", true)
      .limit(1);
    if (!membership?.length) {
      return json(403, { ok: false, errorCode: "UNAUTHORIZED", message: "Organization membership required" });
    }

    const publicUrlFor = (path: string) =>
      serviceClient.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;

    // ── cache ────────────────────────────────────────────────────────────────
    // JPEG first: renditions created before WebP was possible must stay valid, so a legacy
    // `.jpg` always wins over producing a second copy in another format.
    for (const ext of ["jpg", "webp"] as const) {
      const candidate = derivedPathFor(storagePath, ext);
      const { data: existing } = await serviceClient.storage.from(BUCKET).download(candidate);
      if (existing && existing.size > 0) {
        logStage({ requestId, stage: "cache_hit", pathRef, ext, elapsedMs: Date.now() - startedAt });
        return json(200, {
          ok: true,
          cached: true,
          storage_path: candidate,
          public_url: publicUrlFor(candidate),
          content_type: ext === "jpg" ? "image/jpeg" : "image/webp",
        });
      }
    }

    // ── original ─────────────────────────────────────────────────────────────
    const { data: original, error: downloadError } = await serviceClient.storage
      .from(BUCKET)
      .download(storagePath);
    if (downloadError || !original) {
      logStage({ requestId, stage: "original_missing", pathRef, elapsedMs: Date.now() - startedAt });
      return json(404, { ok: false, errorCode: "NOT_FOUND", message: "Attachment not found in storage" });
    }
    if (original.size > MAX_INPUT_BYTES) {
      return json(400, { ok: false, errorCode: "INPUT_TOO_LARGE", message: "Attachment too large" });
    }

    // Only the first bytes are inspected. The full original is never expanded to pixels.
    const header = new Uint8Array(await original.slice(0, 16).arrayBuffer());
    if (!looksLikeHeic(header)) {
      // Anything already renderable does not belong here — the client previews it directly.
      return json(400, { ok: false, errorCode: "NOT_HEIC", message: "Attachment is not a HEIC/HEIF image" });
    }

    // ── native transformation ────────────────────────────────────────────────
    // Storage fronts imgproxy, which decodes HEIC in native code. `format=origin` is
    // deliberately NOT requested: the origin is HEIC, which is the thing browsers cannot
    // render. Accept advertises both renderable formats and the RESPONSE decides.
    const transformUrl =
      `${supabaseUrl}/storage/v1/render/image/authenticated/${BUCKET}/` +
      `${storagePath.split("/").map(encodeURIComponent).join("/")}` +
      `?width=${TRANSFORM.width}&height=${TRANSFORM.height}` +
      `&resize=${TRANSFORM.resize}&quality=${TRANSFORM.quality}`;

    let transformed: Response;
    try {
      transformed = await fetch(transformUrl, {
        headers: {
          Authorization: `Bearer ${serviceRoleKey}`,
          apikey: serviceRoleKey,
          Accept: "image/jpeg,image/webp",
        },
      });
    } catch (error) {
      logStage({ requestId, stage: "transform_network_error", pathRef, elapsedMs: Date.now() - startedAt });
      return json(422, {
        ok: false,
        errorCode: "TRANSFORM_FAILED",
        message: `Transformation unreachable: ${error instanceof Error ? error.message : "unknown error"}`,
      });
    }

    if (!transformed.ok) {
      // The common real failure is imgproxy's source-resolution ceiling. Typed, not a 500 —
      // the function is alive and has a definite answer.
      logStage({
        requestId,
        stage: "transform_rejected",
        pathRef,
        status: transformed.status,
        inputBytes: original.size,
        elapsedMs: Date.now() - startedAt,
      });
      return json(422, {
        ok: false,
        errorCode: "TRANSFORM_FAILED",
        message: `Image transformation returned ${transformed.status}`,
      });
    }

    const outputContentType = transformed.headers.get("content-type") ?? "";
    if (isHeicContentType(outputContentType)) {
      return json(422, {
        ok: false,
        errorCode: "TRANSFORM_FAILED",
        message: "Transformation returned HEIC, which is not browser-renderable",
      });
    }
    const ext = extensionForContentType(outputContentType);
    if (!outputContentType.startsWith("image/") || !ext) {
      return json(422, {
        ok: false,
        errorCode: "TRANSFORM_FAILED",
        message: `Transformation returned unusable content type: ${outputContentType || "none"}`,
      });
    }

    const renditionBytes = new Uint8Array(await transformed.arrayBuffer());
    if (renditionBytes.byteLength === 0) {
      return json(422, {
        ok: false,
        errorCode: "TRANSFORM_FAILED",
        message: "Transformation returned an empty body",
      });
    }
    if (renditionBytes.byteLength > MAX_OUTPUT_BYTES) {
      return json(422, {
        ok: false,
        errorCode: "TRANSFORM_FAILED",
        message: "Transformation output exceeded the derived size cap",
      });
    }

    // ── store ────────────────────────────────────────────────────────────────
    const derivedPath = derivedPathFor(storagePath, ext);
    const storedContentType = ext === "jpg" ? "image/jpeg" : "image/webp";

    const { error: uploadError } = await serviceClient.storage
      .from(BUCKET)
      .upload(derivedPath, renditionBytes, {
        contentType: storedContentType,
        // Renditions are deterministic, so replacing one is always safe and makes a
        // partially-written object self-healing on the next request. The ORIGINAL is a
        // different key and is never written or removed by this function.
        upsert: true,
        cacheControl: "31536000",
      });
    if (uploadError) {
      logStage({ requestId, stage: "upload_failed", pathRef, elapsedMs: Date.now() - startedAt });
      return json(500, {
        ok: false,
        errorCode: "UPLOAD_FAILED",
        message: `Could not store converted image: ${uploadError.message}`,
      });
    }

    logStage({
      requestId,
      stage: "converted",
      pathRef,
      inputBytes: original.size,
      outputBytes: renditionBytes.byteLength,
      outputContentType: storedContentType,
      cached: false,
      elapsedMs: Date.now() - startedAt,
    });

    return json(200, {
      ok: true,
      cached: false,
      storage_path: derivedPath,
      public_url: publicUrlFor(derivedPath),
      content_type: storedContentType,
    });
  } catch (error) {
    logStage({ requestId, stage: "unhandled", elapsedMs: Date.now() - startedAt });
    return json(500, {
      ok: false,
      errorCode: "SERVER_ERROR",
      message: error instanceof Error ? error.message : "Unexpected error",
    });
  }
});
