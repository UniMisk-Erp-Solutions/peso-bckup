/**
 * Tenant hostname resolution + same-origin path building.
 *
 * These guard the two facts the tenant PWA fix depends on:
 *   1. ml.pesowise.unimisk.com resolves to tenant label "ml" (so employee-ID
 *      login is even considered), and unrelated hosts never do.
 *   2. Internal navigation resolves against the CURRENT origin — never the apex.
 */
import { describe, it, expect, afterEach } from "vitest";
import { normalizeHostname, resolveTenantLabelFromHostname } from "@/lib/tenantContext";
import {
  buildSameOriginPath,
  getCurrentAppOrigin,
  isRunningOnTenantOrigin,
  normalizeInternalPath,
} from "@/lib/appOrigin";

const BASE = "pesowise.unimisk.com";

/** Replaces window.location for the duration of a test. */
function setLocation(href: string): void {
  const url = new URL(href);
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: {
      href: url.href,
      origin: url.origin,
      protocol: url.protocol,
      host: url.host,
      hostname: url.hostname,
      port: url.port,
      pathname: url.pathname,
      search: url.search,
      replace: () => {},
      assign: () => {},
    },
  });
}

const originalLocation = window.location;
afterEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: originalLocation,
  });
});

describe("tenant resolution from hostname", () => {
  it("resolves the apex as a non-tenant host", () => {
    expect(resolveTenantLabelFromHostname(BASE, BASE)).toEqual({
      subdomainLabel: null,
      isTenantHost: false,
    });
  });

  it("resolves ml.pesowise.unimisk.com to tenant label 'ml'", () => {
    expect(resolveTenantLabelFromHostname(`ml.${BASE}`, BASE)).toEqual({
      subdomainLabel: "ml",
      isTenantHost: true,
    });
  });

  it("removes the port safely", () => {
    expect(normalizeHostname(`ml.${BASE}:8443`)).toBe(`ml.${BASE}`);
    expect(resolveTenantLabelFromHostname(`ml.${BASE}:8443`, BASE).subdomainLabel).toBe("ml");
  });

  it("normalizes an uppercase host safely", () => {
    expect(resolveTenantLabelFromHostname(`ML.PESOWISE.UNIMISK.COM`, BASE)).toEqual({
      subdomainLabel: "ml",
      isTenantHost: true,
    });
  });

  it("does not turn an unrelated hostname into a tenant", () => {
    expect(resolveTenantLabelFromHostname("ml.evil.example.com", BASE).isTenantHost).toBe(false);
    // Suffix look-alike that is not actually a subdomain of the base domain.
    expect(resolveTenantLabelFromHostname("notpesowise.unimisk.com", BASE).isTenantHost).toBe(
      false,
    );
  });

  it("rejects a multi-level unexpected subdomain", () => {
    expect(resolveTenantLabelFromHostname(`a.b.${BASE}`, BASE)).toEqual({
      subdomainLabel: null,
      isTenantHost: false,
    });
  });

  it("falls back to the default base domain when VITE_APP_BASE_DOMAIN is unset", () => {
    // getAppBaseDomain() returns the apex default; resolution against it still works.
    expect(resolveTenantLabelFromHostname(`ml.${BASE}`, BASE).isTenantHost).toBe(true);
  });
});

describe("appOrigin — same-origin navigation", () => {
  it("reports the current tenant origin, not the apex", () => {
    setLocation(`https://ml.${BASE}/auth`);
    expect(getCurrentAppOrigin()).toBe(`https://ml.${BASE}`);
    expect(isRunningOnTenantOrigin()).toBe(true);
    expect(buildSameOriginPath("/auth")).toBe(`https://ml.${BASE}/auth`);
    expect(buildSameOriginPath("/dashboard")).toBe(`https://ml.${BASE}/dashboard`);
  });

  it("keeps the apex on the apex", () => {
    setLocation(`https://${BASE}/auth`);
    expect(isRunningOnTenantOrigin()).toBe(false);
    expect(buildSameOriginPath("/auth")).toBe(`https://${BASE}/auth`);
  });

  it("preserves protocol and port", () => {
    setLocation(`http://ml.${BASE}:5173/`);
    expect(buildSameOriginPath("/auth")).toBe(`http://ml.${BASE}:5173/auth`);
  });

  it("never allows an external redirect through the path argument", () => {
    setLocation(`https://ml.${BASE}/auth`);
    expect(buildSameOriginPath("https://evil.example.com/steal")).toBe(`https://ml.${BASE}/`);
    expect(buildSameOriginPath("//evil.example.com/steal")).toBe(`https://ml.${BASE}/`);
    expect(buildSameOriginPath("javascript:alert(1)")).toBe(`https://ml.${BASE}/`);
  });

  it("normalizes paths without escaping the origin root", () => {
    expect(normalizeInternalPath("dashboard")).toBe("/dashboard");
    expect(normalizeInternalPath("/../../etc/passwd")).toBe("/etc/passwd");
    expect(normalizeInternalPath("")).toBe("/");
    expect(normalizeInternalPath("/auth?from_wrong_tenant=1")).toBe("/auth?from_wrong_tenant=1");
  });
});
