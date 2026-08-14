/**
 * MaintenanceTimePicker — custom time input with manual text entry and visual clock popover.
 *
 * The primary field is a plain text input (NOT input[type="time"]) so there is no
 * browser-native time chrome on any platform, including Android Chrome's multi-column
 * drum-scroll picker.
 *
 * Usage:
 *   <MaintenanceTimePicker
 *     id="sw-start-time"
 *     value={parts.time}          // canonical "HH:mm"
 *     onChange={(v) => setParts({ ...parts, time: v })}
 *     ariaLabel="Maintenance start time"
 *   />
 *
 * Props:
 *   value    — canonical "HH:mm" (24-hour, two-digit padded)
 *   onChange — called with a new canonical "HH:mm"
 *   error    — inline error message shown under the field
 *   minuteStep — grid granularity shown in the clock (default 5)
 */

import {
  useState,
  useRef,
  useCallback,
  useEffect,
  KeyboardEvent,
} from "react";
import { Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  parseManualTimeInput,
  formatCanonicalTimeForDisplay,
  normalizeClockTime,
  canonicalTimeToClockParts,
} from "@/lib/maintenanceDateTime";

// ── Types ───────────────────────────────────────────────────────────────────

export type MaintenanceTimePickerProps = {
  id: string;
  value: string;       // canonical HH:mm
  onChange: (value: string) => void;
  disabled?: boolean;
  error?: string;
  minuteStep?: number; // default 5
  ariaLabel: string;
};

type ClockPhase = "hour" | "minute";

// ── Helpers ─────────────────────────────────────────────────────────────────

const MINUTE_OPTIONS = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];

function clockAngularPosition(
  index: number,
  total: number,
  radius: number,
  cx: number,
  cy: number,
): { x: number; y: number } {
  const angle = (2 * Math.PI * index) / total - Math.PI / 2;
  return {
    x: cx + radius * Math.cos(angle),
    y: cy + radius * Math.sin(angle),
  };
}

// ── Clock face (SVG-based) ──────────────────────────────────────────────────

type ClockFaceProps = {
  phase: ClockPhase;
  selectedHour: number;  // 1–12
  selectedMinute: number;
  period: "AM" | "PM";
  onSelectHour: (h: number) => void;
  onSelectMinute: (m: number) => void;
};

function ClockFace({
  phase,
  selectedHour,
  selectedMinute,
  onSelectHour,
  onSelectMinute,
}: ClockFaceProps) {
  const SIZE = 200;
  const CX = SIZE / 2;
  const CY = SIZE / 2;
  const OUTER_R = 78;
  const DOT_R = 16;

  if (phase === "hour") {
    const hours = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    return (
      <svg
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        width={SIZE}
        height={SIZE}
        aria-label="Clock face — select hour"
        role="img"
      >
        {/* Face background */}
        <circle cx={CX} cy={CY} r={CX - 4} className="fill-muted stroke-border" strokeWidth={1} />

        {/* Center dot */}
        <circle cx={CX} cy={CY} r={3} className="fill-primary" />

        {/* Hand */}
        {(() => {
          const idx = hours.indexOf(selectedHour);
          if (idx < 0) return null;
          const pos = clockAngularPosition(idx, 12, OUTER_R, CX, CY);
          return (
            <line
              x1={CX} y1={CY}
              x2={pos.x} y2={pos.y}
              className="stroke-primary"
              strokeWidth={2}
              strokeLinecap="round"
            />
          );
        })()}

        {/* Hour numbers */}
        {hours.map((h, i) => {
          const pos = clockAngularPosition(i, 12, OUTER_R, CX, CY);
          const isSelected = h === selectedHour;
          return (
            <g key={h} onClick={() => onSelectHour(h)} style={{ cursor: "pointer" }}>
              <circle
                cx={pos.x}
                cy={pos.y}
                r={DOT_R}
                className={isSelected ? "fill-primary" : "fill-transparent hover:fill-muted-foreground/20"}
              />
              <text
                x={pos.x}
                y={pos.y}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={13}
                fontWeight={isSelected ? "600" : "400"}
                className={isSelected ? "fill-primary-foreground" : "fill-foreground"}
                style={{ userSelect: "none", pointerEvents: "none" }}
              >
                {h}
              </text>
            </g>
          );
        })}
      </svg>
    );
  }

  // Minute grid (not circular — clean grid layout is more usable than a 60-mark clock)
  return null;
}

// ── Main component ──────────────────────────────────────────────────────────

