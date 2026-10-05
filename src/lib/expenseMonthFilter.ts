/**
 * Shared MONTH + YEAR exact-filter utility for Review Expenses and My Expenses.
 *
 * One source of truth for: the machine value shape, half-open UTC-safe month
 * boundaries, the full-calendar-range dropdown generation, and the display
 * label -- so neither page reimplements month parsing independently.
 *
 * The authoritative date for this filter is always `expenses.trip_start`
 * (the business/expense date), never created_at/submitted_at/updated_at or
 * any review/approval timestamp.
 *
 * All arithmetic here is pure string/integer month rollover -- no `Date`
 * object is ever used for the bounds themselves, so there is no local-
 * timezone conversion that could shift a date across a month boundary.
 * `Date` is used only where the CALLER supplies "now" (e.g. to bound the
 * dropdown's upper end), and only its UTC year/month are read.
 */

export type ExpenseMonthValue = "all" | `${number}-${string}`;

const MONTH_VALUE_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

export const ALL_MONTHS: ExpenseMonthValue = "all";

/** True for "all" or a well-formed "YYYY-MM" (01-12) value. */
export function isExpenseMonthValue(v: unknown): v is ExpenseMonthValue {
  if (v === "all") return true;
  return typeof v === "string" && MONTH_VALUE_RE.test(v);
}

function splitMonth(month: string): { year: number; month: number } {
  const [y, m] = month.split("-");
  return { year: Number(y), month: Number(m) };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function pad4(n: number): string {
  return String(n).padStart(4, "0");
}

function monthValue(year: number, month: number): ExpenseMonthValue {
  return `${pad4(year)}-${pad2(month)}` as ExpenseMonthValue;
}

/** The "YYYY-MM" value for a Date's UTC year/month (used for "now" / a trip_start). */
export function expenseMonthOf(d: Date): ExpenseMonthValue {
  return monthValue(d.getUTCFullYear(), d.getUTCMonth() + 1);
}

/** The "YYYY-MM" value for a trip_start "YYYY-MM-DD" (or any ISO-prefixed) string. */
export function expenseMonthOfDateString(tripStart: string): ExpenseMonthValue {
  const y = Number(tripStart.slice(0, 4));
  const m = Number(tripStart.slice(5, 7));
  return monthValue(y, m);
}

/** month rolled forward by one, calendar-correct across year boundaries. */
function nextMonthOf(year: number, month: number): { year: number; month: number } {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

/** month rolled backward by one, calendar-correct across year boundaries. */
function prevMonthOf(year: number, month: number): { year: number; month: number } {
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

export type ExpenseMonthBounds = {
  /** Inclusive lower bound, "YYYY-MM-01". */
  from: string;
  /** EXCLUSIVE upper bound, the 1st of the following month -- half-open range semantics. */
  toExclusive: string;
};

/**
 * Half-open [from, toExclusive) bounds for an exact "YYYY-MM" value.
 * `null` for "all" (no bound -- unfiltered).
 *
 * Usage: `trip_start >= from AND trip_start < toExclusive`. Never derive an
 * inclusive end via "last day of month 23:59:59.999" -- that is exactly the
 * fragile timestamp logic this half-open contract exists to avoid.
 */
export function expenseMonthBounds(month: ExpenseMonthValue): ExpenseMonthBounds | null {
  if (month === "all") return null;
  if (!isExpenseMonthValue(month)) return null;
  const { year, month: mo } = splitMonth(month);
  const next = nextMonthOf(year, mo);
  return {
    from: `${pad4(year)}-${pad2(mo)}-01`,
    toExclusive: `${pad4(next.year)}-${pad2(next.month)}-01`,
  };
}

/**
 * Adapts the half-open `toExclusive` bound to an INCLUSIVE end-of-month date
 * string, for a caller whose server contract predates this feature and
 * filters `<= p_date_to` rather than `< p_date_to_exclusive` (e.g. the
 * existing Review queue RPCs' `p_date_to`). `trip_start` is a DATE column
 * with no time-of-day component, so "the day before toExclusive" IS the
 * month's last calendar day -- this is exact, not an approximation, and
 * still never touches a timestamp or a local timezone.
 */
export function expenseMonthInclusiveEnd(toExclusive: string): string {
  const [y, m, d] = toExclusive.split("-").map(Number);
  const prevDayMs = Date.UTC(y, m - 1, d) - 24 * 60 * 60 * 1000;
  const prevDay = new Date(prevDayMs);
  return `${pad4(prevDay.getUTCFullYear())}-${pad2(prevDay.getUTCMonth() + 1)}-${pad2(prevDay.getUTCDate())}`;
}

/** "August 2026" for "2026-08"; "All months" for "all". */
export function formatExpenseMonthLabel(month: ExpenseMonthValue): string {
  if (month === "all") return "All months";
  if (!isExpenseMonthValue(month)) return "All months";
  const { year, month: mo } = splitMonth(month);
  return `${MONTH_NAMES[mo - 1]} ${year}`;
}

export type ExpenseMonthOption = {
  value: ExpenseMonthValue;
  label: string;
};

/** Later of two "YYYY-MM" values (zero-padded strings compare lexicographically = chronologically). */
function laterMonth(a: ExpenseMonthValue, b: ExpenseMonthValue | null | undefined): ExpenseMonthValue {
  if (!b || b === "all") return a;
  if (a === "all") return b;
  return a >= b ? a : b;
}

/**
 * Builds the full "All months" + every calendar month dropdown, newest
 * first, per §3/§4 of the month-filter spec:
 *  - EVERY calendar month between the earliest and latest bound is
 *    generated, including months with zero expenses -- never a client
 *    slice of "months that happen to have data".
 *  - the upper bound is max(current month, latest accessible trip_start
 *    month) so a legitimate future-dated expense's month is never hidden.
 *
 * `earliest` is the earliest accessible trip_start month (or null when the
 * caller has no accessible expenses at all -- the result is then just
 * `["all"]`, never a fabricated range).
 */
export function buildExpenseMonthOptions(params: {
  earliest: ExpenseMonthValue | null;
  now: Date;
  latestExpenseMonth?: ExpenseMonthValue | null;
}): ExpenseMonthOption[] {
  const options: ExpenseMonthOption[] = [{ value: "all", label: "All months" }];
  if (!params.earliest || !isExpenseMonthValue(params.earliest)) return options;

  const nowMonth = expenseMonthOf(params.now);
  const latest = laterMonth(nowMonth, params.latestExpenseMonth ?? null);
  const earliest = params.earliest;

  let cursor = splitMonth(latest);
  const end = splitMonth(earliest);
  // Safety valve: a corrupt/absurd range must never hang the browser generating options.
  let guard = 0;
  const MAX_MONTHS = 2400; // 200 years -- generous, unreachable in practice
  while ((cursor.year > end.year || (cursor.year === end.year && cursor.month >= end.month)) && guard < MAX_MONTHS) {
    const value = monthValue(cursor.year, cursor.month);
    options.push({ value, label: formatExpenseMonthLabel(value) });
    cursor = prevMonthOf(cursor.year, cursor.month);
    guard += 1;
  }
  return options;
}
