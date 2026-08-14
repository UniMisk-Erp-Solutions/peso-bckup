/**
 * SystemAvailabilityContext — polls /api/system-status and exposes the result.
 * Must be mounted ABOVE AuthProvider so maintenance gate works before auth resolves.
 * Does NOT clear auth storage on network errors (resilience rule).
 * Distinguishes browser-offline from server outage.
 *
 * When SYSTEM_STATUS_CONTROL_ENABLED is false the provider returns a stable
 * "operational, non-blocking" value and performs zero network requests.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { SystemStatusPayload, SystemState } from "@/lib/systemAvailability";
import { SYSTEM_STATUS_CONTROL_ENABLED } from "@/config/systemStatusFeature";

const POLL_INTERVAL_NORMAL_MS = 60_000;
const POLL_INTERVAL_BLOCKING_MS = 15_000;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_CONSECUTIVE_ERRORS = 3;

type StatusSource = "live" | "cached" | "none";

type SystemAvailabilityContextValue = {
  state: SystemState;
  blocking: boolean;
  status: SystemStatusPayload | null;
  initializing: boolean;
  lastCheckedAt: string | null;
  error: string | null;
  browserOnline: boolean;
  statusSource: StatusSource;
  refreshStatus: () => void;
};

const DEFAULT_VALUE: SystemAvailabilityContextValue = {
  state: "unknown",
  blocking: false,
  status: null,
  initializing: true,
  lastCheckedAt: null,
  error: null,
  browserOnline: typeof navigator !== "undefined" ? navigator.onLine : true,
  statusSource: "none",
  refreshStatus: () => {},
};

/** Stable disabled value — always operational, never blocking, no requests. */
const DISABLED_VALUE: SystemAvailabilityContextValue = {
  state: "operational",
  blocking: false,
  status: null,
  initializing: false,
  lastCheckedAt: null,
  error: null,
  browserOnline: typeof navigator !== "undefined" ? navigator.onLine : true,
  statusSource: "none",
  refreshStatus: () => {},
};

const SystemAvailabilityContext =
  createContext<SystemAvailabilityContextValue>(DEFAULT_VALUE);

export function useSystemAvailability(): SystemAvailabilityContextValue {
  return useContext(SystemAvailabilityContext);
}

