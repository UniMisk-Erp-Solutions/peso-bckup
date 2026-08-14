/**
 * HEIC/HEIF receipt preview.
 *
 * HEIC is the iPhone camera default, and no Chromium or Firefox build can decode it in
 * an <img>. Uploads have been converted to JPEG since `uploadCompression.ts` landed, but
 * two populations of raw HEIC still reach the preview:
 *   a) receipts uploaded before that conversion existed, and
 *   b) uploads where conversion failed — that branch deliberately stores the ORIGINAL
 *      file (`failureReason: "heic-convert-failed"`) rather than losing the receipt.
 *
 * Both used to land on the <img> onError handler, which set the same flag as "the bytes
 * are not in storage" — so an intact HEIC receipt was reported to the user as
 * "This file is no longer available in storage." These tests pin the two apart.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const heic2any = vi.fn();
const invokeFunction = vi.fn();

vi.mock("heic2any", () => ({ default: (...a: unknown[]) => heic2any(...a) }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    storage: {
      from: () => ({
        getPublicUrl: (path: string) => ({
          data: { publicUrl: `https://sb.example.com/storage/v1/object/public/receipts/${path}` },
        }),
        download: async () => ({ data: null, error: new Error("Object not found") }),
        createSignedUrl: async () => ({ data: null, error: new Error("Object not found") }),
      }),
    },
    functions: { invoke: (...a: unknown[]) => invokeFunction(...a) },
  },
}));

import { isHeicAttachment, resolveImagePreviewSource } from "@/lib/attachmentPreview";

const BASE = "https://sb.example.com/storage/v1/object/public/receipts";

/**
 * A minimal ISO-BMFF header: 4-byte size, "ftyp", then the brand. This is what the
 * resolver sniffs, and it is the only signal available when storage reports the file
 * as application/octet-stream (routine for .heic, whose MIME the browser often leaves
 * empty at upload time).
 */
function heicBytes(brand = "heic"): Uint8Array {
  const header = [0, 0, 0, 24];
  const ascii = (s: string) => Array.from(s).map((c) => c.charCodeAt(0));
  return new Uint8Array([...header, ...ascii("ftyp"), ...ascii(brand), 0, 0, 0, 0]);
}

/**
 * Serve one blob for the original object, and 404 the `derived/` rendition — i.e. a receipt
 * that has never been converted server-side. Distinguishing the two paths matters: the
 * resolver probes for an existing rendition before decoding anything, so a stub that
 * answered every URL would make every case look like a cache hit.
 */
function serve(bytes: BlobPart, type: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      String(url).includes("/receipts/derived/")
        ? { ok: false, status: 404 }
        : { ok: true, blob: async () => new Blob([bytes], { type }) },
    ),
  );
}

/** As `serve`, but the server-side JPEG rendition already exists. */
function serveWithRendition(bytes: BlobPart, type: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      String(url).includes("/receipts/derived/")
        ? { ok: true, blob: async () => new Blob(["server-jpeg"], { type: "image/jpeg" }) }
        : { ok: true, blob: async () => new Blob([bytes], { type }) },
    ),
  );
}

function serveNothing() {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 400 })));
}

let created: string[] = [];
let revoked: string[] = [];

beforeEach(() => {
  heic2any.mockReset();
  invokeFunction.mockReset();
  // Default: the edge function is unreachable, so cases that don't opt in exercise the
  // pre-existing client-side behaviour rather than silently depending on the server.
  invokeFunction.mockResolvedValue({ data: null, error: new Error("not deployed") });
  vi.unstubAllGlobals();
  created = [];
  revoked = [];
  let n = 0;
  URL.createObjectURL = vi.fn(() => {
    const u = `blob:obj-${++n}`;
    created.push(u);
    return u;
  }) as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn((u: string) => {
    revoked.push(u);
  }) as unknown as typeof URL.revokeObjectURL;
});

