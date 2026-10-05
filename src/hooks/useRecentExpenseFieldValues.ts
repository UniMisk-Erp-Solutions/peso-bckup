import { useEffect, useState } from "react";
import { fetchRecentExpenseFieldValues, getRecentValuesVersion } from "@/lib/expenseFieldMemory";

/**
 * Batch-fetches recent free-text values for a set of field identities once
 * per (org, user, identities) change. Mirrors useRecommendedFieldOptions's
 * shape. Always resolves to {} on error/disabled/missing ids -- never throws,
 * never blocks the form.
 */
export function useRecentExpenseFieldValues(
  organizationId: string | null | undefined,
  userId: string | null | undefined,
  identities: string[],
  enabled: boolean,
): Record<string, string[]> {
  const [byKey, setByKey] = useState<Record<string, string[]>>({});
  const key = enabled ? identities.slice().sort().join("|") : "";
  // Recomputed every render; changes whenever recordRecentExpenseFieldValues
  // invalidates this (org, user)'s cache, even if identities/enabled never
  // change -- so a save that keeps the same component mounted (no route
  // change) still refetches on the next render instead of only working via
  // a full remount.
  const version = getRecentValuesVersion(organizationId, userId);

  useEffect(() => {
    let cancelled = false;
    if (!enabled || !organizationId || !userId || identities.length === 0) {
      setByKey({});
      return;
    }
    void fetchRecentExpenseFieldValues(organizationId, userId, identities).then((result) => {
      if (!cancelled) setByKey(result);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId, userId, enabled, key, version]);

  return byKey;
}
