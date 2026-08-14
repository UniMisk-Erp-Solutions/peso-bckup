import { useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { ORGANIZATION_FEATURE_KEYS } from "@/lib/organizationFeatureKeys";

/**
 * Whether batch expense entry is enabled for the signed-in user's organization.
 * Uses AuthContext flags first, then RPC fallback (handles stale session / RLS edge cases).
 */
export function useBatchExpenseEntry() {
  const { organizationId, hasOrganizationFeature, organizationFeatureFlags } =
    useAuth();
  const [enabled, setEnabled] = useState(
    () =>
      organizationFeatureFlags[ORGANIZATION_FEATURE_KEYS.allow_batch_expense_entry] ===
      true,
  );
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!organizationId) {
      setEnabled(false);
      setLoading(false);
      return;
    }

    if (hasOrganizationFeature(ORGANIZATION_FEATURE_KEYS.allow_batch_expense_entry)) {
      setEnabled(true);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    void supabase
      .rpc("get_organization_feature_enabled", {
        p_organization_id: organizationId,
        p_feature_key: ORGANIZATION_FEATURE_KEYS.allow_batch_expense_entry,
      })
      .then(({ data, error }) => {
        if (cancelled) return;
        setEnabled(!error && data === true);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    organizationId,
    hasOrganizationFeature,
    organizationFeatureFlags,
  ]);

  return { batchExpenseEntryEnabled: enabled, batchEntryLoading: loading };
}