describe("isHeicAttachment", () => {
  it("matches on content type", () => {
    expect(isHeicAttachment(`${BASE}/e1/a.bin`, "image/heic")).toBe(true);
    expect(isHeicAttachment(`${BASE}/e1/a.bin`, "image/heif")).toBe(true);
    expect(isHeicAttachment(`${BASE}/e1/a.bin`, "image/heic; charset=binary")).toBe(true);
  });

  it("matches on extension when the content type is unhelpful", () => {
    expect(isHeicAttachment(`${BASE}/e1/IMG_0001.HEIC`, "application/octet-stream")).toBe(true);
    expect(isHeicAttachment(`${BASE}/e1/IMG_0001.heif`, "")).toBe(true);
    expect(isHeicAttachment(`${BASE}/e1/IMG_0001.heic?token=x`, null)).toBe(true);
  });

  it("does not claim ordinary images", () => {
    expect(isHeicAttachment(`${BASE}/e1/a.png`, "image/png")).toBe(false);
    expect(isHeicAttachment(`${BASE}/e1/a.jpg`, "image/jpeg")).toBe(false);
  });
});

describe("resolveImagePreviewSource — HEIC", () => {
  it("converts a HEIC receipt to JPEG so an <img> can render it", async () => {
    serve(heicBytes(), "image/heic");
    heic2any.mockResolvedValue(new Blob(["jpeg-bytes"], { type: "image/jpeg" }));

    const result = await resolveImagePreviewSource(`${BASE}/e1/IMG_0001.heic`, "image/heic");

    expect(heic2any).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("ok");
    expect(result.objectUrl).not.toBeNull();
    // The renderable source is the CONVERTED file; the original stays available so
    // Download and Open in new tab still hand back the real receipt.
    expect(result.objectUrl).not.toBe(result.originalObjectUrl);
    expect(result.originalObjectUrl).not.toBeNull();
  });

  it("detects HEIC from magic bytes when storage reports octet-stream", async () => {
    // The common production shape: neither the extension nor the recorded MIME says heic.
    serve(heicBytes("mif1"), "application/octet-stream");
    heic2any.mockResolvedValue(new Blob(["jpeg-bytes"], { type: "image/jpeg" }));

    const result = await resolveImagePreviewSource(
      `${BASE}/e1/receipt-1782737966702`,
      "application/octet-stream",
    );

    expect(heic2any).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("ok");
  });

  it("reports unsupported — NOT missing — when decoding fails", async () => {
    serve(heicBytes(), "image/heic");
    heic2any.mockRejectedValue(new Error("wasm blocked by CSP"));

    const result = await resolveImagePreviewSource(`${BASE}/e1/IMG_0001.heic`, "image/heic");

    expect(result.status).toBe("unsupported");
    expect(result.objectUrl).toBeNull();
    // This is the whole point: the bytes are here, so the user must still be able to
    // open or download them rather than being told the receipt was lost.
    expect(result.originalObjectUrl).not.toBeNull();
  });

  it("treats an empty conversion result as unsupported", async () => {
    serve(heicBytes(), "image/heic");
    heic2any.mockResolvedValue(new Blob([], { type: "image/jpeg" }));

    const result = await resolveImagePreviewSource(`${BASE}/e1/IMG_0001.heic`, "image/heic");

    expect(result.status).toBe("unsupported");
    expect(result.originalObjectUrl).not.toBeNull();
  });

  it("unwraps the array heic2any returns for burst / live-photo containers", async () => {
    serve(heicBytes(), "image/heic");
    heic2any.mockResolvedValue([
      new Blob(["frame-1"], { type: "image/jpeg" }),
      new Blob(["frame-2"], { type: "image/jpeg" }),
    ]);

    const result = await resolveImagePreviewSource(`${BASE}/e1/IMG_0001.heic`, "image/heic");

    expect(result.status).toBe("ok");
    expect(result.objectUrl).not.toBeNull();
  });

  it("still reports missing when the bytes really are gone", async () => {
    serveNothing();

    const result = await resolveImagePreviewSource(`${BASE}/e1/IMG_0001.heic`, "image/heic");

    expect(result.status).toBe("missing");
    expect(result.objectUrl).toBeNull();
    expect(result.originalObjectUrl).toBeNull();
    expect(heic2any).not.toHaveBeenCalled();
  });
});

