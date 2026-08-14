import { supabase } from "@/integrations/supabase/client";

// ---------------------------------------------------------------------------
// Shared organization_settings cache
//
// Problem: many hooks (useOrganizationRoleLabels, useAllowCashierExpenseSubmission,
// useRequireImmediateSupervisor) and pages (ExpenseForm, EngineerReview) each query
// organization_settings independently. With 7+ components mounting on the same page,
// that produces 14+ concurrent requests — saturating the self-hosted Supabase
// connection pool and queueing every other query for 8-12 seconds.
//
// Fix: one shared fetch per (organizationId), coalesced and cached for 5 minutes.
// All hooks and pages read from this cache; no more per-component DB round-trips.
// ---------------------------------------------------------------------------

export type OrgSettingsRow = {
  organization_id: string;
  approval_hierarchy_role_labels: unknown;
  allow_cashier_expense_submission: boolean | null;
  require_immediate_supervisor: boolean | null;
  engineer_approval_limit: number | null;
  attachment_required_above_amount: number | null;
  batch_expense_attachment_mode: string | null;
};

const TTL_MS = 5 * 60 * 1000;
const _cache = new Map<string, { data: OrgSettingsRow; ts: number }>();
const _inflight = new Map<string, Promise<OrgSettingsRow | null>>();

export async function getOrgSettings(organizationId: string): Promise<OrgSettingsRow | null> {
  const cached = _cache.get(organizationId);
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.data;

  const existing = _inflight.get(organizationId);
  if (existing) return existing;

  const promise = (async (): Promise<OrgSettingsRow | null> => {
    const { data, error } = await supabase
      .from("organization_settings")
      .select(
        "organization_id, approval_hierarchy_role_labels, allow_cashier_expense_submission, require_immediate_supervisor, engineer_approval_limit, attachment_required_above_amount, batch_expense_attachment_mode",
      )
      .eq("organization_id", organizationId)
      .maybeSingle();

    _inflight.delete(organizationId);
    if (error || !data) {
      if (error) console.warn("getOrgSettings:", error.message);
      return null;
    }
    _cache.set(organizationId, { data: data as OrgSettingsRow, ts: Date.now() });
    return data as OrgSettingsRow;
  })();

  _inflight.set(organizationId, promise);
  return promise;
}

/** Call after any write to organization_settings so the next read fetches fresh data. */
export function invalidateOrgSettings(organizationId: string): void {
  _cache.delete(organizationId);
}
