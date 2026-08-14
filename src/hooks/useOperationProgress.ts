import { useCallback, useEffect, useRef, useState } from "react";

export type OperationStatus = "idle" | "running" | "success" | "warning" | "error";

export interface OperationProgressState {
  status: OperationStatus;
  phase: string;
  description?: string;
  currentStep?: number;
  totalSteps?: number;
  completed?: number;
  total?: number;
  errorMessage?: string;
}

const IDLE: OperationProgressState = { status: "idle", phase: "" };

// Anti-flicker: don't show progress for operations that finish within this delay
const SHOW_DELAY_MS = 300;
// Keep visible at least this long once shown (avoids flash-disappear)
const MIN_VISIBLE_MS = 500;
// Success auto-clears after this duration
const SUCCESS_CLEAR_MS = 1800;

interface UseOperationProgressOptions {
  showDelay?: number;
  minVisible?: number;
  successClear?: number;
}

export function useOperationProgress(opts: UseOperationProgressOptions = {}) {
  const {
    showDelay = SHOW_DELAY_MS,
    minVisible = MIN_VISIBLE_MS,
    successClear = SUCCESS_CLEAR_MS,
  } = opts;

  // Internal truth — always updated immediately
  const [internal, setInternal] = useState<OperationProgressState>(IDLE);
  // What the UI actually sees — delayed by anti-flicker logic
  const [visible, setVisible] = useState<OperationProgressState>(IDLE);

  // Always holds the latest internal state so timer callbacks see current data
  const internalRef = useRef<OperationProgressState>(IDLE);
  internalRef.current = internal;

  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showTimerPendingRef = useRef(false);
  const shownAtRef = useRef<number | null>(null);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearAllTimers = useCallback(() => {
    if (showTimerRef.current) { clearTimeout(showTimerRef.current); showTimerRef.current = null; }
    if (clearTimerRef.current) { clearTimeout(clearTimerRef.current); clearTimerRef.current = null; }
    showTimerPendingRef.current = false;
  }, []);

  useEffect(() => {
    if (internal.status === "idle") {
      // Cancel any pending show timer — operation ended before it appeared
      if (showTimerRef.current) { clearTimeout(showTimerRef.current); showTimerRef.current = null; }
      showTimerPendingRef.current = false;
      if (clearTimerRef.current) { clearTimeout(clearTimerRef.current); clearTimerRef.current = null; }

      if (shownAtRef.current !== null) {
        const elapsed = Date.now() - shownAtRef.current;
        const remaining = minVisible - elapsed;
        if (remaining > 0) {
          clearTimerRef.current = setTimeout(() => {
            setVisible(IDLE);
            shownAtRef.current = null;
          }, remaining);
        } else {
          setVisible(IDLE);
          shownAtRef.current = null;
        }
      } else {
        setVisible(IDLE);
      }
      return;
    }

    if (internal.status === "running") {
      if (shownAtRef.current !== null) {
        // Already visible — update immediately
        setVisible(internal);
      } else if (!showTimerPendingRef.current) {
        // Start the show timer exactly once per operation start.
        // Subsequent updateOperation calls update internalRef but do NOT restart the timer.
        showTimerPendingRef.current = true;
        showTimerRef.current = setTimeout(() => {
          showTimerRef.current = null;
          showTimerPendingRef.current = false;
          // Use the latest internal state at fire time (not the captured snapshot)
          setVisible(internalRef.current);
          shownAtRef.current = Date.now();
        }, showDelay);
      }
      // If showTimerPendingRef.current is already true, the timer is already running;
      // internalRef.current is up to date so when it fires it will show latest state.
      return;
    }

    // success / warning / error — cancel any pending show timer and display immediately
    if (showTimerRef.current) { clearTimeout(showTimerRef.current); showTimerRef.current = null; }
    showTimerPendingRef.current = false;
    if (clearTimerRef.current) { clearTimeout(clearTimerRef.current); clearTimerRef.current = null; }

    if (shownAtRef.current === null) shownAtRef.current = Date.now();
    setVisible(internal);

    if (internal.status === "success") {
      clearTimerRef.current = setTimeout(() => {
        setVisible(IDLE);
        setInternal(IDLE);
        shownAtRef.current = null;
      }, successClear);
    }
  }, [internal, showDelay, minVisible, successClear]);

  // Cleanup on unmount
  useEffect(() => clearAllTimers, [clearAllTimers]);

  const startOperation = useCallback(
    (phase: string, options: Partial<Omit<OperationProgressState, "status" | "phase">> = {}) => {
      setInternal({ status: "running", phase, ...options });
    },
    [],
  );

  const updateOperation = useCallback(
    (phase: string, options: Partial<Omit<OperationProgressState, "status" | "phase">> = {}) => {
      setInternal((prev) => ({ ...prev, status: "running", phase, ...options }));
    },
    [],
  );

  const completeOperation = useCallback(
    (phase: string, options: Partial<Omit<OperationProgressState, "status" | "phase">> = {}) => {
      setInternal({ status: "success", phase, ...options });
    },
    [],
  );

  const warnOperation = useCallback(
    (phase: string, options: Partial<Omit<OperationProgressState, "status" | "phase">> = {}) => {
      setInternal({ status: "warning", phase, ...options });
    },
    [],
  );

  const failOperation = useCallback(
    (phase: string, errorMessage: string, options: Partial<Omit<OperationProgressState, "status" | "phase" | "errorMessage">> = {}) => {
      setInternal({ status: "error", phase, errorMessage, ...options });
    },
    [],
  );

  const resetOperation = useCallback(() => {
    clearAllTimers();
    setInternal(IDLE);
    setVisible(IDLE);
    shownAtRef.current = null;
  }, [clearAllTimers]);

  return {
    progress: visible,
    startOperation,
    updateOperation,
    completeOperation,
    warnOperation,
    failOperation,
    resetOperation,
  };
}
