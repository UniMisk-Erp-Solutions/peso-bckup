import { useCallback, useEffect, useMemo, useState } from "react";
import { User, Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { normalizeLogoPublicUrl } from "@/lib/attachmentPreview";
import { cacheOrganization } from "@/lib/organizationCache";
import { isOrganizationFeatureActive } from "@/lib/orgFeatureGates";
import { ORGANIZATION_FEATURE_KEYS, type OrganizationFeatureKey } from "@/lib/organizationFeatureKeys";
import {
  getAppBaseDomain,
  getDevTenantSubdomainOverride,
  resolveTenantLabelFromHostname,
} from "@/lib/tenantContext";
import { changeAppLanguage } from "@/i18n/i18nInstance";
import { normalizeAppLanguage, type AppLanguage } from "@/i18n/config";
import {
  getValidatedAuthUser,
  isInvalidRefreshTokenError,
  recoverFromInvalidAuthSession,
  isSupabaseNetworkError,
} from "@/lib/authSession";
import {
  AuthContext,
  type AppRole,
  type Organization,
  type TenantFeatureStatus,
  type TenantResolutionStatus,
  type UserProfile,
} from "@/contexts/auth-context";

// ---------------------------------------------------------------------------
// Auth context localStorage cache — eliminates the loading spinner on page
// reload / tab eviction by hydrating from cache before DB queries run.
// ---------------------------------------------------------------------------
const AUTH_CTX_CACHE_KEY = "pesowise-auth-ctx-v1";

interface AuthCtxCacheEntry {
  userId: string;
  role: string | null;
  profile: Record<string, unknown> | null;
  organization: Record<string, unknown> | null;
  organizationId: string | null;
  organizationFeatureFlags: Record<string, boolean>;
  membershipIsAccountantCashier: boolean;
  preferredLanguage: string;
  cachedAt: number;
}

function _readAuthCtxCache(userId: string): AuthCtxCacheEntry | null {
  try {
    const raw = localStorage.getItem(AUTH_CTX_CACHE_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as AuthCtxCacheEntry;
    return d?.userId === userId ? d : null;
  } catch { return null; }
}

function _clearAuthCtxCache(): void {
  try { localStorage.removeItem(AUTH_CTX_CACHE_KEY); } catch {}
}
// ---------------------------------------------------------------------------

export { useAuth } from "@/contexts/auth-context";
export type { AppRole, AuthContextType, Organization, UserProfile } from "@/contexts/auth-context";

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [userRole, setUserRole] = useState<AppRole | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [organization, setOrganization] = useState<Organization | null>(null);
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [appBaseDomain] = useState(() => getAppBaseDomain());
  // Computed synchronously (not `false`/effect-set) so a tenant host is known
  // from the very first render — ProtectedRoute gates its tenant-verification
  // effect on this value, and a `false`-then-effect-corrected initial state
  // let a cached-authenticated user's protected child mount and fire
  // authenticated requests for one render before tenant checking had even
  // started. resolveTenantLabelFromHostname is a pure read of
  // window.location.hostname — no network call, safe to run in an initializer.
  const [isTenantHost, setIsTenantHost] = useState(
    () =>
      resolveTenantLabelFromHostname(
        typeof window !== "undefined" ? window.location.hostname : "",
        getAppBaseDomain(),
        getDevTenantSubdomainOverride(),
      ).isTenantHost,
  );
  const [tenantSubdomainLabel, setTenantSubdomainLabel] = useState<string | null>(
    () =>
      resolveTenantLabelFromHostname(
        typeof window !== "undefined" ? window.location.hostname : "",
        getAppBaseDomain(),
        getDevTenantSubdomainOverride(),
      ).subdomainLabel,
  );
  const [tenantHostOrgId, setTenantHostOrgId] = useState<string | null>(null);
  const [tenantHostOrg, setTenantHostOrg] = useState<{
    id: string;
    name: string;
    slug: string;
    logo_url?: string | null;
  } | null>(null);
  const [organizationFeatureFlags, setOrganizationFeatureFlags] = useState<Record<string, boolean>>({});
  const [tenantEmployeeIdLoginEnabled, setTenantEmployeeIdLoginEnabled] = useState(false);
  const [tenantResolutionStatus, setTenantResolutionStatus] =
    useState<TenantResolutionStatus>("idle");
  const [tenantFeatureStatus, setTenantFeatureStatus] = useState<TenantFeatureStatus>("idle");
  const [tenantRetryToken, setTenantRetryToken] = useState(0);
  const [preferredLanguage, setPreferredLanguageState] = useState<AppLanguage>("en");
  const [membershipIsAccountantCashier, setMembershipIsAccountantCashier] = useState(false);
  const [userBalance, setUserBalance] = useState<number | null>(null);

  useEffect(() => {
    const { subdomainLabel, isTenantHost: tenant } = resolveTenantLabelFromHostname(
      typeof window !== "undefined" ? window.location.hostname : "",
      appBaseDomain,
      getDevTenantSubdomainOverride(),
    );
    setIsTenantHost(tenant);
    setTenantSubdomainLabel(subdomainLabel);
    if (!tenant || !subdomainLabel) {
      setTenantHostOrgId(null);
      setTenantHostOrg(null);
      setTenantResolutionStatus("idle");
      return;
    }
    let cancelled = false;
    setTenantResolutionStatus("loading");
    void (async () => {
      const { data, error } = await supabase.rpc("get_organization_by_subdomain", {
        p_subdomain: subdomainLabel,
      });
      if (cancelled) return;
      // An RPC/network failure is NOT the same as "this subdomain does not exist".
      // Collapsing the two used to make a transient error look like an unconfigured
      // tenant, which silently dropped the login form back to email-only mode.
      if (error) {
        console.error("get_organization_by_subdomain:", error);
        setTenantHostOrgId(null);
        setTenantHostOrg(null);
        setTenantResolutionStatus("error");
        return;
      }
      if (!data?.length) {
        setTenantHostOrgId(null);
        setTenantHostOrg(null);
        setTenantResolutionStatus("not_found");
        return;
      }
      const row = data[0] as {
        id: string;
        name: string;
        slug: string;
        logo_url?: string | null;
      };
      setTenantHostOrgId(row.id);
      setTenantHostOrg({
        id: row.id,
        name: row.name,
        slug: row.slug,
        logo_url: normalizeLogoPublicUrl(row.logo_url ?? null),
      });
      setTenantResolutionStatus("resolved");
    })();
    return () => {
      cancelled = true;
    };
  }, [appBaseDomain, tenantRetryToken]);

  useEffect(() => {
    if (!tenantHostOrgId || !isTenantHost) {
      setTenantEmployeeIdLoginEnabled(false);
      setTenantFeatureStatus("idle");
      return;
    }
    let cancelled = false;
    setTenantFeatureStatus("loading");
    void (async () => {
      const { data, error } = await supabase.rpc("get_organization_feature_enabled", {
        p_organization_id: tenantHostOrgId,
        p_feature_key: ORGANIZATION_FEATURE_KEYS.employee_id_login,
      });
      if (cancelled) return;
      // "The RPC failed" must not be reported as "the feature is disabled".
      // tenantEmployeeIdLoginEnabled stays false (it gates the RPC call), but the
      // status tells the UI to show a retry instead of claiming email-only mode.
      if (error) {
        console.error("get_organization_feature_enabled:", error);
        setTenantEmployeeIdLoginEnabled(false);
        setTenantFeatureStatus("error");
        return;
      }
      setTenantEmployeeIdLoginEnabled(Boolean(data));
      setTenantFeatureStatus("resolved");
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantHostOrgId, isTenantHost, tenantRetryToken]);

  /** Re-runs organization + employee-login-feature resolution after a failure. */
  const retryTenantResolution = useCallback(() => {
    setTenantRetryToken((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const profileLoadedForUserIdRef = { current: null as string | null };

    const clearAuthState = () => {
      _clearAuthCtxCache();
      profileLoadedForUserIdRef.current = null;
      setSession(null);
      setUser(null);
      setUserRole(null);
      setUserProfile(null);
      setOrganization(null);
      setOrganizationId(null);
      setOrganizationFeatureFlags({});
      setMembershipIsAccountantCashier(false);
      setUserBalance(null);
      setLoading(false);
    };

    const loadUserContext = async (userId: string, isBackground = false) => {
      // Guard: skip re-loading the same user unless it's a background refresh.
      // This prevents the SIGNED_IN event fired on tab focus from re-running
      // all the DB queries and flipping `loading` on/off.
      if (!isBackground && profileLoadedForUserIdRef.current === userId) {
        if (!cancelled) setLoading(false);
        return;
      }
      profileLoadedForUserIdRef.current = userId;
      await Promise.all([
        fetchUserRole(userId),
        fetchUserProfile(userId),
        fetchOrganization(userId),
      ]);
      if (!cancelled) setLoading(false); // idempotent when called from background path
    };

    const applySignedInSession = (session: Session | null) => {
      if (cancelled) return;
      setSession(session);
      setUser(session?.user ?? null);
      if (!session?.user) {
        clearAuthState();
        return;
      }
      setLoading(true);
      void loadUserContext(session.user.id);
    };

    // Pre-arm the INITIAL_SESSION / SIGNED_IN same-user guard synchronously, before
    // registering the listener. Without this there is a race: INITIAL_SESSION fires on
    // the next microtask after onAuthStateChange, but profileLoadedForUserIdRef is only
    // set later inside the async fast-path IIFE (after its first await). If INITIAL_SESSION
    // wins that race the guard is unarmed → applySignedInSession fires → setLoading(true)
    // → visible spinner flash even when the cache is perfectly fresh.
    // Reading our own localStorage cache (no async) arms the guard immediately.
    try {
      const raw = localStorage.getItem(AUTH_CTX_CACHE_KEY);
      if (raw) {
        const preloaded = JSON.parse(raw) as AuthCtxCacheEntry;
        if (preloaded?.userId) {
          profileLoadedForUserIdRef.current = preloaded.userId;
        }
      }
    } catch {}

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "TOKEN_REFRESHED" && !session) {
        void recoverFromInvalidAuthSession("Invalid Refresh Token");
        clearAuthState();
        return;
      }

      if (event === "SIGNED_OUT") {
        clearAuthState();
        return;
      }

      if (event === "TOKEN_REFRESHED" && session) {
        if (cancelled) return;
        setSession(session);
        setUser(session.user);
        return;
      }

      if (event === "USER_UPDATED" && session?.user) {
        if (cancelled) return;
        setSession(session);
        setUser(session.user);
        return;
      }

      if (event === "SIGNED_IN") {
        // Supabase also emits SIGNED_IN on tab focus / visibility regain — not just on a
        // real login. If it's the same user we already loaded, just refresh the session
        // object. Do NOT reset the guard or call applySignedInSession (which flips `loading`
        // on and refetches everything) — that is what made the whole app flash its loader
        // and "auto-refresh" on every tab switch.
        if (session?.user && profileLoadedForUserIdRef.current === session.user.id) {
          if (!cancelled) {
            setSession(session);
            setUser(session.user);
          }
          return;
        }
        profileLoadedForUserIdRef.current = null;
        applySignedInSession(session);
        return;
      }

      if (event === "INITIAL_SESSION") {
        // Same guard as SIGNED_IN: if the fast-path already hydrated this user from
        // the localStorage cache (profileLoadedForUserIdRef is set + loading is false),
        // skip applySignedInSession — it would call setLoading(true) and restart the
        // loading flow, causing a brief spinner that looks like a reload.
        if (session?.user && profileLoadedForUserIdRef.current === session.user.id) {
          if (!cancelled) {
            setSession(session);
            setUser(session.user);
          }
          return;
        }
        applySignedInSession(session);
      }
    });

    void (async () => {
      // ── Fast-path ──────────────────────────────────────────────────────────
      // Read the cached session from localStorage (no network). If we find a
      // matching auth-context cache for that user, hydrate state instantly and
      // set loading=false right away so the app renders without a spinner.
      // Token validation + DB refresh then happen silently in the background.
      const { data: { session: localSession } } = await supabase.auth.getSession();
      if (localSession?.user) {
        const cache = _readAuthCtxCache(localSession.user.id);
        if (cache && !cancelled) {
          setSession(localSession);
          setUser(localSession.user);
          setUserRole(cache.role as AppRole | null);
          setUserProfile(cache.profile as UserProfile | null);
          setOrganization(cache.organization as Organization | null);
          setOrganizationId(cache.organizationId);
          setOrganizationFeatureFlags(cache.organizationFeatureFlags);
          setMembershipIsAccountantCashier(cache.membershipIsAccountantCashier);
          const lang = normalizeAppLanguage(cache.preferredLanguage);
          setPreferredLanguageState(lang);
          void changeAppLanguage(lang);
          profileLoadedForUserIdRef.current = localSession.user.id;
          setLoading(false); // ← instant — no spinner

          // Validate token server-side and refresh DB data in background
          const { user: validUser, error: validError } = await getValidatedAuthUser();
          if (cancelled) return;
          if (validError && isInvalidRefreshTokenError(validError.message)) {
            clearAuthState();
            return;
          }
          // Only refresh from DB if the cache is older than 5 minutes.
          // A fresh cache means the data is current; skipping the background refresh
          // eliminates 3 DB re-renders on every page load when the user just loaded
          // the app moments ago.
          const CACHE_MAX_AGE_MS = 5 * 60 * 1000;
          if (validUser && Date.now() - (cache.cachedAt ?? 0) > CACHE_MAX_AGE_MS) {
            void loadUserContext(localSession.user.id, true); // background, no loading toggle
          }
          return;
        }
      }

      // ── Normal-path (first load, no cache) ────────────────────────────────
      const { user, error } = await getValidatedAuthUser();
      if (cancelled) return;

      if (error && isInvalidRefreshTokenError(error.message)) {
        clearAuthState();
        return;
      }

      if (user) {
        const { data: { session } } = await supabase.auth.getSession();
        applySignedInSession(session);
        return;
      }

      // user is null — network error or not authenticated.
      // Check local session before clearing state so a transient network failure
      // doesn't log out a user who has a valid locally-cached session.
      const { data: { session: raceSession } } = await supabase.auth.getSession();

      if (profileLoadedForUserIdRef.current) {
        // INITIAL_SESSION / SIGNED_IN already handled this user in the listener.
        // Ensure loading is not stuck in case that path skipped setLoading(false).
        if (!cancelled) setLoading(false);
        return;
      }

      if (raceSession?.user) {
        // Local session exists but network validation failed (transient error).
        // Fall back to the local session so the app can render; token refresh will
        // re-validate when the network recovers.
        applySignedInSession(raceSession);
        return;
      }

      clearAuthState();
    })();

    const handleOnline = () => {
      // When the network recovers, trigger a background session re-validation so
      // data fetched during the offline window gets refreshed.
      void (async () => {
        if (cancelled) return;
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.user || cancelled) return;
        void loadUserContext(session.user.id, true);
      })();
    };
    window.addEventListener("online", handleOnline);

    return () => {
      cancelled = true;
      subscription.unsubscribe();
      window.removeEventListener("online", handleOnline);
    };
  }, []);

  // Write auth context to localStorage whenever it is fully loaded. This is the
  // source of truth for the fast-path hydration on the next page load / tab eviction.
  useEffect(() => {
    if (!loading && user?.id) {
      try {
        localStorage.setItem(AUTH_CTX_CACHE_KEY, JSON.stringify({
          userId: user.id,
          role: userRole,
          profile: userProfile,
          organization,
          organizationId,
          organizationFeatureFlags,
          membershipIsAccountantCashier,
          preferredLanguage,
          cachedAt: Date.now(),
        }));
      } catch { /* ignore quota errors */ }
    }
  }, [loading, user?.id, userRole, userProfile, organization, organizationId,
    organizationFeatureFlags, membershipIsAccountantCashier, preferredLanguage]);

  const refreshBalance = useCallback(async () => {
    if (!user?.id) return;
    try {
      const { data, error } = await supabase
        .from("profiles")
        .select("balance")
        .eq("user_id", user.id)
        .maybeSingle();
      if (error) throw error;
      setUserBalance(data?.balance ?? 0);
    } catch (error) {
      console.error("Error fetching user balance:", error);
    }
  }, [user?.id]);

  useEffect(() => {
    const userId = user?.id;
    const showBalance =
      userRole === "employee" || userRole === "engineer" || userRole === "cashier";
    if (!userId || !showBalance) {
      setUserBalance(null);
      return;
    }

    void refreshBalance();

    const channelName = `auth-balance-${userId}`;
    const existingChannel = supabase.getChannels().find(
      (ch) => ch.topic === `realtime:${channelName}`,
    );
    if (existingChannel) {
      supabase.removeChannel(existingChannel);
    }

    const channel = supabase
      .channel(channelName)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "profiles",
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          const newBalance = (payload.new as { balance?: number })?.balance;
          if (typeof newBalance === "number") {
            setUserBalance(newBalance);
          } else {
            void refreshBalance();
          }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user?.id, userRole, refreshBalance]);

  const fetchUserRole = async (userId: string) => {
    try {
      // Master admins: check profile first
      const { data: profile } = await (supabase as any)
        .from("profiles")
        .select("is_master_admin")
        .eq("user_id", userId)
        .maybeSingle() as { data: { is_master_admin?: boolean } | null };

      if (profile?.is_master_admin === true) {
        setUserRole("master_admin");
        setMembershipIsAccountantCashier(false);
        return;
      }

      // Also check master_admin_memberships (alternative source)
      const { data: membership } = await (supabase as any)
        .from("master_admin_memberships")
        .select("id")
        .eq("user_id", userId)
        .eq("is_active", true)
        .maybeSingle() as { data: { id?: string } | null };

      if (membership) {
        setUserRole("master_admin");
        setMembershipIsAccountantCashier(false);
        return;
      }

      // Get role from organization_memberships
      const { data, error } = await (supabase as any)
        .from("organization_memberships")
        .select("role, is_accountant_cashier")
        .eq("user_id", userId)
        .eq("is_active", true)
        .maybeSingle() as {
        data: { role?: string; is_accountant_cashier?: boolean } | null;
        error: Error | null;
      };

      if (error) throw error;
      setUserRole((data?.role as AppRole) || null);
      setMembershipIsAccountantCashier(data?.is_accountant_cashier === true);
    } catch (error) {
      console.error("Error fetching user role:", error);
    }
  };

  const fetchUserProfile = async (userId: string) => {
    try {
      const { data, error } = await (supabase as any)
        .from("profiles")
        .select("id, name, email, organization_id, preferred_language, balance")
        .eq("user_id", userId)
        .maybeSingle() as { data: (UserProfile & { balance?: number }) | null; error: Error | null };

      if (error) throw error;
      setUserProfile(data);
      if (data && typeof data.balance === "number") {
        setUserBalance(data.balance);
      }
      const lang = normalizeAppLanguage(data?.preferred_language);
      setPreferredLanguageState(lang);
      void changeAppLanguage(lang);
      // Master admins may have null organization_id
      if (data?.organization_id) {
        setOrganizationId(data.organization_id);
      } else {
        setOrganizationId(null);
      }
    } catch (error) {
      console.error("Error fetching user profile:", error);
    } finally {
      setLoading(false);
    }
  };

  const fetchOrganization = async (userId: string) => {
    try {
      // Master admins don't have an organization
      const { data: profile } = await (supabase as any)
        .from("profiles")
        .select("is_master_admin")
        .eq("user_id", userId)
        .maybeSingle() as { data: { is_master_admin?: boolean } | null };
      if (profile?.is_master_admin === true) {
        setOrganization(null);
        setOrganizationId(null);
        setOrganizationFeatureFlags({});
        return;
      }

      // Get organization via organization_memberships
      const { data: membership, error: membershipError } = await (supabase as any)
        .from("organization_memberships")
        .select("organization_id")
        .eq("user_id", userId)
        .eq("is_active", true)
        .maybeSingle() as { data: { organization_id?: string } | null; error: Error | null };

      if (membershipError) throw membershipError;
      if (!membership?.organization_id) return;

      // Fetch organization details
      const { data: orgData, error: orgError } = await (supabase as any)
        .from("organizations")
        .select("id, name, slug, plan, logo_url, strategy_slug, subdomain")
        .eq("id", membership.organization_id)
        .single() as { data: Organization | null; error: Error | null };

      if (orgError) throw orgError;
      if (orgData) {
        const orgWithLogo = {
          ...orgData,
          logo_url: normalizeLogoPublicUrl(orgData.logo_url ?? null),
        };
        setOrganization(orgWithLogo);
        setOrganizationId(orgWithLogo.id);
        const { data: featRows, error: featErr } = await supabase
          .from("organization_features")
          .select("feature_key, enabled")
          .eq("organization_id", orgData.id);
        if (!featErr && featRows) {
          const map: Record<string, boolean> = {};
          for (const row of featRows as { feature_key: string; enabled: boolean }[]) {
            map[row.feature_key] = row.enabled;
          }
          setOrganizationFeatureFlags(map);
        } else {
          setOrganizationFeatureFlags({});
        }
      }

      // Cache organization data for login page logo display.
      // getUser() is a network call (JWT validation) — fire-and-forget so it
      // doesn't block the loadUserContext Promise.all that awaits fetchOrganization.
      void (async () => {
        try {
          const { data: { user: currentUser } } = await supabase.auth.getUser();
          if (currentUser?.email && orgData) {
            cacheOrganization(currentUser.email, {
              id: orgData.id,
              name: orgData.name,
              logo_url: normalizeLogoPublicUrl(orgData.logo_url ?? null),
            });
          }
        } catch {}
      })();
    } catch (error) {
      console.error("Error fetching organization:", error);
    }
  };

  const refreshUserProfile = async (userIdOverride?: string) => {
    const id = userIdOverride || user?.id;
    if (!id) return;
    await fetchUserProfile(id);
  };

  const refreshOrganization = async () => {
    if (!user?.id) return;
    await fetchOrganization(user.id);
  };

  // useCallback([]) makes signOut a stable reference across renders.
  // Without this, Auth page's useEffect (which lists signOut in its dep array)
  // re-fires on every AuthContext render → repeated getValidatedAuthUser() calls
  // and spurious navigate("/dashboard") while the user is on /auth.
  const signOut = useCallback(async () => {
    _clearAuthCtxCache(); // clear before signOut so next fast-path doesn't find stale data
    sessionStorage.removeItem("pesowise:load-all:admin");
    sessionStorage.removeItem("pesowise:load-all:review");
    sessionStorage.removeItem("pesowise:admin-expenses-page");
    localStorage.removeItem("pesowise-user-activity-leader");
    try {
      await supabase.auth.signOut();
    } catch {
      await supabase.auth.signOut({ scope: "local" });
    }
    setPreferredLanguageState("en");
    void changeAppLanguage("en");
  }, []);

  const setPreferredLanguage = async (lang: AppLanguage) => {
    const normalized = normalizeAppLanguage(lang);
    if (!user?.id) {
      setPreferredLanguageState(normalized);
      void changeAppLanguage(normalized);
      return;
    }
    const { error } = await (supabase as any)
      .from("profiles")
      .update({ preferred_language: normalized })
      .eq("user_id", user.id);
    if (error) throw error;
    setPreferredLanguageState(normalized);
    setUserProfile((prev) => (prev ? { ...prev, preferred_language: normalized } : prev));
    await changeAppLanguage(normalized);
  };

  const hasOrganizationFeature = useCallback(
    (key: OrganizationFeatureKey) =>
      isOrganizationFeatureActive(key, {
        featureFlags: organizationFeatureFlags,
        isTenantHost,
        tenantHostOrgId,
        organizationId,
      }),
    [organizationFeatureFlags, isTenantHost, tenantHostOrgId, organizationId],
  );

  const isAccountantCashier = useMemo(
    () =>
      userRole === "cashier" &&
      membershipIsAccountantCashier &&
      hasOrganizationFeature(ORGANIZATION_FEATURE_KEYS.cashier_accountant_mode),
    [userRole, membershipIsAccountantCashier, hasOrganizationFeature],
  );

  return (
    <AuthContext.Provider value={{
      user,
      session,
      userRole,
      userProfile,
      organization,
      organizationId,
      loading,
      signOut,
      refreshUserProfile,
      refreshOrganization,
      appBaseDomain,
      isTenantHost,
      tenantSubdomainLabel,
      tenantHostOrgId,
      tenantHostOrg,
      organizationFeatureFlags,
      hasOrganizationFeature,
      tenantEmployeeIdLoginEnabled,
      tenantResolutionStatus,
      tenantFeatureStatus,
      retryTenantResolution,
      preferredLanguage,
      setPreferredLanguage,
      isAccountantCashier,
      userBalance,
      refreshBalance,
    }}>
      {children}
    </AuthContext.Provider>
  );
}
