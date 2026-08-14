import { createRoot } from "react-dom/client";
import { HelmetProvider } from "react-helmet-async";
import App from "./App.tsx";
import { AuthProvider } from "@/contexts/AuthContext";
import { I18nProvider } from "@/i18n/I18nProvider";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { AppErrorFallback } from "@/components/AppErrorFallback";
import { SystemAvailabilityProvider } from "@/contexts/SystemAvailabilityContext";
import {
  capturePwaInstallPromptEarly,
  registerPwaServiceWorker,
} from "@/lib/pwaInstallCapture";
import "./index.css";
import { bootstrapAuthSession } from "@/lib/authSession";
import { initMonitoring } from "@/lib/monitoring";
import { installPreloadErrorHandler } from "@/lib/chunkRecovery";

// Register the Vite-native stale dynamic-import recovery FIRST — before any route
// navigation can trigger a lazy import — so a post-deploy chunk 404 self-heals via
// a single guarded reload instead of surfacing as an ErrorBoundary crash.
installPreloadErrorHandler();

initMonitoring();
capturePwaInstallPromptEarly();
registerPwaServiceWorker();

let appRendered = false;
function renderApp() {
  if (appRendered) return;
  appRendered = true;
  createRoot(document.getElementById("root")!).render(
    <ErrorBoundary fallback={AppErrorFallback}>
      <HelmetProvider>
        <SystemAvailabilityProvider>
          <AuthProvider>
            <I18nProvider>
              <App />
            </I18nProvider>
          </AuthProvider>
        </SystemAvailabilityProvider>
      </HelmetProvider>
    </ErrorBoundary>
  );
}

// Render as soon as the auth pre-check settles, but NEVER block the UI on it for more than
// a short cap. A slow/unreachable self-hosted auth server must not leave the page blank —
// AuthProvider re-validates the session and shows its own loading state once mounted.
// bootstrapAuthSession keeps running in the background to finish any token cleanup.
const BOOTSTRAP_RENDER_CAP_MS = 1500;
void Promise.race([
  bootstrapAuthSession(),
  new Promise<void>((resolve) => setTimeout(resolve, BOOTSTRAP_RENDER_CAP_MS)),
]).finally(renderApp);
