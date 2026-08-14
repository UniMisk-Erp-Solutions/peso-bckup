/**
 * MaintenanceScheduleDialog — responsive dialog for scheduling a maintenance break.
 *
 * Replaces the old max-w-md cramped dialog with separate date+time fields,
 * timezone display, inline validation, a review panel, and a sticky footer.
 *
 * Timezone handling: all fields are entered in the browser's local timezone.
 * combineLocalDateAndTimeToUtcIso() handles the conversion so UTC is never
 * displayed in the entry fields.
 *
 * Form state is preserved on write failure so the admin can retry without
 * retyping. The dialog closes only after a confirmed successful write.
 */

import { useState, useEffect, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Calendar, AlertTriangle, Info, Clock } from "lucide-react";
import { MaintenanceTimePicker } from "./MaintenanceTimePicker";
import {
  combineLocalDateAndTimeToUtcIso,
  utcIsoToLocalDateAndTime,
  formatMaintenanceLocalDateTime,
  formatUtcPreview,
  calculateMaintenanceDuration,
  validateLocalDateTimeParts,
  getScheduleDefaults,
  getBrowserTimezone,
  getBrowserTimezoneAbbr,
  type LocalDateTimeParts,
} from "@/lib/maintenanceDateTime";
import type { MaintenanceWindow } from "../../../api/_lib/systemStatusTypes";

// ── Types ──────────────────────────────────────────────────────────────────

export type ScheduleDialogWritePayload = {
  action: "create_window";
  revision: string;
  title: string;
  message: string;
  starts_at: string;
  ends_at: string;
  announce_from: string;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  revision: string;
  existingWindows: MaintenanceWindow[];
  working: boolean;
  onSchedule: (payload: ScheduleDialogWritePayload) => Promise<void>;
};

type FieldErrors = Partial<Record<
  "title" | "message" | "announceDate" | "announceTime" |
  "startDate" | "startTime" | "endDate" | "endTime" | "cross",
  string
>>;

// ── Sub-components ─────────────────────────────────────────────────────────

