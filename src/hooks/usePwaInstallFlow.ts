import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { usePwaInstall } from "@/hooks/usePwaInstall";
import { refreshManifestLink, verifyManifestForCurrentHost } from "@/lib/manifestVerification";

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
