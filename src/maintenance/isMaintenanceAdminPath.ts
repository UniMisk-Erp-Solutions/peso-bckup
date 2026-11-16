/**
 * True when the current URL should render MaintenanceAdminApplication
 * instead of MaintenanceBootstrap. Plain pathname check — deliberately not
 * a React Router hook, since this decision is made ABOVE any router.
 *
 * Case-insensitive: a stray link, bookmark, or hand-typed URL like
 * /ADMIN/MAINTENANCE/LOGIN must still reach the admin app rather than
 * silently falling through to the ordinary maintenance gate. Still requires
 * an exact segment match — "/admin/maintenance-other" or
 * "/foo/admin/maintenance" must NOT match.
 *
 * Lives in its own tiny module (and is re-exported from
 * MaintenanceAdminApplication) so src/main.tsx can make this decision without
 * importing the maintenance admin screens — and their chart library — into the
 * startup bundle for every visitor.
 */
export function isMaintenanceAdminPath(pathname: string): boolean {
  const normalized = pathname.toLowerCase();
  return normalized === "/admin/maintenance" || normalized.startsWith("/admin/maintenance/");
}
