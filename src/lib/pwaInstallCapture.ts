/**
 * Captures beforeinstallprompt as early as possible (before React hydration).
 * Browsers only fire this once per session when PWA installability criteria are met.
 */

export type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();

function notifyListeners(): void {
  listeners.forEach((fn) => fn());
}

export function capturePwaInstallPromptEarly(): void {
  if (typeof window === "undefined") return;

  const win = window as Window & { __pesowisePwaCaptureInit?: boolean };
  if (win.__pesowisePwaCaptureInit) return;
  win.__pesowisePwaCaptureInit = true;

  window.addEventListener(
    "beforeinstallprompt",
    (e) => {
      e.preventDefault();
      deferredPrompt = e as BeforeInstallPromptEvent;
      notifyListeners();
    },
    { capture: true },
  );

  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    notifyListeners();
  });
}

export function getCapturedInstallPrompt(): BeforeInstallPromptEvent | null {
  return deferredPrompt;
}

export function subscribeInstallPrompt(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function waitForInstallPrompt(timeoutMs = 12000): Promise<BeforeInstallPromptEvent | null> {
  if (deferredPrompt) return Promise.resolve(deferredPrompt);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: BeforeInstallPromptEvent | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsub();
      resolve(value);
    };

    const timer = window.setTimeout(() => finish(null), timeoutMs);
    const unsub = subscribeInstallPrompt(() => {
      if (deferredPrompt) finish(deferredPrompt);
    });
  });
}

export async function triggerNativeInstallPrompt(): Promise<
  "accepted" | "dismissed" | "unavailable"
> {
  const prompt = deferredPrompt ?? (await waitForInstallPrompt(10000));
  if (!prompt) return "unavailable";

  try {
    await prompt.prompt();
    const { outcome } = await prompt.userChoice;
    if (outcome === "accepted") {
      deferredPrompt = null;
    }
    return outcome;
  } catch {
    return "unavailable";
  }
}

let serviceWorkerRegistered = false;

export function registerPwaServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;

  if (!import.meta.env.PROD) {
    void navigator.serviceWorker.getRegistrations().then((registrations) => {
      registrations.forEach((registration) => registration.unregister());
    });
    if ("caches" in window) {
      void caches.keys().then((keys) => keys.forEach((key) => caches.delete(key)));
    }
    return;
  }

  if (serviceWorkerRegistered) return;
  serviceWorkerRegistered = true;

  const register = () => {
    void navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .catch((error) => {
        console.warn("Service worker registration failed:", error);
        serviceWorkerRegistered = false;
      });
  };

  // Intentionally NO `controllerchange` → window.location.reload() handler. Auto-reloading
  // when a new service worker takes control caused a full page reload (and loss of in-progress
  // form data) whenever the tab regained focus and the SW had updated. A freshly-activated SW
  // serves fresh assets on the next natural navigation/load; stale chunks mid-session are
  // recovered by lazyWithRetry. So we let the new SW take over quietly instead of reloading.

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", register, { once: true });
  } else {
    register();
  }
}
