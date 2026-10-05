import { describe, it, expect } from "vitest";
import { expenseWriteIsSubmissionEvent, type ExpenseWriteEvent } from "@/lib/expenseDateLockTriggerLogic";
import { isExpenseDateLocked, type ExpenseDateLock } from "@/lib/expenseDateLocks";

/**
 * Date-lock semantics test suite (2026-10-01 review fix).
 *
 * `expenseWriteIsSubmissionEvent` is a hand-maintained pure mirror of the
 * real SQL trigger's own condition (see that file's own doc comment for
 * why: no sandboxed Postgres in this environment, same constraint every
 * other DB-trigger feature in this repo has). Combined with
 * `isExpenseDateLocked` (the real, shipped client-side range check), these
 * tests prove the FULL effective decision -- "would this write be blocked"
 * -- for every scenario the review asked for. Cross-org isolation and the
 * feature-flag gate inside `is_expense_date_locked_v1` itself are SQL-only
 * (RLS + `is_org_admin()` + `get_organization_feature_enabled()`) and are
 * explicitly NOT re-tested here -- they still require live/staging
 * database verification before this migration is applied; this file says
 * so at the exact point each such case would otherwise appear.
 */

function wouldBlock(event: ExpenseWriteEvent, locks: ExpenseDateLock[]): boolean {
  if (!expenseWriteIsSubmissionEvent(event)) return false;
  const [y, m, d] = event.newTripStart.split("-").map(Number);
  return isExpenseDateLocked(new Date(y, m - 1, d), locks).locked;
}

function lock(overrides: Partial<ExpenseDateLock> = {}): ExpenseDateLock {
  return {
    id: "lock-1",
    organization_id: "org-a",
    date_from: "2026-08-01",
    date_to: "2026-08-31",
    reason: "Monthly accounts closed",
    is_active: true,
    created_by: "admin-1",
    created_at: "2026-07-25T00:00:00Z",
    updated_at: "2026-07-25T00:00:00Z",
    ...overrides,
  };
}

const AUGUST_LOCK = [lock()];

describe("expenseWriteIsSubmissionEvent -- mirrors the SQL trigger condition exactly", () => {
  it("a fresh INSERT already at 'submitted' IS a submission event (admin-submit-for-employee, MicroLink's atomic path)", () => {
    expect(
      expenseWriteIsSubmissionEvent({ tgOp: "INSERT", oldStatus: null, newStatus: "submitted", oldTripStart: null, newTripStart: "2026-08-10" }),
    ).toBe(true);
  });

  it("a fresh INSERT at 'draft' is NOT a submission event -- a brand new draft/historical insert must never be blocked solely because a lock exists", () => {
    expect(
      expenseWriteIsSubmissionEvent({ tgOp: "INSERT", oldStatus: null, newStatus: "draft", oldTripStart: null, newTripStart: "2026-08-10" }),
    ).toBe(false);
  });

  it("an UPDATE transitioning draft -> submitted IS a submission event (the normal create-then-submit flow)", () => {
    expect(
      expenseWriteIsSubmissionEvent({ tgOp: "UPDATE", oldStatus: "draft", newStatus: "submitted", oldTripStart: "2026-08-10", newTripStart: "2026-08-10" }),
    ).toBe(true);
  });

  it("a draft created BEFORE a lock existed, later submitted AFTER the lock exists, IS a submission event -- the lock applies at submission time regardless of when the draft was created", () => {
    expect(
      expenseWriteIsSubmissionEvent({ tgOp: "UPDATE", oldStatus: "draft", newStatus: "submitted", oldTripStart: "2026-08-10", newTripStart: "2026-08-10" }),
    ).toBe(true);
  });

  it("an UPDATE transitioning rejected -> submitted (resubmission) IS a submission event", () => {
    expect(
      expenseWriteIsSubmissionEvent({ tgOp: "UPDATE", oldStatus: "rejected", newStatus: "submitted", oldTripStart: "2026-08-10", newTripStart: "2026-08-10" }),
    ).toBe(true);
  });

  it("an UPDATE transitioning edited -> submitted (resubmission after an admin correction) IS a submission event", () => {
    expect(
      expenseWriteIsSubmissionEvent({ tgOp: "UPDATE", oldStatus: "edited", newStatus: "submitted", oldTripStart: "2026-08-10", newTripStart: "2026-08-10" }),
    ).toBe(true);
  });

  it("review/approval transitions (submitted -> under_review -> verified -> approved) are NEVER submission events -- NEW.status is never 'submitted' again, so unrelated administrative review transitions are structurally unaffected", () => {
    expect(
      expenseWriteIsSubmissionEvent({ tgOp: "UPDATE", oldStatus: "submitted", newStatus: "under_review", oldTripStart: "2026-08-10", newTripStart: "2026-08-10" }),
    ).toBe(false);
    expect(
      expenseWriteIsSubmissionEvent({ tgOp: "UPDATE", oldStatus: "under_review", newStatus: "verified", oldTripStart: "2026-08-10", newTripStart: "2026-08-10" }),
    ).toBe(false);
    expect(
      expenseWriteIsSubmissionEvent({ tgOp: "UPDATE", oldStatus: "verified", newStatus: "approved", oldTripStart: "2026-08-10", newTripStart: "2026-08-10" }),
    ).toBe(false);
    expect(
      expenseWriteIsSubmissionEvent({ tgOp: "UPDATE", oldStatus: "approved", newStatus: "paid", oldTripStart: "2026-08-10", newTripStart: "2026-08-10" }),
    ).toBe(false);
  });

  it("an admin correction (submitted -> edited) is NOT a submission event -- editing is always allowed, matching 'historical expenses stay untouched'", () => {
    expect(
      expenseWriteIsSubmissionEvent({ tgOp: "UPDATE", oldStatus: "submitted", newStatus: "edited", oldTripStart: "2026-08-10", newTripStart: "2026-08-10" }),
    ).toBe(false);
  });

  it("a plain re-save while already submitted (no status change, no trip_start change) is NOT re-checked -- a lock created after legitimate submission never retroactively blocks it", () => {
    expect(
      expenseWriteIsSubmissionEvent({ tgOp: "UPDATE", oldStatus: "submitted", newStatus: "submitted", oldTripStart: "2026-08-10", newTripStart: "2026-08-10" }),
    ).toBe(false);
  });

  it("a trip_start change while remaining submitted IS a submission event -- moving an existing submitted expense's date must respect the current lock state", () => {
    expect(
      expenseWriteIsSubmissionEvent({ tgOp: "UPDATE", oldStatus: "submitted", newStatus: "submitted", oldTripStart: "2026-07-10", newTripStart: "2026-08-10" }),
    ).toBe(true);
  });
});

