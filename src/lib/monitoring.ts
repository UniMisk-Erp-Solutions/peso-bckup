import * as Sentry from "@sentry/react";
import {
  buildFingerprint,
  handledIssueTitle,
  normalizeError,
  scrubObject,
  scrubUrl,
  shouldDropEvent,
  type ClassifiableEvent,
  type MonitoringContext,
} from "@/lib/monitoringClassify";

export type { MonitoringContext } from "@/lib/monitoringClassify";

let initialized = false;

/**
 * Build-time constants injected by vite.config.ts. Non-secret by construction:
 * a commit SHA and a deployment environment name, nothing more.
 */
declare const __APP_RELEASE__: string;
declare const __APP_DEPLOY_ENV__: string;

function buildConstant(name: "__APP_RELEASE__" | "__APP_DEPLOY_ENV__", fallback: string): string {
  try {
    const value = name === "__APP_RELEASE__" ? __APP_RELEASE__ : __APP_DEPLOY_ENV__;
    return typeof value === "string" && value ? value : fallback;
  } catch {
    // Constant not defined (e.g. a test importing this module directly).
    return fallback;
  }
}

export function getRelease(): string {
  return buildConstant("__APP_RELEASE__", "dev-local");
}

/** "production" | "preview" | "development" — distinguishes Vercel preview from Production. */
export function getDeployEnvironment(): string {
  return buildConstant("__APP_DEPLOY_ENV__", import.meta.env.MODE ?? "development");
}

/* -------------------------------------------------------------------------- */
/* beforeSend                                                                  */
/* -------------------------------------------------------------------------- */

type SentryEvent = Sentry.ErrorEvent;

/** Flatten a Sentry event into the shape the pure classifier understands. */
export function toClassifiableEvent(event: SentryEvent): ClassifiableEvent {
  const exception = event.exception?.values?.[0];
  return {
    message: typeof event.message === "string" ? event.message : undefined,
    exceptionType: exception?.type,
    exceptionValue: exception?.value,
    frames: exception?.stacktrace?.frames?.map((f) => ({ filename: f.filename })),
    handled: event.tags?.pesowise_handled === true,
  };
}

/** Scrub URLs and secret-looking keys from everything we are about to send. */
export function scrubEvent(event: SentryEvent): SentryEvent {
  if (event.request?.url) {
    event.request.url = scrubUrl(event.request.url);
  }
  if (event.request?.headers) {
    event.request.headers = scrubObject(event.request.headers);
  }
  if (event.request?.query_string && typeof event.request.query_string === "string") {
    event.request.query_string = scrubUrl(`?${event.request.query_string}`)?.slice(1);
  }
  if (event.extra) event.extra = scrubObject(event.extra);
  if (event.contexts) event.contexts = scrubObject(event.contexts);
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map((b) => ({
      ...b,
      data: b.data ? scrubObject(b.data) : b.data,
      message: b.message ? scrubUrl(b.message) : b.message,
    }));
  }
  return event;
}

/**
 * Single gate for outbound events: drop non-actionable noise, scrub the rest.
 * Split into small helpers so each rule is independently testable.
 */
export function processEvent(event: SentryEvent): SentryEvent | null {
  const decision = shouldDropEvent(toClassifiableEvent(event));
  if (decision.drop) return null;
  return scrubEvent(event);
}

/* -------------------------------------------------------------------------- */
/* Init                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Initialize GlitchTip (Sentry-compatible) error monitoring.
 * No-op when VITE_GLITCHTIP_DSN is unset, so local/dev builds stay quiet.
 * Call once, as early as possible, before the app renders.
 */
