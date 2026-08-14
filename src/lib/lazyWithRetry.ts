import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import {
  clearStaleChunkReloadFlag,
  isStaleChunkError,
  recoverFromStaleChunk,
} from "./chunkRecovery";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const MALFORMED_MODULE_MESSAGE = "Loaded module has no default export";

/** True for the marker error thrown below when a resolved module has no usable `default`. */
function isMalformedModuleError(error: unknown): boolean {
  return error instanceof Error && error.message === MALFORMED_MODULE_MESSAGE;
}

/**
 * A dynamic import can resolve successfully (no rejected promise — the
 * network fetch worked) yet still be unusable: `undefined`, `{}`, or any
 * shape without a `default`. React.lazy would then crash reading `.default`
 * off it. Validating here lets that case go through the SAME retry-then-
 * guarded-reload path as a stale-chunk rejection, instead of a distinct,
 * unhandled crash.
 */
function hasUsableDefault<T>(module: unknown): module is { default: T } {
  if (typeof module !== "object" || module === null) return false;
  const value = (module as { default?: unknown }).default;
  return value !== undefined && value !== null;
}

export function lazyWithRetry<T extends ComponentType<unknown>>(
  importer: () => Promise<{ default: T }>,
): LazyExoticComponent<T> {
  return lazy(async () => {
    try {
      const module = await importer();
      if (!hasUsableDefault<T>(module)) throw new Error(MALFORMED_MODULE_MESSAGE);
      clearStaleChunkReloadFlag();
      return module;
    } catch (error) {
      if (!isStaleChunkError(error) && !isMalformedModuleError(error)) throw error;

      // A stale dynamic import is often transient (network blip, SW swapping caches).
      // Retry the import in place once before resorting to a reload — this avoids the page
      // getting stuck on a blank Suspense and needing a manual refresh to switch.
      try {
        await delay(400);
        const module = await importer();
        if (!hasUsableDefault<T>(module)) throw new Error(MALFORMED_MODULE_MESSAGE);
        clearStaleChunkReloadFlag();
        return module;
      } catch (retryError) {
        // Still stale/malformed after a retry — hand off to the ONE shared guarded
        // reload primitive (same cooldown as the vite:preloadError handler and the
        // ErrorBoundary, so this reloads once, never in a loop). If the reload
        // cooldown is already active, recoverFromStaleChunk() returns false and the
        // real error surfaces instead of retrying forever — a genuine build/export
        // bug fails identically after the reload and is never silently swallowed.
        if (
          (isStaleChunkError(retryError) || isMalformedModuleError(retryError)) &&
          recoverFromStaleChunk()
        ) {
          return new Promise<{ default: T }>(() => {}); // hold until reload
        }
        throw retryError;
      }
    }
  });
}

// Re-exported so existing importers (ErrorBoundary, tests) keep a single source.
export { isStaleChunkError, clearStaleChunkReloadFlag } from "./chunkRecovery";
