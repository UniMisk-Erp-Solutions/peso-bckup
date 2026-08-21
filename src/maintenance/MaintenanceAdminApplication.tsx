/**
 * MaintenanceAdminApplication — the Cloud-only branch for /admin/maintenance*.
 *
 * Mounted BEFORE MaintenanceBootstrap's decision and BEFORE
 * LocalPesoWiseBootstrap. Never renders AuthProvider, never calls
 * bootstrapAuthSession(), never imports the local Supabase client — an
 * admin must be able to reach this while the local server is down and/or
 * while maintenance is actively blocking everyone else.
 *
 * Owns its own <BrowserRouter> — this is safe because it is mutually
 * exclusive with App.tsx's own <BrowserRouter> (see src/main.tsx: exactly
 * one of MaintenanceAdminApplication or MaintenanceBootstrap renders per
 * page load, decided by a plain pathname check, never both).
 */
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { MaintenanceAdminLogin } from "@/pages/maintenance-admin/MaintenanceAdminLogin";
import { MaintenanceAdminDashboard } from "@/pages/maintenance-admin/MaintenanceAdminDashboard";

export function MaintenanceAdminApplication() {
  return (
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route path="/admin/maintenance/login" element={<MaintenanceAdminLogin />} />
        <Route path="/admin/maintenance" element={<MaintenanceAdminDashboard />} />
        <Route path="/admin/maintenance/*" element={<Navigate to="/admin/maintenance" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

/** True when the current URL should render MaintenanceAdminApplication
 * instead of MaintenanceBootstrap. Plain pathname check — deliberately not
 * a React Router hook, since this decision is made ABOVE any router.
 *
 * Case-insensitive: a stray link, bookmark, or hand-typed URL like
 * /ADMIN/MAINTENANCE/LOGIN must still reach the admin app rather than
 * silently falling through to the ordinary maintenance gate. Still requires
 * an exact segment match — "/admin/maintenance-other" or
 * "/foo/admin/maintenance" must NOT match. */
export function isMaintenanceAdminPath(pathname: string): boolean {
  const normalized = pathname.toLowerCase();
  return normalized === "/admin/maintenance" || normalized.startsWith("/admin/maintenance/");
}
