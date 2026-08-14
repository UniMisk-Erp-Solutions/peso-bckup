/**
 * DOC-090 — pure classification and scrubbing helpers for GlitchTip monitoring.
 *
 * Deliberately free of Sentry imports and browser globals beyond what is passed
 * in, so every rule below is unit-testable without a live SDK.
 *
 * The guiding rule: an event reaches GlitchTip only if a human could act on it.
 * Validation messages, handled auth recovery and third-party bridge noise are
 * not defects, and drowning the real errors in them is how the incident that
 * prompted this work started.
 */

/** Where a handled failure happened, supplied by the caller that has the context. */
export type MonitoringContext = {
  /** Feature area, e.g. "expenses", "auth", "receipts". */
  area: string;
  /** Specific operation, e.g. "approve-expense". Stable, never interpolated with IDs. */
  operation: string;
  /** Backend/PostgREST/Auth code when known — the most useful grouping key. */
  errorCode?: string;
  severity?: "warning" | "error" | "fatal";
  tags?: Record<string, string | number | boolean>;
  extra?: Record<string, unknown>;
  /** Overrides the derived fingerprint when a caller needs finer control. */
  fingerprintKey?: string;
};

/** Result of flattening an unknown thrown value into something reportable. */
export type NormalizedError = {
  /** Short, stable-ish label. Never a whole serialized object. */
  name: string;
  message: string;
  code?: string;
  status?: number | string;
  details?: string;
  hint?: string;
  /** The original Error when there was one — its stack must survive. */
  original?: Error;
};

const MAX_MESSAGE_LEN = 300;

/** Keys whose values must never leave the browser. */
const SECRET_KEY_PATTERN =
  /(access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|api[_-]?key|apikey|session|password|passwd|secret|credential|cookie|set-cookie|service[_-]?role|bearer|jwt|dsn)/i;

/** Query parameters scrubbed out of any URL we attach to an event. */
const SENSITIVE_QUERY_PARAMS = [
  "access_token",
  "refresh_token",
  "token",
  "apikey",
  "api_key",
  "key",
  "code",
  "password",
  "secret",
  "signature",
  "sig",
];

const REDACTED = "[redacted]";

/* -------------------------------------------------------------------------- */
/* Error normalization                                                         */
/* -------------------------------------------------------------------------- */

function truncate(value: string): string {
  const s = value.trim();
  return s.length > MAX_MESSAGE_LEN ? `${s.slice(0, MAX_MESSAGE_LEN)}…` : s;
}

function readString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  if (typeof v === "string" && v.trim()) return truncate(v);
  if (typeof v === "number") return String(v);
  return undefined;
}

/**
 * Flatten anything throwable into a reportable shape.
 *
 * Handles Error, Supabase/PostgREST error objects ({message, code, details,
 * hint}), AuthApiError ({message, status}), bare strings and unknown objects —
 * without ever producing "[object Object]" or "undefined" as a title, and
 * without swallowing the original stack.
 */
export function normalizeError(input: unknown): NormalizedError {
  if (input instanceof Error) {
    const anyErr = input as Error & Record<string, unknown>;
    return {
      name: input.name || "Error",
      message: truncate(input.message || String(input)),
      code: readString(anyErr, "code"),
      status: (typeof anyErr.status === "number" || typeof anyErr.status === "string"
        ? anyErr.status
        : undefined) as number | string | undefined,
      details: readString(anyErr, "details"),
      hint: readString(anyErr, "hint"),
      original: input,
    };
  }

  if (typeof input === "string") {
    const msg = input.trim();
    return { name: "Error", message: msg ? truncate(msg) : "Unknown error (empty string thrown)" };
  }

  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    const message =
      readString(obj, "message") ??
      readString(obj, "error_description") ??
      readString(obj, "error") ??
      readString(obj, "msg");
    const code = readString(obj, "code");
    const status = (typeof obj.status === "number" || typeof obj.status === "string"
      ? obj.status
      : undefined) as number | string | undefined;

    return {
      name: readString(obj, "name") ?? "UnknownObjectError",
      // Never stringify the whole object into the title — that is how issues
      // become unreadable. Missing message degrades to a code/status hint.
      message:
        message ??
        (code ? `Error code ${code}` : undefined) ??
        (status !== undefined ? `Error status ${status}` : undefined) ??
        "Non-Error object thrown (no message field)",
      code,
      status,
      details: readString(obj, "details"),
      hint: readString(obj, "hint"),
    };
  }

  if (input === null) return { name: "Error", message: "Null thrown" };
  if (input === undefined) return { name: "Error", message: "Undefined thrown" };
  return { name: "Error", message: truncate(`Non-object thrown: ${String(input)}`) };
}

