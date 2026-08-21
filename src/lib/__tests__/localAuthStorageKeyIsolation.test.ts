/**
 * Regression coverage for the local-vs-Cloud auth storage isolation bug found
 * during Cloud Maintenance admin work: with two independent Supabase clients
 * now sharing one origin (local PesoWise + the Cloud maintenance client,
 * storageKey "pw-maintenance-cloud-auth"), a broad "sb-*-auth-token" or
 * "contains auth" sweep risks deleting a session it does not own.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const cwd = process.cwd();

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("localSupabaseAuthStorageKey", () => {
  it("derives the exact default supabase-js key from a project URL", async () => {
    const { localSupabaseAuthStorageKey } = await import("@/lib/localAuthStorageKey");
    expect(localSupabaseAuthStorageKey("https://abcxyz123.supabase.co")).toBe(
      "sb-abcxyz123-auth-token",
    );
  });

  it("returns null when the URL cannot be parsed", async () => {
    const { localSupabaseAuthStorageKey } = await import("@/lib/localAuthStorageKey");
    expect(localSupabaseAuthStorageKey(undefined)).toBeNull();
    expect(localSupabaseAuthStorageKey("")).toBeNull();
    expect(localSupabaseAuthStorageKey("not-a-url")).toBeNull();
  });
});

describe("clearLocalAuthStorage — scoped isolation", () => {
  const LOCAL_URL = "https://localproj123.supabase.co";
  const LOCAL_KEY = "sb-localproj123-auth-token";
  const MAINTENANCE_KEY = "pw-maintenance-cloud-auth";

  beforeEach(() => {
    localStorage.clear();
    vi.stubEnv("VITE_SUPABASE_URL", LOCAL_URL);
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllEnvs();
  });

  it("removes only the local project's own auth key", async () => {
    const { clearLocalAuthStorage } = await import("@/lib/localAuthStorageKey");
    localStorage.setItem(LOCAL_KEY, "local-session-json");
    clearLocalAuthStorage();
    expect(localStorage.getItem(LOCAL_KEY)).toBeNull();
  });

  it("removes auxiliary keys prefixed with the local key (e.g. PKCE verifier)", async () => {
    const { clearLocalAuthStorage } = await import("@/lib/localAuthStorageKey");
    localStorage.setItem(`${LOCAL_KEY}-code-verifier`, "verifier");
    clearLocalAuthStorage();
    expect(localStorage.getItem(`${LOCAL_KEY}-code-verifier`)).toBeNull();
  });

  it("never removes the Cloud maintenance client's session key", async () => {
    const { clearLocalAuthStorage } = await import("@/lib/localAuthStorageKey");
    localStorage.setItem(MAINTENANCE_KEY, "cloud-maintenance-session-json");
    localStorage.setItem(LOCAL_KEY, "local-session-json");

    clearLocalAuthStorage();

    expect(localStorage.getItem(MAINTENANCE_KEY)).toBe("cloud-maintenance-session-json");
    expect(localStorage.getItem(LOCAL_KEY)).toBeNull();
  });

  it("never removes another Supabase project's sb-*-auth-token key on the same origin", async () => {
    const { clearLocalAuthStorage } = await import("@/lib/localAuthStorageKey");
    const otherProjectKey = "sb-someotherproject-auth-token";
    localStorage.setItem(otherProjectKey, "other-project-session-json");

    clearLocalAuthStorage();

    expect(localStorage.getItem(otherProjectKey)).toBe("other-project-session-json");
  });

  it("does nothing when VITE_SUPABASE_URL cannot be parsed, rather than guessing", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", "");
    const { clearLocalAuthStorage } = await import("@/lib/localAuthStorageKey");
    localStorage.setItem(MAINTENANCE_KEY, "cloud-maintenance-session-json");

    clearLocalAuthStorage();

    expect(localStorage.getItem(MAINTENANCE_KEY)).toBe("cloud-maintenance-session-json");
  });
});

describe("source guard — no duplicated broad sweep remains", () => {
  it("src/integrations/supabase/client.ts delegates to the shared scoped helper", () => {
    const src = stripComments(
      readFileSync(resolve(cwd, "src/integrations/supabase/client.ts"), "utf-8"),
    );
    expect(src).toContain("clearLocalAuthStorage()");
    expect(src).not.toContain('startsWith("sb-")');
    expect(src).not.toContain("key.includes(projectRef)");
  });

  it("src/lib/authSession.ts no longer defines its own broad sweep", () => {
    const src = stripComments(readFileSync(resolve(cwd, "src/lib/authSession.ts"), "utf-8"));
    expect(src).not.toContain('startsWith("sb-")');
    expect(src).not.toContain("key.includes(projectRef)");
  });

  it("the maintenance Cloud client keeps a storageKey outside the sb-*-auth-token shape", () => {
    const src = readFileSync(
      resolve(cwd, "src/integrations/maintenance-cloud/client.ts"),
      "utf-8",
    );
    expect(src).toContain('"pw-maintenance-cloud-auth"');
  });
});
