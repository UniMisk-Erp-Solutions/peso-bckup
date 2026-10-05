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
  /**
   * Historical Balance Anchor V2: Opening Balance, Balance Update, Tally
   * Group Summary import, and anchor edit/replace/reverse in the Balances
   * import wizard. This flag controls UI AVAILABILITY only -- it never
   * selects between v1 and v2 financial RPCs. When enabled, the wizard
   * additionally requires balance_historical_v2_capabilities_v1 to report
   * ready=true (see src/lib/balanceHistoricalV2Capability.ts) before
   * exposing these modes; if the backend migrations aren't installed yet it
   * shows an "unavailable" state instead of calling any RPC, v1 or v2.
   * Allocation is unaffected by this flag (pre-existing behavior, always
   * available regardless of its state).
   */
  historical_balance_v2: "historical_balance_v2",
  /**
   * Recently-used free-text expense field suggestions (title/destination/
   * purpose + custom text/textarea template + branch fields). Convenience
   * only -- never required to save an expense. See DOC-130.
   */
  expense_field_memory: "expense_field_memory",
  /**
   * Admin-controlled expense date locking: org admins define locked date
   * ranges (single date, month, custom range) during which NEW expense
   * submissions / expense-date changes are blocked. Server-side
   * enforcement (a trigger on public.expenses, see
   * 20261018100000_expense_date_locking_v1.sql) always checks this flag
   * first -- OFF means byte-for-byte unchanged behavior even if lock rows
   * exist. See src/lib/expenseDateLocks.ts.
   */
  expense_date_locking: "expense_date_locking",
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
  {
    key: ORGANIZATION_FEATURE_KEYS.historical_balance_v2,
    labelKey: "features.historicalBalanceV2",
    requiresSubdomain: false,
  },
  {
    key: ORGANIZATION_FEATURE_KEYS.expense_field_memory,
    labelKey: "features.expenseFieldMemory",
    requiresSubdomain: false,
  },
  {
    key: ORGANIZATION_FEATURE_KEYS.expense_date_locking,
    labelKey: "features.expenseDateLocking",
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
