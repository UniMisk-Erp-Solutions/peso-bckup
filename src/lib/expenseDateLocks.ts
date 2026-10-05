/**
 * Admin-controlled expense date locking (hotfix, 2026-10-01).
 *
 * Canonical client-side helpers for "is this expense date locked" -- every
 * screen that needs this answer (ExpenseForm's single-date picker,
 * ExpenseBatchForm's shared-date picker, any future one) MUST go through
 * `isExpenseDateLocked` here rather than re-deriving its own range check,
 * per the task's own explicit requirement for ONE canonical helper.
 *
 * This is UX only. The real, unbypassable enforcement is the
 * `enforce_expense_date_lock` trigger on `public.expenses`
 * (20261018100000_expense_date_locking_v1.sql) -- this module exists so the
 * UI can disable/flag locked dates BEFORE a submit attempt, matching the
 * explicit UX requirement that an employee should never fill out a whole
 * form only to be rejected at the end.
 */
import { supabase } from "@/integrations/supabase/client";

// organization_expense_date_locks is new (20261018100000_expense_date_locking_v1.sql)
// and not yet in the generated Supabase types -- same established cast
// pattern used elsewhere in this codebase for a brand-new table ahead of a
// types regen (e.g. src/lib/expenseFieldMemory.ts).
const db = supabase as any;

export interface ExpenseDateLock {
  id: string;
  organization_id: string;
  /** yyyy-MM-dd */
  date_from: string;
  /** yyyy-MM-dd */
  date_to: string;
  reason: string | null;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

function toLocalDateOnly(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export type ExpenseDateLocksFetchResult =
  | { ok: true; locks: ExpenseDateLock[] }
  | { ok: false; locks: ExpenseDateLock[]; error: string };

/**
 * Fetches every lock row (active and inactive) for an organization --
 * inactive rows are included so an admin-facing list can show history, but
 * `isExpenseDateLocked` below only ever honors `is_active === true` rows.
 *
 * Distinguishes "successfully loaded zero locks" from "failed to load lock
 * data" (2026-10-01 review fix) -- the DATABASE trigger still protects the
 * write either way, but a screen gating its date picker on this needs to
 * know when it genuinely cannot vouch for "no known locks", so it can warn
 * the employee instead of silently looking identical to a real all-clear.
 */
export async function fetchExpenseDateLocksResult(organizationId: string): Promise<ExpenseDateLocksFetchResult> {
  if (!organizationId) return { ok: true, locks: [] };
  const { data, error } = await db
    .from("organization_expense_date_locks")
    .select("id, organization_id, date_from, date_to, reason, is_active, created_by, created_at, updated_at")
    .eq("organization_id", organizationId)
    .order("date_from", { ascending: false });
  if (error || !data) {
    return { ok: false, locks: [], error: error?.message ?? "Could not load expense date locks." };
  }
  return { ok: true, locks: data as ExpenseDateLock[] };
}

/**
 * Convenience wrapper that degrades to "no known locks" on any error --
 * kept for callers (the admin management list) where a plain array is
 * enough and a transient fetch failure degrading to an empty list is
 * acceptable (the admin can simply retry/reload). A screen that needs to
 * tell "zero locks" apart from "failed to load" (the employee-facing date
 * picker) should use `fetchExpenseDateLocksResult` instead -- see
 * `useExpenseDateLocks.ts`.
 */
export async function fetchExpenseDateLocks(organizationId: string): Promise<ExpenseDateLock[]> {
  return (await fetchExpenseDateLocksResult(organizationId)).locks;
}

export interface ExpenseDateLockResult {
  locked: boolean;
  reason: string | null;
}

/**
 * THE canonical check. Pass the full lock list (active + inactive is fine
 * -- only active rows are ever honored) and the candidate expense date.
 * Pure and synchronous so it can be called on every keystroke/calendar
 * render without a network round-trip.
 */
export function isExpenseDateLocked(date: Date | null | undefined, locks: ExpenseDateLock[]): ExpenseDateLockResult {
  if (!date || !locks || locks.length === 0) return { locked: false, reason: null };
  const candidate = toLocalDateOnly(date);
  for (const lock of locks) {
    if (!lock.is_active) continue;
    if (candidate >= lock.date_from && candidate <= lock.date_to) {
      return { locked: true, reason: lock.reason ?? null };
    }
  }
  return { locked: false, reason: null };
}

/** Thin wrapper for the `Calendar`'s own `disabled` predicate -- combine with `(date) => date > today` etc. via a small `||` chain at the call site, never replace the existing future-date rule. */
export function makeIsDateLockedPredicate(locks: ExpenseDateLock[]): (date: Date) => boolean {
  return (date: Date) => isExpenseDateLocked(date, locks).locked;
}

/**
 * The ONE place that turns an `isExpenseDateLocked` result into the
 * user-facing explanation (admin reason, or a plain-language fallback when
 * none was given) -- every screen that needs to SHOW why a date is closed
 * (inline field notice, Calendar tooltip/aria-label, a mobile tap message)
 * calls this instead of re-deriving its own "reason ? ... : ..." text, so
 * the copy can never drift between them. Returns `null` for a date that
 * isn't locked (including one that's merely a future date, or matches only
 * an INACTIVE lock -- `isExpenseDateLocked` already excludes those).
 */
export function getExpenseDateLockMessage(
  date: Date | null | undefined,
  locks: ExpenseDateLock[],
  t: (key: string, options?: Record<string, unknown>) => string,
): string | null {
  const result = isExpenseDateLocked(date, locks);
  if (!result.locked) return null;
  if (result.reason) {
    return t("dateLock.closedWithReason", { reason: result.reason });
  }
  // No admin-provided reason: "This expense date is closed for submission."
  // followed by the plain-language fallback, exactly as specified -- never
  // technical/raw-error language.
  return `${t("dateLock.closed")} ${t("dateLock.adminBlocked")}`;
}
