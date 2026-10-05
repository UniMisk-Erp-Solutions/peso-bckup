/**
 * Runtime discovery of Additive Credit V3 backend support (see
 * balance_additive_v3_capabilities_v1 in
 * supabase/migrations/20260901121500_additive_credit_v3_import.sql).
 *
 * Mirrors balanceHistoricalV2Capability.ts's contract and caching strategy
 * exactly (including the asymmetric TTL fix from the Tally hotfix): FAIL
 * CLOSED on any error, cache a definitive `ready: true` for the tab's
 * lifetime, cache a `ready: false` for only NEGATIVE_CACHE_TTL_MS so a tab
 * that probed before the backend became ready self-heals without a reload.
 */

import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface BalanceAdditiveV3Capability {
  ready: boolean;
  functions: Record<string, boolean>;
}

const NOT_READY: BalanceAdditiveV3Capability = { ready: false, functions: {} };

export const NEGATIVE_CACHE_TTL_MS = 60_000;

let inFlight: Promise<BalanceAdditiveV3Capability> | null = null;
let cached: BalanceAdditiveV3Capability | null = null;
let cachedAt = 0;

function cacheIsFresh(): boolean {
  if (!cached) return false;
  if (cached.ready) return true;
  return Date.now() - cachedAt < NEGATIVE_CACHE_TTL_MS;
}

export async function fetchBalanceAdditiveV3Capability(): Promise<BalanceAdditiveV3Capability> {
  if (cacheIsFresh()) return cached as BalanceAdditiveV3Capability;
  if (inFlight) return inFlight;

  const client = supabase as unknown as {
    rpc: (
      n: string,
      p: Record<string, unknown>,
    ) => Promise<{ data: unknown; error: { message?: string; code?: string } | null }>;
  };

  inFlight = (async () => {
    try {
      const { data, error } = await client.rpc("balance_additive_v3_capabilities_v1", {});
      if (error) return NOT_READY;
      const rec = data as { contract?: string; ready?: boolean; functions?: Record<string, boolean> } | null;
      if (!rec || rec.contract !== "balance-additive-v3") return NOT_READY;
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
export function resetBalanceAdditiveV3CapabilityCache(): void {
  cached = null;
  cachedAt = 0;
  inFlight = null;
}

export function useBalanceAdditiveV3Capability(): {
  ready: boolean;
  loading: boolean;
  functions: Record<string, boolean>;
} {
  const [state, setState] = useState<{ loading: boolean } & BalanceAdditiveV3Capability>({
    loading: true,
    ready: false,
    functions: {},
  });
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await fetchBalanceAdditiveV3Capability();
      if (!cancelled) setState({ loading: false, ready: r.ready, functions: r.functions });
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}
