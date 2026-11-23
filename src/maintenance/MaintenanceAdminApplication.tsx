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

// Kept exported from here for existing importers/tests; defined in its own small module.
export { isMaintenanceAdminPath } from "./isMaintenanceAdminPath";
