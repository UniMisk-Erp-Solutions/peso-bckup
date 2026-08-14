/**
 * SystemBroadcastCard — Master Admin control for independent broadcast announcements.
 *
 * Publishes a scrolling banner message visible to all users even when the system
 * is fully operational. The announcement is separate from maintenance windows.
 *
 * Uses GET/POST /api/master/announcement (authenticated).
 * Controls are always visible — disabled while loading or on auth/config errors.
 * Inputs are preserved on write failure so the admin can retry without retyping.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useSystemAvailability } from "@/contexts/SystemAvailabilityContext";
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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AsyncOperationProgress } from "@/components/AsyncOperationProgress";
import { useOperationProgress } from "@/hooks/useOperationProgress";
import { Megaphone, X, Loader2, RefreshCw, AlertTriangle, Settings } from "lucide-react";

type AnnouncementData = {
  id: string;
  title: string;
  message: string;
  published_at: string;
} | null;

type LoadError = {
  message: string;
  httpStatus?: number;
  requestId?: string;
  missingVariables?: string[];
  code?: string;
};

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; err: LoadError }
  | { kind: "ready"; announcement: AnnouncementData; revision: string };

const TOKEN_CACHE_TTL_MS = 30_000;

async function getToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

async function fetchAnnouncement(token: string): Promise<{ announcement: AnnouncementData; revision: string }> {
  const res = await fetch("/api/master/announcement", {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const json = await res.json() as Record<string, unknown>;
  if (!res.ok) {
    const err: LoadError = {
      message: typeof json.error === "string" ? json.error : `HTTP ${res.status}`,
      httpStatus: res.status,
      requestId: typeof json.request_id === "string" ? json.request_id : undefined,
      code: typeof json.code === "string" ? json.code : undefined,
      missingVariables: Array.isArray(json.missingVariables) ? json.missingVariables as string[] : undefined,
    };
    throw Object.assign(new Error(err.message), err);
  }
  return { announcement: (json.announcement ?? null) as AnnouncementData, revision: json.revision as string };
}

async function writeAnnouncement(
  payload: Record<string, unknown>,
  token: string,
): Promise<{ announcement: AnnouncementData; revision: string }> {
  const res = await fetch("/api/master/announcement", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const json = await res.json() as Record<string, unknown>;
  if (!res.ok) {
    if (res.status === 409) throw Object.assign(new Error(json.error as string ?? "Conflict"), { conflict: true });
    const errMsg = typeof json.error === "string" ? json.error : `HTTP ${res.status}`;
    throw Object.assign(new Error(errMsg), {
      httpStatus: res.status,
      requestId: json.request_id,
      code: json.code,
      missingVariables: json.missingVariables,
    });
  }
  return { announcement: (json.announcement ?? null) as AnnouncementData, revision: json.revision as string };
}

export function SystemBroadcastCard() {
  const { user } = useAuth();
  const { toast } = useToast();
  const { refreshStatus } = useSystemAvailability();

  const [loadState, setLoadState] = useState<LoadState>({ kind: "loading" });
  const [titleInput, setTitleInput] = useState("");
  const [messageInput, setMessageInput] = useState("");
  const [actionLoading, setActionLoading] = useState(false);

  const {
    progress: opProgress,
    startOperation,
    completeOperation,
    failOperation,
  } = useOperationProgress();

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const load = useCallback(async () => {
    if (!user) return;
    setLoadState({ kind: "loading" });
    try {
      const token = await getToken();
      if (!token) {
        setLoadState({ kind: "error", err: { message: "Not authenticated" } });
        return;
      }
      const { announcement, revision } = await fetchAnnouncement(token);
      if (!mountedRef.current) return;
      setLoadState({ kind: "ready", announcement, revision });
    } catch (err) {
      if (!mountedRef.current) return;
      const e = err as Record<string, unknown>;
      setLoadState({
        kind: "error",
        err: {
          message: err instanceof Error ? err.message : "Failed to load",
          httpStatus: typeof e.httpStatus === "number" ? e.httpStatus : undefined,
          requestId: typeof e.requestId === "string" ? e.requestId : undefined,
          code: typeof e.code === "string" ? e.code : undefined,
          missingVariables: Array.isArray(e.missingVariables) ? e.missingVariables as string[] : undefined,
        },
      });
    }
  }, [user]);

  useEffect(() => { void load(); }, [load]);

  const isConfigError =
    loadState.kind === "error" &&
    (loadState.err.code === "server_configuration_missing" ||
     loadState.err.code === "announcement_store_not_configured");

  const controlsDisabled =
    loadState.kind === "loading" ||
    actionLoading ||
    (loadState.kind === "error" && isConfigError);

  const revision = loadState.kind === "ready" ? loadState.revision : "init";

  const handlePublish = async () => {
    if (!titleInput.trim() || !messageInput.trim()) {
      toast({ title: "Title and message are required", variant: "destructive" });
      return;
    }
    setActionLoading(true);
    const isUpdate = loadState.kind === "ready" && loadState.announcement !== null;
    startOperation(isUpdate ? "Updating announcement…" : "Publishing announcement…");
    try {
      const token = await getToken();
      if (!token) throw new Error("Not authenticated");
      const result = await writeAnnouncement({
        action: "publish_announcement",
        revision,
        title: titleInput.trim(),
        message: messageInput.trim(),
      }, token);
      if (!mountedRef.current) return;
      completeOperation("Announcement published");
      setLoadState({ kind: "ready", announcement: result.announcement, revision: result.revision });
      setTitleInput("");
      setMessageInput("");
      refreshStatus();
      toast({ title: "Announcement published", description: "Banner will appear on next status poll." });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      const isConflict = (err as Record<string, unknown>).conflict === true;
      failOperation(isConflict ? "Revision conflict — reloading…" : msg);
      // Preserve inputs on failure so the admin can retry
      toast({ title: isConflict ? "Conflict" : "Failed to publish", description: msg, variant: "destructive" });
      if (isConflict) await load();
    } finally {
      if (mountedRef.current) setActionLoading(false);
    }
  };

  const handleClear = async () => {
    setActionLoading(true);
    startOperation("Ending announcement…");
    try {
      const token = await getToken();
      if (!token) throw new Error("Not authenticated");
      const result = await writeAnnouncement({
        action: "clear_announcement",
        revision,
      }, token);
      if (!mountedRef.current) return;
      completeOperation("Announcement ended");
      setLoadState({ kind: "ready", announcement: result.announcement, revision: result.revision });
      refreshStatus();
      toast({ title: "Announcement ended" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      const isConflict = (err as Record<string, unknown>).conflict === true;
      failOperation(isConflict ? "Revision conflict — reloading…" : msg);
      toast({ title: isConflict ? "Conflict" : "Failed to end", description: msg, variant: "destructive" });
      if (isConflict) await load();
    } finally {
      if (mountedRef.current) setActionLoading(false);
    }
  };

  const activeAnnouncement = loadState.kind === "ready" ? loadState.announcement : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Megaphone className="h-4 w-4" />
          Broadcast Announcement
        </CardTitle>
        <CardDescription>
          Publish a scrolling banner visible to all users — independent of maintenance windows.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">

        {/* ── LOADING ────────────────────────────────────────────────── */}
        {loadState.kind === "loading" && (
          <AsyncOperationProgress status="running" title="Loading announcement…" compact />
        )}

        {/* ── CONFIGURATION ERROR ────────────────────────────────────── */}
        {loadState.kind === "error" && isConfigError && (
          <Alert className="border-amber-200 bg-amber-50 dark:bg-amber-950/20">
            <Settings className="h-4 w-4 text-amber-600" />
            <AlertTitle className="text-amber-800 dark:text-amber-400">
              Announcement control not configured
            </AlertTitle>
            <AlertDescription className="text-amber-700 dark:text-amber-300 space-y-2 mt-1">
              <p>{loadState.err.message}</p>
              {(loadState.err.missingVariables ?? []).length > 0 && (
                <ul className="list-disc list-inside space-y-0.5 text-xs font-mono">
                  {(loadState.err.missingVariables ?? []).map((v) => (
                    <li key={v}>{v}</li>
                  ))}
                </ul>
              )}
              {loadState.err.httpStatus != null && (
                <p className="text-xs">HTTP {loadState.err.httpStatus}</p>
              )}
              {loadState.err.requestId && (
                <p className="text-xs">Request ID: {loadState.err.requestId}</p>
              )}
              <Button size="sm" variant="outline" onClick={() => void load()} disabled={actionLoading} className="mt-2 gap-2">
                <RefreshCw className="h-3.5 w-3.5" /> Retry
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {/* ── OTHER ERRORS (auth, network) ───────────────────────────── */}
        {loadState.kind === "error" && !isConfigError && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="flex items-center justify-between gap-2 flex-wrap">
              <div className="space-y-0.5">
                <span className="block">{loadState.err.message}</span>
                {loadState.err.httpStatus != null && (
                  <span className="text-xs block">HTTP {loadState.err.httpStatus}</span>
                )}
                {loadState.err.requestId && (
                  <span className="text-xs block">Request ID: {loadState.err.requestId}</span>
                )}
              </div>
              <Button size="sm" variant="outline" onClick={() => void load()}>
                <RefreshCw className="h-3.5 w-3.5 mr-1" /> Retry
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {/* ── ACTIVE ANNOUNCEMENT DISPLAY ───────────────────────────── */}
        {activeAnnouncement && (
          <div className="rounded-md border border-violet-200 bg-violet-50 dark:border-violet-800 dark:bg-violet-950/30 p-3 space-y-1">
            <div className="flex items-center justify-between gap-2">
              <Badge variant="secondary" className="text-violet-700 bg-violet-100 dark:bg-violet-900 dark:text-violet-300 border-0">
                Active
              </Badge>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-destructive border-destructive/40 hover:bg-destructive/5"
                onClick={handleClear}
                disabled={actionLoading}
              >
                {actionLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <X className="h-3.5 w-3.5 mr-1" />}
                End Announcement
              </Button>
            </div>
            <p className="text-sm font-medium">{activeAnnouncement.title}</p>
            <p className="text-xs text-muted-foreground">{activeAnnouncement.message}</p>
            <p className="text-xs text-muted-foreground">
              Published {new Date(activeAnnouncement.published_at).toLocaleString()}
            </p>
          </div>
        )}

        {loadState.kind === "ready" && !activeAnnouncement && (
          <p className="text-sm text-muted-foreground">No active announcement.</p>
        )}

        {/* ── PUBLISH / UPDATE FORM — always visible ─────────────────── */}
        <div className="space-y-3 pt-1">
          <p className="text-sm font-medium">
            {activeAnnouncement ? "Update announcement" : "Publish new announcement"}
          </p>
          <div className="space-y-1">
            <Label htmlFor="ann-title" className="text-xs">Title</Label>
            <Input
              id="ann-title"
              placeholder="e.g. Scheduled report delay tonight"
              value={titleInput}
              onChange={(e) => setTitleInput(e.target.value)}
              maxLength={200}
              disabled={controlsDisabled}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="ann-message" className="text-xs">Message</Label>
            <Textarea
              id="ann-message"
              placeholder="Detailed message shown in the scrolling banner…"
              value={messageInput}
              onChange={(e) => setMessageInput(e.target.value)}
              maxLength={2000}
              rows={3}
              disabled={controlsDisabled}
            />
          </div>
          <Button
            onClick={handlePublish}
            disabled={controlsDisabled || !titleInput.trim() || !messageInput.trim()}
            className="w-full"
          >
            {actionLoading ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <Megaphone className="h-4 w-4 mr-2" />
            )}
            {activeAnnouncement ? "Update Announcement" : "Publish Announcement"}
          </Button>
        </div>

        <AsyncOperationProgress
          status={opProgress.status}
          title={opProgress.phase}
          compact={opProgress.status === "running"}
          showSuccess
        />
      </CardContent>
    </Card>
  );
}
