/**
 * Canonical Edge Config write configuration resolver.
 * Server-only. Never exposes credential values.
 *
 * Token resolution order:
 *   1. VERCEL_API_TOKEN
 *   2. EDGE_CONFIG_WRITE_TOKEN
 *
 * Team support:
 *   VERCEL_TEAM_ID — when present, appended as ?teamId= on write requests.
 *
 * All values are trimmed and empty-string-rejected at resolution time.
 * Error messages name missing variables but never log values.
 */

export type EdgeConfigWriteConfig = {
  token: string;
  configId: string;
  teamId: string | null;
};

export type EdgeConfigWriteConfigResult =
  | { ok: true; config: EdgeConfigWriteConfig }
  | { ok: false; missingVariables: string[] };

/** Resolve write credentials without exposing values. */
export function resolveEdgeConfigWriteConfig(): EdgeConfigWriteConfigResult {
  const missing: string[] = [];

  const rawToken =
    (process.env.VERCEL_API_TOKEN ?? "").trim() ||
    (process.env.EDGE_CONFIG_WRITE_TOKEN ?? "").trim();

  const configId = (process.env.EDGE_CONFIG_ID ?? "").trim();
  const teamId = (process.env.VERCEL_TEAM_ID ?? "").trim() || null;

  if (!rawToken) missing.push("VERCEL_API_TOKEN or EDGE_CONFIG_WRITE_TOKEN");
  if (!configId) missing.push("EDGE_CONFIG_ID");

  if (missing.length > 0) {
    return { ok: false, missingVariables: missing };
  }

  return {
    ok: true,
    config: { token: rawToken, configId, teamId },
  };
}

/** Build the write URL, appending teamId when configured. */
export function buildEdgeConfigWriteUrl(config: EdgeConfigWriteConfig): string {
  const base = `https://api.vercel.com/v1/edge-config/${config.configId}/items`;
  if (config.teamId) {
    return `${base}?teamId=${encodeURIComponent(config.teamId)}`;
  }
  return base;
}

// ── Safe error mapping ──────────────────────────────────────────────────────

/** Structured error safe to return to the browser. */
export type SafeProviderError = {
  code:
    | "invalid_api_token"
    | "forbidden"
    | "edge_config_not_found"
    | "revision_conflict"
    | "rate_limited"
    | "provider_unavailable"
    | "provider_error";
  message: string;
  httpStatus: number;
};

/**
 * Map a raw Vercel API response to a safe structured error.
 * Never returns the provider response body to the caller.
 */
export function mapProviderError(httpStatus: number): SafeProviderError {
  if (httpStatus === 401) {
    return {
      code: "invalid_api_token",
      message: "Edge Config write token is invalid or expired. Check VERCEL_API_TOKEN / EDGE_CONFIG_WRITE_TOKEN.",
      httpStatus,
    };
  }
  if (httpStatus === 403) {
    return {
      code: "forbidden",
      message: "Access denied when writing to Edge Config. Check token permissions and VERCEL_TEAM_ID if using a team store.",
      httpStatus,
    };
  }
  if (httpStatus === 404) {
    return {
      code: "edge_config_not_found",
      message: "Edge Config store not found. Check EDGE_CONFIG_ID.",
      httpStatus,
    };
  }
  if (httpStatus === 409) {
    return {
      code: "revision_conflict",
      message: "Edge Config write conflict — another write occurred concurrently.",
      httpStatus,
    };
  }
  if (httpStatus === 429) {
    return {
      code: "rate_limited",
      message: "Edge Config write rate limit reached. Try again in a moment.",
      httpStatus,
    };
  }
  if (httpStatus >= 500) {
    return {
      code: "provider_unavailable",
      message: `Edge Config provider returned ${httpStatus}. Retry in a moment.`,
      httpStatus,
    };
  }
  return {
    code: "provider_error",
    message: `Unexpected Edge Config response (HTTP ${httpStatus}).`,
    httpStatus,
  };
}
