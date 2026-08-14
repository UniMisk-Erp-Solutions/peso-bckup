/**
 * DOC-090 — monitoring classification rules.
 *
 * Includes regression fixtures for every class of entry visible in the reported
 * GlitchTip issue list. These prove the CLASSIFICATION, not a blacklist: the
 * same message text is kept or dropped depending on whether PesoWise frames are
 * present, which is the only honest way to separate our bugs from bridge noise.
 */
import { describe, it, expect } from "vitest";
import {
  buildFingerprint,
  handledIssueTitle,
  hasApplicationFrame,
  isApplicationFrame,
  isExpectedAuthRecovery,
  isMeaninglessTitle,
  isThirdPartyFrame,
  looksLikeExternalBridgeNoise,
  normalizeError,
  scrubObject,
  scrubUrl,
  shouldDropEvent,
} from "@/lib/monitoringClassify";

const APP_FRAME = { filename: "https://app.example.com/assets/index-ABC123.js" };
const SRC_FRAME = { filename: "src/services/ExpenseService.ts" };
const EXT_FRAME = { filename: "chrome-extension://abcdef/content.js" };
const GRAMMARLY = { filename: "https://cdn.grammarly.com/inject.js" };
const VERCEL = { filename: "https://vercel.live/_next-live/feedback/feedback.js" };

describe("normalizeError", () => {
  it("keeps a real Error and its stack", () => {
    const err = new TypeError("Cannot read properties of undefined");
    const n = normalizeError(err);
    expect(n.name).toBe("TypeError");
    expect(n.message).toContain("Cannot read properties");
    expect(n.original).toBe(err);
    expect(n.original?.stack).toBeDefined();
  });

  it("extracts Supabase/PostgREST fields", () => {
    const n = normalizeError({
      message: "permission denied for table expenses",
      code: "42501",
      details: "RLS",
      hint: "check policy",
    });
    expect(n.message).toContain("permission denied");
    expect(n.code).toBe("42501");
    expect(n.details).toBe("RLS");
    expect(n.hint).toBe("check policy");
  });

  it("extracts auth error status", () => {
    const n = normalizeError({ name: "AuthApiError", message: "Unauthorized", status: 401 });
    expect(n.name).toBe("AuthApiError");
    expect(n.status).toBe(401);
  });

  it("handles a string throw", () => {
    expect(normalizeError("boom").message).toBe("boom");
  });

  it.each([
    [null, "Null thrown"],
    [undefined, "Undefined thrown"],
  ])("handles %s", (input, expected) => {
    expect(normalizeError(input).message).toBe(expected);
  });

  it("never produces [object Object] or undefined as a message", () => {
    for (const input of [{}, { foo: "bar" }, { nested: { a: 1 } }, 42, true]) {
      const n = normalizeError(input);
      expect(n.message).not.toContain("[object Object]");
      expect(n.message).not.toBe("undefined");
      expect(n.message.length).toBeGreaterThan(0);
    }
  });

  it("truncates a huge message instead of making it the whole title", () => {
    const n = normalizeError(new Error("x".repeat(5000)));
    expect(n.message.length).toBeLessThanOrEqual(301);
  });
});

describe("isMeaninglessTitle — the $L / LL / z$ class", () => {
  it.each(["$L", "LL", "z$", "hL", "a2", "k2", "C2", "", "  "])(
    "treats %j as meaningless",
    (t) => expect(isMeaninglessTitle(t)).toBe(true),
  );

  it.each([
    "TypeError",
    "Failed to fetch",
    "AuthApiError",
    "Purpose / Title is required",
    "404",
    "500",
  ])("keeps %j", (t) => expect(isMeaninglessTitle(t)).toBe(false));
});

