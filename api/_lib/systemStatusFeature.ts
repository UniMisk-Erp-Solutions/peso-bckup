/**
 * Server-side feature flag for the Edge Config-backed system-status feature.
 *
 * Default: DISABLED — an absent or non-"true" SYSTEM_STATUS_CONTROL_ENABLED
 * variable means the feature is off. Only the exact string "true" enables it.
 *
 * Do NOT use a VITE-prefixed variable here.
 * Do NOT inspect EDGE_CONFIG to decide whether the feature is enabled.
 * A missing EDGE_CONFIG must not generate errors while disabled.
 */
export function isSystemStatusControlEnabled(): boolean {
  return process.env.SYSTEM_STATUS_CONTROL_ENABLED === "true";
}
