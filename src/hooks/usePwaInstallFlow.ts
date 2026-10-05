import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { usePwaInstall } from "@/hooks/usePwaInstall";
import { refreshManifestLink, verifyManifestForCurrentHost } from "@/lib/manifestVerification";
import { reportError } from "@/lib/monitoring";

export function usePwaInstallFlow() {
  const { t } = useTranslation("common");
  const { toast } = useToast();
  const { isTenantHost, tenantHostOrg } = useAuth();
  const { isStandalone, isIos, canNativeInstall, promptInstall } = usePwaInstall();
  const [iosGuideOpen, setIosGuideOpen] = useState(false);
  const [manualGuideOpen, setManualGuideOpen] = useState(false);
  const [installing, setInstalling] = useState(false);

  // On a tenant host the button must name the organization, so the user can tell an
  // ML install apart from a generic PesoWise (apex) install on their home screen.
  const orgName = isTenantHost ? tenantHostOrg?.name?.trim() : "";
  const title = orgName
    ? t("pwa.installTitleOrg", { org: orgName })
    : isTenantHost
      ? t("pwa.installTitleTenant")
      : t("pwa.installTitle");
  const description = isTenantHost
    ? t("pwa.installDescriptionTenant")
    : t("pwa.installDescription");

  const handleInstall = async (): Promise<
    "accepted" | "dismissed" | "unavailable" | "ios" | "standalone" | "wrong_manifest"
  > => {
    if (isStandalone) return "standalone";

    if (isIos) {
      setIosGuideOpen(true);
      return "ios";
    }

    // Refuse to install an app whose manifest describes a different host — that is
    // how an apex-branded PWA ends up installed from a tenant page.
    const verdict = await verifyManifestForCurrentHost();
    if (!verdict.ok) {
      refreshManifestLink();
      // This used to fail with a toast and nothing else, so a total install
      // outage left no trace anywhere — GlitchTip held zero manifest events
      // while every install on every host was being refused. Report it.
      reportError(new Error(`pwa_install_blocked:${verdict.reason}`), {
        area: "pwa",
        operation: "verify-manifest",
        severity: "warning",
        errorCode: verdict.reason,
        tags: {
          reason: verdict.reason,
          marker: verdict.marker ?? "none",
          expected_marker: verdict.expectedMarker,
        },
        extra: {
          host: typeof window !== "undefined" ? window.location.hostname : "unknown",
        },
        fingerprintKey: `pwa-install-blocked:${verdict.reason}`,
      });
      toast({
        variant: "destructive",
        title: t("pwa.installBlockedTitle"),
        description: t("pwa.installBlockedDescription"),
      });
      return "wrong_manifest";
    }

    setInstalling(true);
    try {
      const outcome = await promptInstall();
      if (outcome === "accepted") {
        toast({ title: t("pwa.installSuccess") });
      } else if (outcome === "unavailable") {
        // The manifest verified, yet the browser never offered a native prompt.
        // That means beforeinstallprompt did not fire — the app is already
        // installed, the browser suppressed a previously dismissed prompt, or an
        // installability criterion is failing on that device. We cannot tell from
        // here, and previously this was invisible: the user just got a "use the
        // browser menu" dialog and we learned nothing. Record enough context to
        // tell those cases apart next time.
        reportError(new Error("pwa_install_prompt_unavailable"), {
          area: "pwa",
          operation: "native-install-prompt",
          severity: "warning",
          errorCode: "prompt_unavailable",
          tags: {
            manifest_verified: true,
            controlled_by_sw:
              typeof navigator !== "undefined" && "serviceWorker" in navigator
                ? String(Boolean(navigator.serviceWorker.controller))
                : "unsupported",
            standalone:
              typeof window !== "undefined"
                ? String(window.matchMedia("(display-mode: standalone)").matches)
                : "unknown",
          },
          extra: {
            host: typeof window !== "undefined" ? window.location.hostname : "unknown",
            userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "unknown",
          },
          fingerprintKey: "pwa-install-prompt-unavailable",
        });
        setManualGuideOpen(true);
      }
      return outcome;
    } finally {
      setInstalling(false);
    }
  };

  return {
    t,
    isStandalone,
    isIos,
    canNativeInstall,
    installing,
    title,
    description,
    handleInstall,
    iosGuideOpen,
    setIosGuideOpen,
    manualGuideOpen,
    setManualGuideOpen,
  };
}
