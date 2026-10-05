/**
 * AuthContext.tsx -- organization_features refresh (owner QA fix pass,
 * 2026-09-23).
 *
 * Root cause of "the memory RPC never fires at all": organizationFeatureFlags
 * hydrated from the fast-path localStorage cache and was only ever refreshed
 * from the DB when the cache was more than 5 minutes old. An admin toggling
 * expense_field_memory in Master Admin and then immediately testing in the
 * SAME tab (well inside that 5-minute window) saw a stale `false` --
 * useRecentExpenseFieldValues's own `enabled` prop was false, so it never
 * called fetchRecentExpenseFieldValues at all, matching the owner's HAR
 * evidence exactly (zero network call, not "zero matching values").
 *
 * AuthContext.tsx's actual auth listener setup (supabase.auth.onAuthStateChange,
 * localStorage, multiple interacting effects) is impractical to fully mount
 * and drive from a unit test, so -- matching this codebase's existing
 * convention for such files (reportExportWorker.test.ts et al.) -- this pins
 * the fix as a source-contract guard on the real file.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const src = readFileSync(
  resolve(process.cwd(), "src/contexts/AuthContext.tsx"),
  "utf-8",
).replace(/\r\n/g, "\n");

describe("refreshOrganizationFeatureFlags", () => {
  it("exists as its own lightweight query, independent of the full fetchOrganization (membership + organizations + features)", () => {
    const start = src.indexOf("const refreshOrganizationFeatureFlags = async");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n  };", start));
    expect(body).toContain('.from("organization_features")');
    expect(body).toContain('.select("feature_key, enabled")');
    expect(body).toContain(".eq(\"organization_id\", organizationId)");
    expect(body).toContain("setOrganizationFeatureFlags(map)");
    // Must never throw -- a failed refresh keeps the last-known flags, it
    // must not crash the whole auth hydration path.
    expect(body).toContain("catch {");
  });
});

describe("fast-path hydration calls the feature-flag refresh unconditionally", () => {
  it("refreshes organizationFeatureFlags on every fast-path hydration, not gated behind the 5-minute cache-age check", () => {
    const fastPathStart = src.indexOf("// ── Fast-path");
    const cacheMaxAgeIdx = src.indexOf("CACHE_MAX_AGE_MS", fastPathStart);
    const refreshCallIdx = src.indexOf("void refreshOrganizationFeatureFlags(cache.organizationId)", fastPathStart);
    expect(fastPathStart).toBeGreaterThan(-1);
    expect(refreshCallIdx).toBeGreaterThan(-1);
    expect(cacheMaxAgeIdx).toBeGreaterThan(-1);
    // The unconditional refresh call must appear BEFORE the 5-minute-gated
    // loadUserContext call -- i.e. it is not itself inside that `if` block.
    expect(refreshCallIdx).toBeLessThan(cacheMaxAgeIdx);
  });

  it("still hydrates organizationFeatureFlags instantly from cache first -- the refresh is additive, not a replacement for the no-spinner fast path", () => {
    const fastPathStart = src.indexOf("// ── Fast-path");
    const hydrateIdx = src.indexOf("setOrganizationFeatureFlags(cache.organizationFeatureFlags)", fastPathStart);
    const refreshCallIdx = src.indexOf("void refreshOrganizationFeatureFlags(cache.organizationId)", fastPathStart);
    expect(hydrateIdx).toBeGreaterThan(-1);
    expect(hydrateIdx).toBeLessThan(refreshCallIdx);
  });
});

describe("organization_features realtime propagation", () => {
  it("subscribes to postgres_changes on organization_features scoped to the current organization, mirroring the existing profiles-balance subscription pattern", () => {
    const start = src.indexOf('table: "organization_features"');
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(Math.max(0, start - 400), start + 200);
    expect(block).toContain("filter: `organization_id=eq.${organizationId}`");
    expect(block).toContain('schema: "public"');
  });

  it("calls refreshOrganizationFeatureFlags (a full, correct re-fetch) on any change, rather than trying to patch state from the raw payload", () => {
    const start = src.indexOf('table: "organization_features"');
    const block = src.slice(start, start + 400);
    expect(block).toContain("void refreshOrganizationFeatureFlags(organizationId)");
  });

  it("cleans up the channel on unmount/org change, same as the balance subscription", () => {
    const start = src.indexOf('table: "organization_features"');
    const block = src.slice(start, start + 400);
    expect(block).toContain("supabase.removeChannel(channel)");
  });
});
