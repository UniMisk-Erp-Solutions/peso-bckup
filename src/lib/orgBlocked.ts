import { ORGANIZATION_FEATURE_KEYS } from "@/lib/organizationFeatureKeys";

/** PLACEHOLDER wording (DOC-165): the owner will provide the final message later. */
export const ORG_BLOCKED_TITLE = "Organization blocked";
export const ORG_BLOCKED_MESSAGE =
  "Access for your organization has been blocked. Please contact your administrator or PesoWise support.";

/**
 * True when Master Admin has ticked `org_blocked` for the organization.
 * Master admins are never blocked (they belong to no organization and must
 * always be able to reach /master to untick the flag).
 */
export function isOrganizationBlocked(
  featureFlags: Record<string, boolean> | null | undefined,
  userRole: string | null | undefined,
): boolean {
  if (userRole === "master_admin") return false;
  return featureFlags?.[ORGANIZATION_FEATURE_KEYS.org_blocked] === true;
}
