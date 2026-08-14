/**
 * Presentation helpers for the debug queue (DOC-080).
 *
 * Deliberately local to this feature so the debug page cannot drift when the V1
 * review page changes its formatting, and vice versa.
 */

/** Never renders a bare dash for money — an absent amount reads as "—" only here. */
export function formatAmount(value: number | null | undefined, locale = "en-IN"): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatDateOnly(value: string | null | undefined, locale = "en-IN"): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "2-digit",
  }).format(d);
}

export function formatDateTime(value: string | null | undefined, locale = "en-IN"): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

/** 1-based inclusive window for "Showing X–Y of Z". */
export function pageWindow(
  pageNumber: number,
  pageSize: number,
  returned: number,
): { from: number; to: number } {
  if (returned <= 0) return { from: 0, to: 0 };
  const from = (pageNumber - 1) * pageSize + 1;
  return { from, to: from + returned - 1 };
}
