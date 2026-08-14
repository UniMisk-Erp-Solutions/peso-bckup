import {
  buildHierarchyFlags,
  isHierarchyEnabled,
  isHierarchyTierEnabled,
  type HierarchyFeatureFlags,
} from "@/lib/approvalHierarchy";
import {
  MASTER_ADMIN_FEATURE_DEFINITIONS,
  ORGANIZATION_FEATURE_KEYS,
  type OrganizationFeatureKey,
} from "@/lib/organizationFeatureKeys";

export { buildHierarchyFlags, isHierarchyEnabled, isHierarchyTierEnabled };
export type { HierarchyFeatureFlags };

export type SessionFeatureContext = {
  featureFlags: Record<string, boolean>;
  isTenantHost: boolean;
  tenantHostOrgId: string | null;
  organizationId: string | null;
};

export function isOrganizationFeatureActive(
  key: OrganizationFeatureKey,
  ctx: SessionFeatureContext,
): boolean {
  if (!ctx.featureFlags[key]) return false;
  const def = MASTER_ADMIN_FEATURE_DEFINITIONS.find((d) => d.key === key);
  const requiresSubdomain = def?.requiresSubdomain ?? false;
  if (!requiresSubdomain) return true;
  if (!ctx.isTenantHost || !ctx.tenantHostOrgId || !ctx.organizationId) return false;
  return ctx.tenantHostOrgId === ctx.organizationId;
}

export function getHierarchyFlagsFromContext(
  ctx: SessionFeatureContext,
): HierarchyFeatureFlags {
  return buildHierarchyFlags(ctx.featureFlags);
}

export function hasApprovalHierarchy(ctx: SessionFeatureContext): boolean {
  return isHierarchyEnabled(getHierarchyFlagsFromContext(ctx));
}

export function hasTeamsEnabled(ctx: SessionFeatureContext): boolean {
  return isOrganizationFeatureActive(ORGANIZATION_FEATURE_KEYS.teams_enabled, ctx);
}

export function hasHierarchyTeamLeader(ctx: SessionFeatureContext): boolean {
  return isHierarchyTierEnabled(getHierarchyFlagsFromContext(ctx), "team_leader");
}

export function hasHierarchyExecutive(ctx: SessionFeatureContext): boolean {
  return isHierarchyTierEnabled(getHierarchyFlagsFromContext(ctx), "executive");
}

/** Master hierarchy flag only (for feature key checks). */
export function isApprovalHierarchyFeatureKey(key: string): boolean {
  return (
    key === ORGANIZATION_FEATURE_KEYS.approval_hierarchy ||
    key === ORGANIZATION_FEATURE_KEYS.hierarchy_team_leader ||
    key === ORGANIZATION_FEATURE_KEYS.hierarchy_executive
  );
}
