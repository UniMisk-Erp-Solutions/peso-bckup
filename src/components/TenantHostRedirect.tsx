import { Navigate, Outlet } from "react-router-dom";
import {
  getAppBaseDomain,
  getDevTenantSubdomainOverride,
  resolveTenantLabelFromHostname,
} from "@/lib/tenantContext";

/**
 * On tenant subdomains (e.g. ms.pesowise.unimisk.com), send users to sign-in
 * instead of marketing/landing pages.
 */
export function TenantHostRedirect() {
  const { isTenantHost } = resolveTenantLabelFromHostname(
    typeof window !== "undefined" ? window.location.hostname : "",
    getAppBaseDomain(),
    getDevTenantSubdomainOverride(),
  );

  if (isTenantHost) {
    return <Navigate to="/auth" replace />;
  }

  return <Outlet />;
}
