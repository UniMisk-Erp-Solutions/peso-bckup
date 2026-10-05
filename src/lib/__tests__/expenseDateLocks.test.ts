/**
 * `getExpenseDateLockMessage` -- the ONE canonical source for the
 * user-facing explanation of why an expense date is closed (2026-10-01,
 * "show date-lock reason" UX pass). Built directly on top of the existing,
 * already-proven `isExpenseDateLocked` range check (see
 * `expenseDateLocking.test.ts` for its own boundary/inactive-lock matrix) --
 * these tests only cover the message-composition layer this file adds.
 */
import { describe, it, expect } from "vitest";
import { getExpenseDateLockMessage, type ExpenseDateLock } from "@/lib/expenseDateLocks";

function lock(overrides: Partial<ExpenseDateLock> = {}): ExpenseDateLock {
  return {
    id: "lock-1",
    organization_id: "org-a",
    date_from: "2026-08-01",
    date_to: "2026-08-31",
    reason: "Monthly accounts have been closed.",
    is_active: true,
    created_by: "admin-1",
    created_at: "2026-07-25T00:00:00Z",
    updated_at: "2026-07-25T00:00:00Z",
    ...overrides,
  };
}

/** A minimal, faithful stand-in for i18next's `t` -- resolves the real
 *  English copy for the two keys this helper calls, with real {{reason}}
 *  interpolation, so these tests exercise the actual composed sentence. */
function t(key: string, options?: Record<string, unknown>): string {
  const strings: Record<string, string> = {
    "dateLock.closed": "This expense date is closed for submission.",
    "dateLock.closedWithReason": "This expense date is closed for submission. Reason: {{reason}}",
    "dateLock.adminBlocked": "Expense submission has been blocked by your admin for this date.",
  };
  const template = strings[key] ?? key;
  if (!options) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, name) => String(options[name] ?? ""));
}

describe("getExpenseDateLockMessage", () => {
  it("locked date + a reason -> the admin's reason is shown", () => {
    const message = getExpenseDateLockMessage(new Date(2026, 7, 5), [lock()], t);
    expect(message).toBe("This expense date is closed for submission. Reason: Monthly accounts have been closed.");
  });

  it("locked date + no reason -> the plain-language fallback is shown, never technical language", () => {
    const message = getExpenseDateLockMessage(new Date(2026, 7, 5), [lock({ reason: null })], t);
    expect(message).toBe(
      "This expense date is closed for submission. Expense submission has been blocked by your admin for this date.",
    );
    expect(message).not.toMatch(/sqlstate|pw010|postgres|error code/i);
  });

  it("a date outside any lock range -> null (no explanation shown at all)", () => {
    expect(getExpenseDateLockMessage(new Date(2026, 8, 1), [lock()], t)).toBeNull();
    expect(getExpenseDateLockMessage(new Date(2026, 6, 31), [lock()], t)).toBeNull();
  });

  it("multiple lock ranges with different reasons -> each date resolves its own matching reason, not the other range's", () => {
    const locks = [
      lock({ id: "aug", date_from: "2026-08-01", date_to: "2026-08-31", reason: "August books closed." }),
      lock({ id: "dec", date_from: "2026-12-20", date_to: "2026-12-31", reason: "Year-end closing." }),
    ];
    expect(getExpenseDateLockMessage(new Date(2026, 7, 10), locks, t)).toContain("August books closed.");
    expect(getExpenseDateLockMessage(new Date(2026, 11, 25), locks, t)).toContain("Year-end closing.");
    expect(getExpenseDateLockMessage(new Date(2026, 11, 25), locks, t)).not.toContain("August books closed.");
  });

  it("an inactive lock produces no message for a date inside what would otherwise be its range", () => {
    expect(getExpenseDateLockMessage(new Date(2026, 7, 5), [lock({ is_active: false })], t)).toBeNull();
  });

  it("a null/undefined date -> null", () => {
    expect(getExpenseDateLockMessage(null, [lock()], t)).toBeNull();
    expect(getExpenseDateLockMessage(undefined, [lock()], t)).toBeNull();
  });
});
