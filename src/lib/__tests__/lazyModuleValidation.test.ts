/**
 * lazyWithRetry — malformed-module case (debug/6456-supervisor-auth-runtime, §38-39).
 *
 * A dynamic import can resolve successfully (no rejected promise) yet still
 * be unusable — `undefined`, `{}`, or any shape without a `default`. Before
 * this fix, only rejected promises were handled; a resolved-but-malformed
 * module passed straight through to React.lazy, which crashes reading
 * `.default` off it. These tests call the real `lazyWithRetry` (not source
 * regex) with controllable importers to prove the retry → guarded-reload →
 * surface-real-error behavior.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement, Suspense } from "react";
import { render, waitFor } from "@testing-library/react";
import { lazyWithRetry } from "@/lib/lazyWithRetry";

vi.mock("@/lib/chunkRecovery", () => ({
  isStaleChunkError: (error: unknown) =>
    error instanceof Error && /dynamically imported module/i.test(error.message),
  clearStaleChunkReloadFlag: vi.fn(),
  recoverFromStaleChunk: vi.fn(() => false), // no jsdom reload in tests
}));

/** A minimal error boundary so a thrown lazy-load error is observable. */
function TestBoundary({ children }: { children: React.ReactNode }) {
  return children as JSX.Element;
}

async function renderLazy(importer: () => Promise<unknown>) {
  const Lazy = lazyWithRetry(importer as () => Promise<{ default: React.ComponentType }>);
  let caughtError: Error | null = null;
  class Boundary extends (await import("react")).Component<
    { children: React.ReactNode },
    { error: Error | null }
  > {
    state = { error: null as Error | null };
    static getDerivedStateFromError(error: Error) {
      return { error };
    }
    componentDidCatch(error: Error) {
      caughtError = error;
    }
    render() {
      if (this.state.error) return createElement("div", null, "errored");
      return this.props.children;
    }
  }
  render(
    createElement(
      Boundary,
      null,
      createElement(Suspense, { fallback: createElement("div", null, "loading") }, createElement(Lazy)),
    ),
  );
  return () => caughtError;
}

describe("lazyWithRetry — resolved-but-malformed module", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("retries once when the module resolves to {} (no default), then surfaces a real error if still malformed", async () => {
    let calls = 0;
    const importer = vi.fn(async () => {
      calls += 1;
      return {}; // malformed both times — never a rejected promise
    });

    const getError = await renderLazy(importer);

    await waitFor(() => expect(calls).toBeGreaterThanOrEqual(2), { timeout: 2000 });
    await waitFor(() => expect(getError()).not.toBeNull(), { timeout: 2000 });
    expect(getError()?.message).toBe("Loaded module has no default export");
  });

  it("recovers on the retry when the second attempt resolves a real module", async () => {
    let calls = 0;
    const RealComponent = () => createElement("div", null, "loaded");
    const importer = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return {}; // first attempt malformed
      return { default: RealComponent }; // retry succeeds
    });

    const getError = await renderLazy(importer);

    await waitFor(() => expect(calls).toBe(2), { timeout: 2000 });
    await waitFor(() => expect(getError()).toBeNull(), { timeout: 2000 });
  });

  it("treats undefined the same as {} — no crash reading .default off undefined", async () => {
    const importer = vi.fn(async () => undefined as unknown);
    const getError = await renderLazy(importer);
    await waitFor(() => expect(getError()).not.toBeNull(), { timeout: 2000 });
    expect(getError()?.message).toBe("Loaded module has no default export");
  });

  it("a genuine rejected import (not malformed-module) still surfaces its own real error", async () => {
    const importer = vi.fn(async () => {
      throw new Error("Some other build failure");
    });
    const getError = await renderLazy(importer);
    await waitFor(() => expect(getError()).not.toBeNull(), { timeout: 2000 });
    expect(getError()?.message).toBe("Some other build failure");
  });
});
