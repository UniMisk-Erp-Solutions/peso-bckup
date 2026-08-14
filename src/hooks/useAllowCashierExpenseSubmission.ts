import { useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { getOrgSettings } from "@/lib/orgSettingsCache";

/**
 * Fetches organization_settings.allow_cashier_expense_submission for the current org.
 * Uses the shared orgSettingsCache so all instances share one in-flight request.
 */
export function useAllowCashierExpenseSubmission(): {
  allowCashierExpenseSubmission: boolean | null;
  loading: boolean;
} {
  const { organizationId } = useAuth();
  const [allowCashierExpenseSubmission, setAllowCashierExpenseSubmission] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!organizationId) {
      setAllowCashierExpenseSubmission(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    void (async () => {
      const settings = await getOrgSettings(organizationId);
      if (cancelled) return;
      setAllowCashierExpenseSubmission(settings?.allow_cashier_expense_submission === true);
      setLoading(false);
    })();

    return () => { cancelled = true; };
  }, [organizationId]);

  return { allowCashierExpenseSubmission, loading };
}
