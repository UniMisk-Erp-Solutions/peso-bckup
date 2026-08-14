import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { recoverFromStaleChunk } from "@/lib/chunkRecovery";
import { reportError } from "@/lib/monitoring";

vi.mock("@/lib/monitoring", () => ({ reportError: vi.fn() }));

const reload = vi.fn();
const originalLocation = window.location;
const Fallback = () => <span>fallback</span>;

function Boom({ err }: { err: Error }): never {
  throw err;
}

beforeEach(() => {
  reload.mockClear();
  (reportError as unknown as ReturnType<typeof vi.fn>).mockClear();
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

describe("ErrorBoundary stale-chunk recovery", () => {
  const FIREFOX_STALE = new TypeError(
    "error loading dynamically imported module: https://pesowise.unimisk.com/assets/AdminPanel-OLDHASH.js",
  );

  // §14 — the exact Production Firefox error must self-heal (reload once) and
  // NOT be reported as a first-class React crash while recovery is occurring.
  it("recovers a Firefox stale-chunk render error without a monitoring event", () => {
    render(
      <ErrorBoundary fallback={Fallback}>
        <Boom err={FIREFOX_STALE} />
      </ErrorBoundary>,
    );
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("reports an ordinary render error and does NOT reload", () => {
    render(
      <ErrorBoundary fallback={Fallback}>
        <Boom err={new Error("Purpose / Title is required")} />
      </ErrorBoundary>,
    );
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByText("fallback")).toBeInTheDocument();
  });

  // §9 — if the SAME release still throws a stale-chunk error after a guarded
  // reload (cooldown active), it is a genuinely broken current deploy and must
  // stay observable.
  it("reports a stale chunk that persists after a guarded reload", () => {
    recoverFromStaleChunk(); // consumes the one reload, sets the cooldown
    reload.mockClear();
    render(
      <ErrorBoundary fallback={Fallback}>
        <Boom err={FIREFOX_STALE} />
      </ErrorBoundary>,
    );
    expect(reload).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});
