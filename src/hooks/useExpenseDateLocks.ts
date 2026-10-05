import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { ORGANIZATION_FEATURE_KEYS } from "@/lib/organizationFeatureKeys";
import { fetchExpenseDateLocksResult, type ExpenseDateLock, type ExpenseDateLocksFetchResult } from "@/lib/expenseDateLocks";

/**
 * Fetches the current organization's expense date locks, but ONLY when
 * expense_date_locking is actually enabled -- when the feature is off this
 * never queries the table at all, and every screen using this hook behaves
 * exactly as if the feature didn't exist (task requirement: OFF means
 * unchanged behavior even if lock rows happen to exist).
 *
 * `error` is non-null when the fetch itself failed (distinct from "loaded
 * successfully, zero locks") -- the database trigger still protects the
 * write either way, but when the CLIENT cannot currently prove a date is
 * safe it must fail CLOSED: callers gate date selection/submission on
 * `loading`/`error`, not just show a warning next to a usable picker
 * (2026-10-01 fail-closed fix).
 *
 * `reload()` re-runs the fetch on demand (wired to a "Retry" button by
 * callers). A retry racing an already in-flight fetch -- or a reload firing
 * right as `enabled`/`organizationId` changes -- is resolved by a
 * monotonically increasing request-id ref: only the response matching the
 * CURRENT highest id is ever allowed to commit state, so an older response
 * can never clobber a newer one.
 */
export function useExpenseDateLocks() {
  const { organizationId, hasOrganizationFeature } = useAuth();
  const enabled = hasOrganizationFeature(ORGANIZATION_FEATURE_KEYS.expense_date_locking);
  const [locks, setLocks] = useState<ExpenseDateLock[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const runFetch = useCallback((orgId: string) => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    void fetchExpenseDateLocksResult(orgId).then((result: ExpenseDateLocksFetchResult) => {
      // A newer fetch (another reload, or a different org/enabled run) has
      // since started -- this response is stale and must never commit.
      if (requestIdRef.current !== requestId) return;
      setLocks(result.locks);
      setError(result.ok === false ? result.error : null);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    // Bump the request id FIRST so any fetch already in flight from a prior
    // org/enabled run (including one kicked off by reload()) is invalidated
    // the instant this effect decides to do something different.
    requestIdRef.current += 1;
    if (!enabled || !organizationId) {
      setLocks([]);
      setLoading(false);
      setError(null);
      return;
    }
    runFetch(organizationId);
  }, [enabled, organizationId, runFetch]);

  const reload = useCallback(() => {
    if (!enabled || !organizationId) return;
    runFetch(organizationId);
  }, [enabled, organizationId, runFetch]);

  return { locks: enabled ? locks : [], loading, error, enabled, reload };
}