export function initMonitoring(): void {
  if (initialized) return;
  const dsn = import.meta.env.VITE_GLITCHTIP_DSN as string | undefined;
  if (!dsn) return;

  Sentry.init({
    dsn,
    release: getRelease(),
    environment: getDeployEnvironment(),

    // NO explicit `integrations` array.
    //
    // In @sentry/react 10.58.0 the browser defaults already include
    // browserApiErrorsIntegration, globalHandlersIntegration, breadcrumbs,
    // dedupe, linkedErrors, httpContext and inboundFilters. Re-registering
    // them by hand (as this file used to) added nothing — getIntegrationsToSetup
    // merges then de-duplicates by name — while creating the impression that
    // removing one would disable a handler.
    //
    // captureConsoleIntegration is deliberately ABSENT. It turned all 229
    // console.error and 111 console.warn calls in this codebase into
    // first-class GlitchTip issues, which is the single largest source of the
    // noise this change exists to remove. Console output still reaches events
    // as breadcrumbs via the default breadcrumbsIntegration — context, not
    // issues.

    tracesSampleRate: 0,
    sampleRate: 1.0,
    maxBreadcrumbs: 100,
    attachStacktrace: true,
    normalizeDepth: 8,
    sendDefaultPii: false,
    beforeSend: (event) => processEvent(event as SentryEvent),
  });
  initialized = true;
}

/** Test seam: reset module state between test cases. */
export function _resetMonitoringForTests(): void {
  initialized = false;
}

export function isMonitoringInitialized(): boolean {
  return initialized;
}

/* -------------------------------------------------------------------------- */
/* Reporting API                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Report a handled application failure with structured context.
 *
 * The caller supplies the area/operation because that is where the technical
 * meaning lives — a toast component cannot know it. The original Error (and its
 * stack) is always what gets captured; the normalized fields become tags/extra.
 */
export function reportError(error: unknown, context: MonitoringContext): void {
  if (!initialized) return;
  const normalized = normalizeError(error);

  Sentry.withScope((scope) => {
    scope.setLevel(context.severity ?? "error");
    // Marks the event as explicitly reported so beforeSend never drops it.
    scope.setTag("pesowise_handled", true);
    scope.setTag("area", context.area);
    scope.setTag("operation", context.operation);
    scope.setTag("release", getRelease());
    scope.setTag("deploy_env", getDeployEnvironment());
    if (normalized.code) scope.setTag("error_code", normalized.code);
    if (context.errorCode) scope.setTag("error_code", context.errorCode);
    if (normalized.status !== undefined) scope.setTag("status", String(normalized.status));
    if (typeof navigator !== "undefined") scope.setTag("online", String(navigator.onLine));
    if (typeof window !== "undefined") scope.setTag("route", window.location?.pathname ?? "unknown");

    for (const [k, v] of Object.entries(context.tags ?? {})) scope.setTag(k, v);

    scope.setExtras(
      scrubObject({
        ...(context.extra ?? {}),
        normalized_name: normalized.name,
        normalized_message: normalized.message,
        ...(normalized.details ? { details: normalized.details } : {}),
        ...(normalized.hint ? { hint: normalized.hint } : {}),
      }),
    );

    // Stable grouping for known operations; dynamic IDs stay out of the key.
    scope.setFingerprint(buildFingerprint(context, normalized));

    if (normalized.original) {
      Sentry.captureException(normalized.original);
    } else {
      // No real Error to preserve — send a titled message instead of an object.
      Sentry.captureMessage(
        `${handledIssueTitle(context)}: ${normalized.message}`,
        context.severity ?? "error",
      );
    }
  });
}

/**
 * Record a non-error signal (breadcrumb only — never an issue).
 * Use for expected conditions worth seeing in context: validation rejections,
 * handled auth recovery, user cancellations.
 */
export function recordBreadcrumb(
  category: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  if (!initialized) return;
  Sentry.addBreadcrumb({
    category,
    message,
    level: "info",
    data: data ? scrubObject(data) : undefined,
  });
}

/* -------------------------------------------------------------------------- */
/* Scope                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Attach the signed-in identity. IDs only — no email, no name.
 * `sendDefaultPii` stays false; this is the minimum needed to tell whether an
 * issue affects one user or everyone.
 */
export function setMonitoringUser(params: {
  userId: string;
  organizationId?: string | null;
  role?: string | null;
}): void {
  if (!initialized) return;
  Sentry.setUser({ id: params.userId });
  Sentry.setTag("organization_id", params.organizationId ?? "none");
  Sentry.setTag("user_role", params.role ?? "unknown");
}

/** Clear identity on sign-out so one user's context cannot leak into another's event. */
export function clearMonitoringUser(): void {
  if (!initialized) return;
  Sentry.setUser(null);
  Sentry.setTag("organization_id", "none");
  Sentry.setTag("user_role", "unknown");
}