/**
 * Production incident: the preview sat on "Loading image…" forever.
 *
 * heic2any decodes inside a blob Worker whose libheif glue calls `new Function`. The
 * enforced CSP is `script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com`
 * with no 'unsafe-eval', so that call threw EvalError inside the worker, the worker died
 * without posting a result, and heic2any's promise NEVER SETTLED — neither resolving nor
 * rejecting. The resolver awaited it, so the dialog's `.finally` never ran and the spinner
 * never cleared. A try/catch cannot save you from a promise that simply never completes.
 */
describe("resolveImagePreviewSource — must never hang", () => {
  // Each case needs its own URL: `KNOWN_MISSING_RECEIPTS` is a module-level negative cache
  // that survives between tests, so a URL any earlier test proved missing stays missing.
  it("gives up on a decoder that never settles instead of awaiting forever", async () => {
    vi.useFakeTimers();
    try {
      serve(heicBytes(), "image/heic");
      // Exactly the production failure: a promise that never resolves and never rejects.
      heic2any.mockReturnValue(new Promise(() => {}));

      const pending = resolveImagePreviewSource(`${BASE}/e1/IMG_HANG.heic`, "image/heic");
      await vi.advanceTimersByTimeAsync(25_000);
      const result = await pending;

      expect(result.status).toBe("unsupported");
      expect(result.originalObjectUrl).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips the decoder entirely when CSP bars new Function", async () => {
    serve(heicBytes(), "image/heic");
    const realFunction = globalThis.Function;
    // Reproduces a document without 'unsafe-eval': constructing a function throws.
    const blocked = function () {
      throw new EvalError("blocked by CSP");
    } as unknown as FunctionConstructor;
    globalThis.Function = blocked;

    try {
      const result = await resolveImagePreviewSource(`${BASE}/e1/IMG_CSPBLOCKED.heic`, "image/heic");

      expect(result.status).toBe("unsupported");
      expect(result.originalObjectUrl).not.toBeNull();
      // The point of the probe: no decoder chunk fetched, no timeout waited out.
      expect(heic2any).not.toHaveBeenCalled();
    } finally {
      globalThis.Function = realFunction;
    }
  });

  it("uses the original when the browser decodes HEIC natively (Safari / iOS)", async () => {
    serve(heicBytes(), "image/heic");
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ close: vi.fn() })),
    );

    const result = await resolveImagePreviewSource(`${BASE}/e1/IMG_NATIVE.heic`, "image/heic");

    expect(result.status).toBe("ok");
    expect(result.objectUrl).toBe(result.originalObjectUrl);
    expect(heic2any).not.toHaveBeenCalled();
  });
});

/**
 * Server-side rendition via the `convert-heic` edge function.
 *
 * This is what actually makes HEIC visible in Chromium and Firefox: CSP is a browser-only
 * policy, so decoding in Deno sidesteps the `new Function` block entirely. The JPEG is
 * written to `derived/<path>.jpg`, so each receipt is decoded ONCE, not once per view.
 */
