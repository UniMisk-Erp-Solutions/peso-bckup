/**
 * MaintenanceAdminDashboard — the maintenance admin console shell.
 *
 * Cloud Auth only. Renders CONTROL and HISTORY tabs (§36 of the
 * architecture doc). Environment is fixed from VITE_MAINTENANCE_ENV and is
 * never user-selectable — no environment dropdown anywhere in this
 * console. The History tab is only ever rendered when the signed-in
 * admin's own row shows is_active=true AND can_view_history=true; database
 * RLS on maintenance_history remains authoritative regardless of this
 * frontend gate (infra/maintenance-cloud/migrations/002_add_maintenance_history.sql).
 */
import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  getOwnMaintenanceAdminAuthorization,
  signOutMaintenanceAdmin,
  type MaintenanceAdminAuthorizationResult,
} from "@/integrations/maintenance-cloud/maintenanceAdminService";
import { MAINTENANCE_ENV } from "@/maintenance/maintenanceConfig";
import { MaintenanceControlTab } from "./MaintenanceControlTab";
import { MaintenanceHistoryTab } from "./MaintenanceHistoryTab";

const IS_PRODUCTION = MAINTENANCE_ENV === "production";

export function MaintenanceAdminDashboard() {
  const [authResult, setAuthResult] = useState<MaintenanceAdminAuthorizationResult | null>(null);
  const [signedOut, setSignedOut] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getOwnMaintenanceAdminAuthorization().then((r) => {
      if (!cancelled) setAuthResult(r);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (signedOut) {
    return <Navigate to="/admin/maintenance/login" replace />;
  }

  if (authResult === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <p className="text-sm text-muted-foreground">Checking authorization…</p>
      </div>
    );
  }

  if (!authResult.ok) {
    return <Navigate to="/admin/maintenance/login" replace />;
  }

  const { admin } = authResult;
  const canViewHistory = admin.is_active && admin.can_view_history;

  async function handleSignOut() {
    await signOutMaintenanceAdmin();
    setSignedOut(true);
  }

  return (
    <div className="min-h-screen bg-background px-4 py-10">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="space-y-1">
            <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              PesoWise Maintenance
            </p>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight text-foreground">
                Control console
              </h1>
              <Badge variant={IS_PRODUCTION ? "destructive" : "secondary"}>
                {IS_PRODUCTION ? "PRODUCTION" : (MAINTENANCE_ENV ?? "unknown").toUpperCase()}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">Signed in as maintenance admin</p>
          </div>
          <Button variant="outline" size="sm" onClick={handleSignOut}>
            Sign out
          </Button>
        </div>

        {canViewHistory ? (
          <Tabs defaultValue="control">
            <TabsList>
              <TabsTrigger value="control">Control</TabsTrigger>
              <TabsTrigger value="history">History</TabsTrigger>
            </TabsList>
            <TabsContent value="control">
              <MaintenanceControlTab admin={admin} />
            </TabsContent>
            <TabsContent value="history">
              <MaintenanceHistoryTab ownUserId={admin.user_id} />
            </TabsContent>
          </Tabs>
        ) : (
          <MaintenanceControlTab admin={admin} />
        )}
      </div>
    </div>
  );
}
