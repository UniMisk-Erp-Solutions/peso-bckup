/**
 * UserActivityTracker
 *
 * Runs silently in the authenticated app shell. Tracks only visible
 * PesoWise app time — no keystrokes, no screenshots, no off-app browsing.
 *
 * Tab-leader election via localStorage prevents double-counting when the
 * same user has multiple tabs open.
 *
 * Lifecycle:
 *   1. On mount  → try to claim tab leadership
 *   2. If leader  → call start_user_activity_session RPC
 *   3. Every 60 s while tab visible → call record_user_activity_heartbeat
 *   4. On visibility hidden → send one final heartbeat for elapsed seconds
 *   5. On pagehide/beforeunload → best-effort end_user_activity_session
 *   6. On signOut or feature-flag disable → stop quietly
 *
 * Follower tabs poll every 30 s for a stale leader and take over if found.
 * Only the leader sends heartbeats.
 *
 * RPC failures are console.warn only — never break the app.
 */

import { useEffect, useRef } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { ORGANIZATION_FEATURE_KEYS } from "@/lib/organizationFeatureKeys";

// Leader-election constants
const LEADER_KEY         = "pesowise-user-activity-leader";
const LEADER_TTL_MS      = 90_000; // 90 s — if leader hasn't refreshed, take over
const HEARTBEAT_MS       = 60_000; // 60 s between heartbeats
const FOLLOWER_CHECK_MS  = 30_000; // 30 s poll interval for follower tabs

interface LeaderRecord {
  tabId:  string;
  userId: string;
  ts:     number; // Date.now()
}