describe("resolveImagePreviewSource — server rendition", () => {
  it("uses an existing rendition without invoking the function or the decoder", async () => {
    serveWithRendition(heicBytes(), "image/heic");

    const result = await resolveImagePreviewSource(`${BASE}/e1/IMG_CACHED.heic`, "image/heic");

    expect(result.status).toBe("ok");
    expect(result.objectUrl).not.toBe(result.originalObjectUrl);
    // The whole point of caching: a converted receipt costs one plain GET thereafter.
    expect(invokeFunction).not.toHaveBeenCalled();
    expect(heic2any).not.toHaveBeenCalled();
  });

  it("invokes convert-heic when no rendition exists yet", async () => {
    serve(heicBytes(), "image/heic");
    invokeFunction.mockImplementation(async () => {
      // Once the function has run the rendition exists, so reading it back succeeds.
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: true,
          blob: async () => new Blob(["server-jpeg"], { type: "image/jpeg" }),
        })),
      );
      return {
        data: { ok: true, public_url: `${BASE}/derived/e1/IMG_FRESH.heic.jpg` },
        error: null,
      };
    });

    const result = await resolveImagePreviewSource(`${BASE}/e1/IMG_FRESH.heic`, "image/heic");

    expect(invokeFunction).toHaveBeenCalledWith("convert-heic", {
      body: { storage_path: "e1/IMG_FRESH.heic" },
    });
    expect(result.status).toBe("ok");
    expect(heic2any).not.toHaveBeenCalled();
  });

  it("keys the rendition off the path the bytes were actually found at", async () => {
    // The stored path is a stale temp/ path; the object really lives under the expense id.
    // Filing the rendition against the stored path would point at nothing.
    const USER = "22ba24a5-40dc-4618-a2de-098974237111";
    const EXPENSE = "361fbbcc-6ada-4442-8848-ba0d59b74169";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes("/receipts/derived/")) return { ok: false, status: 404 };
        if (u.includes(`/receipts/${EXPENSE}/`)) {
          return { ok: true, blob: async () => new Blob([heicBytes()], { type: "image/heic" }) };
        }
        return { ok: false, status: 400 };
      }),
    );

    await resolveImagePreviewSource(`${BASE}/temp/${USER}/IMG_MOVED.heic`, "image/heic", {
      fallbackTempUserId: USER,
      fallbackExpenseId: EXPENSE,
    });

    expect(invokeFunction).toHaveBeenCalledWith("convert-heic", {
      body: { storage_path: `${EXPENSE}/IMG_MOVED.heic` },
    });
  });

  it("degrades to unsupported when the function is not deployed", async () => {
    serve(heicBytes(), "image/heic");
    // Default mock already rejects. CSP-blocked browsers then have nothing left.
    const realFunction = globalThis.Function;
    globalThis.Function = function () {
      throw new EvalError("blocked by CSP");
    } as unknown as FunctionConstructor;

    try {
      const result = await resolveImagePreviewSource(`${BASE}/e1/IMG_NOFN.heic`, "image/heic");

      expect(result.status).toBe("unsupported");
      expect(result.originalObjectUrl).not.toBeNull();
    } finally {
      globalThis.Function = realFunction;
    }
  });
});

/**
 * Rendition extensions. The deployment runs `IMGPROXY_AUTO_WEBP=true`, so the server-side
 * transformation's output format is decided by content negotiation and cannot be assumed.
 * The client therefore probes both — JPEG first, so renditions created before WebP was
 * possible are never bypassed in favour of producing a second copy.
 */
describe("resolveImagePreviewSource — rendition extensions", () => {
  function serveOnlyExt(ext: "jpg" | "webp", seen: string[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes("/receipts/derived/")) {
          seen.push(u.endsWith(".webp") ? "webp" : "jpg");
          return u.endsWith(`.${ext}`)
            ? { ok: true, blob: async () => new Blob(["rendition"], { type: `image/${ext}` }) }
            : { ok: false, status: 400 };
        }
        return { ok: true, blob: async () => new Blob([heicBytes()], { type: "image/heic" }) };
      }),
    );
  }

  it("uses a legacy .jpg rendition and never looks further", async () => {
    const seen: string[] = [];
    serveOnlyExt("jpg", seen);

    const result = await resolveImagePreviewSource(`${BASE}/e1/IMG_LEGACY.heic`, "image/heic");

    expect(result.status).toBe("ok");
    expect(seen).toEqual(["jpg"]);
    expect(invokeFunction).not.toHaveBeenCalled();
  });

  it("falls through to a .webp rendition when no .jpg exists", async () => {
    const seen: string[] = [];
    serveOnlyExt("webp", seen);

    const result = await resolveImagePreviewSource(`${BASE}/e1/IMG_WEBP.heic`, "image/heic");

    expect(result.status).toBe("ok");
    // Order matters: the legacy extension must be asked for first.
    expect(seen).toEqual(["jpg", "webp"]);
    expect(invokeFunction).not.toHaveBeenCalled();
  });

  it("invokes the function only when neither rendition exists", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes("/receipts/derived/")) {
          seen.push(u.endsWith(".webp") ? "webp" : "jpg");
          return { ok: false, status: 400 };
        }
        return { ok: true, blob: async () => new Blob([heicBytes()], { type: "image/heic" }) };
      }),
    );

    await resolveImagePreviewSource(`${BASE}/e1/IMG_NONE.heic`, "image/heic");

    expect(seen).toEqual(["jpg", "webp"]);
    expect(invokeFunction).toHaveBeenCalledWith("convert-heic", {
      body: { storage_path: "e1/IMG_NONE.heic" },
    });
  });

  it("keeps the ORIGINAL available for download when a rendition renders", async () => {
    serveOnlyExt("webp", []);

    const result = await resolveImagePreviewSource(`${BASE}/e1/IMG_DL.heic`, "image/heic");

    // Download and Open in new tab must hand back the real uploaded HEIC, never the
    // converted stand-in.
    expect(result.originalObjectUrl).not.toBeNull();
    expect(result.objectUrl).not.toBe(result.originalObjectUrl);
  });
});