/* -------------------------------------------------------------------------- */
/* Titles                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A stable human title for a handled failure, e.g. "expenses/approve-expense".
 * Callers pass a fixed operation, so transaction numbers and UUIDs never reach
 * the issue title — they belong in tags/extra.
 */
export function handledIssueTitle(ctx: MonitoringContext): string {
  return `${ctx.area}/${ctx.operation}`;
}

/**
 * Detect the meaningless short symbols seen in the GlitchTip issue list
 * ("$L", "LL", "z$", "hL", "a2", "k2", "C2").
 *
 * These are minified identifiers that reached an event title. This is a
 * *shape* test, not a blacklist of those seven strings: any very short token
 * made only of identifier punctuation/letters/digits, carrying no whitespace
 * and no real word, cannot describe a failure to a human.
 */
export function isMeaninglessTitle(title: string | undefined | null): boolean {
  if (!title) return true;
  const t = title.trim();
  if (!t) return true;
  if (t.length > 4) return false;
  if (/\s/.test(t)) return false;
  // Allow genuinely meaningful short words (rare, but do not discard them).
  if (/^(404|500|401|403|429|502|503|504|NaN|OOM)$/i.test(t)) return false;
  return /^[A-Za-z0-9$_]{1,4}$/.test(t);
}

/* -------------------------------------------------------------------------- */
/* Frame origin                                                                */
/* -------------------------------------------------------------------------- */

/** Frame origins that are never PesoWise code. */
const THIRD_PARTY_FRAME_PATTERNS = [
  /^chrome-extension:\/\//i,
  /^moz-extension:\/\//i,
  /^safari-extension:\/\//i,
  /^safari-web-extension:\/\//i,
  /grammarly/i,
  /vercel\.live/i,
  /_next-live\/feedback/i,
  /gtm\.js|googletagmanager|google-analytics/i,
];

export function isThirdPartyFrame(filename: string | undefined): boolean {
  if (!filename) return false;
  return THIRD_PARTY_FRAME_PATTERNS.some((re) => re.test(filename));
}

/**
 * True when a frame looks like our own bundle or source.
 *
 * Both the minified deployed shape (`/assets/index-ABC123.js`) and the
 * source-mapped shape (`src/services/ExpenseService.ts`) count, because this
 * must keep working before and after source maps land.
 */
export function isApplicationFrame(filename: string | undefined): boolean {
  if (!filename) return false;
  if (isThirdPartyFrame(filename)) return false;
  if (/^(native|<anonymous>)$/i.test(filename)) return false;
  return (
    /\/assets\/[^/]+\.(js|mjs)$/i.test(filename) ||
    /(^|\/)src\//i.test(filename) ||
    /\.(tsx?|jsx?)$/i.test(filename)
  );
}

export type EventFrameLike = { filename?: string };

/**
 * Does this event contain at least one PesoWise frame?
 *
 * This is the gate for dropping third-party noise. A message mentioning
 * `window.webkit.messageHandlers` is dropped only when NOTHING in the stack is
 * ours — never on the message text alone, because the same symptom with an
 * application frame is a real bug we must see.
 */
export function hasApplicationFrame(frames: EventFrameLike[] | undefined): boolean {
  if (!frames || frames.length === 0) return false;
  return frames.some((f) => isApplicationFrame(f.filename));
}

/* -------------------------------------------------------------------------- */
/* Expected (non-defect) conditions                                            */
/* -------------------------------------------------------------------------- */

/**
 * Messages produced by external webview/native bridges. Only meaningful in
 * combination with "no application frame" — see shouldDropEvent.
 */
const BRIDGE_NOISE_PATTERNS = [
  /window\.webkit\.messageHandlers/i,
  /Java object is gone/i,
  /Error invoking postMessage/i,
  /ResizeObserver loop/i,
];

export function looksLikeExternalBridgeNoise(message: string | undefined): boolean {
  if (!message) return false;
  return BRIDGE_NOISE_PATTERNS.some((re) => re.test(message));
}

/**
 * Auth states the application already handles by design.
 *
 * `recoverFromInvalidAuthSession` clears a stale token and re-authenticates;
 * reporting that as a defect produced a recurring issue for behaviour working
 * exactly as intended. Unexpected auth failures are NOT matched here and still
 * report — this must never become "suppress all AuthApiError".
 */
const EXPECTED_AUTH_PATTERNS = [
  /Invalid Refresh Token/i,
  /Refresh Token Not Found/i,
  /refresh_token_not_found/i,
  /Auth session missing/i,
  /session_not_found/i,
];