function makeTabId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function readLeader(): LeaderRecord | null {
  try {
    const raw = localStorage.getItem(LEADER_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as LeaderRecord;
  } catch {
    return null;
  }
}

function writeLeader(record: LeaderRecord): void {
  try {
    localStorage.setItem(LEADER_KEY, JSON.stringify(record));
  } catch {
    // Storage quota or privacy mode — ignore
  }
}

function clearLeader(tabId: string): void {
  try {
    const current = readLeader();
    if (current?.tabId === tabId) {
      localStorage.removeItem(LEADER_KEY);
    }
  } catch {
    // ignore
  }
}

function tryClaimLeadership(tabId: string, userId: string): boolean {
  const existing = readLeader();
  const now = Date.now();

  // Claim if: no leader, stale leader, different user, or WE are already the leader
  if (
    !existing ||
    existing.userId !== userId ||
    now - existing.ts > LEADER_TTL_MS
  ) {
    writeLeader({ tabId, userId, ts: now });
    // Re-read to confirm we won (best-effort race guard)
    const confirmed = readLeader();
    return confirmed?.tabId === tabId;
  }

  return existing.tabId === tabId;
}

function refreshLeaderTimestamp(tabId: string, userId: string): void {
  const current = readLeader();
  if (current?.tabId === tabId) {
    writeLeader({ tabId, userId, ts: Date.now() });
  }
}

function isLeaderStale(): boolean {
  const existing = readLeader();
  if (!existing) return true;
  return Date.now() - existing.ts > LEADER_TTL_MS;
}

// ─────────────────────────────────────────────────────────────────────────────

export function UserActivityTracker({
  noticeAcknowledged = false,
}: {
  noticeAcknowledged?: boolean;
}) {
  const { user, organizationId, userRole, hasOrganizationFeature } = useAuth();

  // Extract userId as a stable primitive so the effect restarts cleanly when
  // the authenticated user changes (e.g. admin impersonating another session).
  const userId = user?.id ?? null;

  const tabIdRef       = useRef<string>(makeTabId());
  const sessionIdRef   = useRef<string | null>(null);
  const isLeaderRef    = useRef<boolean>(false);
  const visibleSecRef  = useRef<number>(0);    // seconds visible since last heartbeat
  const lastTickRef    = useRef<number | null>(null); // timestamp when tab became visible
  const intervalRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const followerRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef     = useRef<boolean>(false);

  const featureEnabled = hasOrganizationFeature(ORGANIZATION_FEATURE_KEYS.user_activity_insights);

  // Tracker must not start until the user has acknowledged the activity notice.
  // noticeAcknowledged is supplied by UserActivityNoticeGate in the app shell.
  const shouldRun =
    !!userId &&
    !!organizationId &&
    userRole !== "master_admin" &&
    featureEnabled &&
    noticeAcknowledged;

  useEffect(() => {
    if (!shouldRun || !userId) return;

    // Reset mountedRef at the start of every active effect so that
    // if the effect restarts (feature flag toggled → re-enabled, userId changed),
    // the session id assignment inside startAsLeader() works correctly.
    mountedRef.current = true;

    const tabId = tabIdRef.current;

    // ── Helpers ───────────────────────────────────────────────────────────────

    const sendHeartbeat = async () => {
      if (!sessionIdRef.current || !mountedRef.current) return;
      if (!isLeaderRef.current) return;

      // Re-confirm leadership on every heartbeat (another tab may have taken over)
      if (!tryClaimLeadership(tabId, userId)) {
        // Lost leadership — stop as leader, become follower
        void stopAsLeader();
        startFollowerPolling();
        return;
      }
      refreshLeaderTimestamp(tabId, userId);

      // Flush visible time accumulated since last tick
      if (lastTickRef.current !== null) {
        visibleSecRef.current += Math.round((Date.now() - lastTickRef.current) / 1000);
        lastTickRef.current = Date.now(); // reset for next interval
      }

      const seconds = visibleSecRef.current;
      visibleSecRef.current = 0;

      if (seconds <= 0) return; // nothing to report

      try {
        const { error } = await supabase.rpc("record_user_activity_heartbeat", {
          p_session_id:      sessionIdRef.current,
          p_visible_seconds: seconds,
        });
        if (error) {
          console.warn("[UserActivityTracker] heartbeat failed:", error.message);
        }
      } catch (e) {
        console.warn("[UserActivityTracker] heartbeat error:", e);
      }
    };

    const startAsLeader = async () => {
      if (isLeaderRef.current) return; // already leader
      isLeaderRef.current = true;

      // Start visible-time accumulation
      if (document.visibilityState === "visible") {
        lastTickRef.current = Date.now();
      }

      // Start session RPC
      try {
        const { data, error } = await supabase.rpc("start_user_activity_session", {
          p_user_agent: navigator.userAgent,
        });
        if (error) {
          console.warn("[UserActivityTracker] start_user_activity_session failed:", error.message);
          return;
        }
        if (mountedRef.current) {
          sessionIdRef.current = data as string | null;
        }
      } catch (e) {
        console.warn("[UserActivityTracker] start failed:", e);
      }

      // Start heartbeat interval
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = setInterval(() => {
        if (document.visibilityState === "visible") {
          void sendHeartbeat();
        }
      }, HEARTBEAT_MS);
    };

    const stopAsLeader = async () => {
      if (!isLeaderRef.current) return;
      isLeaderRef.current = false;

      // Stop heartbeat interval
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }

      const sid = sessionIdRef.current;
      sessionIdRef.current = null;
      visibleSecRef.current = 0;
      lastTickRef.current = null;

      // Always release the leader key even when start returned null
      clearLeader(tabId);
      if (sid) {
        void supabase.rpc("end_user_activity_session", { p_session_id: sid }).then(() => {}, () => {});
      }
    };

    const startFollowerPolling = () => {
      // Only one follower interval at a time
      if (followerRef.current) return;

      followerRef.current = setInterval(async () => {
        if (!mountedRef.current) return;
        if (isLeaderRef.current) return; // already leader, stop polling

        if (isLeaderStale() && tryClaimLeadership(tabId, userId)) {
          // Won the election — become leader
          if (followerRef.current) {
            clearInterval(followerRef.current);
            followerRef.current = null;
          }
          await startAsLeader();
        }
      }, FOLLOWER_CHECK_MS);
    };

    // ── Initial leadership attempt ─────────────────────────────────────────

    if (tryClaimLeadership(tabId, userId)) {
      void startAsLeader();
    } else {
      // Not the leader — start follower polling for stale-leader takeover
      startFollowerPolling();
    }

    // ── Visibility change handler ──────────────────────────────────────────

    const handleVisibilityChange = () => {
      if (!isLeaderRef.current) return; // only leader tracks visible time
      if (document.visibilityState === "visible") {
        lastTickRef.current = Date.now();
      } else {
        // Tab hidden — flush accumulated seconds immediately
        if (lastTickRef.current !== null) {
          visibleSecRef.current += Math.round((Date.now() - lastTickRef.current) / 1000);
          lastTickRef.current = null;
        }
        if (visibleSecRef.current > 0 && sessionIdRef.current) {
          void sendHeartbeat();
        }
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    // ── End session on unload ──────────────────────────────────────────────

    const endSessionOnUnload = () => {
      if (!sessionIdRef.current) return;
      const sid = sessionIdRef.current;
      sessionIdRef.current = null;
      clearLeader(tabId);
      // Best-effort fire-and-forget RPC on unload
      void supabase.rpc("end_user_activity_session", { p_session_id: sid }).then(() => {}, () => {});
    };

    window.addEventListener("pagehide",     endSessionOnUnload);
    window.addEventListener("beforeunload", endSessionOnUnload);

    // ── Cleanup ────────────────────────────────────────────────────────────
    return () => {
      mountedRef.current = false;

      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide",     endSessionOnUnload);
      window.removeEventListener("beforeunload", endSessionOnUnload);

      // Stop heartbeat and follower intervals
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (followerRef.current) {
        clearInterval(followerRef.current);
        followerRef.current = null;
      }

      // End session if we were leader
      isLeaderRef.current = false;
      const sid = sessionIdRef.current;
      sessionIdRef.current = null;
      visibleSecRef.current = 0;
      lastTickRef.current = null;

      // Always release our own leader key, even if start_user_activity_session
      // returned null (feature disabled server-side or RPC error).
      clearLeader(tabId);
      if (sid) {
        void supabase
          .rpc("end_user_activity_session", { p_session_id: sid })
          .then(() => {}, () => {});
      }
    };
    // userId is included so the effect restarts cleanly on user change.
    // Other shouldRun dependencies (orgId, role, featureEnabled) are captured
    // through the shouldRun boolean which is included directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldRun, userId]);

  // Renders nothing — purely a side-effect component
  return null;
}