/**
 * The function's `public_url` is NOT trusted.
 *
 * `getPublicUrl()` inside the Edge Runtime resolves against that runtime's `SUPABASE_URL`,
 * which on this self-hosted deployment is the INTERNAL Docker address
 * `http://supabase-kong:8000`. A browser cannot resolve that host, so fetching the returned
 * URL verbatim fails even though the rendition was created correctly and is publicly
 * readable. The symptom was subtle: the FIRST open of a freshly converted receipt failed,
 * and a later reopen succeeded — because the reopen used the direct `derived/` probe, which
 * never involves the function's URL.
 *
 * These drive the real resolver, not source strings.
 */
describe("resolveImagePreviewSource — rendition URL contract", () => {
  const INTERNAL = "http://supabase-kong:8000/storage/v1/object/public/receipts";
  const PUBLIC = "https://sb.example.com/storage/v1/object/public/receipts";

  /** Original resolves; derived probes miss; only `allowedUrl` serves the rendition. */
  function serveConversion(allowedUrl: string, fetched: string[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        fetched.push(u);
        if (u === allowedUrl) {
          return { ok: true, blob: async () => new Blob(["webp"], { type: "image/webp" }) };
        }
        if (u.includes("/receipts/derived/")) return { ok: false, status: 400 };
        return { ok: true, blob: async () => new Blob([heicBytes()], { type: "image/heic" }) };
      }),
    );
  }

  it("renders on the FIRST open despite an internal Kong public_url", async () => {
    const key = "derived/e1/IMG_KONG.heic.webp";
    const fetched: string[] = [];
    serveConversion(`${PUBLIC}/${key}`, fetched);
    invokeFunction.mockResolvedValue({
      data: { ok: true, cached: false, storage_path: key, public_url: `${INTERNAL}/${key}` },
      error: null,
    });

    const result = await resolveImagePreviewSource(`${BASE}/e1/IMG_KONG.heic`, "image/heic");

    // No close-and-reopen, no refresh: the same dialog session gets a renderable source.
    expect(result.status).toBe("ok");
    expect(result.objectUrl).not.toBeNull();
    // The internal host must never be requested.
    expect(fetched.some((u) => u.includes("supabase-kong"))).toBe(false);
    expect(fetched).toContain(`${PUBLIC}/${key}`);
  });

  it("succeeds from storage_path alone, with no public_url at all", async () => {
    const key = "derived/e1/IMG_PATHONLY.heic.webp";
    const fetched: string[] = [];
    serveConversion(`${PUBLIC}/${key}`, fetched);
    invokeFunction.mockResolvedValue({
      data: { ok: true, cached: false, storage_path: key },
      error: null,
    });

    const result = await resolveImagePreviewSource(`${BASE}/e1/IMG_PATHONLY.heic`, "image/heic");
    expect(result.status).toBe("ok");
  });

  it("accepts a .jpg rendition path as well as .webp", async () => {
    const key = "derived/e1/IMG_JPGPATH.heic.jpg";
    const fetched: string[] = [];
    serveConversion(`${PUBLIC}/${key}`, fetched);
    invokeFunction.mockResolvedValue({
      data: { ok: true, cached: true, storage_path: key },
      error: null,
    });

    const result = await resolveImagePreviewSource(`${BASE}/e1/IMG_JPGPATH.heic`, "image/heic");
    expect(result.status).toBe("ok");
  });

  it.each([
    ["outside derived/", "uploads/e1/evil.webp"],
    ["parent traversal", "derived/../../etc/passwd.webp"],
    ["an embedded URL", "derived/https://evil.example.com/x.webp"],
    ["an unsupported extension", "derived/e1/IMG.heic.svg"],
    ["a non-string", 42],
  ])("rejects a storage_path %s", async (_label, badPath) => {
    const fetched: string[] = [];
    serveConversion("never-served", fetched);
    invokeFunction.mockResolvedValue({
      data: { ok: true, cached: false, storage_path: badPath },
      error: null,
    });

    const result = await resolveImagePreviewSource(`${BASE}/e1/IMG_BAD.heic`, "image/heic");

    // The original bytes exist, so this is unsupported — never "missing".
    expect(result.status).toBe("unsupported");
    expect(result.originalObjectUrl).not.toBeNull();
    expect(fetched.some((u) => u.includes("evil.example.com"))).toBe(false);
    expect(fetched.some((u) => u.includes("etc/passwd"))).toBe(false);
  });

  it("normalises a legacy internal public_url to the browser origin when no path is given", async () => {
    const key = "derived/e1/IMG_LEGACYURL.heic.jpg";
    const fetched: string[] = [];
    serveConversion(`${PUBLIC}/${key}`, fetched);
    invokeFunction.mockResolvedValue({
      data: { ok: true, cached: false, public_url: `${INTERNAL}/${key}` },
      error: null,
    });

    const result = await resolveImagePreviewSource(`${BASE}/e1/IMG_LEGACYURL.heic`, "image/heic");

    expect(result.status).toBe("ok");
    expect(fetched.some((u) => u.includes("supabase-kong"))).toBe(false);
  });

  it("never fetches an arbitrary external public_url unchanged", async () => {
    const fetched: string[] = [];
    serveConversion("never-served", fetched);
    invokeFunction.mockResolvedValue({
      data: { ok: true, cached: false, public_url: "https://attacker.example.com/payload.jpg" },
      error: null,
    });

    await resolveImagePreviewSource(`${BASE}/e1/IMG_EXTERNAL.heic`, "image/heic");

    expect(fetched.some((u) => u.includes("attacker.example.com"))).toBe(false);
  });

  it("keeps the ORIGINAL as the download/open target after a server conversion", async () => {
    const key = "derived/e1/IMG_ORIG.heic.webp";
    const fetched: string[] = [];
    serveConversion(`${PUBLIC}/${key}`, fetched);
    invokeFunction.mockResolvedValue({
      data: { ok: true, cached: false, storage_path: key },
      error: null,
    });

    const result = await resolveImagePreviewSource(`${BASE}/e1/IMG_ORIG.heic`, "image/heic");

    expect(result.originalObjectUrl).not.toBeNull();
    expect(result.objectUrl).not.toBe(result.originalObjectUrl);
  });

  it("reports unsupported — not missing — when the rendition fetch fails", async () => {
    const fetched: string[] = [];
    serveConversion("never-served", fetched);
    invokeFunction.mockResolvedValue({
      data: { ok: true, cached: false, storage_path: "derived/e1/IMG_GONE.heic.webp" },
      error: null,
    });

    const result = await resolveImagePreviewSource(`${BASE}/e1/IMG_GONE.heic`, "image/heic");

    expect(result.status).toBe("unsupported");
    expect(result.originalObjectUrl).not.toBeNull();
  });
});

describe("resolveImagePreviewSource — non-HEIC", () => {
  it("leaves ordinary images untouched and never loads the decoder", async () => {
    serve("png-bytes", "image/png");

    const result = await resolveImagePreviewSource(`${BASE}/e1/a.png`, "image/png");

    expect(heic2any).not.toHaveBeenCalled();
    expect(result.status).toBe("ok");
    // One object URL, reused for render and download — nothing extra to revoke.
    expect(result.objectUrl).toBe(result.originalObjectUrl);
  });
});
