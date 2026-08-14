/**
 * Tests for the canonical Supabase server config resolver.
 * Tests T1–T7 (server config resolution).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveSupabaseServerConfig, getMissingServiceRoleVars } from "../../../api/_lib/supabaseServerConfig";

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const original: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    original[key] = process.env[key];
    if (vars[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = vars[key];
    }
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(original)) {
      if (original[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original[key];
      }
    }
  }
}

const ALL_VARS = [
  "SUPABASE_URL", "VITE_SUPABASE_URL",
  "SUPABASE_ANON_KEY", "VITE_SUPABASE_ANON_KEY", "VITE_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
];

describe("resolveSupabaseServerConfig", () => {
  beforeEach(() => {
    for (const v of ALL_VARS) delete process.env[v];
  });
  afterEach(() => {
    for (const v of ALL_VARS) delete process.env[v];
  });

  it("T1: SUPABASE_URL preferred over VITE fallback", () => {
    withEnv({
      SUPABASE_URL: "https://direct.supabase.co",
      VITE_SUPABASE_URL: "https://vite.supabase.co",
      SUPABASE_ANON_KEY: "anon-key",
    }, () => {
      const result = resolveSupabaseServerConfig();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.sources.url).toBe("SUPABASE_URL");
      }
    });
  });

  it("T2: SUPABASE_ANON_KEY preferred over VITE fallbacks", () => {
    withEnv({
      SUPABASE_URL: "https://test.supabase.co",
      SUPABASE_ANON_KEY: "direct-anon",
      VITE_SUPABASE_ANON_KEY: "vite-anon",
      VITE_SUPABASE_PUBLISHABLE_KEY: "vite-pub",
    }, () => {
      const result = resolveSupabaseServerConfig();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.sources.anonKey).toBe("SUPABASE_ANON_KEY");
      }
    });
  });

  it("T3: VITE_SUPABASE_ANON_KEY accepted as compatibility fallback", () => {
    withEnv({
      VITE_SUPABASE_URL: "https://test.supabase.co",
      VITE_SUPABASE_ANON_KEY: "vite-anon-key",
    }, () => {
      const result = resolveSupabaseServerConfig();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.sources.anonKey).toBe("VITE_SUPABASE_ANON_KEY");
      }
    });
  });

  it("T4: VITE_SUPABASE_PUBLISHABLE_KEY accepted as compatibility fallback", () => {
    withEnv({
      VITE_SUPABASE_URL: "https://test.supabase.co",
      VITE_SUPABASE_PUBLISHABLE_KEY: "vite-pub-key",
    }, () => {
      const result = resolveSupabaseServerConfig();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.sources.anonKey).toBe("VITE_SUPABASE_PUBLISHABLE_KEY");
      }
    });
  });

  it("T5: service-role key has no VITE fallback", () => {
    withEnv({
      SUPABASE_URL: "https://test.supabase.co",
      SUPABASE_ANON_KEY: "anon",
      // SUPABASE_SERVICE_ROLE_KEY is absent
    }, () => {
      const result = resolveSupabaseServerConfig();
      // config still succeeds without service role
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.serviceRoleKey).toBeNull();
      }
      // and getMissingServiceRoleVars reports it
      const missing = getMissingServiceRoleVars();
      expect(missing).toContain("SUPABASE_SERVICE_ROLE_KEY");
    });
  });

  it("T6: missing variables are reported by name only", () => {
    withEnv({
      // nothing set
    }, () => {
      const result = resolveSupabaseServerConfig();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.missingVariables).toContain("SUPABASE_URL");
        expect(result.missingVariables).toContain("SUPABASE_ANON_KEY");
      }
    });
  });

  it("T7: error path exposes only variable names, not values", () => {
    // Only URL is set, no anon key — error path
    withEnv({
      SUPABASE_URL: "https://secret.supabase.co",
      // no anon key
    }, () => {
      const result = resolveSupabaseServerConfig();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // missingVariables must only contain variable names, never values
        for (const entry of result.missingVariables) {
          expect(entry).not.toContain("secret");
          expect(entry).not.toContain("https://");
          // Must be a recognisable env var name (uppercase with underscores)
          expect(entry).toMatch(/^[A-Z_]+$/);
        }
      }
    });
  });
});
