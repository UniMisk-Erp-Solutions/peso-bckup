import { ORGANIZATION_FEATURE_KEYS, type OrganizationFeatureKey } from "@/lib/organizationFeatureKeys";

/** Build-time master switch (VITE_PWT_SYNC=1). Off means the integration does not exist in this deployment. */
export const PWT_BUILD_ENABLED = import.meta.env.VITE_PWT_SYNC === "1";

/**
 * The PesoWise-Tally integration is visible to a company only when the
 * deployment has it built in AND Master Admin switched "Tally integration"
 * on for that company (organization_features.tally_integration, default off).
 */
export function isPwtSyncEnabled(
  hasOrganizationFeature: (key: OrganizationFeatureKey) => boolean,
  buildEnabled: boolean = PWT_BUILD_ENABLED,
): boolean {
  return buildEnabled && hasOrganizationFeature(ORGANIZATION_FEATURE_KEYS.tally_integration);
}
