import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearStaleChunkReloadFlag,
  installPreloadErrorHandler,
  isStaleChunkError,
  recoverFromStaleChunk,
} from "@/lib/chunkRecovery";

const reload = vi.fn();
const originalLocation = window.location;

beforeEach(() => {
  reload.mockClear();
  try {
    sessionStorage.clear();
  } catch {
    /* ignore */
  }
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: { ...originalLocation, reload },
  });
});

afterEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: originalLocation,
  });
});

// ── §11 matcher matrix ───────────────────────────────────────────────────────
describe("isStaleChunkError", () => {
  it("A. Chromium 'Failed to fetch dynamically imported module' → true", () => {
    expect(
      isStaleChunkError(
        new TypeError(
          "Failed to fetch dynamically imported module: https://example.com/assets/Page.js",
        ),
      ),
    ).toBe(true);
  });

  it("B. Firefox 'error loading dynamically imported module' → true (exact Production case)", () => {
    expect(
      isStaleChunkError(
        new TypeError(
          "error loading dynamically imported module: https://example.com/assets/Page.js",
        ),
      ),
    ).toBe(true);
  });

  it("C. Safari 'Importing a module script failed.' → true", () => {
    expect(isStaleChunkError(new TypeError("Importing a module script failed."))).toBe(true);
  });

  it("D. 'Loading chunk AdminPanel failed' → true", () => {
    expect(isStaleChunkError(new Error("Loading chunk AdminPanel failed"))).toBe(true);
  });

  it("E. generic 'Failed to fetch' → false (ordinary API/network failure)", () => {
    expect(isStaleChunkError(new TypeError("Failed to fetch"))).toBe(false);
  });

  it("F. 'Network request failed' → false", () => {
    expect(isStaleChunkError(new Error("Network request failed"))).toBe(false);
  });

  it("G. 'Unauthorized' → false", () => {
    expect(isStaleChunkError(new Error("Unauthorized"))).toBe(false);
  });

  it("H. 'Purpose / Title is required' → false (ordinary validation error)", () => {
    expect(isStaleChunkError(new Error("Purpose / Title is required"))).toBe(false);
  });

  it("non-Error values → false", () => {
    expect(isStaleChunkError(null)).toBe(false);
    expect(isStaleChunkError(undefined)).toBe(false);
    expect(isStaleChunkError(42)).toBe(false);
    expect(isStaleChunkError({})).toBe(false);
  });

  it("also matches a bare string carrying the Firefox wording", () => {
    expect(
      isStaleChunkError("error loading dynamically imported module: /assets/x.js"),
    ).toBe(true);
  });
});

// ── §12/§13 guarded reload primitive ─────────────────────────────────────────
describe("recoverFromStaleChunk (single guarded reload)", () => {
  it("reloads exactly once, then blocks within the cooldown (no loop)", () => {
    expect(recoverFromStaleChunk()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    // Second attempt inside the cooldown must NOT reload again.
    expect(recoverFromStaleChunk()).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("recovers again after a successful import clears the marker", () => {
    expect(recoverFromStaleChunk()).toBe(true);
    clearStaleChunkReloadFlag();
    expect(recoverFromStaleChunk()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });
});

// ── §12 vite:preloadError handler ────────────────────────────────────────────
describe("installPreloadErrorHandler (vite:preloadError)", () => {
  function firePreloadError(): boolean {
    const ev = new Event("vite:preloadError", { cancelable: true });
    (ev as unknown as { payload: Error }).payload = new TypeError(
      "error loading dynamically imported module: /assets/AdminPanel-OLDHASH.js",
    );
    window.dispatchEvent(ev);
    return ev.defaultPrevented;
  }

  it("recovers a stale preload once: preventDefault + a single reload", () => {
    installPreloadErrorHandler();
    installPreloadErrorHandler(); // idempotent — only one listener
    const prevented = firePreloadError();
    expect(prevented).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does NOT preventDefault a second failure within cooldown (stays observable)", () => {
    installPreloadErrorHandler();
    firePreloadError(); // reloads, sets cooldown
    reload.mockClear();
    const prevented = firePreloadError(); // cooldown active
    expect(prevented).toBe(false); // propagates to ErrorBoundary / monitoring
    expect(reload).not.toHaveBeenCalled();
  });

  it("ignores unrelated window events", () => {
    installPreloadErrorHandler();
    window.dispatchEvent(new Event("resize"));
    expect(reload).not.toHaveBeenCalled();
  });
});
