/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * DOC-090 — monitoring wiring: SDK init options, the beforeSend pipeline,
 * reporting API, scope handling, and source guards proving the duplicate
 * capture paths are gone.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const initMock = vi.fn();
const captureExceptionMock = vi.fn();
const captureMessageMock = vi.fn();
const addBreadcrumbMock = vi.fn();
const setUserMock = vi.fn();
const setTagMock = vi.fn();

const scope = {
  setLevel: vi.fn(),
  setTag: vi.fn(),
  setTags: vi.fn(),
  setExtras: vi.fn(),
  setFingerprint: vi.fn(),
};

vi.mock("@sentry/react", () => ({
  init: (...a: unknown[]) => initMock(...a),
  captureException: (...a: unknown[]) => captureExceptionMock(...a),
  captureMessage: (...a: unknown[]) => captureMessageMock(...a),
  addBreadcrumb: (...a: unknown[]) => addBreadcrumbMock(...a),
  setUser: (...a: unknown[]) => setUserMock(...a),
  setTag: (...a: unknown[]) => setTagMock(...a),
  withScope: (cb: (s: typeof scope) => void) => cb(scope),
}));

const SRC = resolve(process.cwd(), "src");
const read = (p: string) => readFileSync(resolve(SRC, p), "utf-8");
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

async function freshModule() {
  vi.resetModules();
  return await import("@/lib/monitoring");
}

// This repo's .env defines VITE_GLITCHTIP_DSN, and Vite inlines VITE_* at
// transform time — assigning to import.meta.env at runtime would not take
// effect. vi.stubEnv is the supported way to control it per test.
const DSN = "https://k@glitchtip.example/1";
const setDsn = (value: string) => vi.stubEnv("VITE_GLITCHTIP_DSN", value);

