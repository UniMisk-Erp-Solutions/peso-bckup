import { useEffect, useRef, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { useSystemAvailability } from "@/contexts/SystemAvailabilityContext";
import { SystemUnavailableScreen } from "@/components/SystemUnavailableScreen";
import {
  rejectWrongTenantSession,
  TenantRedirectingError,
  verifyTenantSessionForUser,
} from "@/lib/tenantAccess";
import { Loader2 } from "lucide-react";

interface ProtectedRouteProps {
  children: React.ReactNode;
  allowedRoles?: (
    | "admin"
    | "engineer"
    | "employee"
    | "cashier"
    | "team_leader"
    | "executive"
    | "master_admin"
  )[];
  /** Allow cashier users flagged as read-only accountant (when org feature is on). */
  allowAccountantCashier?: boolean;
  /** Block read-only accountant cashiers (operational routes). */
  blockAccountantCashier?: boolean;
}

export function ProtectedRoute({
  children,
  allowedRoles,
  allowAccountantCashier = false,
  blockAccountantCashier = false,
}: ProtectedRouteProps) {
  const {
    user,
    userRole,
    loading,
    isTenantHost,
    tenantHostOrgId,
    tenantSubdomainLabel,
    signOut,
    isAccountantCashier,
  } = useAuth();
  const { blocking, initializing: systemInitializing } = useSystemAvailability();
  const location = useLocation();

  const [tenantAllowed, setTenantAllowed] = useState(true);
  const [tenantRedirecting, setTenantRedirecting] = useState(false);
  const hadAuthenticatedUserRef = useRef(false);
  // Tracks which (user, tenant) combination verifyTenantSessionForUser has
  // already resolved for, so `tenantChecking` below can be a value DERIVED
  // synchronously during render instead of a separate piece of state only
  // set true inside an effect (which runs after the first commit). The old
  // effect-set boolean started `false` on every render where `loading` had
  // just flipped to `false` from a cached session — giving a protected child
  // exactly one mount window to fire authenticated requests before tenant
  // verification had even begun. Deriving it in-render closes that gap.
  //
  // This MUST be real state, not a ref: on the (common) allowed-tenant path
  // `tenantAllowed` is set to `true`, its own already-default value, so React
  // bails out of that setState with no re-render — a ref write alone would
  // then never be reflected, and `tenantChecking` (computed at render time)
  // would stay stuck on its last-rendered value forever.
  const [tenantVerifiedKey, setTenantVerifiedKey] = useState<string | null>(null);

  useEffect(() => {
    if (user?.id) {
      hadAuthenticatedUserRef.current = true;
    }
  }, [user?.id]);

  // Determine whether maintenance is actively blocking this user.
  // We only apply the gate once auth is resolved (so we know if they're Master Admin).
  // During system initialization, we do not block (avoids false positives on startup).
  const maintenanceBlocking = !loading && !systemInitializing && blocking;
  const isMasterAdmin = userRole === "master_admin";
  const onMasterRoute = location.pathname === "/master";

  // Tenant verification effect — runs unconditionally (hooks rule).
  // However, it skips the async work when the maintenance gate would block this user,
  // to avoid unnecessary network requests.
  const shouldSkipTenantCheck =
    maintenanceBlocking && !isMasterAdmin; // blocked non-master: skip tenant work

  const tenantVerifyKey = `${user?.id ?? ""}|${tenantHostOrgId ?? ""}|${tenantSubdomainLabel ?? ""}|${isTenantHost}`;

  // Derived, not stateful: true exactly when we're on a tenant host with a
  // known (non-loading) user whose (user, tenant) combination has not yet
  // been verified. Computed in the SAME render as `loading`/`user` flipping,
  // so there is no render where a cached-but-unverified user reads as
  // "not checking" before the effect below has had a chance to run.
  const tenantChecking =
    !shouldSkipTenantCheck &&
    !loading &&
    Boolean(user?.id) &&
    isTenantHost &&
    tenantVerifiedKey !== tenantVerifyKey;

  useEffect(() => {
    if (shouldSkipTenantCheck) {
      setTenantAllowed(true);
      return;
    }

    if (loading || !user?.id) {
      if (!user?.id) setTenantAllowed(true);
      return;
    }

    if (!isTenantHost) {
      setTenantAllowed(true);
      return;
    }

    if (tenantVerifiedKey === tenantVerifyKey) return;

    let cancelled = false;
    void verifyTenantSessionForUser(
      user.id,
      tenantHostOrgId,
      isTenantHost,
      tenantSubdomainLabel,
    ).then((result) => {
      if (cancelled) return;
      setTenantVerifiedKey(tenantVerifyKey);
      if (!result.allowed) {
        setTenantAllowed(false);
        setTenantRedirecting(true);
        void rejectWrongTenantSession({ userId: user.id, signOut })
          .catch((err) => {
            if (err instanceof TenantRedirectingError) return;
            console.error("tenant redirect:", err);
            setTenantRedirecting(false);
          });
      } else {
        setTenantAllowed(true);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [
    shouldSkipTenantCheck,
    user?.id,
    loading,
    isTenantHost,
    tenantHostOrgId,
    tenantSubdomainLabel,
    signOut,
    tenantVerifyKey,
    tenantVerifiedKey,
  ]);

  // ── Maintenance gate ──────────────────────────────────────────────────────
  // Evaluated BEFORE tenant verification renders, but AFTER auth resolves.
  // Gate rules:
  //   non-Master-Admin + blocking             → SystemUnavailableScreen (no Layout, no page)
  //   Master Admin + blocking + on /master    → pass through
  //   Master Admin + blocking + not on /master→ redirect to /master
  if (maintenanceBlocking && user) {
    if (isMasterAdmin) {
      if (!onMasterRoute) {
        return <Navigate to="/master" replace />;
      }
      // Fall through — Master Admin on /master during maintenance is allowed
    } else {
      return <SystemUnavailableScreen />;
    }
  }

  // ── Standard auth loading ─────────────────────────────────────────────────
  const showBlockingLoader =
    (loading && !hadAuthenticatedUserRef.current) || tenantChecking || tenantRedirecting;

  if (showBlockingLoader) {
    return (
      <div className="min-h-app flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/auth" replace />;
  }

  if (isTenantHost && !tenantAllowed) {
    return (
      <div className="min-h-app flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (blockAccountantCashier && isAccountantCashier) {
    return <Navigate to="/dashboard" replace />;
  }

  if (allowedRoles && userRole && !allowedRoles.includes(userRole)) {
    const accountantAllowed =
      allowAccountantCashier && userRole === "cashier" && isAccountantCashier;
    if (!accountantAllowed) {
      return <Navigate to="/dashboard" replace />;
    }
  }

  return <>{children}</>;
}
