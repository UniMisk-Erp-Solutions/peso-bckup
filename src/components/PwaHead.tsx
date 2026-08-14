import { useEffect } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { applyManifestLink, applyPwaMetaTags } from "@/lib/pwa";
import { PWA_INSTALL_ICONS } from "@/lib/pwaManifest";

/**
 * Applies host- and org-aware PWA manifest + meta tags (tenant logo/name on subdomains).
 */
export function PwaHead() {
  const { isTenantHost, tenantHostOrg, organization, organizationId } = useAuth();

  useEffect(() => {
    const hostname = window.location.hostname;
    const org =
      isTenantHost && tenantHostOrg
        ? { name: tenantHostOrg.name, logo_url: tenantHostOrg.logo_url }
        : organizationId && organization
          ? { name: organization.name, logo_url: organization.logo_url }
          : null;

    applyManifestLink(hostname, org);

    const shortTitle =
      isTenantHost && tenantHostOrg?.name
        ? tenantHostOrg.name
        : organization?.name && organizationId
          ? organization.name
          : "PesoWise";

    applyPwaMetaTags({
      title: shortTitle.slice(0, 32),
      themeColor: "#1e40af",
      iconUrl: org?.logo_url ?? organization?.logo_url ?? PWA_INSTALL_ICONS.icon192,
    });
  }, [
    isTenantHost,
    tenantHostOrg?.id,
    tenantHostOrg?.name,
    tenantHostOrg?.logo_url,
    organization?.id,
    organization?.name,
    organization?.logo_url,
    organizationId,
  ]);

  return null;
}
