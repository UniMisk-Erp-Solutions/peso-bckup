/**
 * Per-organization feature flags (organization_features.feature_key).
 * Master admin toggles these in Master Admin; app gates UX and APIs.
 */
export const ORGANIZATION_FEATURE_KEYS = {
  /** Allow employee ID login on tenant subdomain (Auth page). */
  employee_id_login: "employee_id_login",
  /** When enabled, new users may use auto-generated synthetic emails (UserManagement). */
  user_email_auto: "user_email_auto",
  /** Admins and assigned managers may correct another user's expense (sets status edited). */
  allow_manager_admin_expense_corrections: "allow_manager_admin_expense_corrections",
  /** Employees may submit multiple expenses in one batch wizard flow. */
  allow_batch_expense_entry: "allow_batch_expense_entry",
  /** Admins can attach child fields to each dropdown option; shown when that option is selected. */
  allow_conditional_dropdown_fields: "allow_conditional_dropdown_fields",
  /** Allows nested select chains (child dropdown options with their own sub-fields). Requires conditional dropdowns. */
  allow_nested_conditional_dropdown_fields: "allow_nested_conditional_dropdown_fields",
  /** Teams org structure: membership, My Teams dashboard, team exports (independent of tier routing). */
  teams_enabled: "teams_enabled",
  /** Multi-tier approval: employee → team leader → executive → manager → admin. */
  approval_hierarchy: "approval_hierarchy",
  /** Enable team leader tier (requires approval_hierarchy). */
  hierarchy_team_leader: "hierarchy_team_leader",
  /** Enable executive tier (requires approval_hierarchy). */
  hierarchy_executive: "hierarchy_executive",
  /** Daily employee×project expense report with category cost bifurcation. */
  daily_project_expense_report: "daily_project_expense_report",
  /** Admin/cashier transfers require recipient accept/reject before balances change. */
  transfer_recipient_acceptance: "transfer_recipient_acceptance",
  /** Designated cashiers become read-only accountants (reports + approved expenses). */
  cashier_accountant_mode: "cashier_accountant_mode",
  /** Org admins can change the input type (text/number/dropdown) of base expense fields. */
  allow_base_field_input_customization: "allow_base_field_input_customization",
  /** Track visible PesoWise app activity per user; admin sees last seen, active time, inactivity trends. */
  user_activity_insights: "user_activity_insights",
  /** Employees may view balance credits recorded to their account (amount + effective transfer date). */
  employee_transfer_history: "employee_transfer_history",
} as const;

export type OrganizationFeatureKey = (typeof ORGANIZATION_FEATURE_KEYS)[keyof typeof ORGANIZATION_FEATURE_KEYS];

export type FeatureDefinition = {
  key: OrganizationFeatureKey;
  /** i18n key under master.features (e.g. features.employeeIdLogin). */
  labelKey: string;
  /** If true, feature is active only on tenant host matching org subdomain. */
  requiresSubdomain: boolean;
};

/** Features shown in Master Admin and used for gating. */
export const MASTER_ADMIN_FEATURE_DEFINITIONS: FeatureDefinition[] = [
  {
    key: ORGANIZATION_FEATURE_KEYS.employee_id_login,
    labelKey: "features.employeeIdLogin",
    requiresSubdomain: true,
  },
  {
    key: ORGANIZATION_FEATURE_KEYS.user_email_auto,
    labelKey: "features.userEmailAuto",
    requiresSubdomain: false,
  },
  {
    key: ORGANIZATION_FEATURE_KEYS.allow_manager_admin_expense_corrections,
    labelKey: "features.managerCorrections",
    requiresSubdomain: false,
  },
  {
    key: ORGANIZATION_FEATURE_KEYS.allow_batch_expense_entry,
    labelKey: "features.batchEntry",
    requiresSubdomain: false,
  },
  {
    key: ORGANIZATION_FEATURE_KEYS.allow_conditional_dropdown_fields,
    labelKey: "features.conditionalDropdown",
    requiresSubdomain: false,
  },
  {
    key: ORGANIZATION_FEATURE_KEYS.allow_nested_conditional_dropdown_fields,
    labelKey: "features.nestedConditional",
    requiresSubdomain: false,
  },
  {
    key: ORGANIZATION_FEATURE_KEYS.teams_enabled,
    labelKey: "features.teamsEnabled",
    requiresSubdomain: false,
  },
  {
    key: ORGANIZATION_FEATURE_KEYS.approval_hierarchy,
    labelKey: "features.approvalHierarchy",
    requiresSubdomain: false,
  },
  {
    key: ORGANIZATION_FEATURE_KEYS.hierarchy_team_leader,
    labelKey: "features.hierarchyTeamLeader",
    requiresSubdomain: false,
  },
  {
    key: ORGANIZATION_FEATURE_KEYS.hierarchy_executive,
    labelKey: "features.hierarchyExecutive",
    requiresSubdomain: false,
  },
  {
    key: ORGANIZATION_FEATURE_KEYS.daily_project_expense_report,
    labelKey: "features.dailyProjectExpenseReport",
    requiresSubdomain: false,
  },
  {
    key: ORGANIZATION_FEATURE_KEYS.transfer_recipient_acceptance,
    labelKey: "features.transferRecipientAcceptance",
    requiresSubdomain: false,
  },
  {
    key: ORGANIZATION_FEATURE_KEYS.cashier_accountant_mode,
    labelKey: "features.cashierAccountantMode",
    requiresSubdomain: false,
  },
  {
    key: ORGANIZATION_FEATURE_KEYS.allow_base_field_input_customization,
    labelKey: "features.baseFieldInputCustomization",
    requiresSubdomain: false,
  },
  {
    key: ORGANIZATION_FEATURE_KEYS.user_activity_insights,
    labelKey: "features.userActivityInsights",
    requiresSubdomain: false,
  },
  {
    key: ORGANIZATION_FEATURE_KEYS.employee_transfer_history,
    labelKey: "features.employeeTransferHistory",
    requiresSubdomain: false,
  },
];

export const STRATEGY_SLUGS = ["standard", "microlink_v1"] as const;
export type StrategySlug = (typeof STRATEGY_SLUGS)[number];

/** Used when `strategies` table is not migrated yet (REST 404). */
export const STRATEGY_OPTIONS_FALLBACK: { slug: string; label: string }[] = [
  { slug: "standard", label: "Standard" },
  { slug: "microlink_v1", label: "MicroLink v1" },
];
