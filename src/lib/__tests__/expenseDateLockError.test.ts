/**
 * Client classifier for the date-lock enforcement trigger's rejection
 * (ERRCODE 'PW010', DETAIL 'EXPENSE_DATE_LOCKED' -- see
 * supabase/migrations/20261018100000_expense_date_locking_v1.sql,
 * trg_enforce_expense_date_lock). Same precedent as PW001 in
 * src/lib/__tests__/orgRequiredExpenseFieldsPolicy.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  EXPENSE_DATE_LOCKED_ERROR_CODE,
  EXPENSE_DATE_LOCKED_MESSAGE,
  formatExpenseDateLockError,
  isExpenseDateLockedError,
} from "../expenseDateLockError";

/** The shape supabase-js hands back for a PostgreSQL RAISE with USING. */
const trigError = {
  code: "PW010",
  message: "This expense date is closed for submission.",
  details: "EXPENSE_DATE_LOCKED",
  hint: "An organization admin has locked this date range for new submissions; existing, already-submitted expenses in that range are unaffected.",
};

describe("isExpenseDateLockedError", () => {
  it("recognises the trigger's rejection by its stable SQLSTATE", () => {
    expect(EXPENSE_DATE_LOCKED_ERROR_CODE).toBe("PW010");
    expect(isExpenseDateLockedError(trigError)).toBe(true);
  });

  it("also recognises it from the DETAIL marker alone (a wrapper that dropped .code)", () => {
    expect(isExpenseDateLockedError({ details: "EXPENSE_DATE_LOCKED" })).toBe(true);
  });

  it("does not mistake an unrelated error for this one", () => {
    expect(isExpenseDateLockedError({ code: "PW001", message: "other policy" })).toBe(false);
    expect(isExpenseDateLockedError({ code: "23514" })).toBe(false);
    expect(isExpenseDateLockedError(new Error("boom"))).toBe(false);
    expect(isExpenseDateLockedError(null)).toBe(false);
    expect(isExpenseDateLockedError(undefined)).toBe(false);
    expect(isExpenseDateLockedError("a string")).toBe(false);
  });
});

describe("formatExpenseDateLockError", () => {
  it("maps a representative PW010 error shape to the one friendly sentence, not a generic 'Database error'", () => {
    const shown = formatExpenseDateLockError(trigError);
    expect(shown).toBe(EXPENSE_DATE_LOCKED_MESSAGE);
    expect(shown).toBe("This expense date is closed for submission.");
    expect(shown).not.toMatch(/database error/i);
    expect(shown).not.toMatch(/PW010/);
  });

  it("returns null (so callers fall through to their own generic formatter) for any other error", () => {
    expect(formatExpenseDateLockError({ code: "PW001", message: "x" })).toBeNull();
    expect(formatExpenseDateLockError(new Error("network down"))).toBeNull();
    expect(formatExpenseDateLockError(null)).toBeNull();
  });
});
