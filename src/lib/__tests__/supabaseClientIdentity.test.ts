/**
 * Console audit 2026-10-16 -- "Multiple GoTrueClient instances detected".
 *
 * @supabase/auth-js 2.72 emits that warning for ANY second GoTrueClient in the page (it counts
 * instances globally, not per storage key). The browser bundle legitimately holds exactly two:
 * the primary PesoWise client and the Cloud maintenance client. The warning is only dangerous if
 * they share an effective storage key, so this suite proves they do not and that one cannot
 * clear the other.
 */
import { describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { clearLocalAuthStorage, localSupabaseAuthStorageKey } from "@/lib/localAuthStorageKey";

const PRIMARY_URL = "https://pesowise-supabase.unimisk.com";
const MAINTENANCE_STORAGE_KEY = "pw-maintenance-cloud-auth";

function storageKeyOf(client: unknown): string {
  return (client as { auth: { storageKey: string } }).auth.storageKey;
}

describe("the two clients have distinct effective auth storage", () => {
  const primary = createClient(PRIMARY_URL, "anon", { auth: { persistSession: false } });
  const maintenance = createClient("https://example-maintenance.supabase.co", "anon", {
    auth: { storageKey: MAINTENANCE_STORAGE_KEY, persistSession: false },
  });

  it("primary uses supabase-js's default key, derived from the hostname's first label", () => {
    expect(storageKeyOf(primary)).toBe("sb-pesowise-supabase-auth-token");
  });

  it("the app's own cleanup helper computes EXACTLY the key the primary client really uses", () => {
    expect(localSupabaseAuthStorageKey(PRIMARY_URL)).toBe(storageKeyOf(primary));
  });

  it("maintenance uses its own explicit key", () => {
    expect(storageKeyOf(maintenance)).toBe(MAINTENANCE_STORAGE_KEY);
    expect(storageKeyOf(maintenance)).not.toBe(storageKeyOf(primary));
  });

  it("clearing the primary session cannot remove the maintenance session (and vice versa is not exposed)", () => {
    const primaryKey = storageKeyOf(primary);
    localStorage.setItem(primaryKey, "p");
    localStorage.setItem(`${primaryKey}-code-verifier`, "v");
    localStorage.setItem(MAINTENANCE_STORAGE_KEY, "m");
    // clearLocalAuthStorage reads VITE_SUPABASE_URL; point it at the primary URL
    (import.meta.env as Record<string, string>).VITE_SUPABASE_URL = PRIMARY_URL;
    clearLocalAuthStorage();
    expect(localStorage.getItem(primaryKey)).toBeNull();
    expect(localStorage.getItem(`${primaryKey}-code-verifier`)).toBeNull();
    expect(localStorage.getItem(MAINTENANCE_STORAGE_KEY)).toBe("m");
    localStorage.clear();
  });
});

describe("the browser bundle contains exactly two Supabase clients", () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name === "__tests__" || name === "node_modules") continue;
        walk(p, out);
      } else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(p);
    }
    return out;
  }

  it("only the primary and the maintenance client call createClient( in src/", () => {
    const hits = walk(resolve(process.cwd(), "src"))
      .filter((f) => /^[^/\n]*\bcreateClient(<[^>]*>)?\(/m.test(readFileSync(f, "utf-8")))
      .map((f) => f.replace(/\\/g, "/").split("/src/")[1])
      .sort();
    expect(hits).toEqual(["integrations/maintenance-cloud/client.ts", "integrations/supabase/client.ts"]);
  });

  it("the maintenance client always sets its own storageKey", () => {
    const src = readFileSync(resolve(process.cwd(), "src/integrations/maintenance-cloud/client.ts"), "utf-8");
    expect(src).toContain("storageKey: MAINTENANCE_AUTH_STORAGE_KEY");
    expect(src).toContain('MAINTENANCE_AUTH_STORAGE_KEY = "pw-maintenance-cloud-auth"');
  });

  it("the primary client does not set a custom storageKey (so the cleanup helper's derived key stays correct)", () => {
    const src = readFileSync(resolve(process.cwd(), "src/integrations/supabase/client.ts"), "utf-8");
    expect(src).not.toContain("storageKey");
  });
});
