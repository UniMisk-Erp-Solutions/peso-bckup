/**
 * Central stale dynamic-import (chunk) recovery.
 *
 * After a deployment, hashed asset filenames change and the previous build's
 * chunks are deleted. A tab opened on the OLD release that then navigates and
 * lazy-imports an old hashed chunk gets a load failure — classic version skew.
 *
 * Recovery has two independent signals so it does not depend on one browser's
 * wording:
 *   1. `vite:preloadError` — Vite's own browser-independent event for a failed
 *      dynamic-import preload. This is the primary signal (see installPreloadErrorHandler).
 *   2. `isStaleChunkError(error)` — a message matcher for the Error we get in the
 *      React.lazy catch and the ErrorBoundary, where no Vite event is available.
 *
 * All three call sites (lazyWithRetry, the preload handler, ErrorBoundary) share
 * ONE guarded reload primitive (recoverFromStaleChunk) and ONE cooldown marker,
 * so a stale chunk triggers exactly one reload — never a loop, never three
 * competing reload implementations.
 */

const CHUNK_RELOAD_KEY = "pesowise-chunk-reload";
/** After a recovery reload, block another for this long so a genuinely broken
 *  CURRENT deployment can't loop — but a later, unrelated transient failure can
 *  still self-heal (the marker is cleared on the next successful import). */
const RELOAD_COOLDOWN_MS = 30_000;

/**
 * True only for JavaScript dynamic-import / chunk LOAD failures, across browsers.
 *
 * Deliberately specific: a bare "Failed to fetch" or a network/API/auth error is
 * NOT a stale chunk, and conflating them would auto-reload the page on ordinary
 * request failures. Every branch here names module/chunk loading explicitly.
 */
export function isStaleChunkError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  if (!message) return false;
  return (
    // Chromium / Chrome / Edge / newer WebKit
    /Failed to fetch dynamically imported module/i.test(message) ||
    // Firefox (the exact Production wording that bypassed recovery)
    /error loading dynamically imported module/i.test(message) ||
    // Safari / older WebKit
    /Importing a module script failed/i.test(message) ||
    // Webpack-style chunk naming (defensive; harmless under Vite)
    /Loading chunk [\w-]+ failed/i.test(message) ||
    /Loading CSS chunk [\w-]+ failed/i.test(message)
  );
}

/** After a successful boot/import, clear the marker so a future stale chunk can
 *  recover again — recovery is not once-per-session-forever. */
export function clearStaleChunkReloadFlag(): void {
  try {
    sessionStorage.removeItem(CHUNK_RELOAD_KEY);
  } catch {
    /* storage unavailable — ignore */
  }
}

function reloadedRecently(): boolean {
  try {
    const raw = sessionStorage.getItem(CHUNK_RELOAD_KEY);
    if (!raw) return false;
    const ts = Number(raw);
    return Number.isFinite(ts) && Date.now() - ts < RELOAD_COOLDOWN_MS;
  } catch {
    return false;
  }
}

function markReloaded(): void {
  try {
    sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()));
  } catch {
    /* storage unavailable — ignore */
  }
}

/**
 * THE single guarded reload primitive. Reloads the page once to pick up the
 * current HTML + current hashed chunks, then blocks further reloads for the
 * cooldown. Returns true iff it initiated a reload; false means the cooldown is
 * active (we already reloaded once — a still-failing import now indicates a
 * genuinely broken CURRENT deployment, which the caller should keep observable).
 */
export function recoverFromStaleChunk(): boolean {
  if (reloadedRecently()) return false;
  markReloaded();
  try {
    window.location.reload();
  } catch {
    /* non-browser env (tests) — the marker is still set, which is what we assert */
  }
  return true;
}

let preloadHandlerInstalled = false;

/**
 * Register the Vite-native recovery signal EARLY in bootstrap, before any route
 * navigation can trigger a lazy import. `vite:preloadError` fires when a dynamic
 * import's preload fails for ANY reason (404 after a deploy, network) — it does
 * not depend on a browser-specific error string, which is exactly why it is the
 * primary signal.
 *
 * On the first failure we reload (guarded) and preventDefault so the recoverable
 * stale chunk does not bubble into the ErrorBoundary as a hard crash. If the
 * cooldown is active (we already reloaded and it STILL failed), we do NOT
 * preventDefault — the error propagates so a genuinely broken current deploy
 * stays observable in monitoring.
 */
export function installPreloadErrorHandler(): void {
  if (preloadHandlerInstalled) return;
  if (typeof window === "undefined") return;
  preloadHandlerInstalled = true;
  window.addEventListener("vite:preloadError", (event) => {
    // vite:preloadError only fires for module-preload failures, so it is a
    // chunk-load signal regardless of the payload's wording.
    if (recoverFromStaleChunk()) {
      event.preventDefault();
    }
    // else: cooldown active → let it propagate to the ErrorBoundary / monitoring.
  });
}

/** Test-only: reset the one-time install guard. */
export function __resetPreloadHandlerForTests(): void {
  preloadHandlerInstalled = false;
}
