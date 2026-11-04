/**
 * Unknown-outcome recovery for Submit (PWA first-submit incident).
 *
 * One Submit press is idempotent by construction (the server maps the logical submission id to ONE expense and a
 * row already past 'draft' is never submitted again), so when a request's outcome is UNKNOWN the press is simply
 * re-run ONCE after a short settle. If the first request had committed, the re-run lands on the already-submitted
 * row and completes; if it had not, the re-run finishes the work. Never more than one automatic re-run.
 */
export type SubmitRunOutcome = "success" | "failure" | "unknown";

export async function submitWithReconcile(opts: {
  /** Runs one full press and reports how it ended. "unknown" = a request's outcome could not be determined. */
  runOnce: () => Promise<SubmitRunOutcome>;
  /** Called before the single automatic re-run (settle delay, wait for foreground, progress text). */
  beforeRetry?: () => Promise<void>;
  onReconcile?: () => void;
}): Promise<{ outcome: SubmitRunOutcome; attempts: number }> {
  const first = await opts.runOnce();
  if (first !== "unknown") return { outcome: first, attempts: 1 };
  opts.onReconcile?.();
  if (opts.beforeRetry) await opts.beforeRetry();
  const second = await opts.runOnce();
  // A second unknown outcome is surfaced to the user as a failure with the draft preserved (manual retry stays available).
  return { outcome: second === "unknown" ? "failure" : second, attempts: 2 };
}
