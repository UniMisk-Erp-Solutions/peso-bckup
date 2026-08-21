/**
 * Cloud Auth sign-in for maintenance admins. Email/password only — no
 * "Create account" link, no public sign-up UI (Decision E / §6 of the
 * architecture doc: admin accounts are created out-of-band).
 *
 * Never imports the local Supabase client or local AuthContext.
 */
import { useState } from "react";
import { Navigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  signInMaintenanceAdmin,
  getOwnMaintenanceAdminAuthorization,
  signOutMaintenanceAdmin,
} from "@/integrations/maintenance-cloud/maintenanceAdminService";
import { isMaintenanceCloudConfigured } from "@/integrations/maintenance-cloud/client";

export function MaintenanceAdminLogin() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authorized, setAuthorized] = useState(false);

  if (!isMaintenanceCloudConfigured()) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4">
        <div className="max-w-sm w-full text-center space-y-2">
          <p className="text-sm text-muted-foreground">
            The maintenance control plane is not configured for this deployment.
          </p>
        </div>
      </div>
    );
  }

  if (authorized) {
    return <Navigate to="/admin/maintenance" replace />;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    const signIn = await signInMaintenanceAdmin(email, password);
    if (!signIn.ok) {
      setError(signIn.error);
      setSubmitting(false);
      return;
    }

    const authz = await getOwnMaintenanceAdminAuthorization();
    if (!authz.ok) {
      // Signed in to Cloud Auth, but not an authorized maintenance admin —
      // sign out immediately rather than leaving an unauthorized Cloud
      // session sitting around.
      await signOutMaintenanceAdmin();
      setError("Not authorized for maintenance control.");
      setSubmitting(false);
      return;
    }

    setAuthorized(true);
    setSubmitting(false);
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <form onSubmit={handleSubmit} className="max-w-sm w-full space-y-4">
        <div className="text-center space-y-1">
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            PesoWise
          </p>
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            Maintenance control sign-in
          </h1>
        </div>

        <div className="space-y-2">
          <Label htmlFor="maintenance-admin-email">Email</Label>
          <Input
            id="maintenance-admin-email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="maintenance-admin-password">Password</Label>
          <Input
            id="maintenance-admin-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting ? "Signing in…" : "Sign in"}
        </Button>

        <p className="text-xs text-muted-foreground text-center">
          Maintenance admin accounts are provisioned separately from PesoWise accounts.
        </p>
      </form>
    </div>
  );
}
