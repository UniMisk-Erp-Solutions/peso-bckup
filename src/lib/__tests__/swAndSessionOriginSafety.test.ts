/**
 * Service-worker origin safety + invalid-refresh-token recovery.
 *
 * The service worker cannot control another origin, but a stale cached manifest or
 * a cached cross-host HTML shell can still make an installed app present the wrong
 * identity. And a stale refresh token must clear once, on the same origin, without
 * a redirect loop or a toast storm.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  SESSION_EXPIRED_EVENT,
  isInvalidRefreshTokenError,
  isSupabaseNetworkError,
  recoverFromInvalidAuthSession,
  resetSessionExpiredNotice,
  wasSessionExpiredHandled,
} from "@/lib/authSession";

const cwd = process.cwd();

/**
 * Strips comments so assertions test executable code, not the prose that explains
 * why a pattern is deliberately absent (e.g. "do NOT clients.claim()").
 */
function code(relativePath: string): string {
  return readFileSync(resolve(cwd, relativePath), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const sw = code("public/sw.js");
const swRaw = readFileSync(resolve(cwd, "public/sw.js"), "utf-8");
const installCapture = code("src/lib/pwaInstallCapture.ts");
const tenantRedirect = code("src/lib/tenantRedirect.ts");

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      signOut: vi.fn().mockResolvedValue({ error: null }),
    },
  },
}));

describe("service worker — origin safety", () => {
  it("registers /sw.js at scope /", () => {
    expect(installCapture).toContain('.register("/sw.js", { scope: "/", updateViaCache: "none" })');
  });

  it("contains no absolute apex navigation URL", () => {
    expect(sw).not.toContain("pesowise.unimisk.com");
    expect(sw).not.toMatch(/https?:\/\//);
  });

  it("keeps the navigation fallback on the current origin", () => {
    // Only same-origin requests are handled at all.
    expect(sw).toContain("if (reqUrl.origin !== self.location.origin) return;");
    // The document fallback is a same-origin cache entry, not a redirect.
    expect(sw).toContain('caches.match("/index.html")');
    expect(sw).not.toContain("Response.redirect");
  });

  it("does not cache the web app manifest under any host assumption", () => {
    expect(sw).not.toContain("FALLBACK_MANIFEST");
    expect(sw).not.toContain('cache.put("/site.webmanifest"');
    // The manifest branch bails out so the browser fetches it natively each time.
    expect(sw).toMatch(/\.webmanifest[\s\S]{0,400}?return;/);
  });

  it("bumps the cache version and deletes only PesoWise caches", () => {
    expect(swRaw).toContain('const CACHE_VERSION = "pesowise-v13"');
    expect(sw).toContain("k.startsWith(CACHE_NAME_PREFIX) && k !== CACHE_VERSION");
  });

  it("introduces no reload-on-focus or auto-claim behaviour", () => {
    expect(sw).not.toContain("self.skipWaiting()");
    expect(sw).not.toContain("clients.claim()");
    expect(installCapture).not.toContain("controllerchange");
    expect(installCapture).not.toContain("location.reload");
  });

  it("does not sign the user out or recover sessions from worker code", () => {
    expect(sw).not.toContain("signOut");
    expect(sw).not.toContain("auth");
  });
});

describe("tenant redirect — no apex fallback", () => {
  it("only navigates cross-origin to a positively resolved, different tenant", () => {
    expect(tenantRedirect).toContain("if (!target || target === current)");
    expect(tenantRedirect).toContain("stayOnSameOriginAuth();");
  });

  it("builds the stay-here URL from the current origin", () => {
    expect(tenantRedirect).toContain('buildSameOriginPath("/auth?from_wrong_tenant=1")');
  });

  it("never calls buildTenantAuthUrl(null), which resolves to the apex", () => {
    expect(tenantRedirect).not.toContain("buildTenantAuthUrl(subdomain)");
    expect(tenantRedirect).not.toContain("buildTenantAuthUrl(null)");
  });
});

describe("invalid refresh token recovery", () => {
  const signOutSpy = vi.fn();

  beforeEach(async () => {
    resetSessionExpiredNotice();
    signOutSpy.mockClear();
    const { supabase } = await import("@/integrations/supabase/client");
    (supabase.auth.signOut as ReturnType<typeof vi.fn>).mockClear();
  });

  afterEach(() => {
    resetSessionExpiredNotice();
  });

  it("classifies a refresh-token failure but not a network failure", () => {
    expect(isInvalidRefreshTokenError("Invalid Refresh Token: Refresh Token Not Found")).toBe(true);
    expect(isInvalidRefreshTokenError("Failed to fetch")).toBe(false);
    expect(isSupabaseNetworkError(new Error("Failed to fetch"))).toBe(true);
  });

  it("clears the invalid session exactly once", async () => {
    const { supabase } = await import("@/integrations/supabase/client");
    const signOut = supabase.auth.signOut as ReturnType<typeof vi.fn>;

    await recoverFromInvalidAuthSession("Invalid Refresh Token: Refresh Token Not Found");
    await recoverFromInvalidAuthSession("Invalid Refresh Token: Refresh Token Not Found");
    await recoverFromInvalidAuthSession("Invalid Refresh Token: Refresh Token Not Found");

    expect(signOut).toHaveBeenCalledTimes(1);
    expect(wasSessionExpiredHandled()).toBe(true);
  });

  it("emits a single session-expired event for repeated failures", async () => {
    const events: Event[] = [];
    const listener = (e: Event) => events.push(e);
    window.addEventListener(SESSION_EXPIRED_EVENT, listener);

    await recoverFromInvalidAuthSession("Invalid Refresh Token: Refresh Token Not Found");
    await recoverFromInvalidAuthSession("Invalid Refresh Token: Refresh Token Not Found");

    window.removeEventListener(SESSION_EXPIRED_EVENT, listener);
    expect(events).toHaveLength(1);
  });

  it("does not clear a valid session on a network error", async () => {
    const { supabase } = await import("@/integrations/supabase/client");
    const signOut = supabase.auth.signOut as ReturnType<typeof vi.fn>;

    await recoverFromInvalidAuthSession("Failed to fetch");
    await recoverFromInvalidAuthSession("TypeError: NetworkError when attempting to fetch");

    expect(signOut).not.toHaveBeenCalled();
    expect(wasSessionExpiredHandled()).toBe(false);
  });

  it("does not navigate — same-origin routing handles /auth", () => {
    const authSession = readFileSync(resolve(cwd, "src/lib/authSession.ts"), "utf-8");
    expect(authSession).not.toContain("location.replace");
    expect(authSession).not.toContain("location.href =");
    expect(authSession).not.toContain("pesowise.unimisk.com");
  });

  it("shows one friendly session-expired message, routed same-origin", () => {
    const notice = readFileSync(
      resolve(cwd, "src/components/SessionExpiredNotice.tsx"),
      "utf-8",
    );
    const protectedRoute = readFileSync(
      resolve(cwd, "src/components/ProtectedRoute.tsx"),
      "utf-8",
    );
    expect(notice).toContain("auth:sessionExpired");
    expect(notice).not.toContain("location");
    expect(protectedRoute).toContain('<Navigate to="/auth" replace />');
  });
});
