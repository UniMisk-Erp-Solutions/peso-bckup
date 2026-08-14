import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { getOrgSettings, invalidateOrgSettings } from "@/lib/orgSettingsCache";
import {
  DEFAULT_ROLE_LABELS,
  getRoleLabel,
  type RoleLabels,
} from "@/lib/approvalHierarchy";

export function useOrganizationRoleLabels() {
  const { organizationId } = useAuth();
  const [labels, setLabels] = useState<RoleLabels | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!organizationId) {
      setLabels(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    // Invalidate so next call fetches from DB, not the 5-min cache.
    invalidateOrgSettings(organizationId);
    const settings = await getOrgSettings(organizationId);
    const raw = settings?.approval_hierarchy_role_labels as RoleLabels | null;
    setLabels(raw && typeof raw === "object" ? raw : null);
    setLoading(false);
  }, [organizationId]);

  useEffect(() => {
    if (!organizationId) {
      setLabels(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      const settings = await getOrgSettings(organizationId);
      if (cancelled) return;
      const raw = settings?.approval_hierarchy_role_labels as RoleLabels | null;
      setLabels(raw && typeof raw === "object" ? raw : null);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [organizationId]);

  const labelFor = useCallback(
    (role: keyof typeof DEFAULT_ROLE_LABELS | string) => getRoleLabel(role, labels),
    [labels],
  );

  return { labels, loading, refresh, labelFor, defaults: DEFAULT_ROLE_LABELS };
}
