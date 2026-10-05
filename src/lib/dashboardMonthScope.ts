/**
 * Pure helpers for the Dashboard Month filter (no React, no network), so the
 * option list, the "current month" rule and the card wording are unit-testable.
 *
 * The month VALUE/BOUNDS/LABEL logic is NOT reimplemented here -- it comes
 * from expenseMonthFilter.ts, the same module My Expenses / Review Expenses
 * use. This file only adapts it to the Dashboard.
 */
import {
  ALL_MONTHS,
  buildExpenseMonthOptions,
  expenseMonthOf,
  formatExpenseMonthLabel,
  type ExpenseMonthOption,
  type ExpenseMonthValue,
} from "@/lib/expenseMonthFilter";

/** The server decides "has this month ended" in Asia/Kolkata; the option list must agree. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** A Date whose UTC fields read as the current IST wall-clock date (what expenseMonthOf reads). */
export function istWallClock(now: Date): Date {
  return new Date(now.getTime() + IST_OFFSET_MS);
}

/** The current calendar month as the server sees it. */
export function currentDashboardMonth(now: Date): ExpenseMonthValue {
  return expenseMonthOf(istWallClock(now));
}

/**
 * "All time" + every calendar month from the earliest accessible expense
 * through the CURRENT month (never a future month -- a future month has no
 * month-end balance to show), newest first. No accessible expenses at all
 * still yields the current month.
 */
export function buildDashboardMonthOptions(params: {
  earliest: ExpenseMonthValue | null;
  now: Date;
}): ExpenseMonthOption[] {
  const nowMonth = currentDashboardMonth(params.now);
  const earliest =
    params.earliest && params.earliest !== "all" && params.earliest < nowMonth ? params.earliest : nowMonth;
  const built = buildExpenseMonthOptions({ earliest, now: istWallClock(params.now) });
  return built.map((o) => (o.value === ALL_MONTHS ? { value: ALL_MONTHS, label: "All time" } : o));
}

/** "31 Aug 2026" for "2026-08-31" -- pure string math, no Date, no timezone. */
export function formatBalanceAsOfDate(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  if (!y || !m || !d || m < 1 || m > 12) return isoDate;
  return `${d} ${names[m - 1]} ${y}`;
}

export { formatExpenseMonthLabel };
