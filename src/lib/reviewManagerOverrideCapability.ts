/**
 * Runtime discovery of Manager-override server support (DOC-080 §4/§27).
 *
 * Replaces the hard-coded MANAGER_OVERRIDE_AVAILABLE flag: the frontend asks the
 * server whether review_approve_expense_manager_override_v1 is installed and
 * enables the override PROCEED path only when it is. FAIL CLOSED — any error
 * (RPC absent on an environment without the migration, network failure) resolves
 * to `false`, so no UI ever offers an action the server cannot perform.
 */

import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export async function fetchManagerOverrideCapability(): Promise<boolean> {
  // The capability RPC is intentionally absent from the stale generated types;
  // one isolated cast avoids hand-editing them (DOC-079).
  const client = supabase as unknown as {
    rpc: (
      n: string,
      p: Record<string, unknown>,
    ) => Promise<{ data: unknown; error: { message?: string; code?: string } | null }>;
  };
  try {
    const { data, error } = await client.rpc("review_manager_override_capabilities_v1", {});
    if (error) return false;
    const rec = data as { contract?: string; ready?: boolean; version?: number } | null;
    return Boolean(rec && rec.contract === "review-manager-override" && rec.ready === true);
  } catch {
    return false;
  }
}

export function useManagerOverrideCapability(): { ready: boolean; loading: boolean } {
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await fetchManagerOverrideCapability();
      if (!cancelled) {
        setReady(r);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return { ready, loading };
}