beforeEach(() => {
  vi.clearAllMocks();
  Object.values(scope).forEach((f) => f.mockClear?.());
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("initialization", () => {
  it("is a no-op with no DSN", async () => {
    setDsn("");
    const m = await freshModule();
    m.initMonitoring();
    expect(initMock).not.toHaveBeenCalled();
    expect(m.isMonitoringInitialized()).toBe(false);
  });

  it("initializes once even when called repeatedly", async () => {
    setDsn(DSN);
    const m = await freshModule();
    m.initMonitoring();
    m.initMonitoring();
    m.initMonitoring();
    expect(initMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT register captureConsoleIntegration", async () => {
    setDsn(DSN);
    const m = await freshModule();
    m.initMonitoring();
    const opts = initMock.mock.calls[0][0];
    // Console output must remain a breadcrumb source, never an issue source.
    expect(JSON.stringify(opts.integrations ?? [])).not.toContain("CaptureConsole");
    expect(opts.integrations).toBeUndefined();
  });

  it("carries release and deployment environment", async () => {
    setDsn(DSN);
    const m = await freshModule();
    m.initMonitoring();
    const opts = initMock.mock.calls[0][0];
    expect(opts.release).toBeTruthy();
    expect(opts.environment).toBeTruthy();
    expect(opts.release).toBe(m.getRelease());
    expect(opts.environment).toBe(m.getDeployEnvironment());
  });

  it("keeps sendDefaultPii false and installs beforeSend", async () => {
    setDsn(DSN);
    const m = await freshModule();
    m.initMonitoring();
    const opts = initMock.mock.calls[0][0];
    expect(opts.sendDefaultPii).toBe(false);
    expect(typeof opts.beforeSend).toBe("function");
  });
});

describe("beforeSend pipeline", () => {
  it("drops a minified-symbol event", async () => {
    const m = await freshModule();
    expect(m.processEvent({ message: "$L" } as any)).toBeNull();
  });

  it("keeps a real application error and scrubs it", async () => {
    const m = await freshModule();
    const out = m.processEvent({
      exception: {
        values: [
          {
            type: "TypeError",
            value: "Failed to fetch",
            stacktrace: { frames: [{ filename: "src/services/ExpenseService.ts" }] },
          },
        ],
      },
      request: { url: "https://app.example.com/review?apikey=SECRET&page=2" },
      extra: { access_token: "leak-me" },
    } as any);

    expect(out).not.toBeNull();
    expect(out!.request!.url).not.toContain("SECRET");
    expect(out!.request!.url).toContain("page=2");
    expect((out!.extra as any).access_token).toBe("[redacted]");
  });

  it("never drops an explicitly handled event", async () => {
    const m = await freshModule();
    const out = m.processEvent({
      tags: { pesowise_handled: true },
      exception: { values: [{ type: "AuthApiError", value: "Invalid Refresh Token" }] },
    } as any);
    expect(out).not.toBeNull();
  });

  it("scrubs breadcrumb data", async () => {
    const m = await freshModule();
    const out = m.processEvent({
      exception: {
        values: [
          { type: "Error", value: "x", stacktrace: { frames: [{ filename: "src/a.ts" }] } },
        ],
      },
      breadcrumbs: [{ message: "req", data: { authorization: "Bearer abc" } }],
    } as any);
    expect(JSON.stringify(out!.breadcrumbs)).not.toContain("Bearer abc");
  });
});

describe("reportError", () => {
  async function initialized() {
    setDsn(DSN);
    const m = await freshModule();
    m.initMonitoring();
    return m;
  }

  it("is a no-op before init", async () => {
    setDsn("");
    const m = await freshModule();
    m.reportError(new Error("x"), { area: "a", operation: "b" });
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it("preserves the original Error object", async () => {
    const m = await initialized();
    const err = new TypeError("boom");
    m.reportError(err, { area: "expenses", operation: "approve-expense" });
    expect(captureExceptionMock).toHaveBeenCalledWith(err);
  });

  it("tags the event as handled so beforeSend cannot drop it", async () => {
    const m = await initialized();
    m.reportError(new Error("x"), { area: "expenses", operation: "approve-expense" });
    expect(scope.setTag).toHaveBeenCalledWith("pesowise_handled", true);
    expect(scope.setTag).toHaveBeenCalledWith("area", "expenses");
    expect(scope.setTag).toHaveBeenCalledWith("operation", "approve-expense");
  });

  it("applies a stable fingerprint", async () => {
    const m = await initialized();
    m.reportError(new Error("failed for txn 00088"), {
      area: "expenses",
      operation: "approve-expense",
      errorCode: "PGRST301",
    });
    expect(scope.setFingerprint).toHaveBeenCalledWith([
      "expenses",
      "approve-expense",
      "PGRST301",
    ]);
  });

  it("sends a titled message when there is no real Error", async () => {
    const m = await initialized();
    m.reportError({ code: "42501" }, { area: "expenses", operation: "approve-expense" });
    expect(captureExceptionMock).not.toHaveBeenCalled();
    const [msg] = captureMessageMock.mock.calls[0];
    expect(msg).toContain("expenses/approve-expense");
    expect(msg).not.toContain("[object Object]");
  });

  it("scrubs secrets out of caller-supplied extra", async () => {
    const m = await initialized();
    m.reportError(new Error("x"), {
      area: "auth",
      operation: "sign-in",
      extra: { refresh_token: "leak", route: "/auth" },
    });
    const extras = scope.setExtras.mock.calls[0][0];
    expect(extras.refresh_token).toBe("[redacted]");
    expect(extras.route).toBe("/auth");
  });
});

describe("scope lifecycle", () => {
  async function initialized() {
    setDsn(DSN);
    const m = await freshModule();
    m.initMonitoring();
    return m;
  }

  it("sets id-only user context, never email or name", async () => {
    const m = await initialized();
    m.setMonitoringUser({ userId: "u-1", organizationId: "org-1", role: "admin" });
    expect(setUserMock).toHaveBeenCalledWith({ id: "u-1" });
    const payload = JSON.stringify(setUserMock.mock.calls[0][0]);
    expect(payload).not.toContain("@");
    expect(setTagMock).toHaveBeenCalledWith("organization_id", "org-1");
    expect(setTagMock).toHaveBeenCalledWith("user_role", "admin");
  });

  it("clears identity on sign-out so context cannot leak between users", async () => {
    const m = await initialized();
    m.setMonitoringUser({ userId: "u-1", organizationId: "org-1" });
    m.clearMonitoringUser();
    expect(setUserMock).toHaveBeenLastCalledWith(null);
    expect(setTagMock).toHaveBeenCalledWith("organization_id", "none");
  });

  it("records breadcrumbs without creating issues", async () => {
    const m = await initialized();
    m.recordBreadcrumb("ui.toast", "Purpose / Title is required", { variant: "destructive" });
    expect(addBreadcrumbMock).toHaveBeenCalled();
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(captureMessageMock).not.toHaveBeenCalled();
  });
});

describe("source guards — duplicate capture paths removed", () => {
  it("use-toast no longer reports destructive toasts as issues", () => {
    // Strip comments: the explanatory note names reportMessage() on purpose.
    const src = stripComments(read("hooks/use-toast.ts"));
    expect(src).not.toMatch(/reportMessage\s*\(/);
    expect(src).not.toMatch(/reportError\s*\(/);
    // Breadcrumb only.
    expect(src).toMatch(/recordBreadcrumb\(/);
  });

  it("ErrorBoundary emits exactly one monitoring report", () => {
    const src = read("components/ErrorBoundary.tsx");
    const reports = src.match(/reportError\(/g) ?? [];
    expect(reports).toHaveLength(1);
    // The developer console log survives, but only outside production, so it
    // cannot become a second event via any console-capture path.
    expect(src).toMatch(/import\.meta\.env\.DEV/);
  });

  it("monitoring never re-registers default integrations by hand", () => {
    const src = read("lib/monitoring.ts");
    expect(src).not.toMatch(/Sentry\.browserApiErrorsIntegration\(/);
    expect(src).not.toMatch(/Sentry\.globalHandlersIntegration\(/);
    expect(src).not.toMatch(/Sentry\.captureConsoleIntegration\(/);
  });

  it("no VITE_-prefixed GlitchTip auth token exists anywhere", () => {
    // A VITE_ variable is inlined into browser JS; an upload token must never be.
    const files = [
      read("lib/monitoring.ts"),
      readFileSync(resolve(process.cwd(), "vite.config.ts"), "utf-8"),
      readFileSync(resolve(process.cwd(), "scripts/glitchtip-sourcemaps.mjs"), "utf-8"),
    ].join("\n");
    expect(files).not.toMatch(/VITE_[A-Z_]*(AUTH|TOKEN|SECRET|KEY)/);
    expect(files).not.toMatch(/VITE_SENTRY/);
  });

  it("build injects a non-secret release and deploy environment only", () => {
    const cfg = readFileSync(resolve(process.cwd(), "vite.config.ts"), "utf-8");
    expect(cfg).toMatch(/__APP_RELEASE__/);
    expect(cfg).toMatch(/__APP_DEPLOY_ENV__/);
    expect(cfg).toMatch(/sourcemap:\s*"hidden"/);
    // Nothing secret may be inlined into the bundle.
    expect(cfg).not.toMatch(/SENTRY_AUTH_TOKEN/);
  });
});

describe("source-map pipeline safety", () => {
  const script = readFileSync(
    resolve(process.cwd(), "scripts/glitchtip-sourcemaps.mjs"),
    "utf-8",
  );
  const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf-8"));

  it("the default build always runs the prune step", () => {
    // Vercel runs `npm run build`. Without this, 86 .map files would deploy and
    // the entire original source would be downloadable by guessing the URL.
    expect(pkg.scripts.build).toContain("glitchtip-sourcemaps.mjs");
  });

  it("prunes maps even when upload credentials are absent", () => {
    expect(script).toMatch(/pruneMaps\("no upload credentials"\)/);
  });

  it("missing credentials skip rather than fail the build", () => {
    // Preview and contributor builds must not depend on a Production secret.
    expect(script).toMatch(/SKIPPING upload/);
    expect(stripComments(script)).not.toMatch(/process\.exitCode = 1;[\s\S]{0,80}missing/);
  });

  it("uses the documented GlitchTip CLI commands", () => {
    expect(script).toMatch(/"sourcemaps",\s*"inject"/);
    expect(script).toMatch(/"sourcemaps",\s*"upload"/);
  });

  it("reads credentials only from build-only SENTRY_* env vars", () => {
    expect(script).toMatch(/SENTRY_URL/);
    expect(script).toMatch(/SENTRY_AUTH_TOKEN/);
    // Comments stripped: the header deliberately explains that nothing here is
    // VITE_-prefixed, and that prose must not fail its own guard.
    expect(stripComments(script)).not.toMatch(/VITE_/);
  });

  it("never prints the auth token", () => {
    expect(script).not.toMatch(/log\([^)]*SENTRY_AUTH_TOKEN[^)]*\)/);
    expect(script).not.toMatch(/console\.log\([^)]*authToken/i);
  });
});
