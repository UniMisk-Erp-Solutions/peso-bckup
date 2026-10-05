/**
 * Canonical Detailed Expense report parameter model (owner QA fix pass,
 * 2026-09-23). Year/Month/Week/Expense-Type/custom-field filters were
 * previously scattered across Reports.tsx with several dead ends (Week
 * never reached the server request at all; custom-field filters and
 * category never reached the Detailed Expense worker path specifically).
 * This module is the one place that turns the raw filter controls into the
 * exact date range + filter payload sent to the server, so there is exactly
 * one implementation to test and no second, silently-different derivation.
 */

const pad2 = (n: number) => String(n).padStart(2, "0");
const isoDate = (y: number, m: number, d: number) => `${y}-${pad2(m)}-${pad2(d)}`;

/**
 * ISO-8601 week-of-year date range (Monday–Sunday), the standard,
 * unambiguous week numbering -- there was no prior working implementation to
 * preserve (the Week control's value never reached any query), so this is a
 * fresh, deterministic choice rather than a guess at historic intent.
 */
export function isoWeekDateRange(year: number, week: number): { from: string; to: string } {
  // The Monday of ISO week 1 is the Monday of the week containing Jan 4.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7; // Mon=1 .. Sun=7
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - (jan4Day - 1));

  const start = new Date(week1Monday);
  start.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);

  return {
    from: isoDate(start.getUTCFullYear(), start.getUTCMonth() + 1, start.getUTCDate()),
    to: isoDate(end.getUTCFullYear(), end.getUTCMonth() + 1, end.getUTCDate()),
  };
}

export type DetailedExpenseDateRange = {
  dateFrom: string | null;
  dateTo: string | null;
  /** Short label for filenames/history display, e.g. "2026", "June 2026", "Week 23, 2026". */
  rangeLabel: string;
};

/**
 * Week takes precedence over Month (it already pins down which month it
 * falls in); Month takes precedence over a bare Year; no Year selected at
 * all means "all time" -- the same precedence order the filter controls are
 * laid out in (Year -> Month -> Week, each one narrowing further).
 */
export function computeDetailedExpenseDateRange(
  selectedYear: string,
  selectedMonth: string,
  selectedWeek: string,
): DetailedExpenseDateRange {
  if (!selectedYear) {
    return { dateFrom: null, dateTo: null, rangeLabel: "All time" };
  }
  const year = parseInt(selectedYear, 10);

  if (selectedWeek && selectedWeek !== "all") {
    const week = parseInt(selectedWeek, 10);
    const { from, to } = isoWeekDateRange(year, week);
    return { dateFrom: from, dateTo: to, rangeLabel: `Week ${week}, ${year}` };
  }

  if (selectedMonth && selectedMonth !== "all") {
    const month = parseInt(selectedMonth, 10);
    const from = isoDate(year, month, 1);
    const to = isoDate(year, month, new Date(year, month, 0).getDate());
    const monthName = new Date(2000, month - 1, 1).toLocaleString("default", { month: "long" });
    return { dateFrom: from, dateTo: to, rangeLabel: `${monthName} ${year}` };
  }

  return {
    dateFrom: isoDate(year, 1, 1),
    dateTo: isoDate(year, 12, 31),
    rangeLabel: String(year),
  };
}

/** Only the entries the caller actually narrowed by -- "all"/empty means unfiltered. */
export function activeCustomFieldFilters(
  customFieldFilters: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(customFieldFilters)) {
    if (!value || value === "all") continue;
    out[key] = value;
  }
  return out;
}