describe("frame origin", () => {
  it.each([EXT_FRAME, GRAMMARLY, VERCEL])("recognises third-party %j", (f) => {
    expect(isThirdPartyFrame(f.filename)).toBe(true);
    expect(isApplicationFrame(f.filename)).toBe(false);
  });

  it.each([APP_FRAME, SRC_FRAME])("recognises application frame %j", (f) => {
    expect(isApplicationFrame(f.filename)).toBe(true);
  });

  it("detects an application frame among third-party ones", () => {
    expect(hasApplicationFrame([EXT_FRAME, APP_FRAME])).toBe(true);
    expect(hasApplicationFrame([EXT_FRAME, GRAMMARLY])).toBe(false);
    expect(hasApplicationFrame([])).toBe(false);
    expect(hasApplicationFrame(undefined)).toBe(false);
  });
});

describe("shouldDropEvent — screenshot regression fixtures", () => {
  it("drops a minified-symbol console event", () => {
    const d = shouldDropEvent({ message: "$L" });
    expect(d.drop).toBe(true);
    expect(d.reason).toBe("meaningless-symbol-title");
  });

  it("drops a third-party-only extension event", () => {
    const d = shouldDropEvent({
      exceptionType: "TypeError",
      exceptionValue: "Cannot read properties of null",
      frames: [EXT_FRAME, GRAMMARLY],
    });
    expect(d.drop).toBe(true);
    expect(d.reason).toBe("third-party-only-frames");
  });

  it("drops webkit bridge noise when no application frame is involved", () => {
    const d = shouldDropEvent({
      exceptionType: "TypeError",
      exceptionValue:
        "undefined is not an object (evaluating 'window.webkit.messageHandlers')",
      frames: [],
    });
    expect(d.drop).toBe(true);
    expect(d.reason).toBe("external-bridge-noise");
  });

  it("KEEPS the same webkit message when a PesoWise frame is present", () => {
    // The critical asymmetry: identical text, opposite verdict, decided by
    // evidence rather than by matching on the word "webkit".
    const d = shouldDropEvent({
      exceptionType: "TypeError",
      exceptionValue:
        "undefined is not an object (evaluating 'window.webkit.messageHandlers')",
      frames: [APP_FRAME],
    });
    expect(d.drop).toBe(false);
  });

  it("drops 'Java object is gone' bridge noise with no app frame", () => {
    expect(
      shouldDropEvent({
        exceptionValue: "Error invoking postMessage: Java object is gone",
        frames: [],
      }).drop,
    ).toBe(true);
  });

  it("drops expected stale-refresh-token recovery", () => {
    const d = shouldDropEvent({
      exceptionType: "AuthApiError",
      exceptionValue: "Invalid Refresh Token: Refresh Token Not Found",
      frames: [APP_FRAME],
    });
    expect(d.drop).toBe(true);
    expect(d.reason).toBe("expected-auth-recovery");
  });

  it("KEEPS an unexpected AuthApiError such as Unauthorized", () => {
    // Proves the auth rule is not "suppress all AuthApiError".
    expect(
      shouldDropEvent({
        exceptionType: "AuthApiError",
        exceptionValue: "Unauthorized",
        frames: [APP_FRAME],
      }).drop,
    ).toBe(false);
  });

  it("KEEPS a genuine application failure", () => {
    expect(
      shouldDropEvent({
        exceptionType: "TypeError",
        exceptionValue: "Failed to fetch",
        frames: [SRC_FRAME],
      }).drop,
    ).toBe(false);
  });

  it("never drops an explicitly reported event", () => {
    // handled:true wins over every heuristic — the caller had the context.
    expect(
      shouldDropEvent({
        handled: true,
        exceptionValue: "Invalid Refresh Token: Refresh Token Not Found",
        frames: [],
      }).drop,
    ).toBe(false);
    expect(shouldDropEvent({ handled: true, message: "$L" }).drop).toBe(false);
  });
});

