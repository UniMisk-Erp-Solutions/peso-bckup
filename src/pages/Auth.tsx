import { useState, useEffect, useMemo, useCallback } from "react";
import { Helmet } from "react-helmet-async";
import { useNavigate, Link, useLocation, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import {
  getCachedEmployeeAuthEmail,
  setCachedEmployeeAuthEmail,
} from "@/lib/employeeLoginCache";
import {
  assertEmailAllowedOnTenant,
  looksLikeEmailIdentifier,
  rejectWrongTenantSession,
  TenantRedirectingError,
  verifyTenantSessionForUser,
} from "@/lib/tenantAccess";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Loader2, ArrowLeft, Eye, EyeOff } from "lucide-react";
import { z } from "zod";
import { getCachedOrganization, getMostRecentOrganization } from "@/lib/organizationCache";
import { OrganizationLogo } from "@/components/OrganizationLogo";
import { DevTenantSelector } from "@/components/DevTenantSelector";
import { AuthTurnstile } from "@/components/AuthTurnstile";
import {
  getValidatedAuthUser,
  prepareForPasswordSignIn,
  formatAuthErrorMessage,
} from "@/lib/authSession";
import { buildAuthCaptchaOptions, getTurnstileSiteKey, isTurnstileConfigured } from "@/lib/turnstile";
import {
  acceptsEmployeeId,
  blocksSubmit,
  offersRetry,
  resolveTenantSignInMode,
  showsEmployeeIdLabel,
} from "@/lib/tenantSignInMode";
import { SystemAlertBanner } from "@/components/SystemAlertBanner";
import { SYSTEM_STATUS_CONTROL_ENABLED } from "@/config/systemStatusFeature";