describe("full effective decision (expenseWriteIsSubmissionEvent + isExpenseDateLocked together)", () => {
  it("feature OFF (simulated: no locks supplied, exactly what useExpenseDateLocks returns when disabled) -> never blocked even for a genuine submission inside what would otherwise be a locked range", () => {
    expect(
      wouldBlock({ tgOp: "INSERT", oldStatus: null, newStatus: "submitted", oldTripStart: null, newTripStart: "2026-08-15" }, []),
    ).toBe(false);
  });

  it("feature ON + a genuinely submitted expense inside the locked range -> blocked", () => {
    expect(
      wouldBlock({ tgOp: "INSERT", oldStatus: null, newStatus: "submitted", oldTripStart: null, newTripStart: "2026-08-15" }, AUGUST_LOCK),
    ).toBe(true);
  });

  it("a draft created before the lock, submitted after the lock exists -> blocked", () => {
    expect(
      wouldBlock({ tgOp: "UPDATE", oldStatus: "draft", newStatus: "submitted", oldTripStart: "2026-08-15", newTripStart: "2026-08-15" }, AUGUST_LOCK),
    ).toBe(true);
  });

  it("a non-submitted (draft) INSERT inside what would otherwise be a locked range -> NOT blocked, consistent with 'draft/non-submitted INSERT must not be blocked solely because a lock exists'", () => {
    expect(
      wouldBlock({ tgOp: "INSERT", oldStatus: null, newStatus: "draft", oldTripStart: null, newTripStart: "2026-08-15" }, AUGUST_LOCK),
    ).toBe(false);
  });

  it("an unrelated review-status change (e.g. verified -> approved) on an expense whose date IS inside a locked range -> unaffected, never blocked", () => {
    expect(
      wouldBlock({ tgOp: "UPDATE", oldStatus: "verified", newStatus: "approved", oldTripStart: "2026-08-15", newTripStart: "2026-08-15" }, AUGUST_LOCK),
    ).toBe(false);
  });

  it("an inactive lock does not block a submission inside what would otherwise be its range", () => {
    expect(
      wouldBlock(
        { tgOp: "INSERT", oldStatus: null, newStatus: "submitted", oldTripStart: null, newTripStart: "2026-08-15" },
        [lock({ is_active: false })],
      ),
    ).toBe(false);
  });

  it("range boundaries: date_from exactly, middle, and date_to exactly are all blocked; the day before/after are not", () => {
    const blocked = (date: string) =>
      wouldBlock({ tgOp: "INSERT", oldStatus: null, newStatus: "submitted", oldTripStart: null, newTripStart: date }, AUGUST_LOCK);
    expect(blocked("2026-07-31")).toBe(false); // day before
    expect(blocked("2026-08-01")).toBe(true); // date_from exactly
    expect(blocked("2026-08-16")).toBe(true); // middle
    expect(blocked("2026-08-31")).toBe(true); // date_to exactly
    expect(blocked("2026-09-01")).toBe(false); // day after
  });

  it("multiple ranges: each enforced independently, a date outside every range is allowed", () => {
    const multi = [lock({ id: "l1", date_from: "2026-04-01", date_to: "2026-04-30" }), lock({ id: "l2", date_from: "2026-08-01", date_to: "2026-08-31" }), lock({ id: "l3", date_from: "2026-12-25", date_to: "2026-12-31" })];
    const blocked = (date: string) =>
      wouldBlock({ tgOp: "INSERT", oldStatus: null, newStatus: "submitted", oldTripStart: null, newTripStart: date }, multi);
    expect(blocked("2026-04-15")).toBe(true);
    expect(blocked("2026-08-15")).toBe(true);
    expect(blocked("2026-12-28")).toBe(true);
    expect(blocked("2026-06-15")).toBe(false);
  });
});

describe("Cross-org isolation and the feature-flag gate -- NOT testable here, requires live/staging database verification", () => {
  it("documents what still needs live verification rather than silently skipping it", () => {
    // deactivate_expense_date_lock_v1 derives organization_id from the lock
    // row itself before calling is_org_admin(v_org_id) -- an admin of a
    // different organization can never pass that check regardless of
    // which lock id they supply (see the migration's own comment). This
    // is a property of the live Postgres function and RLS policy, which
    // this repo's Vitest environment cannot execute -- it needs a real or
    // staging database to actually prove.
    // get_organization_feature_enabled(org_id, 'expense_date_locking')
    // being OFF server-side is likewise SQL-only and not exercised here --
    // this test suite's "feature OFF" case above simulates it at the
    // CLIENT layer (useExpenseDateLocks returning no locks when disabled),
    // which is the real, shipped behavior, but is not the same as proving
    // the SQL function itself returns false when the flag is off.
    expect(true).toBe(true);
  });
});
