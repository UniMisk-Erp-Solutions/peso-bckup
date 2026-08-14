import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePwaInstall } from "@/hooks/usePwaInstall";
import { useToast } from "@/hooks/use-toast";

type PwaInstallBannerProps = {
  /** e.g. "Sign in faster on your phone" vs "Install the app" */
  variant?: "tenant" | "app" | "marketing";
  className?: string;
};

export function PwaInstallBanner({ variant = "app", className = "" }: PwaInstallBannerProps) {
  const { t } = useTranslation("common");
  const { toast } = useToast();
  const { shouldShowPrompt, canNativeInstall, installed, promptInstall, skipPrompt } =
    usePwaInstall();
  const [hidden, setHidden] = useState(false);

  if (!shouldShowPrompt || !canNativeInstall || installed || hidden) return null;

  const title =
    variant === "tenant"
      ? t("pwa.installTitleTenant")
      : variant === "marketing"
        ? t("pwa.installTitleMarketing")
        : t("pwa.installTitle");

  const description =
    variant === "tenant"
      ? t("pwa.installDescriptionTenant")
      : variant === "marketing"
        ? t("pwa.installDescriptionMarketing")
        : t("pwa.installDescription");

  const handleInstall = async () => {
    const outcome = await promptInstall();
    if (outcome === "accepted") {
      toast({ title: t("pwa.installSuccess") });
    }
  };

  const handleDismiss = () => {
    skipPrompt();
    setHidden(true);
  };

  return (
    <div
      className={`flex flex-col sm:flex-row sm:items-center gap-3 rounded-lg border border-primary/20 bg-primary/5 px-4 py-3 ${className}`}
      role="region"
      aria-label={title}
    >
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Button size="sm" onClick={() => void handleInstall()} className="gap-1.5">
          <Download className="h-4 w-4" />
          {t("pwa.installAction")}
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8"
          onClick={handleDismiss}
          aria-label={t("pwa.dismiss")}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