async function fetchStatus(signal: AbortSignal): Promise<SystemStatusPayload | null> {
  try {
    const res = await fetch("/api/system-status", {
      signal,
      cache: "no-store",
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (json?.schema_version === 1) return json as SystemStatusPayload;
    return null;
  } catch {
    // AbortError or network error — return null, do not clear auth tokens
    return null;
  }
}

/**
 * Full polling implementation. Only mounted when the feature is enabled.
 * All hooks live here to avoid conditional-hook violations in the outer provider.
 */
function EnabledSystemAvailabilityProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [status, setStatus] = useState<SystemStatusPayload | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusSource, setStatusSource] = useState<StatusSource>("none");
  const [browserOnline, setBrowserOnline] = useState(
    typeof navigator !== "undefined" ? navigator.onLine : true,
  );

  const consecutiveErrorsRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFirstRef = useRef(true);

  const scheduleTransitionRefresh = useCallback(
    (result: SystemStatusPayload) => {
      if (transitionTimerRef.current) clearTimeout(transitionTimerRef.current);

      const serverNow = new Date(result.server_now).getTime();
      const clientNow = Date.now();
      const serverOffset = serverNow - clientNow; // server clock offset

      // Schedule refresh at maintenance start or end if timestamps are available
      const candidates: number[] = [];
      if (result.starts_at) {
        const msUntilStart =
          new Date(result.starts_at).getTime() - clientNow - serverOffset;
        if (msUntilStart > 0 && msUntilStart < 24 * 60 * 60 * 1000) {
          candidates.push(msUntilStart + 2_000); // 2s after scheduled start
        }
      }
      if (result.ends_at) {
        const msUntilEnd =
          new Date(result.ends_at).getTime() - clientNow - serverOffset;
        if (msUntilEnd > 0 && msUntilEnd < 24 * 60 * 60 * 1000) {
          candidates.push(msUntilEnd + 2_000);
        }
      }
      if (result.next_window?.announce_from) {
        const msUntilAnnounce =
          new Date(result.next_window.announce_from).getTime() - clientNow - serverOffset;
        if (msUntilAnnounce > 0 && msUntilAnnounce < 24 * 60 * 60 * 1000) {
          candidates.push(msUntilAnnounce + 2_000);
        }
      }

      if (candidates.length > 0) {
        const earliest = Math.min(...candidates);
        transitionTimerRef.current = setTimeout(() => {
          if (timerRef.current) clearTimeout(timerRef.current);
          void doPoll(false);
        }, earliest);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const doPoll = useCallback(async (first: boolean) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    // If browser is offline, skip the fetch and preserve last state
    if (!navigator.onLine) {
      clearTimeout(timeoutId);
      if (first) {
        setInitializing(false);
        isFirstRef.current = false;
      }
      setError("Browser is offline");
      // Don't change status — preserve last known state
      const interval = POLL_INTERVAL_NORMAL_MS;
      timerRef.current = setTimeout(() => void doPoll(false), interval);
      return;
    }

    const result = await fetchStatus(controller.signal);
    clearTimeout(timeoutId);

    if (controller.signal.aborted) return;

    if (result) {
      consecutiveErrorsRef.current = 0;
      setStatus(result);
      setLastCheckedAt(new Date().toISOString());
      setError(null);
      setStatusSource("live");
      scheduleTransitionRefresh(result);
    } else {
      consecutiveErrorsRef.current += 1;
      // Preserve last valid status — do NOT clear it on network error
      setStatusSource((prev) => (prev === "live" ? "cached" : prev));
      if (consecutiveErrorsRef.current > MAX_CONSECUTIVE_ERRORS) {
        setError("System status endpoint unavailable");
      }
    }

    if (first) {
      setInitializing(false);
      isFirstRef.current = false;
    }

    const isBlocking = result?.blocking ?? false;
    const interval = isBlocking ? POLL_INTERVAL_BLOCKING_MS : POLL_INTERVAL_NORMAL_MS;

    const backoff = Math.min(
      interval *
        Math.pow(1.5, Math.max(0, consecutiveErrorsRef.current - MAX_CONSECUTIVE_ERRORS)),
      300_000,
    );
    const delay = consecutiveErrorsRef.current > MAX_CONSECUTIVE_ERRORS ? backoff : interval;

    timerRef.current = setTimeout(() => void doPoll(false), delay);
  }, [scheduleTransitionRefresh]);

  const refreshStatus = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    void doPoll(false);
  }, [doPoll]);

  useEffect(() => {
    void doPoll(true);
    return () => {
      abortRef.current?.abort();
      if (timerRef.current) clearTimeout(timerRef.current);
      if (transitionTimerRef.current) clearTimeout(transitionTimerRef.current);
    };
  }, [doPoll]);

  // Visibility refresh — re-poll when tab becomes visible
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        if (timerRef.current) clearTimeout(timerRef.current);
        void doPoll(false);
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [doPoll]);

  // Focus refresh
  useEffect(() => {
    const handleFocus = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      void doPoll(false);
    };
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [doPoll]);

  // Online/offline listeners — distinguish browser-offline from server outage
  useEffect(() => {
    const handleOnline = () => {
      setBrowserOnline(true);
      setError(null);
      if (timerRef.current) clearTimeout(timerRef.current);
      void doPoll(false);
    };
    const handleOffline = () => {
      setBrowserOnline(false);
      setError("Browser is offline");
      setStatusSource((prev) => (prev === "live" ? "cached" : prev));
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [doPoll]);

  const value: SystemAvailabilityContextValue = {
    state: (status?.state ?? "unknown") as SystemState,
    blocking: status?.blocking ?? false,
    status,
    initializing,
    lastCheckedAt,
    error,
    browserOnline,
    statusSource,
    refreshStatus,
  };

  return (
    <SystemAvailabilityContext.Provider value={value}>
      {children}
    </SystemAvailabilityContext.Provider>
  );
}

/**
 * Public provider. When the feature is disabled this renders children under
 * the stable DISABLED_VALUE with zero side-effects. When enabled it delegates
 * to EnabledSystemAvailabilityProvider which contains all polling hooks.
 */
export function SystemAvailabilityProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  if (!SYSTEM_STATUS_CONTROL_ENABLED) {
    return (
      <SystemAvailabilityContext.Provider value={DISABLED_VALUE}>
        {children}
      </SystemAvailabilityContext.Provider>
    );
  }

  return (
    <EnabledSystemAvailabilityProvider>
      {children}
    </EnabledSystemAvailabilityProvider>
  );
}
