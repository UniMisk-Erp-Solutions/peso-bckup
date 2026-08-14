/**
 * `convert-heic` — architecture guards.
 *
 * WHAT THESE REPLACED, AND WHY
 * This file previously asserted the *correct handling* of a decoded RGBA pixel buffer:
 * that the three-argument `new Uint8Array(buffer, byteOffset, byteLength)` view was used
 * instead of the one-argument form that exposed the whole wasm heap.
 *
 * Those tests are gone because the thing they guarded is gone. The pixel buffer itself was
 * the defect. Measured evidence: the controlled receipt is 3768 × 5800 = 21.9 MP, which is
 * 83 MB of RGBA before libheif's own copy in the wasm heap and before the JPEG encoder's
 * working buffers — against a 150 MB per-worker cap. The supervisor OOM-killed the isolate,
 * so the caller got a bare 500 with no JSON body and none of the typed error codes ever
 * appeared. Removing one frame copy narrowed the gap; it could never close it.
 *
 * The decode now happens in imgproxy (native libvips/libheif, streaming, never a full RGBA
 * frame in a JS heap). imgproxy's own log proved the capability was always there — it
 * measured the file and rejected it on `IMGPROXY_MAX_SRC_RESOLUTION`, not on format support.
 *
 * So these are stronger guards, not weaker ones: instead of checking that a dangerous
 * allocation is done carefully, they assert the dangerous allocation cannot occur at all.
 * The function runs under Deno and cannot execute in this runtime, so its runtime behaviour
 * is covered by the client-side suites plus the Phase B live verification.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const SOURCE_PATH = "supabase/functions/convert-heic/index.ts";
const source = readFileSync(resolve(process.cwd(), SOURCE_PATH), "utf-8");

/**
 * Comments are stripped before the guards run. The file's own header necessarily describes
 * the removed architecture in prose, and a guard that matched prose would fire on the
 * documentation rather than on a real regression.
 */
const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the in-isolate decode architecture is gone", () => {
  it.each([
    ["heic-decode import", /heic-decode/],
    ["jpeg-js import", /jpeg-js/],
    ["decodeHeic call", /decodeHeic\s*\(/],
    ["jpeg.encode call", /jpeg\s*\.\s*encode\s*\(/],
  ])("no %s", (_label, pattern) => {
    expect(pattern.test(code)).toBe(false);
  });

  it("never materialises an RGBA frame", () => {
    // Any of these would mean pixels are being expanded inside the 150 MB isolate again.
    expect(code).not.toMatch(/Uint8ClampedArray/);
    expect(code).not.toMatch(/decoded\.data/);
    expect(code).not.toMatch(/width\s*\*\s*height\s*\*\s*4/);
  });

  it("reads only a header slice of the original, never the whole thing as pixels", () => {
    // The HEIC sniff needs 16 bytes. Anything more would defeat the point of moving the
    // decode out of the isolate.
    expect(code).toMatch(/original\.slice\(0,\s*16\)/);
  });
});

describe("native transformation request", () => {
  it("targets the Storage render endpoint for the ORIGINAL object", () => {
    expect(code).toMatch(/render\/image\/authenticated/);
    expect(code).toMatch(/\$\{storagePath\./);
  });

  it.each([
    ["width 2000", /width:\s*2000/],
    ["height 2000", /height:\s*2000/],
    ["resize contain", /resize:\s*"contain"/],
    ["quality 82", /quality:\s*82/],
  ])("requests %s", (_label, pattern) => {
    expect(pattern.test(code)).toBe(true);
  });

  it("never asks for format=origin — the origin is the unrenderable format", () => {
    expect(code).not.toMatch(/format[=:]\s*["']?origin/i);
  });

  it("advertises both renderable formats but trusts the response", () => {
    expect(code).toMatch(/Accept:\s*"image\/jpeg,image\/webp"/);
    // The decision must come from the response header, not the request.
    expect(code).toMatch(/transformed\.headers\.get\("content-type"\)/);
  });
});

describe("output format handling", () => {
  it("maps content type to extension rather than assuming JPEG", () => {
    // IMGPROXY_AUTO_WEBP=true on this deployment, so the format is negotiated.
    expect(code).toMatch(/image\/webp/);
    expect(code).toMatch(/extensionForContentType/);
  });

  it("rejects HEIC output, non-image output and empty bodies", () => {
    expect(code).toMatch(/isHeicContentType/);
    expect(code).toMatch(/startsWith\("image\/"\)/);
    expect(code).toMatch(/byteLength === 0/);
  });

  it("stores the content type that matches the extension, never a false one", () => {
    expect(code).toMatch(/ext === "jpg" \? "image\/jpeg" : "image\/webp"/);
  });

  it("probes the legacy .jpg rendition before .webp so old renditions stay valid", () => {
    const order = code.match(/\["jpg",\s*"webp"\]/);
    expect(order, "cache probe order must be jpg then webp").toBeTruthy();
  });
});

describe("safety contract preserved through the refactor", () => {
  it.each([
    ["bearer token check", /Authorization/],
    ["getUser", /auth\.getUser/],
    ["active membership", /is_active/],
    ["path normalisation", /normalizeStoragePath/],
    ["traversal rejection", /segment === "\.\."/],
    ["url rejection", /includes\(":\/\/"\)/],
    ["derived recursion rejection", /startsWith\(`\$\{DERIVED_PREFIX\}\/`\)/],
    ["ftyp byte sniff", /looksLikeHeic/],
    ["upsert", /upsert:\s*true/],
    ["long cache control", /cacheControl:\s*"31536000"/],
    ["typed transform failure", /TRANSFORM_FAILED/],
    ["typed upload failure", /UPLOAD_FAILED/],
  ])("still enforces %s", (_label, pattern) => {
    expect(pattern.test(code)).toBe(true);
  });

  it("never writes or removes the original object", () => {
    // Every mutation must target derivedPath. A remove() of any kind would be a red flag.
    expect(code).not.toMatch(/\.remove\(/);
    const uploads = code.match(/\.upload\(\s*(\w+)/g) ?? [];
    expect(uploads.length).toBe(1);
    expect(uploads[0]).toContain("derivedPath");
  });

  it("logs no secret, URL or identity", () => {
    const logged = code.match(/logStage\(\{[\s\S]*?\}\)/g)?.join("\n") ?? "";
    for (const forbidden of [
      "serviceRoleKey",
      "jwt",
      "authHeader",
      "public_url",
      "publicUrlFor",
      "transformUrl",
      "storagePath",
    ]) {
      expect(logged, `logStage must not include ${forbidden}`).not.toContain(forbidden);
    }
    // Correlation uses a truncated one-way digest instead of the path itself.
    expect(code).toMatch(/pathDigest/);
    expect(logged).toContain("pathRef");
  });
});