export function isExpectedAuthRecovery(message: string | undefined): boolean {
  if (!message) return false;
  return EXPECTED_AUTH_PATTERNS.some((re) => re.test(message));
}

/* -------------------------------------------------------------------------- */
/* Scrubbing                                                                   */
/* -------------------------------------------------------------------------- */

/** Remove sensitive query parameters from a URL, keeping the path readable. */
export function scrubUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  const qIndex = url.indexOf("?");
  if (qIndex === -1) return url;
  const base = url.slice(0, qIndex);
  const query = url.slice(qIndex + 1);
  const parts = query.split("&").map((pair) => {
    const eq = pair.indexOf("=");
    const key = eq === -1 ? pair : pair.slice(0, eq);
    const sensitive =
      SENSITIVE_QUERY_PARAMS.includes(key.toLowerCase()) || SECRET_KEY_PATTERN.test(key);
    return sensitive ? `${key}=${REDACTED}` : pair;
  });
  return `${base}?${parts.join("&")}`;
}

/**
 * Recursively redact secret-looking keys.
 *
 * Depth-limited so a cyclic or enormous payload cannot hang the reporter, and
 * because anything deeper than a few levels is not readable in an issue anyway.
 */
export function scrubObject<T>(input: T, depth = 0): T {
  if (depth > 6 || input === null || input === undefined) return input;

  if (typeof input === "string") return scrubUrl(input) as unknown as T;
  if (typeof input !== "object") return input;

  if (Array.isArray(input)) {
    return input.map((v) => scrubObject(v, depth + 1)) as unknown as T;
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = scrubObject(value, depth + 1);
  }
  return out as unknown as T;
}

/* -------------------------------------------------------------------------- */
/* Drop decision                                                               */
/* -------------------------------------------------------------------------- */

export type DropDecision = { drop: boolean; reason?: string };

export type ClassifiableEvent = {
  message?: string;
  exceptionType?: string;
  exceptionValue?: string;
  frames?: EventFrameLike[];
  /** True when the app explicitly called reportError/reportMessage. */
  handled?: boolean;
};

/**
 * The single decision point for "does this event deserve to be an issue?".
 *
 * Explicitly reported events (`handled: true`) are never dropped — the caller
 * had the technical context and decided it mattered. Everything else is judged
 * on evidence, never on message text alone.
 */
export function shouldDropEvent(event: ClassifiableEvent): DropDecision {
  if (event.handled) return { drop: false };

  const message = event.exceptionValue || event.message || "";
  const title = event.exceptionType || event.message || "";

  // 1. Minified symbol titles carry no information for a human.
  if (!event.exceptionValue && isMeaninglessTitle(event.message)) {
    return { drop: true, reason: "meaningless-symbol-title" };
  }
  if (event.exceptionType && isMeaninglessTitle(event.exceptionType) && !message.trim()) {
    return { drop: true, reason: "meaningless-symbol-title" };
  }

  const appFrame = hasApplicationFrame(event.frames);

  // 2. Third-party-only events. Evidence-based: dropped only when the stack
  //    contains no PesoWise frame at all.
  if (!appFrame && event.frames && event.frames.length > 0) {
    if (event.frames.every((f) => isThirdPartyFrame(f.filename))) {
      return { drop: true, reason: "third-party-only-frames" };
    }
  }

  // 3. External bridge noise — only when nothing of ours is implicated.
  if (looksLikeExternalBridgeNoise(message) && !appFrame) {
    return { drop: true, reason: "external-bridge-noise" };
  }

  // 4. Auth states the app recovers from by design.
  if (isExpectedAuthRecovery(message)) {
    return { drop: true, reason: "expected-auth-recovery" };
  }

  void title;
  return { drop: false };
}

/* -------------------------------------------------------------------------- */
/* Fingerprinting                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Grouping key for an explicitly handled error.
 *
 * area + operation + errorCode — deliberately excluding the dynamic message, so
 * "approval failed for transaction 00088" and "… 00102" collapse into one issue
 * when the technical failure is identical. Different error codes stay apart, so
 * an authorization failure is never merged with a network failure.
 *
 * Returns undefined for unhandled errors, leaving the SDK's default grouping
 * alone — overriding it globally would hide genuinely distinct crashes.
 */
export function buildFingerprint(
  ctx: MonitoringContext,
  normalized: NormalizedError,
): string[] {
  if (ctx.fingerprintKey) return [ctx.fingerprintKey];
  const parts = [ctx.area, ctx.operation];
  const code = ctx.errorCode ?? normalized.code ?? (normalized.status !== undefined ? String(normalized.status) : undefined);
  if (code) parts.push(String(code));
  else parts.push(normalized.name);
  return parts;
}
