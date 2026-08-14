import { useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { getOrgSettings } from "@/lib/orgSettingsCache";

/** Whether org requires immediate supervisor for employee / team_leader / executive. */
export function useRequireImmediateSupervisor(): {
  requireImmediateSupervisor: boolean;
  loading: boolean;
} {
  const { organizationId } = useAuth();
  const [requireImmediateSupervisor, setRequireImmediateSupervisor] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!organizationId) {
      setRequireImmediateSupervisor(false);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    void (async () => {
      const settings = await getOrgSettings(organizationId);
      if (cancelled) return;
      setRequireImmediateSupervisor(settings?.require_immediate_supervisor === true);
      setLoading(false);
    })();

    return () => { cancelled = true; };
  }, [organizationId]);

  return { requireImmediateSupervisor, loading };
}
