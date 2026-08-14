/**
 * Server-only environment readiness helper for the system status feature.
 * Validates required env vars without exposing their values.
 * Never throws — always returns a diagnostics object.
 */

import { resolveSupabaseServerConfig } from "./supabaseServerConfig.js";

export type SystemStatusEnvironmentDiagnostics = {
  /** Whether the Edge Config read connection is configured */
  readReady: boolean;
  /** Whether the Edge Config write credentials are configured */
  writeReady: boolean;
  /** Whether Supabase auth is configured (URL + anon key found) */
  supabaseAuthReady: boolean;
  /** Variable names that are missing (names only, never values) */
  missingReadVars: string[];
  missingWriteVars: string[];
  missingAuthVars: string[];
  /** Optional public status page URL config state */
  publicStatusUrlConfigured: boolean;
};

export function getSystemStatusEnvironmentDiagnostics(): SystemStatusEnvironmentDiagnostics {
  const missingReadVars: string[] = [];
  const missingWriteVars: string[] = [];

  // Read: EDGE_CONFIG connection string (set automatically by Vercel when Edge Config is linked)
  if (!process.env.EDGE_CONFIG) missingReadVars.push("EDGE_CONFIG");

  // Write: both required to persist changes
  if (!process.env.EDGE_CONFIG_WRITE_TOKEN) missingWriteVars.push("EDGE_CONFIG_WRITE_TOKEN");
  if (!process.env.EDGE_CONFIG_ID) missingWriteVars.push("EDGE_CONFIG_ID");

  // Auth: use the canonical resolver — reports exactly which vars are missing
  const supabaseConfig = resolveSupabaseServerConfig();
  const missingAuthVars: string[] = supabaseConfig.ok ? [] : [...supabaseConfig.missingVariables];

  return {
    readReady: missingReadVars.length === 0,
    writeReady: missingWriteVars.length === 0,
    supabaseAuthReady: missingAuthVars.length === 0,
    missingReadVars,
    missingWriteVars,
    missingAuthVars,
    publicStatusUrlConfigured: Boolean(process.env.PUBLIC_STATUS_URL),
  };
}

/** True when running in a Vercel deployment (Preview or Production). */
export function isVercelRuntime(): boolean {
  return Boolean(process.env.VERCEL || process.env.VERCEL_ENV);
}

/** True when the in-memory store is permissible (local dev only). */
export function isMemoryStorePermitted(): boolean {
  if (isVercelRuntime()) return false;
  // Allow explicit opt-in for local testing
  return process.env.ALLOW_MEMORY_STATUS_STORE === "1" || process.env.NODE_ENV !== "production";
}
