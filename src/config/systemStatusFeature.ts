/**
 * Client-side feature flag for the Edge Config-backed system-status feature.
 *
 * Default: DISABLED — an absent or non-"true" VITE_SYSTEM_STATUS_CONTROL_ENABLED
 * variable means the feature is off. Only the exact string "true" enables it.
 *
 * Do NOT fall back to true. Do NOT read any Edge Config value from the browser.
 */
export const SYSTEM_STATUS_CONTROL_ENABLED =
  import.meta.env.VITE_SYSTEM_STATUS_CONTROL_ENABLED === "true";