export function MaintenanceTimePicker({
  id,
  value,
  onChange,
  disabled = false,
  error,
  minuteStep = 5,
  ariaLabel,
}: MaintenanceTimePickerProps) {
  // Display text in the input — shown as h:mm AM/PM when value is canonical
  const [inputText, setInputText] = useState(
    value ? formatCanonicalTimeForDisplay(value) : "",
  );
  const [inputError, setInputError] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  // Clock internal state
  const { hour12, minute, period } = canonicalTimeToClockParts(value || "");
  const [clockHour, setClockHour] = useState(hour12);
  const [clockMinute, setClockMinute] = useState(
    minuteStep > 1 ? Math.round(minute / minuteStep) * minuteStep : minute,
  );
  const [clockPeriod, setClockPeriod] = useState<"AM" | "PM">(period);
  const [phase, setPhase] = useState<ClockPhase>("hour");

  // Keep display text in sync when the parent resets value from the outside
  const prevValueRef = useRef(value);
  useEffect(() => {
    if (value !== prevValueRef.current) {
      prevValueRef.current = value;
      setInputText(value ? formatCanonicalTimeForDisplay(value) : "");
      setInputError(null);
      const parts = canonicalTimeToClockParts(value || "");
      setClockHour(parts.hour12);
      setClockMinute(parts.minute);
      setClockPeriod(parts.period);
    }
  }, [value]);

  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Close popover on outside click
  useEffect(() => {
    if (!isOpen) return;
    function handle(e: MouseEvent) {
      const target = e.target as Node;
      if (
        !popoverRef.current?.contains(target) &&
        !buttonRef.current?.contains(target)
      ) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [isOpen]);

  // ── Manual input handlers ──────────────────────────────────────────────

  function handleInputChange(text: string) {
    setInputText(text);
    setInputError(null);
  }

  function handleInputBlur() {
    if (!inputText.trim()) {
      // cleared — propagate empty through onChange only if parent cares
      return;
    }
    const parsed = parseManualTimeInput(inputText);
    if (parsed.ok) {
      setInputText(formatCanonicalTimeForDisplay(parsed.value));
      setInputError(null);
      prevValueRef.current = parsed.value;
      const parts = canonicalTimeToClockParts(parsed.value);
      setClockHour(parts.hour12);
      setClockMinute(parts.minute);
      setClockPeriod(parts.period);
      onChange(parsed.value);
    } else {
      setInputError(parsed.error);
    }
  }

  function handleInputKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      handleInputBlur();
    }
    if (e.key === "Escape") {
      setIsOpen(false);
    }
  }

  // ── Clock handlers ─────────────────────────────────────────────────────

  const openClock = useCallback(() => {
    if (disabled) return;
    setPhase("hour");
    // Sync clock to current canonical value
    const parts = canonicalTimeToClockParts(value || "");
    setClockHour(parts.hour12);
    setClockMinute(parts.minute);
    setClockPeriod(parts.period);
    setIsOpen(true);
  }, [disabled, value]);

  function handleHourSelect(h: number) {
    setClockHour(h);
    setPhase("minute");
  }

  function handleMinuteSelect(m: number) {
    setClockMinute(m);
  }

  function handleApply() {
    const canonical = normalizeClockTime(clockHour, clockMinute, clockPeriod);
    prevValueRef.current = canonical;
    setInputText(formatCanonicalTimeForDisplay(canonical));
    setInputError(null);
    onChange(canonical);
    setIsOpen(false);
    inputRef.current?.focus();
  }

  function handleCancel() {
    setIsOpen(false);
    inputRef.current?.focus();
  }

  function handlePopoverKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      handleCancel();
    }
  }

  function handleNow() {
    const now = new Date();
    const h24 = now.getHours();
    const m = Math.round(now.getMinutes() / minuteStep) * minuteStep % 60;
    const p: "AM" | "PM" = h24 < 12 ? "AM" : "PM";
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    setClockHour(h12);
    setClockMinute(m);
    setClockPeriod(p);
    setPhase("minute");
  }

  // ── Derived ────────────────────────────────────────────────────────────

  const displayError = error ?? inputError ?? null;
  const previewTime = formatCanonicalTimeForDisplay(
    normalizeClockTime(clockHour, clockMinute, clockPeriod),
  );

  // Minute options filtered by step
  const minuteOptions = MINUTE_OPTIONS.filter((m) => m % minuteStep === 0);

  return (
    <div className="relative">
      {/* ── Text input + clock button row ─────────────────────────── */}
      <div className="flex items-center gap-1">
        <div className="relative flex-1">
          <input
            ref={inputRef}
            id={id}
            type="text"
            inputMode="text"
            autoComplete="off"
            value={inputText}
            onChange={(e) => handleInputChange(e.target.value)}
            onBlur={handleInputBlur}
            onKeyDown={handleInputKeyDown}
            disabled={disabled}
            aria-label={ariaLabel}
            aria-invalid={!!displayError}
            aria-describedby={displayError ? `${id}-error` : undefined}
            placeholder="e.g. 3:30 PM or 15:30"
            className={[
              "flex h-9 w-full rounded-md border bg-background px-3 py-1 text-sm",
              "ring-offset-background placeholder:text-muted-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              "disabled:cursor-not-allowed disabled:opacity-50",
              displayError
                ? "border-destructive focus-visible:ring-destructive"
                : "border-input",
            ].join(" ")}
          />
        </div>

        <Button
          ref={buttonRef}
          type="button"
          variant="outline"
          size="icon"
          className="h-9 w-9 shrink-0"
          onClick={openClock}
          disabled={disabled}
          aria-label={`Open clock picker for ${ariaLabel}`}
          aria-expanded={isOpen}
          aria-haspopup="dialog"
        >
          <Clock className="h-4 w-4" />
        </Button>
      </div>

      {/* ── Inline error ───────────────────────────────────────────── */}
      {displayError && (
        <p id={`${id}-error`} className="mt-1 text-xs text-destructive" role="alert">
          {displayError}
        </p>
      )}

      {/* ── Clock popover ──────────────────────────────────────────── */}
      {isOpen && (
        <div
          ref={popoverRef}
          role="dialog"
          aria-modal="true"
          aria-label={`Clock picker for ${ariaLabel}`}
          onKeyDown={handlePopoverKeyDown}
          className={[
            "absolute z-50 mt-1 w-[260px]",
            "rounded-xl border bg-popover text-popover-foreground shadow-lg",
            "left-0",
          ].join(" ")}
          style={{ maxHeight: "calc(100vh - 120px)", overflow: "auto" }}
        >
          <div className="p-3 space-y-3">
            {/* ── Header: current preview + phase labels ─────────── */}
            <div className="flex items-center justify-between">
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => setPhase("hour")}
                  className={[
                    "px-2 py-0.5 rounded text-sm font-mono transition-colors",
                    phase === "hour"
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted",
                  ].join(" ")}
                  aria-pressed={phase === "hour"}
                >
                  {String(clockHour).padStart(2, "0")}
                </button>
                <span className="text-sm font-mono self-center">:</span>
                <button
                  type="button"
                  onClick={() => setPhase("minute")}
                  className={[
                    "px-2 py-0.5 rounded text-sm font-mono transition-colors",
                    phase === "minute"
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted",
                  ].join(" ")}
                  aria-pressed={phase === "minute"}
                >
                  {String(clockMinute).padStart(2, "0")}
                </button>
              </div>

              {/* AM/PM toggle */}
              <div className="flex rounded-md border overflow-hidden text-xs">
                {(["AM", "PM"] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setClockPeriod(p)}
                    aria-pressed={clockPeriod === p}
                    className={[
                      "px-2.5 py-1 transition-colors",
                      clockPeriod === p
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-muted",
                    ].join(" ")}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>

            {/* ── Clock face (hour) or minute grid ───────────────── */}
            {phase === "hour" ? (
              <div className="flex justify-center">
                <ClockFace
                  phase="hour"
                  selectedHour={clockHour}
                  selectedMinute={clockMinute}
                  period={clockPeriod}
                  onSelectHour={handleHourSelect}
                  onSelectMinute={handleMinuteSelect}
                />
              </div>
            ) : (
              <div>
                <p className="text-xs text-muted-foreground mb-2">Select minute</p>
                <div className="grid grid-cols-4 gap-1">
                  {minuteOptions.map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => handleMinuteSelect(m)}
                      aria-pressed={m === clockMinute}
                      className={[
                        "h-9 rounded text-sm font-mono transition-colors min-w-[40px]",
                        m === clockMinute
                          ? "bg-primary text-primary-foreground"
                          : "hover:bg-muted text-foreground",
                      ].join(" ")}
                    >
                      :{String(m).padStart(2, "0")}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* ── Now shortcut ────────────────────────────────────── */}
            <button
              type="button"
              onClick={handleNow}
              className="w-full text-xs text-muted-foreground hover:text-foreground hover:bg-muted rounded px-2 py-1 transition-colors text-left"
            >
              Now → {new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
            </button>

            {/* ── Selected preview ────────────────────────────────── */}
            <p className="text-center text-sm font-medium text-foreground">
              {previewTime}
            </p>

            {/* ── Actions ─────────────────────────────────────────── */}
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={handleCancel}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                className="flex-1"
                onClick={handleApply}
              >
                Apply
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
