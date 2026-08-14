/**
 * Canonical types and normalizer for the Dashboard backend-health diagnostic.
 *
 * This is purely for the Dashboard's informational health chip.
 * It NEVER:
 *   - activates maintenance
 *   - blocks routes
 *   - writes Edge Config
 *   - signs users out
 *   - modifies the manual maintenance state
 */

export type DashboardBackendHealthState =
  | "checking"
  | "healthy"
  | "degraded"
  | "unavailable";

export interface DashboardBackendHealth {
  state: DashboardBackendHealthState;
  checkedAt: string | null;
  responseTimeMs: number | null;
  databaseReachable: boolean | null;
  authReachable: boolean | null;
  storageReachable: boolean | null;
  message: string;
}

export const INITIAL_HEALTH: DashboardBackendHealth = {
  state: "checking",
  checkedAt: null,
  responseTimeMs: null,
  databaseReachable: null,
  authReachable: null,
  storageReachable: null,
  message: "Checking backend health…",
};

/** Latency thresholds for healthy vs degraded. */
const LATENCY_DEGRADED_MS = 2_000;

/**
 * Normalize the raw RPC result into a DashboardBackendHealth.
 *
 * The RPC `get_backend_health` may return any shape — this normalizer
 * is defensive: it never throws and never trusts the RPC body blindly.
 *
 * Semantics:
 *   HEALTHY    – RPC succeeded, no explicit failure fields, latency OK
 *   DEGRADED   – RPC succeeded but a service is marked unhealthy, OR latency high
 *   UNAVAILABLE – RPC errored, timed out, or returned malformed data
 */
export function normalizeBackendHealthRpc(
  data: unknown,
  error: unknown,
  elapsedMs: number | null,
): DashboardBackendHealth {
  const now = new Date().toISOString();

  // Any RPC-level error → unavailable
  if (error) {
    const msg = safeMessage(error);
    const isOffline =
      msg.toLowerCase().includes("failed to fetch") ||
      msg.toLowerCase().includes("network") ||
      msg.toLowerCase().includes("offline") ||
      !navigator.onLine;
    return {
      state: "unavailable",
      checkedAt: now,
      responseTimeMs: elapsedMs,
      databaseReachable: null,
      authReachable: null,
      storageReachable: null,
      message: isOffline ? "Browser is offline" : "Backend health check failed",
    };
  }

  // No data (null/undefined) → unavailable
  if (data === null || data === undefined) {
    return {
      state: "unavailable",
      checkedAt: now,
      responseTimeMs: elapsedMs,
      databaseReachable: null,
      authReachable: null,
      storageReachable: null,
      message: "Health check returned no data",
    };
  }

  // Parse known fields defensively
  const obj = typeof data === "object" ? (data as Record<string, unknown>) : {};

  const dbReachable = coerceBool(obj["database_reachable"] ?? obj["db_reachable"] ?? obj["database"]);
  const authReachable = coerceBool(obj["auth_reachable"] ?? obj["auth"]);
  const storageReachable = coerceBool(obj["storage_reachable"] ?? obj["storage"]);
  const rawStatus = typeof obj["status"] === "string" ? obj["status"].toLowerCase() : null;
  const rawMessage = typeof obj["message"] === "string" ? obj["message"] : "";

  // Explicit "unavailable" or "unreachable" in status field
  if (rawStatus === "unavailable" || rawStatus === "unreachable" || rawStatus === "error") {
    return {
      state: "unavailable",
      checkedAt: now,
      responseTimeMs: elapsedMs,
      databaseReachable: dbReachable,
      authReachable: authReachable,
      storageReachable: storageReachable,
      message: rawMessage || "One or more backend services are unavailable",
    };
  }

  // A service is explicitly false → degraded
  const anyServiceFailed =
    dbReachable === false ||
    authReachable === false ||
    storageReachable === false;

  const explicitlyDegraded = rawStatus === "degraded" || anyServiceFailed;

  // High latency → degraded
  const slowLatency =
    elapsedMs !== null && elapsedMs > LATENCY_DEGRADED_MS;

  if (explicitlyDegraded || slowLatency) {
    return {
      state: "degraded",
      checkedAt: now,
      responseTimeMs: elapsedMs,
      databaseReachable: dbReachable,
      authReachable: authReachable,
      storageReachable: storageReachable,
      message:
        rawMessage ||
        (slowLatency && !explicitlyDegraded
          ? `Slow response (${elapsedMs}ms)`
          : "One or more services are degraded"),
    };
  }

  return {
    state: "healthy",
    checkedAt: now,
    responseTimeMs: elapsedMs,
    databaseReachable: dbReachable ?? true,
    authReachable: authReachable ?? true,
    storageReachable: storageReachable ?? true,
    message: rawMessage || "All systems operational",
  };
}

function coerceBool(v: unknown): boolean | null {
  if (v === true || v === 1 || v === "true") return true;
  if (v === false || v === 0 || v === "false") return false;
  return null;
}

function safeMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Unknown error";
}
