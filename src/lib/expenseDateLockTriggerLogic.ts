/**
 * Pure TypeScript mirror of `trg_enforce_expense_date_lock`'s own decision
 * logic (`supabase/migrations/20261018100000_expense_date_locking_v1.sql`).
 *
 * This repo's environment has no sandboxed Postgres to run a real SQL
 * integration test against the live trigger (consistent with every other
 * database-trigger feature in this codebase's own test suite -- the
 * state-machine trigger this one is modeled on has no SQL test runner
 * either). This module exists so the TRIGGER'S OWN CONDITION -- which was
 * the exact thing review found too broad -- has an automated regression
 * test here, in the one test infrastructure this repo actually has
 * (Vitest), kept in lockstep BY HAND with the SQL. It is a contract test,
 * not a substitute for live database verification: before this migration
 * is ever applied to a real database, the SQL itself should still be
 * re-read against this file to confirm they have not drifted, and ideally
 * exercised against a real/staging database at that time.
 *
 * Mirrors exactly:
 *   IF NEW.status = 'submitted' AND (
 *        TG_OP = 'INSERT'
 *        OR OLD.status IS DISTINCT FROM NEW.status
 *        OR OLD.trip_start IS DISTINCT FROM NEW.trip_start
 *      )
 *   THEN check the lock
 */
export interface ExpenseWriteEvent {
  tgOp: "INSERT" | "UPDATE";
  /** null for an INSERT -- there is no OLD row. */
  oldStatus: string | null;
  newStatus: string;
  /** yyyy-MM-dd. null for an INSERT. */
  oldTripStart: string | null;
  /** yyyy-MM-dd. */
  newTripStart: string;
}

/**
 * Whether this write is the "a new submission happened" business event the
 * date lock governs -- i.e. whether the trigger even evaluates the lock
 * range at all. Returning false here means the row is NEVER blocked by the
 * date lock for this write, regardless of trip_start or any active lock.
 */
export function expenseWriteIsSubmissionEvent(event: ExpenseWriteEvent): boolean {
  if (event.newStatus !== "submitted") return false;
  if (event.tgOp === "INSERT") return true;
  if (event.oldStatus !== event.newStatus) return true;
  if (event.oldTripStart !== event.newTripStart) return true;
  return false;
}
