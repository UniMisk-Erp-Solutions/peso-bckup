/** Mirrors src/lib/detailedExpenseReportFilters.ts for edge worker date resolution. */
const pad2 = (n: number) => String(n).padStart(2, "0");
const isoDate = (y: number, m: number, d: number) => `${y}-${pad2(m)}-${pad2(d)}`;

function isoWeekDateRange(year: number, week: number): { from: string; to: string } {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
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

export function computeDetailedExpenseDateRange(
  selectedYear: string,
  selectedMonth: string,
  selectedWeek: string,
): { dateFrom: string | null; dateTo: string | null } {
  if (!selectedYear) return { dateFrom: null, dateTo: null };
  const year = parseInt(selectedYear, 10);
  if (selectedWeek && selectedWeek !== "all") {
    const { from, to } = isoWeekDateRange(year, parseInt(selectedWeek, 10));
    return { dateFrom: from, dateTo: to };
  }
  if (selectedMonth && selectedMonth !== "all") {
    const month = parseInt(selectedMonth, 10);
    return {
      dateFrom: isoDate(year, month, 1),
      dateTo: isoDate(year, month, new Date(year, month, 0).getDate()),
    };
  }
  return { dateFrom: isoDate(year, 1, 1), dateTo: isoDate(year, 12, 31) };
}

export function resolveDetailedExpenseRpcDates(raw: Record<string, unknown>): {
  dateFrom: string | null;
  dateTo: string | null;
} {
  if (raw.date_from || raw.date_to) {
    return {
      dateFrom: raw.date_from ? String(raw.date_from) : null,
      dateTo: raw.date_to ? String(raw.date_to) : null,
    };
  }
  const year = raw.year ? String(raw.year) : "";
  const month = raw.month ? String(raw.month) : "all";
  const week = raw.week ? String(raw.week) : "all";
  return computeDetailedExpenseDateRange(year, month, week);
}
