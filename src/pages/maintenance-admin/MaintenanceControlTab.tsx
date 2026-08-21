/**
 * MaintenanceControlTab — the write-control surface of the maintenance
 * admin console (force/schedule). Extracted from the original single-page
 * dashboard so /admin/maintenance can host CONTROL + HISTORY as tabs. See
 * docs/maintenance/CLOUD_MAINTENANCE_CONTROL_PLANE.md §36.
 */
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { MaintenanceTimePicker } from "@/components/maintenance/MaintenanceTimePicker";
import {
  combineLocalDateAndTimeToUtcIso,
  utcIsoToLocalDateAndTime,
  formatMaintenanceDateTime,
} from "@/lib/maintenanceDateTime";
import { useToast } from "@/hooks/use-toast";
import {
  readMaintenanceStatusForAdmin,
  updateMaintenanceStatus,
} from "@/integrations/maintenance-cloud/maintenanceStatusService";
import { readMaintenanceHistory } from "@/integrations/maintenance-cloud/maintenanceHistoryService";
import type { MaintenanceStatusRow, MaintenanceAdminRow } from "@/integrations/maintenance-cloud/types";
import type { MaintenanceHistoryRow } from "@/integrations/maintenance-cloud/types";
import { MAINTENANCE_ENV } from "@/maintenance/maintenanceConfig";
import { resolveMaintenanceState, isValidMaintenanceEnvironment } from "@/maintenance/maintenanceResolver";
import { validateMaintenanceSchedule } from "@/maintenance/maintenanceScheduleValidation";
import { deriveMaintenanceHistoryStatus } from "@/maintenance/maintenanceHistoryDerivedStatus";

const IS_PRODUCTION = MAINTENANCE_ENV === "production";

type PendingAction =
  | { kind: "enable" }
  | { kind: "disable" }
  | { kind: "saveSchedule" }
  | { kind: "cancelSchedule" }
  | null;

type Props = {
  admin: MaintenanceAdminRow;
};

