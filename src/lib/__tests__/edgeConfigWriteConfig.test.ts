/**
 * Tests for api/_lib/edgeConfigWriteConfig.ts
 * Covers T59–T64: token resolution, URL building, safe error mapping.
 *
 * These run in Vitest's Node-like environment (jsdom is not needed).
 * Each test sets/clears process.env keys directly.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

// We import the functions via relative path. The API lib files use .js
// extensions in their import statements (for Node ESM) but TypeScript
// resolves them to .ts at compile time — Vitest follows suit.
// Use a dynamic import so we can snapshot the module fresh per test group.
import {
  resolveEdgeConfigWriteConfig,
  buildEdgeConfigWriteUrl,
  mapProviderError,
  type EdgeConfigWriteConfig,
} from "../../../api/_lib/edgeConfigWriteConfig";

// ── Env helpers ──────────────────────────────────────────────────────────────

function setEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
}

const REQUIRED = {
  VERCEL_API_TOKEN: undefined,
  EDGE_CONFIG_WRITE_TOKEN: undefined,
  EDGE_CONFIG_ID: undefined,
  VERCEL_TEAM_ID: undefined,
};

beforeEach(() => setEnv(REQUIRED));
afterEach(() => setEnv(REQUIRED));

// ── T59: token resolution ────────────────────────────────────────────────────

describe("resolveEdgeConfigWriteConfig — token resolution (T59)", () => {
  it("prefers VERCEL_API_TOKEN over EDGE_CONFIG_WRITE_TOKEN", () => {
    setEnv({
      VERCEL_API_TOKEN: "vat_primary",
      EDGE_CONFIG_WRITE_TOKEN: "ecwt_fallback",
      EDGE_CONFIG_ID: "ecfg_abc123",
    });
    const r = resolveEdgeConfigWriteConfig();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.token).toBe("vat_primary");
  });

  it("falls back to EDGE_CONFIG_WRITE_TOKEN when VERCEL_API_TOKEN absent", () => {
    setEnv({
      EDGE_CONFIG_WRITE_TOKEN: "ecwt_fallback",
      EDGE_CONFIG_ID: "ecfg_abc123",
    });
    const r = resolveEdgeConfigWriteConfig();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.token).toBe("ecwt_fallback");
  });

  it("returns not-ok when both tokens are missing", () => {
    setEnv({ EDGE_CONFIG_ID: "ecfg_abc123" });
    const r = resolveEdgeConfigWriteConfig();
    expect(r.ok).toBe(false);
  });

  it("trims whitespace from token values", () => {
    setEnv({ VERCEL_API_TOKEN: "  vat_trimmed  ", EDGE_CONFIG_ID: "ecfg_abc123" });
    const r = resolveEdgeConfigWriteConfig();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.token).toBe("vat_trimmed");
  });

  it("rejects empty-string VERCEL_API_TOKEN (falls back)", () => {
    setEnv({
      VERCEL_API_TOKEN: "",
      EDGE_CONFIG_WRITE_TOKEN: "ecwt_ok",
      EDGE_CONFIG_ID: "ecfg_abc123",
    });
    const r = resolveEdgeConfigWriteConfig();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.token).toBe("ecwt_ok");
  });
});

// ── T60: EDGE_CONFIG_ID required ────────────────────────────────────────────

describe("resolveEdgeConfigWriteConfig — EDGE_CONFIG_ID required (T60)", () => {
  it("fails when EDGE_CONFIG_ID is absent", () => {
    setEnv({ VERCEL_API_TOKEN: "vat_ok" });
    const r = resolveEdgeConfigWriteConfig();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missingVariables.some((v) => v.includes("EDGE_CONFIG_ID"))).toBe(true);
  });

  it("includes configId in the resolved config", () => {
    setEnv({ VERCEL_API_TOKEN: "vat_ok", EDGE_CONFIG_ID: "ecfg_mystore" });
    const r = resolveEdgeConfigWriteConfig();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.configId).toBe("ecfg_mystore");
  });
});

// ── T61: VERCEL_TEAM_ID optional ────────────────────────────────────────────

describe("buildEdgeConfigWriteUrl — team support (T61)", () => {
  const base: EdgeConfigWriteConfig = {
    token: "t",
    configId: "ecfg_abc",
    teamId: null,
  };

  it("omits teamId query param when null", () => {
    const url = buildEdgeConfigWriteUrl(base);
    expect(url).not.toContain("teamId");
    expect(url).toBe("https://api.vercel.com/v1/edge-config/ecfg_abc/items");
  });

  it("appends teamId query param when set", () => {
    const url = buildEdgeConfigWriteUrl({ ...base, teamId: "team_xyz" });
    expect(url).toContain("?teamId=team_xyz");
  });

  it("URI-encodes teamId", () => {
    const url = buildEdgeConfigWriteUrl({ ...base, teamId: "team a/b" });
    expect(url).toContain("teamId=team%20a%2Fb");
  });
});

// ── T62–T64: safe error mapping ──────────────────────────────────────────────

describe("mapProviderError (T62–T64)", () => {
  it("T62: maps 401 → invalid_api_token", () => {
    const e = mapProviderError(401);
    expect(e.code).toBe("invalid_api_token");
    expect(e.httpStatus).toBe(401);
    expect(e.message).not.toContain("{");
  });

  it("maps 403 → forbidden", () => {
    const e = mapProviderError(403);
    expect(e.code).toBe("forbidden");
  });

  it("T63: maps 404 → edge_config_not_found", () => {
    const e = mapProviderError(404);
    expect(e.code).toBe("edge_config_not_found");
    expect(e.message).not.toContain("vercel");
  });

  it("maps 409 → revision_conflict", () => {
    const e = mapProviderError(409);
    expect(e.code).toBe("revision_conflict");
  });

  it("maps 429 → rate_limited", () => {
    const e = mapProviderError(429);
    expect(e.code).toBe("rate_limited");
  });

  it("T64: maps 500 → provider_unavailable", () => {
    const e = mapProviderError(500);
    expect(e.code).toBe("provider_unavailable");
    expect(e.message).not.toMatch(/raw|body|vercel json/i);
  });

  it("maps 503 → provider_unavailable", () => {
    const e = mapProviderError(503);
    expect(e.code).toBe("provider_unavailable");
  });

  it("maps unknown status → provider_error", () => {
    const e = mapProviderError(418);
    expect(e.code).toBe("provider_error");
  });
});
