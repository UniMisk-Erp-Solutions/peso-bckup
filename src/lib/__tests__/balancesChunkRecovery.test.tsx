import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Suspense, type ComponentType } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { lazyWithRetry } from "@/lib/lazyWithRetry";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { hasChunkReloadBeenAttempted, isStaleChunkError, recoverFromStaleChunk, clearStaleChunkReloadFlag } from "@/lib/chunkRecovery";

const report = vi.fn();
vi.mock("@/lib/monitoring", () => ({ reportError: (...a: unknown[]) => report(...a) }));

const reload = vi.fn();
const originalLocation = window.location;

beforeEach(() => {
  reload.mockClear();
  report.mockClear();
  sessionStorage.clear();
  Object.defineProperty(window, "location", { configurable: true, writable: true, value: { ...originalLocation, reload } });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(window, "location", { configurable: true, writable: true, value: originalLocation });
});

type Importer = () => Promise<{ default: ComponentType<unknown> }>;
const FIREFOX_404 = "error loading dynamically imported module: https://pesowise.unimisk.com/assets/Balances-OLDHASH.js";

function renderRoute(importer: Importer) {
  const Balances = lazyWithRetry(importer);
  return render(
    <ErrorBoundary>
      <Suspense fallback={<div>loading</div>}>
        <Balances />
      </Suspense>
    </ErrorBoundary>,
  );
}

describe("Balances chunk failure after a deployment (DOC-150 follow-up)", () => {
  it("1. classifies the 404'd old hashed chunk (Firefox/Chromium/Safari wordings)", () => {
    expect(isStaleChunkError(new TypeError(FIREFOX_404))).toBe(true);
    expect(isStaleChunkError(new TypeError("Failed to fetch dynamically imported module: /assets/Balances-X.js"))).toBe(true);
    expect(isStaleChunkError(new TypeError("Importing a module script failed."))).toBe(true);
  });

  it("2/6/8. stale deployment: the old Balances chunk 404s -> exactly ONE recovery reload, uses the flag name", async () => {
    const importer = vi.fn<Importer>().mockRejectedValue(new TypeError(FIREFOX_404));
    renderRoute(importer);
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(sessionStorage.getItem("pw_chunk_reload_attempted")).not.toBeNull();
    expect(hasChunkReloadBeenAttempted()).toBe(true);
    expect(report).not.toHaveBeenCalled();
  });

  it("3/7. direct /balances refresh that still hits the removed chunk: no second reload, friendly 'new version' UI with Reload now", async () => {
    sessionStorage.setItem("pw_chunk_reload_attempted", String(Date.now())); // the first (and only) auto reload already happened
    const importer = vi.fn<Importer>().mockRejectedValue(new TypeError(FIREFOX_404));
    renderRoute(importer);
    expect(await screen.findByText("A new version is available")).toBeTruthy();
    expect(screen.getByText("A new version of PesoWise was deployed. Please refresh the page.")).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reload now" }));
    expect(reload).toHaveBeenCalledTimes(1); // user-initiated reload is allowed
  });

  it("recovery succeeds after the reload: the NEW Balances chunk loads and the flag is cleared", async () => {
    sessionStorage.setItem("pw_chunk_reload_attempted", String(Date.now()));
    const Balances: ComponentType = () => <div>balances loaded</div>;
    renderRoute(vi.fn<Importer>().mockResolvedValue({ default: Balances as ComponentType<unknown> }));
    expect(await screen.findByText("balances loaded")).toBeTruthy();
    expect(sessionStorage.getItem("pw_chunk_reload_attempted")).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });

  it("4. an unrelated React render error does NOT reload and shows the normal error screen", async () => {
    const Boom: ComponentType = () => {
      throw new Error("Cannot read properties of undefined (reading 'map')");
    };
    renderRoute(vi.fn<Importer>().mockResolvedValue({ default: Boom as ComponentType<unknown> }));
    expect(await screen.findByText("Something went wrong")).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("5. API / auth / database errors from the import path never reload", async () => {
    for (const msg of ["Failed to fetch", "JWT expired", "new row violates row-level security policy", "Bill photos are required"]) {
      sessionStorage.clear();
      reload.mockClear();
      const { unmount } = renderRoute(vi.fn<Importer>().mockRejectedValue(new Error(msg)));
      await screen.findByText("Something went wrong");
      expect(reload).not.toHaveBeenCalled();
      unmount();
    }
  });

  it("one attempt only: a second stale failure is refused until a successful import clears the flag", () => {
    expect(recoverFromStaleChunk()).toBe(true);
    expect(recoverFromStaleChunk()).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    clearStaleChunkReloadFlag();
    expect(recoverFromStaleChunk()).toBe(true);
  });
});
