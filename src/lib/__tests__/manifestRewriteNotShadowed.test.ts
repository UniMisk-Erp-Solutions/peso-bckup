import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { MANIFEST_URL_PATH } from "@/lib/manifestVerification";

const root = resolve(__dirname, "../../..");

/**
 * PWA install was blocked on every host with "This page's app details did not
 * match this address".
 *
 * Cause: `vercel.json` rewrites /site.webmanifest -> /api/manifest, and the API
 * is what stamps the `x-pesowise-manifest-tenant` header and builds the
 * per-tenant name/start_url. But a real file existed at
 * `public/site.webmanifest`, and on Vercel a static asset is matched BEFORE any
 * rewrite. So the request never reached the function: every host got the same
 * generic manifest with no header, `verifyManifestForCurrentHost()` read a null
 * marker, and the install was refused as a tenant mismatch.
 *
 * The file carried a comment claiming it was a harmless "static fallback".
 * It was not harmless — it was the bug.
 */

describe("the tenant manifest rewrite must not be shadowed by a static file", () => {
  it("has no static file at the rewritten manifest path", () => {
    const shadowed = resolve(root, "public", MANIFEST_URL_PATH.replace(/^\//, ""));
    expect(
      existsSync(shadowed),
      `${shadowed} exists. On Vercel a file in public/ is served before any rewrite, so ` +
        `${MANIFEST_URL_PATH} would never reach /api/manifest, the ` +
        `x-pesowise-manifest-tenant header would be absent, and PWA install would be ` +
        `refused on every host. Do not re-add it as a "fallback".`,
    ).toBe(false);
  });

  it("still rewrites that path to the tenant-aware API", () => {
    const vercel = JSON.parse(readFileSync(resolve(root, "vercel.json"), "utf8")) as {
      rewrites?: { source: string; destination: string }[];
    };
    const rewrite = vercel.rewrites?.find((r) => r.source === MANIFEST_URL_PATH);
    expect(rewrite, `no rewrite for ${MANIFEST_URL_PATH} in vercel.json`).toBeDefined();
    expect(rewrite?.destination).toBe("/api/manifest");
  });

  it("keeps the document's manifest link pointing at that path", () => {
    const html = readFileSync(resolve(root, "index.html"), "utf8");
    expect(html).toContain(`href="${MANIFEST_URL_PATH}"`);
  });

  it("does not leave another static manifest able to shadow the second route", () => {
    // /manifest.webmanifest is rewritten to the same API and must stay unshadowed too.
    expect(existsSync(resolve(root, "public", "manifest.webmanifest"))).toBe(false);
  });
});
