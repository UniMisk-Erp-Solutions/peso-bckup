/**
 * Install-flow manifest verification.
 *
 * The install button must refuse to run when the manifest served on this origin
 * describes a different host — that is exactly how an apex-branded PWA gets
 * installed from a tenant page and then launches on the wrong origin.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  evaluateManifest,
  expectedManifestMarker,
  isSameOriginManifestUrl,
} from "@/lib/manifestVerification";

const BASE = "pesowise.unimisk.com";
const ML_ORIGIN = `https://ml.${BASE}`;
const APEX_ORIGIN = `https://${BASE}`;

describe("expectedManifestMarker", () => {
  it("expects the subdomain label on a tenant host", () => {
    expect(expectedManifestMarker(`ml.${BASE}`, BASE)).toBe("ml");
  });

  it("expects 'apex' on the apex host", () => {
    expect(expectedManifestMarker(BASE, BASE)).toBe("apex");
  });
});

describe("evaluateManifest", () => {
  const mlOk = {
    marker: "ml",
    expectedMarker: "ml",
    startUrl: "/auth?source=pwa&tenant=ml",
    scope: "/",
    origin: ML_ORIGIN,
  };

  it("accepts the ML manifest on the ML origin", () => {
    expect(evaluateManifest(mlOk).ok).toBe(true);
  });

  it("rejects the apex manifest on the ML origin", () => {
    const verdict = evaluateManifest({ ...mlOk, marker: "apex", startUrl: "/" });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe("tenant_mismatch");
  });

  it("rejects a manifest with a missing tenant marker", () => {
    const verdict = evaluateManifest({ ...mlOk, marker: null });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe("tenant_mismatch");
  });

  it("rejects a cross-origin start_url", () => {
    const verdict = evaluateManifest({ ...mlOk, startUrl: `${APEX_ORIGIN}/auth` });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe("cross_origin_start_url");
  });

  it("rejects a cross-origin scope", () => {
    const verdict = evaluateManifest({ ...mlOk, scope: `${APEX_ORIGIN}/` });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe("cross_origin_scope");
  });

  it("accepts the apex manifest on the apex origin", () => {
    expect(
      evaluateManifest({
        marker: "apex",
        expectedMarker: "apex",
        startUrl: "/",
        scope: "/",
        origin: APEX_ORIGIN,
      }).ok,
    ).toBe(true);
  });
});

describe("isSameOriginManifestUrl", () => {
  it("accepts relative paths", () => {
    expect(isSameOriginManifestUrl("/auth", ML_ORIGIN)).toBe(true);
  });

  it("accepts an absolute same-origin URL", () => {
    expect(isSameOriginManifestUrl(`${ML_ORIGIN}/auth`, ML_ORIGIN)).toBe(true);
  });

  it("rejects another origin", () => {
    expect(isSameOriginManifestUrl(`${APEX_ORIGIN}/auth`, ML_ORIGIN)).toBe(false);
  });

  it("rejects non-string or empty values", () => {
    expect(isSameOriginManifestUrl(undefined, ML_ORIGIN)).toBe(false);
    expect(isSameOriginManifestUrl("", ML_ORIGIN)).toBe(false);
  });
});

describe("install flow wiring", () => {
  /** Comments are stripped so assertions test code, not the prose explaining it. */
  const code = (p: string) =>
    readFileSync(resolve(process.cwd(), p), "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

  const flow = code("src/hooks/usePwaInstallFlow.ts");
  const verification = code("src/lib/manifestVerification.ts");

  it("verifies the manifest before prompting for install", () => {
    expect(flow).toContain("verifyManifestForCurrentHost");
    const verifyAt = flow.indexOf("verifyManifestForCurrentHost");
    const promptAt = flow.indexOf("await promptInstall()");
    expect(verifyAt).toBeGreaterThan(-1);
    expect(promptAt).toBeGreaterThan(verifyAt);
  });

  it("does not prompt when the manifest does not match this host", () => {
    expect(flow).toContain("if (!verdict.ok)");
    expect(flow).toContain('return "wrong_manifest"');
  });

  it("refreshes the manifest link instead of deleting unrelated PWA data", () => {
    expect(flow).toContain("refreshManifestLink");
    expect(flow).not.toContain("caches.delete");
    expect(flow).not.toContain("unregister");
  });

  it("uses tenant branding for the install label", () => {
    expect(flow).toContain("pwa.installTitleOrg");
  });

  it("fetches the manifest with caching disabled from the current origin", () => {
    expect(verification).toContain('cache: "no-store"');
    expect(verification).toContain("new URL(MANIFEST_URL_PATH, origin)");
    expect(verification).not.toContain("pesowise.unimisk.com");
  });
});
