import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "@/contexts/auth-context";
import { isPwtSyncEnabled } from "@/lib/pwtSyncGate";

/** Renders its children only for companies that have the Tally integration switched on; everyone else goes to the dashboard. */
export function PwtFeatureGate({ children }: { children: ReactNode }) {
  const { hasOrganizationFeature, loading } = useAuth();
  if (loading) return null;
  if (!isPwtSyncEnabled(hasOrganizationFeature)) return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}
