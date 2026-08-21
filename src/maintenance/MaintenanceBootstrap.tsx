/**
 * MaintenanceBootstrap — the gate described in
 * docs/maintenance/CLOUD_MAINTENANCE_CONTROL_PLANE.md §5/§17/§35.
 *
 * This is the component that actually fixes the architecture-correction
 * finding in §2 of that document: LocalPesoWiseBootstrap (which calls
 * bootstrapAuthSession() and therefore contacts local Supabase) is only
 * ever mounted from the "normal / upcoming / any Cloud failure with no
 * active lease" branches below. It is NEVER mounted while a trusted
 * maintenance lease is held — proven by
 * src/maintenance/__tests__/maintenanceBootstrap.test.tsx.
 *
 * §35 fix: state no longer comes directly from a single poll's
 * resolveMaintenanceState() call. Instead every poll (and every local
 * exact-transition timer tick) runs through the stateful lease reducer in
 * maintenanceLeaseState.ts, so a transient read failure during an ALREADY
 * ESTABLISHED maintenance window no longer instantly unlocks the app — only
 * a fresh success, or the lease's own bounded expiry (ends_at for
 * scheduled, a failure grace period for forced), can end it.
 *
 * Disabled (VITE_MAINTENANCE_CONTROL_ENABLED !== "true"): zero Cloud
 * requests, immediate local app — matches the old
 * VITE_SYSTEM_STATUS_CONTROL_ENABLED convention.
 */
import { useEffect, useRef, useState } from "react";
import {
  MAINTENANCE_CONTROL_ENABLED,
  MAINTENANCE_ENV,
  MAINTENANCE_REQUEST_TIMEOUT_MS,
  MAINTENANCE_POLL_INTERVAL_NORMAL_MS,
  MAINTENANCE_POLL_INTERVAL_ACTIVE_MS,
  MAINTENANCE_ACTIVE_FAILURE_GRACE_MS,
} from "./maintenanceConfig";
import { fetchMaintenanceStatus } from "@/integrations/maintenance-cloud/maintenanceStatusService";
import type { MaintenanceReadOutcome, MaintenanceResolution } from "./maintenanceResolver";
import {
  applyMaintenanceOutcome,
  createEmptyLeaseState,
  deriveMaintenanceResolution,
  nextLeaseTransitionMs,
  scheduleAt,
  tickLeaseExpiry,
  type MaintenanceLeaseState,
} from "./maintenanceLeaseState";
import { CloudMaintenanceScreen } from "./CloudMaintenanceScreen";
import { CloudUpcomingBanner } from "./CloudUpcomingBanner";
import { LocalPesoWiseBootstrap } from "./LocalPesoWiseBootstrap";

export function MaintenanceBootstrap() {
  if (!MAINTENANCE_CONTROL_ENABLED) {
    // Feature disabled: zero Cloud requests, local app renders immediately,
    // exactly as if this whole gate did not exist.
    return <LocalPesoWiseBootstrap />;
  }
  return <EnabledMaintenanceBootstrap />;
}

