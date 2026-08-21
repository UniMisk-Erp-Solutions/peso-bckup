/**
 * LocalPesoWiseBootstrap — mounts the normal PesoWise application, including
 * the local-Supabase auth bootstrap, EXACTLY as src/main.tsx used to do
 * unconditionally before this feature existed.
 *
 * This component is only ever mounted by MaintenanceBootstrap once the Cloud
 * maintenance check has resolved to something other than an active block
 * (normal / upcoming / any Cloud failure — all fail-open to here). While
 * maintenance is confirmed active, this component — and therefore
 * bootstrapAuthSession() and every local-Supabase call it makes — is never
 * mounted at all. See docs/maintenance/CLOUD_MAINTENANCE_CONTROL_PLANE.md
 * §2 "Architecture correction" for why this had to move here rather than
 * merely reordering provider nesting.
 *
 * Preserves, unchanged in spirit:
 *  - stale refresh-token cleanup (bootstrapAuthSession -> recoverFromInvalidAuthSession)
 *  - invalid-session recovery
 *  - network failures never sign the user out
 *  - the same 1500ms maximum boot cap (AuthProvider re-validates once mounted regardless)
 */
import { useEffect, useState } from "react";
import { AuthProvider } from "@/contexts/AuthContext";
import { I18nProvider } from "@/i18n/I18nProvider";
import { SystemAvailabilityProvider } from "@/contexts/SystemAvailabilityContext";
import { bootstrapAuthSession } from "@/lib/authSession";
import App from "@/App";

const BOOTSTRAP_RENDER_CAP_MS = 1500;

export function LocalPesoWiseBootstrap() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void Promise.race([
      bootstrapAuthSession(),
      new Promise<void>((resolve) => setTimeout(resolve, BOOTSTRAP_RENDER_CAP_MS)),
    ]).finally(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
    // Intentionally run once per mount — this component is only ever mounted
    // fresh by MaintenanceBootstrap, never re-used across a maintenance
    // on/off transition (MaintenanceBootstrap unmounts/remounts instead).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Blank until the race settles — matches the old pre-React-mount gate in
  // main.tsx exactly: no loading UI flash, same as when nothing had rendered
  // yet at all.
  if (!ready) return null;

  return (
    <SystemAvailabilityProvider>
      <AuthProvider>
        <I18nProvider>
          <App />
        </I18nProvider>
      </AuthProvider>
    </SystemAvailabilityProvider>
  );
}
