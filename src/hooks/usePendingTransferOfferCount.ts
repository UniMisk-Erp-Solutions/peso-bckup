import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { ORGANIZATION_FEATURE_KEYS } from "@/lib/organizationFeatureKeys";
import { BalanceTransferOfferService } from "@/services/BalanceTransferOfferService";
import { supabase } from "@/integrations/supabase/client";

export function usePendingTransferOfferCount() {
  const { user, hasOrganizationFeature } = useAuth();
  const enabled = hasOrganizationFeature(
    ORGANIZATION_FEATURE_KEYS.transfer_recipient_acceptance,
  );
  const [count, setCount] = useState(0);

  const refresh = useCallback(async () => {
    if (!enabled || !user?.id) {
      setCount(0);
      return;
    }
    try {
      const pending = await BalanceTransferOfferService.countPendingForRecipient(user.id);
      setCount(pending);
    } catch {
      setCount(0);
    }
  }, [enabled, user?.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!enabled || !user?.id) return;

    const channel = supabase
      .channel(`transfer-offers-count-${user.id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "balance_transfer_offers",
          filter: `recipient_id=eq.${user.id}`,
        },
        () => {
          void refresh();
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [enabled, user?.id, refresh]);

  return { count, enabled, refresh };
}
