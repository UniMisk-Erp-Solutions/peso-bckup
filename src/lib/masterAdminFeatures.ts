/**
 * Pure helpers for the Master Admin "Features" tab (DOC-165).
 * No React, no Supabase: categorisation, search and change-diffing only, so they
 * are unit-testable and cannot alter how a flag is saved.
 */
import {
  MASTER_ADMIN_FEATURE_DEFINITIONS,
  ORGANIZATION_FEATURE_KEYS,
  type FeatureDefinition,
  type OrganizationFeatureKey,
} from "@/lib/organizationFeatureKeys";

export type FeatureCategory = {
  id: string;
  label: string;
  description: string;
  keys: OrganizationFeatureKey[];
};

/** Flags that have a dedicated place elsewhere (Security tab) and are not listed in Features. */
export const FEATURES_TAB_EXCLUDED_KEYS: OrganizationFeatureKey[] = [ORGANIZATION_FEATURE_KEYS.org_blocked];

export const FEATURE_CATEGORIES: FeatureCategory[] = [
  {
    id: "access",
    label: "Access & login",
    description: "How users sign in and are created.",
    keys: [ORGANIZATION_FEATURE_KEYS.employee_id_login, ORGANIZATION_FEATURE_KEYS.user_email_auto],
  },
  {
    id: "expenses",
    label: "Expenses & forms",
    description: "Expense entry, corrections and custom form fields.",
    keys: [
      ORGANIZATION_FEATURE_KEYS.allow_manager_admin_expense_corrections,
      ORGANIZATION_FEATURE_KEYS.allow_batch_expense_entry,
      ORGANIZATION_FEATURE_KEYS.allow_conditional_dropdown_fields,
      ORGANIZATION_FEATURE_KEYS.allow_nested_conditional_dropdown_fields,
      ORGANIZATION_FEATURE_KEYS.allow_base_field_input_customization,
      ORGANIZATION_FEATURE_KEYS.expense_field_memory,
      ORGANIZATION_FEATURE_KEYS.expense_date_locking,
    ],
  },
  {
    id: "approvals",
    label: "Teams & approvals",
    description: "Team structure and multi-tier approval.",
    keys: [
      ORGANIZATION_FEATURE_KEYS.teams_enabled,
      ORGANIZATION_FEATURE_KEYS.approval_hierarchy,
      ORGANIZATION_FEATURE_KEYS.hierarchy_team_leader,
      ORGANIZATION_FEATURE_KEYS.hierarchy_executive,
    ],
  },
  {
    id: "finance",
    label: "Balances & reports",
    description: "Transfers, balances and reporting.",
    keys: [
      ORGANIZATION_FEATURE_KEYS.daily_project_expense_report,
      ORGANIZATION_FEATURE_KEYS.transfer_recipient_acceptance,
      ORGANIZATION_FEATURE_KEYS.cashier_accountant_mode,
      ORGANIZATION_FEATURE_KEYS.employee_transfer_history,
      ORGANIZATION_FEATURE_KEYS.historical_balance_v2,
    ],
  },
  {
    id: "insights",
    label: "Insights & integrations",
    description: "Activity tracking and external integrations.",
    keys: [ORGANIZATION_FEATURE_KEYS.user_activity_insights, ORGANIZATION_FEATURE_KEYS.tally_integration],
  },
];

export const OTHER_CATEGORY_ID = "other";

export type CategorizedFeatures = {
  id: string;
  label: string;
  description: string;
  features: FeatureDefinition[];
};

/**
 * Group definitions by category. A definition that is not mapped to any category (for
 * example a flag added later) lands in "Other features" so it can never disappear from
 * Master Admin. Excluded keys are skipped.
 */
export function categorizeFeatures(
  defs: FeatureDefinition[] = MASTER_ADMIN_FEATURE_DEFINITIONS,
  categories: FeatureCategory[] = FEATURE_CATEGORIES,
  excluded: OrganizationFeatureKey[] = FEATURES_TAB_EXCLUDED_KEYS,
): CategorizedFeatures[] {
  const visible = defs.filter((d) => !excluded.includes(d.key));
  const used = new Set<string>();
  const groups: CategorizedFeatures[] = categories.map((c) => {
    const features = c.keys
      .map((k) => visible.find((d) => d.key === k))
      .filter((d): d is FeatureDefinition => Boolean(d));
    features.forEach((f) => used.add(f.key));
    return { id: c.id, label: c.label, description: c.description, features };
  });
  const rest = visible.filter((d) => !used.has(d.key));
  if (rest.length > 0) {
    groups.push({
      id: OTHER_CATEGORY_ID,
      label: "Other features",
      description: "Features not yet assigned to a category.",
      features: rest,
    });
  }
  return groups.filter((g) => g.features.length > 0);
}

/** Case-insensitive search over the displayed label and the raw key. */
export function filterFeatureGroups(
  groups: CategorizedFeatures[],
  query: string,
  labelOf: (def: FeatureDefinition) => string,
): CategorizedFeatures[] {
  const q = query.trim().toLowerCase();
  if (!q) return groups;
  return groups
    .map((g) => ({
      ...g,
      features: g.features.filter(
        (f) => labelOf(f).toLowerCase().includes(q) || f.key.toLowerCase().includes(q),
      ),
    }))
    .filter((g) => g.features.length > 0);
}

export type FeatureChange = { key: string; enabled: boolean };

/**
 * Differences between the saved flags and the draft the admin edited. A missing key
 * counts as OFF (matches the app: no organization_features row means off).
 */
export function computeFeatureChanges(
  saved: Record<string, boolean>,
  draft: Record<string, boolean>,
  keys: string[],
): FeatureChange[] {
  const changes: FeatureChange[] = [];
  for (const key of keys) {
    const before = saved[key] === true;
    const after = draft[key] === true;
    if (before !== after) changes.push({ key, enabled: after });
  }
  return changes;
}
