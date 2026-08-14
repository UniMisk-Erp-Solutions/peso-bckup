import { useEffect, useState } from "react";
import { Download, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePwaInstall } from "@/hooks/usePwaInstall";
import { usePwaInstallFlow } from "@/hooks/usePwaInstallFlow";
import { PwaInstallDialogs } from "@/components/PwaInstallDialogs";

/**
 * One-time install prompt (all devices). Install opens the browser's native PWA dialog when available.
 */
export function PwaInstallPrompt() {
  const { shouldShowPrompt, skipPrompt } = usePwaInstall();
  const flow = usePwaInstallFlow();
  const [hidden, setHidden] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!shouldShowPrompt) {
      setVisible(false);
      return;
    }
    if (flow.isIos || flow.canNativeInstall) {
      setVisible(true);
      return;
    }
    const timer = window.setTimeout(() => setVisible(true), 2500);
    return () => window.clearTimeout(timer);
  }, [shouldShowPrompt, flow.isIos, flow.canNativeInstall]);

  if (!shouldShowPrompt || hidden || !visible || flow.isStandalone) return null;

  const handleSkip = () => {
    skipPrompt();
    setHidden(true);
  };

  const handleInstall = async () => {
    const outcome = await flow.handleInstall();
    if (outcome === "accepted") setHidden(true);
  };

  return (
    <>
      <div
        className="fixed bottom-safe-offset left-4 right-4 z-[100] mx-auto max-w-md animate-in slide-in-from-bottom-4 duration-300 sm:left-auto sm:right-6 sm:max-w-sm pl-safe pr-safe"
        role="dialog"
        aria-labelledby="pwa-install-prompt-title"
        aria-describedby="pwa-install-prompt-desc"
      >
        <div className="rounded-xl border border-primary/25 bg-background shadow-lg ring-1 ring-black/5 px-4 py-3">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Download className="h-5 w-5" aria-hidden />
            </div>
            <div className="min-w-0 flex-1 pt-0.5">
              <p id="pwa-install-prompt-title" className="text-sm font-semibold text-foreground">
                {flow.title}
              </p>
              <p
                id="pwa-install-prompt-desc"
                className="text-xs text-muted-foreground mt-0.5 leading-relaxed"
              >
                {flow.description}
              </p>
              <div className="mt-3 flex items-center gap-2">
                <Button
                  size="sm"
                  className="h-8 gap-1.5"
                  disabled={flow.installing}
                  onClick={() => void handleInstall()}
                >
                  {flow.installing ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Download className="h-3.5 w-3.5" />
                  )}
                  {flow.installing ? flow.t("pwa.installPreparing") : flow.t("pwa.installAction")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 text-muted-foreground"
                  disabled={flow.installing}
                  onClick={handleSkip}
                >
                  {flow.t("pwa.notNow")}
                </Button>
              </div>
            </div>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 shrink-0 -mr-1 -mt-0.5"
              disabled={flow.installing}
              onClick={handleSkip}
              aria-label={flow.t("pwa.dismiss")}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      <PwaInstallDialogs
        t={flow.t}
        iosGuideOpen={flow.iosGuideOpen}
        setIosGuideOpen={flow.setIosGuideOpen}
        manualGuideOpen={flow.manualGuideOpen}
        setManualGuideOpen={flow.setManualGuideOpen}
      />
    </>
  );
}