export function MaintenanceControlTab({ admin }: Props) {
  const { toast } = useToast();

  const [row, setRow] = useState<MaintenanceStatusRow | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastMaintenance, setLastMaintenance] = useState<MaintenanceHistoryRow | null>(null);

  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [startDate, setStartDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endDate, setEndDate] = useState("");
  const [endTime, setEndTime] = useState("");
  const [scheduleError, setScheduleError] = useState<string | null>(null);

  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [confirmText, setConfirmText] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const environmentAuthorized = IS_PRODUCTION ? admin.can_manage_production : admin.can_manage_preview;

  const loadRow = useCallback(async () => {
    if (!isValidMaintenanceEnvironment(MAINTENANCE_ENV)) {
      setLoadError(`VITE_MAINTENANCE_ENV is not a valid environment: ${String(MAINTENANCE_ENV)}`);
      return;
    }
    setRefreshing(true);
    const result = await readMaintenanceStatusForAdmin(MAINTENANCE_ENV);
    setRefreshing(false);
    if (!result.ok) {
      setLoadError(result.error);
      return;
    }
    setLoadError(null);
    setRow(result.row);
    setTitle(result.row.title ?? "");
    setMessage(result.row.message ?? "");
    if (result.row.starts_at) {
      const parts = utcIsoToLocalDateAndTime(result.row.starts_at);
      setStartDate(parts.date);
      setStartTime(parts.time);
    } else {
      setStartDate("");
      setStartTime("");
    }
    if (result.row.ends_at) {
      const parts = utcIsoToLocalDateAndTime(result.row.ends_at);
      setEndDate(parts.date);
      setEndTime(parts.time);
    } else {
      setEndDate("");
      setEndTime("");
    }
  }, []);

  const loadLastMaintenance = useCallback(async () => {
    if (!isValidMaintenanceEnvironment(MAINTENANCE_ENV)) return;
    // RLS-gated automatically — an admin without can_view_history simply
    // gets zero rows back here, never a special-cased client-side hide.
    const result = await readMaintenanceHistory({ environment: MAINTENANCE_ENV, page: 1, pageSize: 5 });
    if (result.ok) {
      const completed = result.rows.find(
        (r) => deriveMaintenanceHistoryStatus(r) === "completed",
      );
      setLastMaintenance(completed ?? null);
    }
  }, []);

  useEffect(() => {
    void loadRow();
    void loadLastMaintenance();
  }, [loadRow, loadLastMaintenance]);

  const status = row ? resolveMaintenanceState({ kind: "success", row }, new Date()) : null;

  function startsAtIso(): string | null {
    if (!startDate || !startTime) return null;
    return combineLocalDateAndTimeToUtcIso({ date: startDate, time: startTime });
  }
  function endsAtIso(): string | null {
    if (!endDate || !endTime) return null;
    return combineLocalDateAndTimeToUtcIso({ date: endDate, time: endTime });
  }

  function requestAction(kind: PendingAction extends null ? never : PendingAction["kind"]) {
    if (kind === "saveSchedule") {
      const validation = validateMaintenanceSchedule(startsAtIso(), endsAtIso());
      if (!validation.ok) {
        setScheduleError(validation.error);
        return;
      }
    }
    setScheduleError(null);
    setConfirmText("");
    setPendingAction({ kind } as PendingAction);
  }

  async function runPendingAction() {
    if (!pendingAction || !isValidMaintenanceEnvironment(MAINTENANCE_ENV)) return;
    setSubmitting(true);
    try {
      let patch: Parameters<typeof updateMaintenanceStatus>[1];
      let successMessage: string;

      switch (pendingAction.kind) {
        case "enable":
          patch = { force_maintenance: true, title: title || null, message: message || null };
          successMessage = "Maintenance enabled.";
          break;
        case "disable":
          patch = { force_maintenance: false };
          successMessage = "Maintenance disabled.";
          break;
        case "saveSchedule":
          patch = {
            title: title || null,
            message: message || null,
            starts_at: startsAtIso(),
            ends_at: endsAtIso(),
          };
          successMessage = "Schedule saved.";
          break;
        case "cancelSchedule":
          patch = { starts_at: null, ends_at: null };
          successMessage = "Schedule cancelled.";
          break;
      }

      const result = await updateMaintenanceStatus(MAINTENANCE_ENV, patch);
      if (!result.ok) {
        toast({ variant: "destructive", title: "Save failed", description: result.error });
        return;
      }

      const readBack = await readMaintenanceStatusForAdmin(MAINTENANCE_ENV);
      if (!readBack.ok) {
        toast({
          variant: "destructive",
          title: "Write may not be confirmed",
          description: `Update returned success but the read-back failed: ${readBack.error}`,
        });
        return;
      }

      const matches =
        readBack.row.force_maintenance === result.row.force_maintenance &&
        readBack.row.title === result.row.title &&
        readBack.row.message === result.row.message &&
        readBack.row.starts_at === result.row.starts_at &&
        readBack.row.ends_at === result.row.ends_at;

      if (!matches) {
        toast({
          variant: "destructive",
          title: "Write may not be confirmed",
          description: "The read-back did not match the write. Refresh and check the current status before retrying.",
        });
        return;
      }

      setRow(readBack.row);
      void loadLastMaintenance();
      toast({ title: successMessage });
    } finally {
      setSubmitting(false);
      setPendingAction(null);
      setConfirmText("");
    }
  }

  const dangerTitle: Record<NonNullable<PendingAction>["kind"], string> = {
    enable: IS_PRODUCTION ? "Enable Production maintenance?" : "Enable maintenance?",
    disable: "Disable maintenance?",
    saveSchedule: "Save schedule?",
    cancelSchedule: "Cancel schedule?",
  };
  const dangerDescription: Record<NonNullable<PendingAction>["kind"], string> = {
    enable: IS_PRODUCTION
      ? 'Users will be prevented from entering PesoWise immediately. Type "production" to confirm.'
      : "Users on this environment will be blocked from PesoWise immediately.",
    disable: "PesoWise will become reachable again immediately for this environment.",
    saveSchedule: "This updates the maintenance window and message shown to users for this environment.",
    cancelSchedule: "The scheduled maintenance window will be cleared for this environment.",
  };

  const requiresTypedConfirmation = IS_PRODUCTION && pendingAction?.kind === "enable";
  const confirmDisabled =
    submitting || (requiresTypedConfirmation && confirmText.trim().toLowerCase() !== "production");

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="rounded-lg border p-3 space-y-1">
          <p className="text-xs text-muted-foreground">Current status</p>
          <p className="text-sm font-semibold text-foreground">
            {status?.state === "maintenance" && `Maintenance (${status.source})`}
            {status?.state === "upcoming" && "Scheduled"}
            {status?.state === "normal" && "Normal"}
            {!status && "…"}
          </p>
        </div>
        <div className="rounded-lg border p-3 space-y-1">
          <p className="text-xs text-muted-foreground">Next maintenance</p>
          <p className="text-sm font-semibold text-foreground">
            {status?.state === "upcoming" && row?.starts_at
              ? formatMaintenanceDateTime(row.starts_at)
              : "None scheduled"}
          </p>
        </div>
        <div className="rounded-lg border p-3 space-y-1">
          <p className="text-xs text-muted-foreground">Last maintenance</p>
          <p className="text-sm font-semibold text-foreground">
            {lastMaintenance
              ? formatMaintenanceDateTime(
                  lastMaintenance.actual_ended_at ?? lastMaintenance.scheduled_end_at ?? lastMaintenance.created_at,
                )
              : "—"}
          </p>
        </div>
        <div className="rounded-lg border p-3 space-y-1">
          <p className="text-xs text-muted-foreground">Last refreshed</p>
          <p className="text-sm font-semibold text-foreground">
            {row ? formatMaintenanceDateTime(row.updated_at) : "…"}
          </p>
        </div>
      </div>

      <div className="rounded-lg border p-4 space-y-2 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Your authority:</span>
          <span className="font-medium text-foreground">
            {environmentAuthorized ? "authorized for this environment" : "NOT authorized for this environment"}
          </span>
        </div>
      </div>

      {!environmentAuthorized && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-4 text-sm text-destructive">
          Your maintenance_admins row does not grant{" "}
          {IS_PRODUCTION ? "can_manage_production" : "can_manage_preview"}. Writes below will be
          rejected by Cloud RLS even if attempted.
        </div>
      )}

      {loadError && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-4 text-sm text-destructive">
          Could not load current status: {loadError}
          <Button variant="outline" size="sm" className="mt-2" onClick={() => void loadRow()}>
            Retry
          </Button>
        </div>
      )}

      <div className="flex justify-end">
        <Button variant="outline" size="sm" disabled={refreshing} onClick={() => void loadRow()}>
          {refreshing ? "Refreshing…" : "Refresh"}
        </Button>
      </div>

      <Separator />

      <div className="space-y-4">
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          Message shown to users
        </p>
        <div className="space-y-1">
          <Label htmlFor="maintenance-title">Title</Label>
          <Input
            id="maintenance-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="PesoWise is under maintenance"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="maintenance-message">Message</Label>
          <Textarea
            id="maintenance-message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="We'll be back shortly."
            rows={3}
          />
        </div>

        <div className="flex gap-2">
          <Button
            variant="destructive"
            disabled={!environmentAuthorized || row?.force_maintenance === true}
            onClick={() => requestAction("enable")}
          >
            Enable maintenance now
          </Button>
          <Button
            variant="outline"
            disabled={!environmentAuthorized || row?.force_maintenance === false}
            onClick={() => requestAction("disable")}
          >
            Disable maintenance
          </Button>
        </div>
      </div>

      <Separator />

      <div className="space-y-4">
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          Schedule a maintenance window
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor="maintenance-start-date">Start date</Label>
            <Input
              id="maintenance-start-date"
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="maintenance-start-time">Start time</Label>
            <MaintenanceTimePicker
              id="maintenance-start-time"
              value={startTime}
              onChange={setStartTime}
              ariaLabel="Maintenance start time"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="maintenance-end-date">End date</Label>
            <Input
              id="maintenance-end-date"
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="maintenance-end-time">End time</Label>
            <MaintenanceTimePicker
              id="maintenance-end-time"
              value={endTime}
              onChange={setEndTime}
              ariaLabel="Maintenance end time"
            />
          </div>
        </div>
        {scheduleError && (
          <p className="text-xs text-destructive" role="alert">
            {scheduleError}
          </p>
        )}
        <div className="flex gap-2">
          <Button disabled={!environmentAuthorized} onClick={() => requestAction("saveSchedule")}>
            Save schedule
          </Button>
          <Button
            variant="outline"
            disabled={!environmentAuthorized || (!row?.starts_at && !row?.ends_at)}
            onClick={() => requestAction("cancelSchedule")}
          >
            Cancel schedule
          </Button>
        </div>
      </div>

      <AlertDialog open={pendingAction !== null} onOpenChange={(open) => !open && setPendingAction(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              {pendingAction && dangerTitle[pendingAction.kind]}
              {IS_PRODUCTION && <Badge variant="destructive">PRODUCTION</Badge>}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingAction && dangerDescription[pendingAction.kind]}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {requiresTypedConfirmation && (
            <div className="space-y-1">
              <Label htmlFor="confirm-production-text">Type "production" to confirm</Label>
              <Input
                id="confirm-production-text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                autoComplete="off"
              />
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={confirmDisabled}
              onClick={(e) => {
                e.preventDefault();
                void runPendingAction();
              }}
            >
              {submitting ? "Working…" : "Confirm"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
