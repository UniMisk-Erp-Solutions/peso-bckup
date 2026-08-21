import { createRoot } from "react-dom/client";
import { HelmetProvider } from "react-helmet-async";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { AppErrorFallback } from "@/components/AppErrorFallback";
import { MaintenanceBootstrap } from "@/maintenance/MaintenanceBootstrap";
import {
  MaintenanceAdminApplication,
  isMaintenanceAdminPath,
} from "@/maintenance/MaintenanceAdminApplication";
import {
  capturePwaInstallPromptEarly,
  registerPwaServiceWorker,
} from "@/lib/pwaInstallCapture";
import "./index.css";
import { initMonitoring } from "@/lib/monitoring";
import { installPreloadErrorHandler } from "@/lib/chunkRecovery";

// Register the Vite-native stale dynamic-import recovery FIRST — before any route
// navigation can trigger a lazy import — so a post-deploy chunk 404 self-heals via
// a single guarded reload instead of surfacing as an ErrorBoundary crash.
installPreloadErrorHandler();

initMonitoring();
capturePwaInstallPromptEarly();
registerPwaServiceWorker();

// bootstrapAuthSession() (local-Supabase session bootstrap) NO LONGER runs
// here. It has moved into LocalPesoWiseBootstrap, which MaintenanceBootstrap
// only ever mounts once the Cloud maintenance check resolves to something
// other than an active block. See
// docs/maintenance/CLOUD_MAINTENANCE_CONTROL_PLANE.md §2/§5 for why running
// it before the maintenance decision defeated the whole point of the Cloud
// control plane: local Supabase must never be contacted while fresh Cloud
// state says maintenance is active.
//
// /admin/maintenance* is decided by a PLAIN pathname check — deliberately
// not a React Router hook — because this decision is made above any router
// and must remain reachable independently of both the maintenance gate and
// the local application (Decision E: the admin path never depends on local
// Supabase or on the Cloud maintenance state itself).
function Root() {
  if (isMaintenanceAdminPath(window.location.pathname)) {
    return <MaintenanceAdminApplication />;
  }
  return <MaintenanceBootstrap />;
}

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary fallback={AppErrorFallback}>
    <HelmetProvider>
      <Root />
    </HelmetProvider>
  </ErrorBoundary>
);