export default function Auth() {
  const { t } = useTranslation(["auth", "common"]);
  const [loading, setLoading] = useState(false);
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [captchaToken, setCaptchaToken] = useState("");
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);
  const [organizationName, setOrganizationName] = useState<string | null>(null);
  const [organizationLogoUrl, setOrganizationLogoUrl] = useState<string | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { toast } = useToast();
  const {
    tenantHostOrg,
    tenantHostOrgId,
    tenantSubdomainLabel,
    tenantEmployeeIdLoginEnabled,
    tenantResolutionStatus,
    tenantFeatureStatus,
    retryTenantResolution,
    isTenantHost,
    signOut,
  } = useAuth();

  const signInMode = resolveTenantSignInMode({
    isTenantHost,
    tenantResolutionStatus,
    tenantFeatureStatus,
    tenantEmployeeIdLoginEnabled,
  });
  const useEmployeeIdLabel = showsEmployeeIdLabel(signInMode);
  const tenantStillResolving = signInMode === "loading";
  const tenantLookupFailed = offersRetry(signInMode);

  const signInSchema = useMemo(
    () =>
      z.object({
        identifier: z.string().min(
          1,
          useEmployeeIdLabel ? t("auth:identifierRequired") : t("auth:emailRequired"),
        ),
        password: z.string().min(6, t("auth:passwordMin")),
      }),
    [t, useEmployeeIdLabel],
  );

  const tenantResolved = !isTenantHost || Boolean(tenantHostOrgId);
  const turnstileSiteKey = getTurnstileSiteKey();

  const resetCaptcha = useCallback(() => {
    setCaptchaToken("");
    setTurnstileResetKey((k) => k + 1);
  }, []);

  useEffect(() => {
    const denied = (location.state as { tenantAccessDenied?: boolean } | null)?.tenantAccessDenied;
    const fromWrongTenant = searchParams.get("from_wrong_tenant") === "1";
    if (denied || fromWrongTenant) {
      toast({
        variant: "destructive",
        title: t("auth:wrongOrganization"),
        description: fromWrongTenant
          ? t("auth:wrongOrganizationRedirect")
          : t("auth:wrongOrganizationDenied"),
      });
      if (fromWrongTenant) {
        searchParams.delete("from_wrong_tenant");
        setSearchParams(searchParams, { replace: true });
      } else {
        window.history.replaceState({}, document.title);
      }
    }
  }, [location.state, searchParams, setSearchParams, toast, t]);

  useEffect(() => {
    if (!tenantResolved) return;

    void (async () => {
      const { user } = await getValidatedAuthUser();
      if (!user) return;
      if (isTenantHost) {
        const access = await verifyTenantSessionForUser(
          user.id,
          tenantHostOrgId,
          isTenantHost,
          tenantSubdomainLabel,
        );
        if (!access.allowed) {
          await rejectWrongTenantSession({
            userId: user.id,
            signOut,
          });
          return;
        }
      }
      navigate("/dashboard");
    })();
  }, [navigate, isTenantHost, tenantHostOrgId, tenantSubdomainLabel, tenantResolved, signOut]);

  useEffect(() => {
    if (tenantHostOrg?.name) {
      setOrganizationName(tenantHostOrg.name);
      setOrganizationLogoUrl(tenantHostOrg.logo_url ?? null);
      return;
    }
    const recentOrg = getMostRecentOrganization();
    if (recentOrg?.name) {
      setOrganizationName(recentOrg.name);
      setOrganizationLogoUrl(recentOrg.logo_url ?? null);
    }
  }, [tenantHostOrg]);

  useEffect(() => {
    if (tenantHostOrg?.name) return;
    if (looksLikeEmailIdentifier(identifier)) {
      const cachedOrg = getCachedOrganization(identifier);
      if (cachedOrg?.name) {
        setOrganizationName(cachedOrg.name);
        setOrganizationLogoUrl(cachedOrg.logo_url ?? null);
      } else {
        const recentOrg = getMostRecentOrganization();
        setOrganizationName(recentOrg?.name || null);
        setOrganizationLogoUrl(recentOrg?.logo_url ?? null);
      }
    } else {
      const recentOrg = getMostRecentOrganization();
      setOrganizationName(recentOrg?.name || null);
      setOrganizationLogoUrl(recentOrg?.logo_url ?? null);
    }
  }, [identifier, tenantHostOrg]);

  const resolveEmployeeAuthEmail = async (
    organizationId: string,
    employeeIdValue: string,
  ): Promise<string> => {
    const trimmedId = employeeIdValue.trim();
    const cached = getCachedEmployeeAuthEmail(organizationId, trimmedId);
    if (cached) return cached;

    const { data, error } = await supabase.rpc("get_employee_auth_email", {
      p_organization_id: organizationId,
      p_employee_id: trimmedId,
    });

    if (error) {
      // PGRST202 = PostgREST could not find the function. Surface the
      // migration-required diagnostic instead of "invalid employee ID", which
      // would send an administrator hunting for a data problem that isn't there.
      const missingFunction =
        error.code === "PGRST202" || Boolean(error.message?.includes("get_employee_auth_email"));
      if (missingFunction) {
        throw new Error(t("auth:employeeIdMigration"));
      }
      throw new Error(error.message || t("auth:couldNotResolveEmployeeId"));
    }

    const email = typeof data === "string" ? data.trim() : "";
    if (!email) {
      throw new Error(t("auth:invalidEmployeeId"));
    }

    setCachedEmployeeAuthEmail(organizationId, trimmedId, email);
    return email;
  };

  const resolveAuthEmail = async (rawIdentifier: string): Promise<string> => {
    const trimmed = rawIdentifier.trim();

    if (looksLikeEmailIdentifier(trimmed)) {
      if (isTenantHost) {
        const emailCheck = await assertEmailAllowedOnTenant(
          trimmed,
          tenantHostOrgId,
          tenantSubdomainLabel,
        );
        if (!emailCheck.allowed) {
          throw new Error(emailCheck.reason || t("auth:cannotSignInSubdomain"));
        }
      }
      return trimmed.toLowerCase();
    }

    // A non-email identifier is only rejected as "not an email" when we KNOW
    // employee-ID login is unavailable here. While the tenant is still resolving,
    // or when a lookup failed, the correct answer is "try again", not "wrong format".
    if (signInMode === "loading") {
      throw new Error(t("auth:orgStillLoading"));
    }
    if (signInMode === "unavailable") {
      throw new Error(t("auth:orgSettingsUnavailable"));
    }
    if (signInMode === "not_configured") {
      throw new Error(t("auth:subdomainNotConfiguredToast"));
    }
    if (!acceptsEmployeeId(signInMode)) {
      throw new Error(t("auth:enterEmailWithAt"));
    }

    if (!tenantHostOrgId) {
      throw new Error(t("auth:orgStillLoading"));
    }

    return resolveEmployeeAuthEmail(tenantHostOrgId, trimmed);
  };

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();

    if (blocksSubmit(signInMode)) {
      toast({
        variant: "destructive",
        title: t("auth:subdomainNotReady"),
        description:
          signInMode === "not_configured"
            ? t("auth:subdomainNotConfiguredToast")
            : signInMode === "unavailable"
              ? t("auth:orgSettingsUnavailable")
              : t("auth:subdomainLoading"),
      });
      return;
    }

    try {
      setLoading(true);

      const validated = signInSchema.parse({ identifier, password });
      const authEmail = await resolveAuthEmail(validated.identifier);

      if (isTurnstileConfigured() && !captchaToken) {
        toast({
          variant: "destructive",
          title: t("auth:signInFailed"),
          description: t("auth:captchaRequired"),
        });
        return;
      }

      await prepareForPasswordSignIn();

      const { error } = await supabase.auth.signInWithPassword({
        email: authEmail,
        password: validated.password,
        options: buildAuthCaptchaOptions(captchaToken),
      });
      if (error) throw error;

      const {
        data: { user: signedInUser },
      } = await supabase.auth.getUser();
      if (signedInUser && isTenantHost) {
        const access = await verifyTenantSessionForUser(
          signedInUser.id,
          tenantHostOrgId,
          isTenantHost,
          tenantSubdomainLabel,
        );
        if (!access.allowed) {
          await rejectWrongTenantSession({
            userId: signedInUser.id,
            email: authEmail,
            signOut,
          });
        }
      }

      resetCaptcha();
      navigate("/dashboard");
    } catch (error: unknown) {
      resetCaptcha();
      if (error instanceof TenantRedirectingError) {
        return;
      }
      if (error instanceof z.ZodError) {
        toast({
          variant: "destructive",
          title: t("auth:validationError"),
          description: error.errors[0].message,
        });
      } else {
        const authError =
          error && typeof error === "object" && "message" in error
            ? formatAuthErrorMessage(error as { message?: string; status?: number; code?: string })
            : t("common:genericError");
        const needsCaptchaHint =
          /captcha|turnstile|challenge/i.test(authError) && !turnstileSiteKey;
        toast({
          variant: "destructive",
          title: t("auth:signInFailed"),
          description: needsCaptchaHint ? t("auth:captchaNotConfigured") : authError,
        });
      }
    } finally {
      setLoading(false);
    }
  };

  // While the tenant is unresolved the label must stay neutral — showing "Email"
  // would tell the user their employee ID is invalid before we know that.
  const identifierLabel = useEmployeeIdLabel
    ? t("auth:employeeIdOrEmail")
    : tenantStillResolving || tenantLookupFailed
      ? t("auth:identifierGeneric")
      : t("auth:email");
  const identifierPlaceholder = useEmployeeIdLabel
    ? t("auth:employeeIdOrEmailPlaceholder")
    : tenantStillResolving || tenantLookupFailed
      ? t("auth:identifierGenericPlaceholder")
      : t("auth:emailPlaceholder");

  // Disabled only while the tenant is genuinely unresolved — never merely because
  // a background feature lookup has not finished on an already-resolved apex host.
  const signInDisabled = loading || blocksSubmit(signInMode);

  return (
    <div className="min-h-app flex flex-col bg-gradient-to-br from-primary/10 via-background to-accent/10">
      {SYSTEM_STATUS_CONTROL_ENABLED ? <SystemAlertBanner /> : null}
      <Helmet>
        <title>{t("auth:signInTitle")}</title>
        <meta name="robots" content="noindex, nofollow" />
      </Helmet>
      <div className="flex-1 flex flex-col items-center justify-center p-4 pb-safe pt-safe gap-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-4">
            <OrganizationLogo
              logoUrl={organizationLogoUrl}
              alt={organizationName || "PesoWise"}
              className="h-16 w-auto max-w-[240px] object-contain"
            />
          </div>
          {organizationName && (
            <CardTitle className="text-xl font-bold text-primary mb-2">
              {organizationName}
            </CardTitle>
          )}
          <CardTitle className={`text-2xl ${organizationName ? "text-muted-foreground" : ""}`}>
            {t("auth:platformTitle")}
          </CardTitle>
          <CardDescription>
            {t("auth:platformDescription")}
            {tenantHostOrg?.slug ? (
              <span className="block mt-1 font-mono text-[11px] opacity-80">
                {t("auth:tenantLabel", { slug: tenantHostOrg.slug })}
              </span>
            ) : isTenantHost && !tenantHostOrg ? (
              <span className="block mt-1 text-destructive text-xs">
                {t("auth:tenantNotConfigured")}
              </span>
            ) : null}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <DevTenantSelector />
          <form onSubmit={handleSignIn} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="signin-identifier">{identifierLabel}</Label>
              <Input
                id="signin-identifier"
                type="text"
                placeholder={identifierPlaceholder}
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                autoComplete="username"
                required
                disabled={blocksSubmit(signInMode)}
              />
              {tenantStillResolving && (
                <p
                  data-testid="tenant-resolving"
                  className="flex items-center gap-1.5 text-xs text-muted-foreground"
                >
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {t("auth:checkingOrgSettings")}
                </p>
              )}
              {tenantLookupFailed && (
                <div
                  data-testid="tenant-lookup-failed"
                  className="flex items-center justify-between gap-2 text-xs text-destructive"
                >
                  <span>{t("auth:orgSettingsUnavailable")}</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={retryTenantResolution}
                  >
                    {t("auth:retry")}
                  </Button>
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="signin-password">{t("auth:password")}</Label>
              <div className="relative">
                <Input
                  id="signin-password"
                  type={showPassword ? "text" : "password"}
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="pr-10"
                  autoComplete="current-password"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((p) => !p)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                  aria-label={showPassword ? t("auth:hidePassword") : t("auth:showPassword")}
                  tabIndex={0}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <AuthTurnstile
              resetKey={turnstileResetKey}
              onToken={setCaptchaToken}
              onExpire={() => setCaptchaToken("")}
            />
            <Button
              type="submit"
              className="w-full"
              disabled={signInDisabled || (isTurnstileConfigured() && !captchaToken)}
            >
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("auth:signIn")}
            </Button>
            {!isTenantHost && (
              <p className="text-center text-sm text-muted-foreground mt-4">
                <Link
                  to="/"
                  className="inline-flex items-center gap-1.5 text-primary hover:underline font-medium"
                >
                  <ArrowLeft className="h-4 w-4" />
                  {t("auth:backToHome")}
                </Link>
              </p>
            )}
          </form>
        </CardContent>
      </Card>
      <p className="mt-4 text-center text-xs text-muted-foreground/70 flex flex-wrap justify-center gap-x-3 gap-y-1">
        <Link to="/privacy" className="hover:text-muted-foreground hover:underline">Privacy Policy</Link>
        <span aria-hidden="true">·</span>
        <Link to="/toc" className="hover:text-muted-foreground hover:underline">Terms</Link>
        <span aria-hidden="true">·</span>
        <Link to="/legal/data-rights" className="hover:text-muted-foreground hover:underline">Data Rights</Link>
      </p>
      </div>
    </div>
  );
}