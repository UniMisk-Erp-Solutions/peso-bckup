/**
 * Organization Identity Mode
 *
 * Derives a canonical identity policy from the org's feature flags.
 * All person-search and identity-display logic should read from this policy
 * instead of branching on individual feature flags in each component.
 *
 * Three modes:
 *   email_only            — employee_id_login=false
 *   employee_id_and_email — employee_id_login=true, user_email_auto=false
 *   employee_id_only      — employee_id_login=true, user_email_auto=true
 */

export type OrganizationIdentityMode =
  | "email_only"
  | "employee_id_and_email"
  | "employee_id_only";

export type OrganizationIdentityPolicy = {
  mode: OrganizationIdentityMode;
  employeeIdEnabled: boolean;
  /** True when the email address is a real, user-chosen address (not synthetic). */
  emailIsUserFacing: boolean;
  /** Include the full email address in person-search tokens. */
  includeEmailInSearch: boolean;
  /** Include the employee_id field in person-search tokens. */
  includeEmployeeIdInSearch: boolean;
  /** Show email beneath a person's name in lists/cards. */
  showEmailInIdentitySubline: boolean;
  /**
   * When employee_id is missing but the auth email is a generated synthetic
   * address (emp.{org}.{id}.{suffix}@…), parse only the ID fragment for
   * search.  Never expose the full synthetic email to the user.
   */
  allowSyntheticEmployeeIdFallback: boolean;
};

export function resolveOrganizationIdentityPolicy(
  employeeIdLoginEnabled: boolean,
  userEmailAuto: boolean,
): OrganizationIdentityPolicy {
  if (!employeeIdLoginEnabled) {
    return {
      mode: "email_only",
      employeeIdEnabled: false,
      emailIsUserFacing: true,
      includeEmailInSearch: true,
      includeEmployeeIdInSearch: false,
      showEmailInIdentitySubline: true,
      allowSyntheticEmployeeIdFallback: false,
    };
  }

  if (!userEmailAuto) {
    // Both employee ID login AND genuine email addresses are in use.
    return {
      mode: "employee_id_and_email",
      employeeIdEnabled: true,
      emailIsUserFacing: true,
      includeEmailInSearch: true,
      includeEmployeeIdInSearch: true,
      showEmailInIdentitySubline: true,
      allowSyntheticEmployeeIdFallback: false,
    };
  }

  // employee_id_login=true AND user_email_auto=true → synthetic emails only.
  return {
    mode: "employee_id_only",
    employeeIdEnabled: true,
    emailIsUserFacing: false,
    includeEmailInSearch: false,
    includeEmployeeIdInSearch: true,
    showEmailInIdentitySubline: false,
    allowSyntheticEmployeeIdFallback: true,
  };
}

/**
 * Returns an i18n translation key for the person-search placeholder.
 * Components call `t(getPersonSearchPlaceholderKey(policy))`.
 */
export function getPersonSearchPlaceholderKey(
  policy: OrganizationIdentityPolicy,
  options?: { includeRole?: boolean },
): string {
  const { mode } = policy;
  if (mode === "email_only") {
    return options?.includeRole
      ? "common:searchPlaceholder.nameEmailRole"
      : "common:searchPlaceholder.nameEmail";
  }
  if (mode === "employee_id_and_email") {
    return options?.includeRole
      ? "common:searchPlaceholder.nameEmployeeIdEmailRole"
      : "common:searchPlaceholder.nameEmployeeIdEmail";
  }
  // employee_id_only
  return options?.includeRole
    ? "common:searchPlaceholder.nameEmployeeIdRole"
    : "common:searchPlaceholder.nameEmployeeId";
}
