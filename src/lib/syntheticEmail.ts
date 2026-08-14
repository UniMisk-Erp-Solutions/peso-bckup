export const DEFAULT_SYNTHETIC_EMAIL_DOMAIN = "users.unimisk.com";

/**
 * Generates a unique synthetic email for Supabase Auth when org uses employee ID login.
 * Domain must be controlled by you (DNS / deliverability). Not for real inbox mail.
 */
export function generateSyntheticUserEmail(params: {
  organizationId: string;
  employeeIdPart: string;
  orgSubdomain: string | null;
  domain?: string;
  /** Optional fixed suffix (tests). Defaults to random UUID fragment. */
  randomSuffix?: string;
}): string {
  const domain =
    params.domain?.trim() ||
    (import.meta.env.VITE_SYNTHETIC_EMAIL_DOMAIN as string | undefined)?.trim() ||
    DEFAULT_SYNTHETIC_EMAIL_DOMAIN;
  const slug = (params.orgSubdomain || params.organizationId.replace(/-/g, "").slice(0, 12))
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 32) || "org";
  const emp =
    params.employeeIdPart
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 32) || "user";
  const suffix =
    params.randomSuffix?.replace(/[^a-z0-9]/g, "").slice(0, 12) ||
    crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  return `emp.${slug}.${emp}.${suffix}@${domain}`;
}
