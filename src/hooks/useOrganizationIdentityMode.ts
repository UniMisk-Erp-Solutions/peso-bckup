/**
 * useOrganizationIdentityMode
 *
 * Derives the canonical OrganizationIdentityPolicy from already-loaded feature
 * flags.  Makes NO new Supabase requests.  Output is stable via useMemo.
 */
import { useMemo } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { ORGANIZATION_FEATURE_KEYS } from "@/lib/organizationFeatureKeys";
import {
  resolveOrganizationIdentityPolicy,
  getPersonSearchPlaceholderKey,
  type OrganizationIdentityMode,
  type OrganizationIdentityPolicy,
} from "@/lib/organizationIdentityMode";
import {
  formatPersonIdentitySubline,
  type PersonIdentitySearchRow,
} from "@/lib/personIdentitySearch";

export type UseOrganizationIdentityModeResult = {
  mode: OrganizationIdentityMode;
  policy: OrganizationIdentityPolicy;
  /** Shorthand: mode === "employee_id_only" */
  employeeIdOnly: boolean;
  employeeIdEnabled: boolean;
  emailIsUserFacing: boolean;
  /**
   * Returns the i18n translation key for the person-search placeholder.
   * Call `t(getSearchPlaceholderKey())` in the component.
   */
  getSearchPlaceholderKey: (options?: { includeRole?: boolean }) => string;
  /** Format a short sub-line for a person card/row (ID or email depending on mode). */
  formatIdentitySubline: (person: PersonIdentitySearchRow, fallbackLabel?: string) => string;
  /** Identity options ready to pass into expenseRowMatchesSearch. */
  expenseSearchIdentityOptions: {
    includeEmail: boolean;
    includeEmployeeId: boolean;
    allowSyntheticEmployeeIdFallback: boolean;
  };
};

export function useOrganizationIdentityMode(): UseOrganizationIdentityModeResult {
  const { organizationFeatureFlags } = useAuth();

  return useMemo(() => {
    const employeeIdLoginEnabled = Boolean(
      organizationFeatureFlags?.[ORGANIZATION_FEATURE_KEYS.employee_id_login],
    );
    const userEmailAuto = Boolean(
      organizationFeatureFlags?.[ORGANIZATION_FEATURE_KEYS.user_email_auto],
    );

    const policy = resolveOrganizationIdentityPolicy(employeeIdLoginEnabled, userEmailAuto);

    return {
      mode: policy.mode,
      policy,
      employeeIdOnly: policy.mode === "employee_id_only",
      employeeIdEnabled: policy.employeeIdEnabled,
      emailIsUserFacing: policy.emailIsUserFacing,
      getSearchPlaceholderKey: (options) => getPersonSearchPlaceholderKey(policy, options),
      formatIdentitySubline: (person, fallbackLabel) =>
        formatPersonIdentitySubline(person, policy, fallbackLabel),
      expenseSearchIdentityOptions: {
        includeEmail: policy.includeEmailInSearch,
        includeEmployeeId: policy.includeEmployeeIdInSearch,
        allowSyntheticEmployeeIdFallback: policy.allowSyntheticEmployeeIdFallback,
      },
    };
  }, [organizationFeatureFlags]);
}
