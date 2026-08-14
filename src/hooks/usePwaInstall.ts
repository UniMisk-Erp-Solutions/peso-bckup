import { useCallback, useEffect, useState } from "react";
import {
  dismissPwaInstallPrompt,
  isIosDevice,
  isStandaloneDisplayMode,
  wasPwaInstallDismissed,
} from "@/lib/pwa";
import {
  getCapturedInstallPrompt,
  subscribeInstallPrompt,
  triggerNativeInstallPrompt,
} from "@/lib/pwaInstallCapture";

export function usePwaInstall() {
  const [hasNativePrompt, setHasNativePrompt] = useState(
    () => Boolean(getCapturedInstallPrompt()),
  );
  const [installed, setInstalled] = useState(false);
  const [dismissed, setDismissed] = useState(wasPwaInstallDismissed);
  const [isIos, setIsIos] = useState(false);

  useEffect(() => {
    setIsIos(isIosDevice());
    setInstalled(isStandaloneDisplayMode());
    setDismissed(wasPwaInstallDismissed());
    setHasNativePrompt(Boolean(getCapturedInstallPrompt()));

    const unsub = subscribeInstallPrompt(() => {
      setHasNativePrompt(Boolean(getCapturedInstallPrompt()));
      if (isStandaloneDisplayMode()) {
        setInstalled(true);
      }
    });

    const onInstalled = () => {
      setInstalled(true);
      setHasNativePrompt(false);
      dismissPwaInstallPrompt();
    };

    window.addEventListener("appinstalled", onInstalled);
    return () => {
      unsub();
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const isStandalone = installed || isStandaloneDisplayMode();
  const canNativeInstall = hasNativePrompt;
  const shouldShowPrompt = !isStandalone && !dismissed;

  const promptInstall = useCallback(async (): Promise<"accepted" | "dismissed" | "unavailable"> => {
    const outcome = await triggerNativeInstallPrompt();
    if (outcome === "accepted") {
      setInstalled(true);
      setHasNativePrompt(false);
      dismissPwaInstallPrompt();
    }
    setHasNativePrompt(Boolean(getCapturedInstallPrompt()));
    return outcome;
  }, []);

  const skipPrompt = useCallback(() => {
    dismissPwaInstallPrompt();
    setDismissed(true);
  }, []);

  return {
    shouldShowPrompt,
    canNativeInstall,
    isIos,
    installed: isStandalone,
    isStandalone,
    promptInstall,
    skipPrompt,
    setDismissed,
  };
}