describe("fingerprinting", () => {
  const base = { area: "expenses", operation: "approve-expense" };

  it("groups the same failure across different dynamic IDs", () => {
    const a = buildFingerprint(
      { ...base, errorCode: "PGRST301" },
      normalizeError(new Error("approval failed for transaction 00088")),
    );
    const b = buildFingerprint(
      { ...base, errorCode: "PGRST301" },
      normalizeError(new Error("approval failed for transaction 00102")),
    );
    expect(a).toEqual(b);
  });

  it("does NOT merge different technical failures in the same operation", () => {
    const authFailure = buildFingerprint({ ...base, errorCode: "42501" }, normalizeError(new Error("denied")));
    const networkFailure = buildFingerprint({ ...base, errorCode: "NETWORK" }, normalizeError(new Error("failed to fetch")));
    expect(authFailure).not.toEqual(networkFailure);
  });

  it("does not merge different operations", () => {
    expect(
      buildFingerprint({ area: "expenses", operation: "approve-expense" }, normalizeError(new Error("x"))),
    ).not.toEqual(
      buildFingerprint({ area: "expenses", operation: "submit-expense" }, normalizeError(new Error("x"))),
    );
  });

  it("falls back to the error name when no code exists", () => {
    expect(buildFingerprint(base, normalizeError(new TypeError("x")))).toEqual([
      "expenses",
      "approve-expense",
      "TypeError",
    ]);
  });

  it("honours an explicit fingerprintKey", () => {
    expect(buildFingerprint({ ...base, fingerprintKey: "custom" }, normalizeError(new Error("x")))).toEqual(["custom"]);
  });

  it("builds a stable title free of dynamic IDs", () => {
    const title = handledIssueTitle({ area: "expenses", operation: "approve-expense" });
    expect(title).toBe("expenses/approve-expense");
    expect(title).not.toMatch(/\d{5}/);
  });
});

describe("scrubbing", () => {
  it.each([
    "access_token",
    "refresh_token",
    "apikey",
    "authorization",
    "password",
    "session",
    "cookie",
  ])("redacts key %s", (key) => {
    const out = scrubObject({ [key]: "super-secret-value" }) as Record<string, string>;
    expect(out[key]).toBe("[redacted]");
    expect(JSON.stringify(out)).not.toContain("super-secret-value");
  });

  it("keeps non-sensitive fields intact", () => {
    const out = scrubObject({ area: "expenses", status: 500 }) as Record<string, unknown>;
    expect(out.area).toBe("expenses");
    expect(out.status).toBe(500);
  });

  it("scrubs nested secrets", () => {
    const out = scrubObject({ a: { b: { access_token: "x" } } });
    expect(JSON.stringify(out)).not.toContain('"x"');
  });

  it("survives deep/cyclic-ish structures without hanging", () => {
    let deep: Record<string, unknown> = { access_token: "leak" };
    for (let i = 0; i < 30; i++) deep = { nested: deep };
    expect(() => scrubObject(deep)).not.toThrow();
  });

  it("redacts sensitive query parameters but keeps the path", () => {
    const scrubbed = scrubUrl("https://api.example.com/v1/rpc?apikey=SECRET&page=2");
    expect(scrubbed).toContain("/v1/rpc");
    expect(scrubbed).toContain("page=2");
    expect(scrubbed).not.toContain("SECRET");
  });

  it("leaves a URL without a query string unchanged", () => {
    expect(scrubUrl("https://app.example.com/review")).toBe("https://app.example.com/review");
  });
});

describe("expected-condition helpers", () => {
  it.each([
    "Invalid Refresh Token: Refresh Token Not Found",
    "Auth session missing!",
  ])("treats %j as expected auth recovery", (m) => expect(isExpectedAuthRecovery(m)).toBe(true));

  it.each(["Unauthorized", "Invalid login credentials"])(
    "does NOT treat %j as expected recovery",
    (m) => expect(isExpectedAuthRecovery(m)).toBe(false),
  );

  it.each([
    "undefined is not an object (evaluating 'window.webkit.messageHandlers')",
    "Error invoking postMessage: Java object is gone",
  ])("recognises bridge noise %j", (m) => expect(looksLikeExternalBridgeNoise(m)).toBe(true));

  it("does not treat an ordinary app error as bridge noise", () => {
    expect(looksLikeExternalBridgeNoise("Failed to fetch")).toBe(false);
  });
});
