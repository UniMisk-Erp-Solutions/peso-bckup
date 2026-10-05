/**
 * Runtime discovery of Historical Balance Anchor V2 backend support
 * (DOC-080-pattern capability probe; see balance_historical_v2_capabilities_v1
 * in supabase/migrations/20260826100000_balance_historical_v2_capabilities.sql).
 *
 * Historical Balance (Opening Balance, Balance Update, Tally import, anchor
 * edit/replace/reverse) is a SERVER capability, not a per-organization
 * setting -- either the five 20260824* migrations are installed on this
 * environment or they aren't. The frontend asks the server at runtime and
 * gates every Historical Balance action on `ready === true`.
 *
 * FAIL CLOSED, same as reviewManagerOverrideCapability: any error (RPC
 * absent because the migration hasn't been applied yet, network failure,
 * contract mismatch) resolves to `ready: false`. There is NO fallback to
 * the v1 import RPCs here or anywhere downstream -- a `false` result means
 * "show an unavailable state", never "use the old path instead".
 *
 * Caching is intentionally ASYMMETRIC:
 *  - `ready: true` is cached for the lifetime of the page/tab. A schema
 *    going ready -> not-ready without a deploy essentially never happens,
 *    so there is nothing to gain from re-probing it.
 *  - `ready: false` (for ANY reason: RPC error/PGRST202 because the
 *    migration genuinely isn't applied yet, a network failure, a malformed
 *    response, or a well-formed "not ready") is cached for only
 *    NEGATIVE_CACHE_TTL_MS. A `false` result is indistinguishable, from the
 *    client alone, between "genuinely not installed" and "installed
 *    moments ago, PostgREST hasn't reloaded its schema cache yet" -- and
 *    unlike the true case, this direction DOES change during a session (an
 *    admin applies the migration while a tab is already open). Caching it
 *    forever is exactly what let a browser tab keep showing "Preview only"
 *    after the backend had actually become ready (see
 *    Documentations MD/tally-import-warning-reconciliation.md). The short
 *    TTL still fully avoids a request storm (every render/mount within the
 *    window reuses the same cached value) while guaranteeing the tab
 *    self-heals shortly after the backend becomes ready, with no manual
 *    reload required. Call resetBalanceHistoricalV2CapabilityCache() only
 *    from tests.
 */

import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface BalanceHistoricalV2Capability {
  ready: boolean;
  functions: Record<string, boolean>;
}

const NOT_READY: BalanceHistoricalV2Capability = { ready: false, functions: {} };

/** How long a `ready: false` result is trusted before the next call re-probes. */
export const NEGATIVE_CACHE_TTL_MS = 60_000;

let inFlight: Promise<BalanceHistoricalV2Capability> | null = null;
let cached: BalanceHistoricalV2Capability | null = null;
let cachedAt = 0;

function cacheIsFresh(): boolean {
  if (!cached) return false;
  if (cached.ready) return true;
  return Date.now() - cachedAt < NEGATIVE_CACHE_TTL_MS;
}

export async function fetchBalanceHistoricalV2Capability(): Promise<BalanceHistoricalV2Capability> {
  if (cacheIsFresh()) return cached as BalanceHistoricalV2Capability;
  if (inFlight) return inFlight;

  // The capability RPC is intentionally absent from the stale generated
  // types until the next `generate_typescript_types` run; one isolated cast
  // avoids hand-editing them (same rationale as reviewManagerOverrideCapability).
  const client = supabase as unknown as {
    rpc: (
      n: string,
      p: Record<string, unknown>,
    ) => Promise<{ data: unknown; error: { message?: string; code?: string } | null }>;
  };

  inFlight = (async () => {
    try {
      const { data, error } = await client.rpc("balance_historical_v2_capabilities_v1", {});
      if (error) return NOT_READY;
      const rec = data as { contract?: string; ready?: boolean; functions?: Record<string, boolean> } | null;
      if (!rec || rec.contract !== "balance-historical-v2") return NOT_READY;
      return { ready: rec.ready === true, functions: rec.functions ?? {} };
    } catch {
      return NOT_READY;
    } finally {
      inFlight = null;
    }
  })();

  const result = await inFlight;
  cached = result;
  cachedAt = Date.now();
  return result;
}

/** Test-only: clears the module-level cache so each test starts fresh. */
export function resetBalanceHistoricalV2CapabilityCache(): void {
  cached = null;
  cachedAt = 0;
  inFlight = null;
}

export function useBalanceHistoricalV2Capability(): {
  ready: boolean;
  loading: boolean;
  functions: Record<string, boolean>;
} {
  const [state, setState] = useState<{ loading: boolean } & BalanceHistoricalV2Capability>({
    loading: true,
    ready: false,
    functions: {},
  });
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await fetchBalanceHistoricalV2Capability();
      if (!cancelled) setState({ loading: false, ready: r.ready, functions: r.functions });
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}
