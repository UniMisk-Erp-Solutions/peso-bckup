import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Suspense, type ComponentType } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { lazyWithRetry } from "@/lib/lazyWithRetry";
import { ErrorBoundary } from "@/components/ErrorBoundary";

// ErrorBoundary reports non-stale errors; keep monitoring quiet in tests.
vi.mock("@/lib/monitoring", () => ({ reportError: vi.fn() }));

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
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: originalLocation,
  });
});

type Importer = () => Promise<{ default: ComponentType<unknown> }>;

describe("lazyWithRetry", () => {
  // §13 + §15 — the exact Firefox/Vite stale dynamic-import wording seen in
  // Production for /assets/AdminPanel-<hash>.js after a deployment.
  it("reloads once when the import and its retry both hit the Firefox stale wording", async () => {
    const importer = vi.fn<Importer>().mockRejectedValue(
      new TypeError(
        "error loading dynamically imported module: https://pesowise.unimisk.com/assets/AdminPanel-OLDHASH.js",
      ),
    );
    const Lazy = lazyWithRetry(importer);
    render(
      <Suspense fallback={<span>loading…</span>}>
        <Lazy />
      </Suspense>,
    );
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1), { timeout: 3000 });
    // initial import + exactly one in-place retry before the guarded reload
    expect(importer).toHaveBeenCalledTimes(2);
  });

  it("does not reload on a successful import", async () => {
    const Ok = () => <div>ready</div>;
    const Lazy = lazyWithRetry(() => Promise.resolve({ default: Ok }));
    render(
      <Suspense fallback={<span>loading…</span>}>
        <Lazy />
      </Suspense>,
    );
    expect(await screen.findByText("ready")).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
  });

  it("propagates a non-stale import error without retrying or reloading", async () => {
    const importer = vi.fn<Importer>().mockRejectedValue(
      new Error("Purpose / Title is required"),
    );
    const Lazy = lazyWithRetry(importer);
    render(
      <ErrorBoundary fallback={() => <span>boom</span>}>
        <Suspense fallback={<span>loading…</span>}>
          <Lazy />
        </Suspense>
      </ErrorBoundary>,
    );
    expect(await screen.findByText("boom")).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
    expect(importer).toHaveBeenCalledTimes(1); // no retry for a non-stale error
  });
});