function DateTimeGroup({
  label,
  dateId,
  timeId,
  dateParts,
  onChange,
  errors,
  dateError,
  timeError,
  utcPreview,
}: {
  label: string;
  dateId: string;
  timeId: string;
  dateParts: LocalDateTimeParts;
  onChange: (parts: LocalDateTimeParts) => void;
  errors?: FieldErrors;
  dateError?: string;
  timeError?: string;
  utcPreview?: string;
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium">{label}</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label htmlFor={dateId} className="text-xs flex items-center gap-1 text-muted-foreground">
            <Calendar className="h-3 w-3" /> Date
          </Label>
          <Input
            id={dateId}
            type="date"
            value={dateParts.date}
            onChange={(e) => onChange({ ...dateParts, date: e.target.value })}
            className={dateError ? "border-destructive" : ""}
          />
          {dateError && <p className="text-xs text-destructive">{dateError}</p>}
        </div>
        <div className="space-y-1">
          <Label htmlFor={timeId} className="text-xs text-muted-foreground">
            Time
          </Label>
          <MaintenanceTimePicker
            id={timeId}
            value={dateParts.time}
            onChange={(t) => onChange({ ...dateParts, time: t })}
            error={timeError}
            ariaLabel={label + " time"}
          />
        </div>
      </div>
      {utcPreview && (
        <p className="text-xs text-muted-foreground font-mono">{utcPreview} UTC</p>
      )}
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

export function MaintenanceScheduleDialog({
  open,
  onOpenChange,
  revision,
  existingWindows,
  working,
  onSchedule,
}: Props) {
  const tz = getBrowserTimezone();
  const tzAbbr = getBrowserTimezoneAbbr();

  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [announceDate, setAnnounceParts] = useState<LocalDateTimeParts>({ date: "", time: "" });
  const [startDate, setStartParts] = useState<LocalDateTimeParts>({ date: "", time: "" });
  const [endDate, setEndParts] = useState<LocalDateTimeParts>({ date: "", time: "" });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [writeError, setWriteError] = useState<string | null>(null);
  const [writeRequestId, setWriteRequestId] = useState<string | null>(null);

  const applyDefaults = useCallback(() => {
    const defaults = getScheduleDefaults();
    setAnnounceParts(defaults.announce);
    setStartParts(defaults.start);
    setEndParts(defaults.end);
  }, []);

  useEffect(() => {
    if (open) {
      setTitle("Scheduled Maintenance");
      setMessage("PesoWise will be temporarily unavailable during this maintenance window.");
      applyDefaults();
      setErrors({});
      setWriteError(null);
      setWriteRequestId(null);
    }
  }, [open, applyDefaults]);

  const announceIso = combineLocalDateAndTimeToUtcIso(announceDate);
  const startIso = combineLocalDateAndTimeToUtcIso(startDate);
  const endIso = combineLocalDateAndTimeToUtcIso(endDate);

  function validate(): FieldErrors {
    const errs: FieldErrors = {};
    if (!title.trim()) errs.title = "Title is required";
    if (!message.trim()) errs.message = "Message is required";

    const av = validateLocalDateTimeParts(announceDate, "Announcement");
    if (!av.ok) {
      if (!announceDate.date) errs.announceDate = av.error;
      else errs.announceTime = av.error;
    }

    const sv = validateLocalDateTimeParts(startDate, "Maintenance start");
    if (!sv.ok) {
      if (!startDate.date) errs.startDate = sv.error;
      else errs.startTime = sv.error;
    }

    const ev = validateLocalDateTimeParts(endDate, "Maintenance end");
    if (!ev.ok) {
      if (!endDate.date) errs.endDate = ev.error;
      else errs.endTime = ev.error;
    }

    if (startIso && new Date(startIso).getTime() <= Date.now()) {
      errs.cross = "Maintenance start must be in the future";
    }

    if (startIso && endIso) {
      const diff = new Date(endIso).getTime() - new Date(startIso).getTime();
      if (diff <= 0) errs.cross = "End must be after start";
      else if (diff < 5 * 60 * 1000) errs.cross = "Minimum duration is 5 minutes";
    }

    if (announceIso && startIso) {
      if (new Date(announceIso).getTime() > new Date(startIso).getTime()) {
        errs.cross = "Announcement must be at or before maintenance start";
      }
    }

    if (startIso && endIso) {
      const others = existingWindows.filter((w) => w.status === "scheduled");
      for (const w of others) {
        const oStart = new Date(w.starts_at).getTime();
        const oEnd = new Date(w.ends_at).getTime();
        const s = new Date(startIso).getTime();
        const e = new Date(endIso).getTime();
        if (s < oEnd && e > oStart) {
          errs.cross = `Overlaps with existing window: "${w.title}"`;
          break;
        }
      }
    }

    return errs;
  }

  const isValid = (() => {
    if (!title.trim() || !message.trim()) return false;
    if (!announceDate.date || !announceDate.time) return false;
    if (!startDate.date || !startDate.time) return false;
    if (!endDate.date || !endDate.time) return false;
    if (!announceIso || !startIso || !endIso) return false;
    return Object.keys(validate()).length === 0;
  })();

  async function handleSubmit() {
    const errs = validate();
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      return;
    }
    setErrors({});
    setWriteError(null);
    setWriteRequestId(null);

    try {
      await onSchedule({
        action: "create_window",
        revision,
        title: title.trim(),
        message: message.trim(),
        starts_at: startIso!,
        ends_at: endIso!,
        announce_from: announceIso!,
      });
      // Dialog is closed by parent only after success
    } catch (err) {
      const e = err as Record<string, unknown>;
      setWriteError(err instanceof Error ? err.message : "Failed to schedule break");
      if (typeof e.requestId === "string") setWriteRequestId(e.requestId);
      // Keep dialog open and preserve all values
    }
  }

  const duration = startIso && endIso ? calculateMaintenanceDuration(startIso, endIso) : "";
  const bannerPreview = startIso && endIso
    ? [
        title ? `Scheduled maintenance: ${title}` : null,
        startIso ? `Starts: ${formatMaintenanceLocalDateTime(startIso)}` : null,
        endIso ? `Expected completion: ${formatMaintenanceLocalDateTime(endIso)}` : null,
        message || null,
      ].filter(Boolean).join(" — ")
    : null;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!working) onOpenChange(o); }}>
      <DialogContent
        className="w-[calc(100vw-1.5rem)] sm:w-full max-w-2xl max-h-[90dvh] overflow-hidden p-0 flex flex-col"
      >
        {/* Fixed header */}
        <div className="px-6 pt-6 pb-4 border-b shrink-0">
          <DialogHeader>
            <DialogTitle>Schedule Maintenance Break</DialogTitle>
            <DialogDescription>
              Users will see a notice banner from the announcement time until maintenance begins.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock className="h-3.5 w-3.5" />
            <span>
              Times are entered in:{" "}
              <span className="font-medium text-foreground">
                {tz}{tzAbbr ? ` (${tzAbbr})` : ""}
              </span>
            </span>
          </div>
        </div>

        {/* Scrollable form body */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">

          {/* Write error */}
          {writeError && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription className="space-y-0.5">
                <span className="block">{writeError}</span>
                {writeRequestId && (
                  <span className="block text-xs opacity-80">Request ID: {writeRequestId}</span>
                )}
              </AlertDescription>
            </Alert>
          )}

          {/* Cross-field validation error */}
          {errors.cross && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>{errors.cross}</AlertDescription>
            </Alert>
          )}

          {/* Title */}
          <div className="space-y-1">
            <Label htmlFor="sw-title" className="text-sm font-medium">Title</Label>
            <Input
              id="sw-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
              placeholder="Scheduled Maintenance"
              className={errors.title ? "border-destructive" : ""}
            />
            {errors.title && <p className="text-xs text-destructive">{errors.title}</p>}
          </div>

          {/* Message */}
          <div className="space-y-1">
            <Label htmlFor="sw-msg" className="text-sm font-medium">Message</Label>
            <Textarea
              id="sw-msg"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={2}
              maxLength={2000}
              placeholder="We will be performing maintenance from…"
              className={errors.message ? "border-destructive" : ""}
            />
            {errors.message && <p className="text-xs text-destructive">{errors.message}</p>}
          </div>

          <div className="border-t pt-4 space-y-5">
            {/* Announcement begins */}
            <DateTimeGroup
              label="Notice begins"
              dateId="sw-announce-date"
              timeId="sw-announce-time"
              dateParts={announceDate}
              onChange={setAnnounceParts}
              dateError={errors.announceDate}
              timeError={errors.announceTime}
              utcPreview={announceIso ? formatUtcPreview(announceIso) : undefined}
            />

            {/* Maintenance begins */}
            <DateTimeGroup
              label="Maintenance begins"
              dateId="sw-start-date"
              timeId="sw-start-time"
              dateParts={startDate}
              onChange={setStartParts}
              dateError={errors.startDate}
              timeError={errors.startTime}
              utcPreview={startIso ? formatUtcPreview(startIso) : undefined}
            />

            {/* Maintenance ends */}
            <DateTimeGroup
              label="Maintenance ends"
              dateId="sw-end-date"
              timeId="sw-end-time"
              dateParts={endDate}
              onChange={setEndParts}
              dateError={errors.endDate}
              timeError={errors.endTime}
              utcPreview={endIso ? formatUtcPreview(endIso) : undefined}
            />
          </div>

          {/* Review panel */}
          {startIso && endIso && title && !errors.cross && (
            <div className="rounded-lg border bg-muted/40 p-4 space-y-2 text-sm">
              <p className="font-medium flex items-center gap-1.5">
                <Info className="h-4 w-4 text-muted-foreground" /> Review
              </p>
              {announceIso && (
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">Notice begins</span>
                  <span className="font-medium text-right">{formatMaintenanceLocalDateTime(announceIso)}</span>
                </div>
              )}
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Maintenance starts</span>
                <span className="font-medium text-right">{formatMaintenanceLocalDateTime(startIso)}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Maintenance ends</span>
                <span className="font-medium text-right">{formatMaintenanceLocalDateTime(endIso)}</span>
              </div>
              {duration && (
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">Duration</span>
                  <span className="font-medium">{duration}</span>
                </div>
              )}
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Timezone</span>
                <span className="font-medium">{tz}</span>
              </div>
              {bannerPreview && (
                <div className="mt-3 border-t pt-3 space-y-1">
                  <p className="text-xs text-muted-foreground">Upcoming banner preview:</p>
                  <p className="text-xs bg-blue-50 dark:bg-blue-950/30 text-blue-800 dark:text-blue-300 rounded p-2 border border-blue-200 dark:border-blue-800">
                    {bannerPreview}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Sticky action footer */}
        <div className="px-6 py-4 border-t bg-background shrink-0 flex flex-col-reverse sm:flex-row gap-2 sm:justify-end">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={working}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!isValid || working}
          >
            {working ? "Scheduling…" : "Schedule Break"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