function EnabledMaintenanceBootstrap() {
  const [resolution, setResolution] = useState<MaintenanceResolution | null>(null);
  const [checking, setChecking] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null);

  const leaseRef = useRef<MaintenanceLeaseState>(createEmptyLeaseState());
  const inFlightRef = useRef(false);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelTransitionRef = useRef<(() => void) | null>(null);
  const mountedRef = useRef(true);

  // scheduleNextTransition / runCheck are mutually recursive: the exact
  // transition timer opportunistically confirms with a fresh (silent)
  // check, and every check result re-arms the transition timer for
  // whichever boundary (starts_at / ends_at / forced grace expiry) is now
  // soonest. Both are plain function declarations (hoisted, so the mutual
  // reference is safe) rather than useCallback — they close over refs only,
  // never over reactive state, so redefining them each render and invoking
  // only the mount-effect's captured versions is safe, matching the
  // pre-existing `useCallback(..., [])` + eslint-disable pattern this
  // replaces.

  function scheduleNextTransition() {
    if (cancelTransitionRef.current) {
      cancelTransitionRef.current();
      cancelTransitionRef.current = null;
    }
    const nextMs = nextLeaseTransitionMs(leaseRef.current, new Date(), MAINTENANCE_ACTIVE_FAILURE_GRACE_MS);
    if (nextMs === null) return;

    cancelTransitionRef.current = scheduleAt(nextMs, Date.now(), () => {
      if (!mountedRef.current) return;
      // Re-derive locally FIRST — instant correctness at exactly starts_at /
      // ends_at / grace-expiry, with zero dependency on network latency.
      const now = new Date();
      leaseRef.current = tickLeaseExpiry(leaseRef.current, now, MAINTENANCE_ACTIVE_FAILURE_GRACE_MS);
      setResolution(deriveMaintenanceResolution(leaseRef.current, now));
      scheduleNextTransition();
      // Then opportunistically confirm with a fresh, silent Cloud read (a
      // schedule may have already been replaced/cancelled right at the
      // boundary) — never blocks the instant local transition above.
      void runCheck(false);
    });
  }

  async function runCheck(manual: boolean) {
    if (inFlightRef.current) return; // single-flight guard — never overlapping reads
    inFlightRef.current = true;
    if (manual) setChecking(true);

    const outcome: MaintenanceReadOutcome = await fetchMaintenanceStatus(
      MAINTENANCE_ENV,
      MAINTENANCE_REQUEST_TIMEOUT_MS,
    );

    inFlightRef.current = false;
    if (!mountedRef.current) return;

    const now = new Date();
    leaseRef.current = applyMaintenanceOutcome(
      leaseRef.current,
      outcome,
      now,
      MAINTENANCE_ACTIVE_FAILURE_GRACE_MS,
    );
    const next = deriveMaintenanceResolution(leaseRef.current, now, outcome.kind);

    setResolution(next);
    setLastCheckedAt(now.toISOString());
    if (manual) setChecking(false);
    scheduleNextTransition();

    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    const interval =
      next.state === "maintenance" ? MAINTENANCE_POLL_INTERVAL_ACTIVE_MS : MAINTENANCE_POLL_INTERVAL_NORMAL_MS;
    pollTimerRef.current = setTimeout(() => void runCheck(false), interval);
  }

  useEffect(() => {
    mountedRef.current = true;
    void runCheck(false);
    return () => {
      mountedRef.current = false;
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      if (cancelTransitionRef.current) cancelTransitionRef.current();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-check on focus / reconnect — silent (not "manual" in the UI sense),
  // matching §29/§30: background re-checks never flicker a "checking" state.
  // The single-flight guard in runCheck prevents these from ever overlapping
  // with the interval timer, the transition timer, or each other.
  useEffect(() => {
    const handleFocus = () => void runCheck(false);
    const handleOnline = () => void runCheck(false);
    window.addEventListener("focus", handleFocus);
    window.addEventListener("online", handleOnline);
    return () => {
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("online", handleOnline);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // First check still in flight: render nothing, bounded by
  // MAINTENANCE_REQUEST_TIMEOUT_MS (never an infinite spinner — the fetch
  // itself is AbortController-timeout-bounded, so this state cannot persist
  // forever). Matches the existing pre-render blank-page precedent in
  // src/main.tsx rather than introducing a new loading UI in this pass.
  if (resolution === null) return null;

  if (resolution.state === "maintenance") {
    return (
      <CloudMaintenanceScreen
        resolution={resolution}
        onCheckAgain={() => void runCheck(true)}
        checking={checking}
        lastCheckedAt={lastCheckedAt}
      />
    );
  }

  if (resolution.state === "upcoming") {
    return (
      <>
        <CloudUpcomingBanner resolution={resolution} />
        <LocalPesoWiseBootstrap />
      </>
    );
  }

  // "normal" — includes every fail-open outcome (paused/timeout/network/
  // malformed/not-configured/etc.) while no trusted lease is held.
  return <LocalPesoWiseBootstrap />;
}
