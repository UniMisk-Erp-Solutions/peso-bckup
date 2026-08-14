/**
 * Dynamic web app manifest — host resolution, tenant identity and cache isolation.
 *
 * Regression under test: the manifest handler read `host` before `x-forwarded-host`,
 * did not split a comma-separated forwarded chain, gave every tenant the same
 * manifest `id` ("/auth"), and was served with `public, max-age=300` and no `Vary`,
 * so one host's manifest could be reused for another.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  buildManifestForHost,
  manifestTenantMarker,
  normalizeHostHeader,
  resolveEffectiveHost,
  resolveTenantFromHost,
} from "../../../api/manifest";

const BASE = "pesowise.unimisk.com";
const ML_HOST = `ml.${BASE}`;
const ML_ORIGIN = `https://${ML_HOST}`;
const APEX_ORIGIN = `https://${BASE}`;

type ManifestBody = {
  id: string;
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  icons: { src: string }[];
};

const mlManifest = () =>
  buildManifestForHost(ML_HOST, ML_ORIGIN, { name: "Mahalaxmi" }) as unknown as ManifestBody;
const apexManifest = () =>
  buildManifestForHost(BASE, APEX_ORIGIN, null) as unknown as ManifestBody;

describe("manifest host resolution", () => {
  it("prefers the platform-set x-forwarded-host over host", () => {
    expect(
      resolveEffectiveHost({
        headers: { host: "peso-patidar.vercel.app", "x-forwarded-host": ML_HOST },
      }),
    ).toBe(ML_HOST);
  });

  it("falls back to host when no forwarded host is present", () => {
    expect(resolveEffectiveHost({ headers: { host: ML_HOST } })).toBe(ML_HOST);
  });

  it("resolves a comma-separated forwarded chain to its first entry", () => {
    expect(normalizeHostHeader(`${ML_HOST}, edge.internal, ${BASE}`)).toBe(ML_HOST);
    expect(
      resolveEffectiveHost({ headers: { "x-forwarded-host": `${ML_HOST}, ${BASE}` } }),
    ).toBe(ML_HOST);
  });

  it("normalizes case, port and www", () => {
    expect(normalizeHostHeader(`ML.PESOWISE.UNIMISK.COM:443`)).toBe(ML_HOST);
    expect(normalizeHostHeader(`www.${BASE}`)).toBe(BASE);
  });

  it("does not treat an unrelated or multi-level host as a tenant", () => {
    expect(resolveTenantFromHost("ml.evil.example.com").isTenantHost).toBe(false);
    expect(resolveTenantFromHost(`a.b.${BASE}`).isTenantHost).toBe(false);
    expect(resolveTenantFromHost("").isTenantHost).toBe(false);
  });
});

describe("tenant manifest body", () => {
  it("produces a tenant manifest for the ML host", () => {
    const m = mlManifest();
    expect(manifestTenantMarker(ML_HOST)).toBe("ml");
    expect(m.name).toBe("Mahalaxmi — PesoWise");
    expect(m.short_name).toBe("Mahalaxmi");
  });

  it("produces the apex manifest for the apex host", () => {
    const m = apexManifest();
    expect(manifestTenantMarker(BASE)).toBe("apex");
    expect(m.name).toBe("PesoWise");
    expect(m.start_url).toBe("/");
  });

  it("uses a relative, tenant-safe start_url on the tenant host", () => {
    const m = mlManifest();
    expect(m.start_url.startsWith("/auth")).toBe(true);
    expect(m.start_url).toContain("tenant=ml");
    expect(new URL(m.start_url, ML_ORIGIN).origin).toBe(ML_ORIGIN);
  });

  it("gives the tenant install a distinct manifest id", () => {
    expect(mlManifest().id).toBe("/?tenant=ml");
    expect(apexManifest().id).toBe("/");
    expect(mlManifest().id).not.toBe(apexManifest().id);
  });

  it("scopes both manifests to /", () => {
    expect(mlManifest().scope).toBe("/");
    expect(apexManifest().scope).toBe("/");
  });

  it("keeps every icon on the requesting origin", () => {
    for (const icon of mlManifest().icons) {
      expect(new URL(icon.src, ML_ORIGIN).origin).toBe(ML_ORIGIN);
    }
    for (const icon of apexManifest().icons) {
      expect(new URL(icon.src, APEX_ORIGIN).origin).toBe(APEX_ORIGIN);
    }
  });

  it("never emits an absolute apex start_url", () => {
    const bodies = [mlManifest(), apexManifest()];
    for (const body of bodies) {
      expect(body.start_url.startsWith("http")).toBe(false);
      expect(body.start_url).not.toContain(BASE);
    }
  });

  it("never references the apex host anywhere in the tenant manifest", () => {
    const serialized = JSON.stringify(mlManifest());
    expect(serialized).not.toContain(APEX_ORIGIN);
  });
});

describe("manifest cache isolation", () => {
  const handlerSource = readFileSync(resolve(process.cwd(), "api/manifest.ts"), "utf-8");
  const vercelConfig = JSON.parse(
    readFileSync(resolve(process.cwd(), "vercel.json"), "utf-8"),
  ) as { headers: { source: string; headers: { key: string; value: string }[] }[] };

  const headersFor = (source: string) =>
    vercelConfig.headers.find((h) => h.source === source)?.headers ?? [];
  const valueOf = (source: string, key: string) =>
    headersFor(source).find((h) => h.key === key)?.value ?? "";

  it("marks the response with the resolved tenant", () => {
    expect(handlerSource).toContain("X-PesoWise-Manifest-Tenant");
    expect(manifestTenantMarker(ML_HOST)).toBe("ml");
    expect(manifestTenantMarker(BASE)).toBe("apex");
  });

  it("does not allow a tenant response to be stored and reused as apex", () => {
    expect(handlerSource).toContain('"private, no-cache, no-store, must-revalidate"');
    expect(handlerSource).not.toContain("stale-while-revalidate");
    expect(valueOf("/api/manifest", "Cache-Control")).toBe(
      "private, no-cache, no-store, must-revalidate",
    );
    expect(valueOf("/site.webmanifest", "Cache-Control")).toBe(
      "private, no-cache, no-store, must-revalidate",
    );
  });

  it("sends Vary on both host headers", () => {
    expect(handlerSource).toContain('res.setHeader("Vary", "Host, X-Forwarded-Host")');
    expect(valueOf("/api/manifest", "Vary")).toBe("Host, X-Forwarded-Host");
    expect(valueOf("/site.webmanifest", "Vary")).toBe("Host, X-Forwarded-Host");
  });

  it("does not redirect the ML tenant host to the apex", () => {
    const config = JSON.parse(readFileSync(resolve(process.cwd(), "vercel.json"), "utf-8")) as {
      redirects: { has?: { type: string; value: string }[] }[];
    };
    const redirectHosts = config.redirects.flatMap((r) =>
      (r.has ?? []).filter((h) => h.type === "host").map((h) => h.value),
    );
    expect(redirectHosts).not.toContain(ML_HOST);
    expect(redirectHosts).not.toContain(BASE);
  });
});
