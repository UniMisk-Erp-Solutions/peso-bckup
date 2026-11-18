import { ORGANIZATION_FEATURE_KEYS } from "@/lib/organizationFeatureKeys";

/** PLACEHOLDER wording (DOC-165): the owner will provide the final message later. */
export const ORG_BLOCKED_TITLE = "Organization blocked";
export const ORG_BLOCKED_MESSAGE =
  "Access for your organization has been blocked. Please contact your administrator or PesoWise support.";

/** Max length of the message Master Admin writes for a blocked organization. */
export const ORG_BLOCK_MESSAGE_MAX = 500;

/**
 * Validates the message typed in the Master Admin "Block organization" box.
 * A message is required (it is what the organization's users will read).
 */
export function validateBlockMessage(
  raw: string,
): { ok: true; message: string } | { ok: false; error: string } {
  const message = raw.trim();
  if (message.length === 0) return { ok: false, error: "Enter the message users of this organization will see." };
  if (message.length > ORG_BLOCK_MESSAGE_MAX) {
    return { ok: false, error: `Message is too long (max ${ORG_BLOCK_MESSAGE_MAX} characters).` };
  }
  return { ok: true, message };
}

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
