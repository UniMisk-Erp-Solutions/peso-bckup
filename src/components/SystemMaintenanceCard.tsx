/**
 * SystemMaintenanceCard — Master Admin control panel for system maintenance.
 *
 * Uses GET /api/master/maintenance (authenticated, full document + diagnostics).
 * Writes via POST /api/master/maintenance and updates UI immediately from
 * the returned document — does not wait for Edge Config propagation.
 *
 * Controls (Immediate Maintenance, Scheduled Breaks) are always visible.
 * They are disabled during loading, configuration errors, or auth failures.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useSystemAvailability } from "@/contexts/SystemAvailabilityContext";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertTriangle,
  CheckCircle,
  Power,
  PowerOff,
  Plus,
  X,
  Wrench,
  Loader2,
  RefreshCw,
  Settings,
  ShieldX,
  Calendar,
} from "lucide-react";
import type { SystemStatusPayload } from "@/lib/systemAvailability";
import type { SystemStatusDocument, MaintenanceWindow } from "../../api/_lib/systemStatusTypes";
import {
  MaintenanceScheduleDialog,
  type ScheduleDialogWritePayload,
} from "@/components/maintenance/MaintenanceScheduleDialog";
import { formatMaintenanceLocalDateTime, getBrowserTimezone } from "@/lib/maintenanceDateTime";

// ── Types ──────────────────────────────────────────────────────────────────

type StoreDiagnostics = {
  provider: "edge_config" | "memory" | "unavailable";
  readable: boolean;
  writable: boolean;
  configurationState:
    | "ready"
    | "missing_read_configuration"
    | "missing_write_configuration"
    | "package_unavailable"
    | "invalid_connection"
    | "read_failed";
  missingVariables?: string[];
};

type AdminLoadOk = {
  ok: true;
  status: SystemStatusPayload;
  document: SystemStatusDocument;
  diagnostics: StoreDiagnostics;
};

type AdminLoadErr = {
  ok: false;
  kind:
    | "endpoint_unavailable"
    | "not_authorized"
    | "configuration_required"
    | "invalid_response"
    | "network_error";
  message: string;
  httpStatus?: number;
  requestId?: string;
  missingVariables?: string[];
};

type MaintenanceAdminLoadResult = AdminLoadOk | AdminLoadErr;

type MaintenanceWritePayload =
  | { action: "start_manual"; revision: string; title: string; message: string; estimated_end_at: string | null }
  | { action: "end_manual"; revision: string }
  | { action: "create_window"; revision: string; title: string; message: string; starts_at: string; ends_at: string; announce_from: string }
  | { action: "cancel_window"; revision: string; window_id: string };

type WriteResult =
  | { ok: true; revision: string; document: SystemStatusDocument; status: SystemStatusPayload }
  | { ok: false; error: string; conflict?: boolean; requestId?: string };

// ── Helpers ────────────────────────────────────────────────────────────────

async function getBearerToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

async function fetchAdminStatus(token: string): Promise<MaintenanceAdminLoadResult> {
  try {
    const res = await fetch("/api/master/maintenance", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    let json: Record<string, unknown>;
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      return {
        ok: false,
        kind: "invalid_response",
        message: `Server returned non-JSON (HTTP ${res.status})`,
        httpStatus: res.status,
      };
    }

    const requestId = typeof json.request_id === "string" ? json.request_id : undefined;

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        kind: "not_authorized",
        message: typeof json.error === "string" ? json.error : "Not authorized",
        httpStatus: res.status,
        requestId,
      };
    }

    if (res.status === 503 && json.code === "maintenance_store_not_configured") {
      const missing = Array.isArray(json.missingVariables)
        ? (json.missingVariables as string[])
        : [];
      return {
        ok: false,
        kind: "configuration_required",
        message: "Maintenance store is not configured for this environment.",
        httpStatus: 503,
        requestId,
        missingVariables: missing,
      };
    }

    if (res.status === 503 && json.code === "server_configuration_missing") {
      const missing = Array.isArray(json.missingVariables)
        ? (json.missingVariables as string[])
        : ["SUPABASE_ANON_KEY"];
      return {
        ok: false,
        kind: "configuration_required",
        message: "Supabase server credentials are not configured for this environment.",
        httpStatus: 503,
        requestId,
        missingVariables: missing,
      };
    }

    if (!res.ok) {
      return {
        ok: false,
        kind: "endpoint_unavailable",
        message:
          typeof json.error === "string"
            ? json.error
            : `Server error (HTTP ${res.status})`,
        httpStatus: res.status,
        requestId,
      };
    }

    // Validate shape
    if (!json.ok || !json.document || !json.public_status || !json.store) {
      return {
        ok: false,
        kind: "invalid_response",
        message: "Unexpected response shape from maintenance endpoint.",
        httpStatus: res.status,
        requestId,
      };
    }

    return {
      ok: true,
      status: json.public_status as SystemStatusPayload,
      document: json.document as SystemStatusDocument,
      diagnostics: json.store as StoreDiagnostics,
    };
  } catch (err) {
    return {
      ok: false,
      kind: "network_error",
      message: err instanceof Error ? err.message : "Network error",
    };
  }
}

async function writeMaintenanceAction(
  payload: MaintenanceWritePayload,
  token: string,
): Promise<WriteResult> {
  try {
    const res = await fetch("/api/master/maintenance", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    let json: Record<string, unknown>;
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      return { ok: false, error: `Server returned non-JSON (HTTP ${res.status})` };
    }
    const requestId = typeof json.request_id === "string" ? json.request_id : undefined;
    if (res.status === 409) {
      return { ok: false, error: typeof json.error === "string" ? json.error : "Conflict", conflict: true, requestId };
    }
    if (!res.ok) {
      return { ok: false, error: typeof json.error === "string" ? json.error : `HTTP ${res.status}`, requestId };
    }
    if (!json.ok || !json.document || !json.public_status) {
      return { ok: false, error: "Unexpected write response shape", requestId };
    }
    return {
      ok: true,
      revision: typeof json.revision === "string" ? json.revision : (json.document as SystemStatusDocument).revision,
      document: json.document as SystemStatusDocument,
      status: json.public_status as SystemStatusPayload,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}

// ── Sub-components ─────────────────────────────────────────────────────────

function StateIndicator({ state }: { state: string }) {
  if (state === "operational") {
    return (
      <Badge className="gap-1 bg-green-100 text-green-800 border-green-200 hover:bg-green-100">
        <CheckCircle className="h-3 w-3" />
        Operational
      </Badge>
    );
  }
  if (state === "maintenance") {
    return (
      <Badge className="gap-1 bg-amber-100 text-amber-800 border-amber-200 hover:bg-amber-100">
        <Wrench className="h-3 w-3" />
        Maintenance
      </Badge>
    );
  }
  if (state === "outage") {
    return (
      <Badge variant="destructive" className="gap-1">
        <AlertTriangle className="h-3 w-3" />
        Outage
      </Badge>
    );
  }
  if (state === "degraded") {
    return (
      <Badge className="gap-1 bg-orange-100 text-orange-800 border-orange-200 hover:bg-orange-100">
        <AlertTriangle className="h-3 w-3" />
        Degraded
      </Badge>
    );
  }
  if (state === "upcoming") {
    return (
      <Badge className="gap-1 bg-blue-100 text-blue-800 border-blue-200 hover:bg-blue-100">
        <Wrench className="h-3 w-3" />
        Upcoming
      </Badge>
    );
  }
  return <Badge variant="secondary">{state}</Badge>;
}

// ── Main component ─────────────────────────────────────────────────────────

const BG_POLL_INTERVAL_MS = 15_000;

export function SystemMaintenanceCard() {
  const { userRole } = useAuth();
  const { toast } = useToast();
  const { refreshStatus } = useSystemAvailability();

  const [loadResult, setLoadResult] = useState<MaintenanceAdminLoadResult | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [backgroundRefreshing, setBackgroundRefreshing] = useState(false);
  const [working, setWorking] = useState(false);

  const bgPollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bgRefreshInFlightRef = useRef(false);

  // Start manual maintenance form
  const [startTitle, setStartTitle] = useState("Scheduled Maintenance");
  const [startMessage, setStartMessage] = useState(
    "PesoWise is undergoing maintenance. We'll be back shortly.",
  );
  const [startEta, setStartEta] = useState("");

  // Schedule break dialog
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleWorking, setScheduleWorking] = useState(false);

  // Confirm end dialog
  const [confirmEndOpen, setConfirmEndOpen] = useState(false);

  // Keep token ref to avoid re-fetching across multiple calls in a sequence
  const tokenRef = useRef<string | null>(null);

  const getToken = useCallback(async (): Promise<string | null> => {
    if (tokenRef.current) return tokenRef.current;
    const t = await getBearerToken();
    tokenRef.current = t;
    // Clear after 30s so we refresh stale tokens
    const timer = setTimeout(() => { tokenRef.current = null; }, 30_000);
    // Ensure timer is cleaned up on unmount (captured in closure)
    return t;
  }, []);

  const doLoad = useCallback(async (background = false) => {
    if (background) {
      if (bgRefreshInFlightRef.current) return; // prevent overlapping
      bgRefreshInFlightRef.current = true;
      setBackgroundRefreshing(true);
    } else {
      setInitialLoading(true);
    }

    const token = await getToken();
    if (!token) {
      if (!background) {
        setLoadResult({
          ok: false,
          kind: "not_authorized",
          message: "No active session. Please sign in again.",
        });
        setInitialLoading(false);
      }
      if (background) {
        bgRefreshInFlightRef.current = false;
        setBackgroundRefreshing(false);
      }
      return;
    }

    const result = await fetchAdminStatus(token);

    if (background) {
      // Only update state when background refresh returns a valid result;
      // keep existing optimistic state when it returns an error.
      if (result.ok) setLoadResult(result);
      bgRefreshInFlightRef.current = false;
      setBackgroundRefreshing(false);
    } else {
      setLoadResult(result);
      setInitialLoading(false);
    }
  }, [getToken]);

  // ── Schedule next transition refresh ────────────────────────────────────

  const scheduleTransitionRefresh = useCallback(
    (doc: MaintenanceAdminLoadResult | null) => {
      if (transitionTimerRef.current) clearTimeout(transitionTimerRef.current);
      if (!doc?.ok) return;

      const now = Date.now();
      const candidates: number[] = [];
      for (const w of doc.document.windows) {
        if (w.status !== "scheduled") continue;
        const ann = new Date(w.announce_from).getTime() - now;
        const start = new Date(w.starts_at).getTime() - now;
        const end = new Date(w.ends_at).getTime() - now;
        [ann, start, end].forEach((ms) => {
          if (ms > 0 && ms < 24 * 60 * 60 * 1000) candidates.push(ms + 250);
        });
      }
      if (candidates.length === 0) return;
      const earliest = Math.min(...candidates);
      transitionTimerRef.current = setTimeout(() => {
        void doLoad(true);
      }, earliest);
    },
    [doLoad],
  );

  // ── Background polling ─────────────────────────────────────────────────

  const scheduleBgPoll = useCallback(() => {
    if (bgPollTimerRef.current) clearTimeout(bgPollTimerRef.current);
    bgPollTimerRef.current = setTimeout(() => {
      if (document.visibilityState !== "hidden") {
        void doLoad(true);
      }
      scheduleBgPoll();
    }, BG_POLL_INTERVAL_MS);
  }, [doLoad]);

  useEffect(() => {
    if (userRole !== "master_admin") return;

    void doLoad(false);
    scheduleBgPoll();

    const handleVisibility = () => {
      if (document.visibilityState === "visible") void doLoad(true);
    };
    const handleFocus = () => void doLoad(true);
    const handleOnline = () => void doLoad(true);

    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("focus", handleFocus);
    window.addEventListener("online", handleOnline);

    return () => {
      if (bgPollTimerRef.current) clearTimeout(bgPollTimerRef.current);
      if (transitionTimerRef.current) clearTimeout(transitionTimerRef.current);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("online", handleOnline);
    };
  }, [userRole, doLoad, scheduleBgPoll]);

  // Re-schedule transition refresh whenever loadResult changes
  useEffect(() => {
    scheduleTransitionRefresh(loadResult);
  }, [loadResult, scheduleTransitionRefresh]);

  if (userRole !== "master_admin") return null;

  const readyData = loadResult?.ok === true ? loadResult : null;
  const errData = loadResult?.ok === false ? loadResult : null;
  const status = readyData?.status ?? null;
  const currentDocument = readyData?.document ?? null;
  const currentRevision = currentDocument?.revision ?? "init";
  const isManualActive =
    status?.source === "manual" && status?.state === "maintenance";

  // Controls are disabled while initial loading, working, not authorized, or store not configured
  const configMissing = errData?.kind === "configuration_required";
  const notAuthorized = errData?.kind === "not_authorized";
  const controlsDisabled = initialLoading || working || notAuthorized || configMissing;

  // ── Apply immediate update from write response ─────────────────────────

  function applyWriteResult(wr: WriteResult & { ok: true }) {
    setLoadResult({
      ok: true,
      status: wr.status,
      document: wr.document,
      diagnostics: (readyData?.diagnostics ?? {
        provider: "edge_config",
        readable: true,
        writable: true,
        configurationState: "ready",
      }) as StoreDiagnostics,
    });
  }

  // ── Revision-aware delayed reconciliation ─────────────────────────────

  function reconcileAfterWrite(
    expectedRevision: string,
    expectedWindowId: string | null,
    attempt = 0,
  ) {
    const MAX_ATTEMPTS = 3;
    const delays = [750, 1500, 3000];
    if (attempt >= MAX_ATTEMPTS) return;

    setTimeout(async () => {
      const token = await getToken();
      if (!token) return;
      const result = await fetchAdminStatus(token);
      if (!result.ok) return;

      const returnedRevision = result.document.revision;
      const hasExpectedWindow =
        expectedWindowId == null ||
        result.document.windows.some((w) => w.id === expectedWindowId);

      if (returnedRevision === expectedRevision || hasExpectedWindow) {
        // Confirmed — safe to accept
        setLoadResult(result);
      } else {
        // Stale — keep optimistic state and retry
        if (process.env.NODE_ENV === "development") {
          // eslint-disable-next-line no-console
          console.debug(
            `[maintenance] reconcile attempt ${attempt + 1}: got revision ${returnedRevision}, expected ${expectedRevision} — retrying`,
          );
        }
        reconcileAfterWrite(expectedRevision, expectedWindowId, attempt + 1);
      }
    }, delays[attempt]);
  }

  // ── Write action handler ────────────────────────────────────────────────

  async function handleAction(payload: Omit<MaintenanceWritePayload, "revision">) {
    setWorking(true);
    const token = await getToken();
    if (!token) {
      toast({ title: "Auth error", description: "Could not get session token.", variant: "destructive" });
      setWorking(false);
      return;
    }

    const result = await writeMaintenanceAction(
      { ...payload, revision: currentRevision } as MaintenanceWritePayload,
      token,
    );

    if (!result.ok) {
      if (result.conflict) {
        toast({
          title: "Revision conflict",
          description: "Status was updated elsewhere. Refreshing…",
          variant: "destructive",
        });
        await doLoad(false);
      } else {
        toast({
          title: "Error",
          description: result.error + (result.requestId ? ` (${result.requestId})` : ""),
          variant: "destructive",
        });
      }
    } else {
      toast({ title: "Done", description: "System status updated." });
      applyWriteResult(result);
      refreshStatus(); // update global banner immediately
      reconcileAfterWrite(result.revision, null);
    }
    setWorking(false);
  }

  // ── Schedule window write handler (used by MaintenanceScheduleDialog) ─────

  async function handleScheduleWindow(payload: ScheduleDialogWritePayload) {
    setScheduleWorking(true);
    try {
      const token = await getToken();
      if (!token) throw Object.assign(new Error("No session token — please sign in again."), {});

      const result = await writeMaintenanceAction(
        { ...payload, revision: currentRevision } as MaintenanceWritePayload,
        token,
      );

      if (!result.ok) {
        const err = new Error(result.error);
        throw Object.assign(err, { requestId: result.requestId, conflict: result.conflict });
      }

      // Apply optimistic state BEFORE closing the dialog
      applyWriteResult(result);
      setScheduleOpen(false); // close only after state applied
      toast({ title: "Done", description: "Maintenance break scheduled." });
      refreshStatus(); // update global banner immediately

      // Capture the new window's ID for reconciliation
      const newWindowId =
        result.document.windows.find(
          (w) => !currentDocument?.windows.some((existing) => existing.id === w.id),
        )?.id ?? null;

      reconcileAfterWrite(result.revision, newWindowId);
    } finally {
      setScheduleWorking(false);
    }
  }

  // ── Date validation helpers ─────────────────────────────────────────────

  function validateStartAction(): string | null {
    if (!startTitle.trim()) return "Title is required.";
    if (!startMessage.trim()) return "Message is required.";
    if (startEta) {
      const eta = new Date(startEta);
      if (isNaN(eta.getTime())) return "Estimated end time is not a valid date.";
      if (eta.getTime() <= Date.now()) return "Estimated end time must be in the future.";
    }
    return null;
  }

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Wrench className="h-4 w-4 text-muted-foreground" />
                System Maintenance
              </CardTitle>
              <CardDescription>
                Control immediate and scheduled maintenance breaks. Supabase outages do not automatically activate maintenance.
              </CardDescription>
            </div>
            {status && <StateIndicator state={status.state} />}
          </div>
        </CardHeader>

        <CardContent className="space-y-5">

          {/* ── LOADING ──────────────────────────────────────────────── */}
          {initialLoading && (
            <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Loading maintenance configuration…</span>
            </div>
          )}

          {/* ── NOT AUTHORIZED ───────────────────────────────────────── */}
          {!initialLoading && errData?.kind === "not_authorized" && (
            <Alert variant="destructive">
              <ShieldX className="h-4 w-4" />
              <AlertTitle>Not authorized</AlertTitle>
              <AlertDescription>
                {errData.message}
              </AlertDescription>
            </Alert>
          )}

          {/* ── CONFIGURATION REQUIRED ───────────────────────────────── */}
          {!initialLoading && errData?.kind === "configuration_required" && (
            <Alert className="border-amber-200 bg-amber-50 dark:bg-amber-950/20">
              <Settings className="h-4 w-4 text-amber-600" />
              <AlertTitle className="text-amber-800 dark:text-amber-400">
                Maintenance control not configured
              </AlertTitle>
              <AlertDescription className="text-amber-700 dark:text-amber-300 space-y-2 mt-1">
                <p>
                  This environment is missing the required Vercel environment variables.
                  Configure them in the Vercel project settings, then redeploy.
                </p>
                {(errData.missingVariables ?? []).length > 0 && (
                  <ul className="list-disc list-inside space-y-0.5 text-xs font-mono">
                    {(errData.missingVariables ?? []).map((v) => (
                      <li key={v}>{v}</li>
                    ))}
                  </ul>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void doLoad(false)}
                  disabled={initialLoading}
                  className="mt-2 gap-2"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          )}

          {/* ── OTHER ENDPOINT ERRORS ─────────────────────────────────── */}
          {!initialLoading && errData &&
            errData.kind !== "not_authorized" &&
            errData.kind !== "configuration_required" && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Status could not be loaded</AlertTitle>
              <AlertDescription className="space-y-2 mt-1">
                <p>{errData.message}</p>
                <div className="text-xs text-muted-foreground space-y-0.5">
                  {errData.httpStatus != null && <p>HTTP {errData.httpStatus}</p>}
                  {errData.requestId && <p>Request ID: {errData.requestId}</p>}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void doLoad(false)}
                  disabled={initialLoading}
                  className="mt-2 gap-2"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          )}

          {/* ── CURRENT STATUS SUMMARY (only when data available) ──────── */}
          {readyData && status && (
            <div className="rounded-md border bg-muted/30 p-3 text-sm space-y-1">
              <div className="flex gap-2">
                <span className="text-muted-foreground w-24 shrink-0">State:</span>
                <span className="font-medium capitalize">{status.state}</span>
              </div>
              <div className="flex gap-2">
                <span className="text-muted-foreground w-24 shrink-0">Source:</span>
                <span>{status.source}</span>
              </div>
              {status.title && (
                <div className="flex gap-2">
                  <span className="text-muted-foreground w-24 shrink-0">Title:</span>
                  <span>{status.title}</span>
                </div>
              )}
              {status.estimated_end_at && (
                <div className="flex gap-2">
                  <span className="text-muted-foreground w-24 shrink-0">Est. end:</span>
                  <span>{new Date(status.estimated_end_at).toLocaleString()}</span>
                </div>
              )}
              <div className="flex gap-2">
                <span className="text-muted-foreground w-24 shrink-0">Backend:</span>
                <span
                  className={
                    status.backend_health.status === "healthy"
                      ? "text-green-700 dark:text-green-400"
                      : "text-amber-700 dark:text-amber-400"
                  }
                >
                  {status.backend_health.status}
                </span>
              </div>
              {readyData.diagnostics.provider !== "edge_config" && (
                <div className="flex gap-2">
                  <span className="text-muted-foreground w-24 shrink-0">Store:</span>
                  <span className="text-amber-700 dark:text-amber-400 capitalize">
                    {readyData.diagnostics.provider} ({readyData.diagnostics.configurationState})
                  </span>
                </div>
              )}
            </div>
          )}

          <Separator />

          {/* ── SECTION A: IMMEDIATE MAINTENANCE — always visible ──────── */}
          <div className="space-y-3">
            {/* Show end-maintenance when active, otherwise show start form */}
            {isManualActive ? (
              <div className="space-y-3">
                <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
                  Manual maintenance is currently active. All non-Master-Admin users are blocked.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2 border-green-600 text-green-700 hover:bg-green-50"
                  disabled={controlsDisabled}
                  onClick={() => setConfirmEndOpen(true)}
                >
                  <PowerOff className="h-4 w-4" />
                  End Maintenance
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm font-semibold">Start immediate maintenance</p>
                <div className="space-y-2">
                  <Label htmlFor="maint-title" className="text-xs">Title</Label>
                  <Input
                    id="maint-title"
                    value={startTitle}
                    onChange={(e) => setStartTitle(e.target.value)}
                    maxLength={200}
                    disabled={controlsDisabled}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="maint-msg" className="text-xs">Message (shown to users)</Label>
                  <Textarea
                    id="maint-msg"
                    value={startMessage}
                    onChange={(e) => setStartMessage(e.target.value)}
                    rows={2}
                    maxLength={2000}
                    disabled={controlsDisabled}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="maint-eta" className="text-xs">
                    Estimated end time — optional, {getBrowserTimezone()}
                  </Label>
                  <Input
                    id="maint-eta"
                    type="datetime-local"
                    value={startEta}
                    onChange={(e) => setStartEta(e.target.value)}
                    disabled={controlsDisabled}
                  />
                  <p className="text-xs text-muted-foreground">
                    Entered in your local timezone ({getBrowserTimezone()}); sent as UTC.
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="destructive"
                  className="gap-2"
                  disabled={controlsDisabled || !startTitle.trim() || !startMessage.trim()}
                  onClick={() => {
                    const err = validateStartAction();
                    if (err) {
                      toast({ title: "Validation error", description: err, variant: "destructive" });
                      return;
                    }
                    const etaUtc = startEta ? new Date(startEta).toISOString() : null;
                    void handleAction({
                      action: "start_manual",
                      title: startTitle.trim(),
                      message: startMessage.trim(),
                      estimated_end_at: etaUtc,
                    });
                  }}
                >
                  <Power className="h-4 w-4" />
                  {working ? "Starting…" : "Start Maintenance Now"}
                </Button>
              </div>
            )}
          </div>

          <Separator />

          {/* ── SECTION B: SCHEDULED MAINTENANCE BREAKS — always visible ── */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold">Scheduled maintenance breaks</p>
              <Button
                size="sm"
                variant="outline"
                className="gap-1 shrink-0"
                disabled={controlsDisabled}
                onClick={() => setScheduleOpen(true)}
              >
                <Plus className="h-3.5 w-3.5" />
                Schedule
              </Button>
            </div>

            {/* Window list grouped by status */}
            {(() => {
              const windows = currentDocument?.windows ?? [];
              if (initialLoading) {
                return (
                  <p className="text-xs text-muted-foreground">Loading…</p>
                );
              }
              if (windows.length === 0) {
                return (
                  <p className="text-xs text-muted-foreground">No maintenance windows scheduled.</p>
                );
              }
              const groups: Array<{ label: string; items: MaintenanceWindow[]; status: string }> = [
                { label: "Upcoming", status: "scheduled", items: windows.filter((w) => w.status === "scheduled") },
                { label: "In progress", status: "active", items: windows.filter((w) => w.status === "active") },
                { label: "Completed", status: "completed", items: windows.filter((w) => w.status === "completed") },
                { label: "Cancelled", status: "cancelled", items: windows.filter((w) => w.status === "cancelled") },
              ].filter((g) => g.items.length > 0);

              return (
                <div className="space-y-3">
                  {groups.map((group) => (
                    <div key={group.status} className="space-y-1.5">
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                        {group.label}
                      </p>
                      {group.items.map((w) => (
                        <div
                          key={w.id}
                          className="rounded-md border bg-muted/30 px-3 py-2 text-xs space-y-0.5"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <span className="font-medium">{w.title}</span>
                            {w.status === "scheduled" && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-5 px-1.5 text-xs gap-1 text-muted-foreground hover:text-destructive shrink-0"
                                disabled={controlsDisabled}
                                onClick={() =>
                                  void handleAction({ action: "cancel_window", window_id: w.id })
                                }
                              >
                                <X className="h-3 w-3" />
                                Cancel
                              </Button>
                            )}
                          </div>
                          <div className="text-muted-foreground space-y-0.5">
                            <p>Start: {formatMaintenanceLocalDateTime(w.starts_at)}</p>
                            <p>End: {formatMaintenanceLocalDateTime(w.ends_at)}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>

          {/* Refresh button + background refresh indicator */}
          <div className="flex items-center justify-end gap-2 pt-1">
            {backgroundRefreshing && (
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <Loader2 className="h-3 w-3 animate-spin" />
                Refreshing…
              </span>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="gap-1.5 text-muted-foreground"
              onClick={() => void doLoad(false)}
              disabled={initialLoading || working}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh status
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* End maintenance confirmation dialog */}
      <Dialog open={confirmEndOpen} onOpenChange={setConfirmEndOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>End maintenance?</DialogTitle>
            <DialogDescription>
              This will immediately restore access for all users.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmEndOpen(false)} disabled={working}>
              Cancel
            </Button>
            <Button
              onClick={async () => {
                setConfirmEndOpen(false);
                await handleAction({ action: "end_manual" });
              }}
              disabled={working}
              className="gap-2"
            >
              <PowerOff className="h-4 w-4" />
              {working ? "Ending…" : "End Maintenance"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <MaintenanceScheduleDialog
        open={scheduleOpen}
        onOpenChange={setScheduleOpen}
        revision={currentRevision}
        existingWindows={currentDocument?.windows ?? []}
        working={scheduleWorking}
        onSchedule={handleScheduleWindow}
      />
    </>
  );
}
