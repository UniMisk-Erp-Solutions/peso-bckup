/**
 * Review submit-driven query model (DOC-080 §6-§14).
 *
 * The Review page separates DRAFT query controls (what the reviewer is
 * composing) from the APPLIED query (what is actually on screen). Changing
 * Status / Sort / Time / custom filters mutates the draft only and issues ZERO
 * network requests; pressing Search commits the whole draft to the applied query
 * AT ONCE, and exactly one coherent query runs (§8/§29).
 *
 * This module is the pure, unit-testable core of that model:
 *  - the AppliedReviewQuery shape and its default,
 *  - `isServerQueryActive` — the BROAD replacement for the old
 *    `employee || generalSearch` predicate (§14): ANY applied server-supported
 *    modifier (status, sort, time, custom filters, employee, general search)
 *    routes through the server queue RPC, so "Level 2 Verified" alone no longer
 *    falls back to the normal full-scope fetch + client filter + enrichment storm,
 *  - the server-parameter mappings (status → statuses, time → date range,
 *    sort passthrough, custom-field record → ReviewCustomFilter[]),
 *  - a stable applied-query key that INCLUDES custom filters (§37).
 *
 * It imports nothing from EngineerReview and performs no I/O.
 */

import type { ReviewCustomFilter, ReviewQueueSort } from "@/features/reviewQueueServer/types";
import {
  ALL_MONTHS,
  expenseMonthBounds,
  expenseMonthInclusiveEnd,
  type ExpenseMonthValue,
} from "@/lib/expenseMonthFilter";

/** Draft/applied custom-field selection: display-label → chosen value ("all" = off). */
export type ReviewCustomFilterRecord = Record<string, string>;

export const CUSTOM_FIELD_FILTER_ALL = "all";

/** The immutable identity + display of the applied employee (never a mutable name key). */
export type AppliedEmployee = {
  userId: string;
  name: string;
  employeeId: string | null;
  email: string | null;
};

/**
 * The committed query the list actually reflects. Draft controls never write
 * here directly — only the Search submit coordinator does, atomically, bumping
 * `revision` once per user submit (§8/§29).
 */
export type AppliedReviewQuery = {
  employeeUserId: string | null;
  employeeDisplay: AppliedEmployee | null;
  generalSearch: string | null;
  /** The raw submitted search text that produced employee/general (for no-relookup, §9/§47). */
  submittedSearch: string | null;
  status: string;
  sortBy: string;
  sortOrder: "asc" | "desc";
  timePeriod: string;
  /**
   * Exact calendar MONTH+YEAR filter on `expenses.trip_start`, mutually
   * exclusive with `timePeriod`'s relative period. Unlike every other field
   * here, this is applied IMMEDIATELY on selection -- it bypasses the
   * draft/Search-submit gate entirely, so it has no draft twin.
   */
  expenseMonth: ExpenseMonthValue;
  customFilters: ReviewCustomFilterRecord;
  showOnlyActionable: boolean;
  includeTeamLeaderReports: boolean;
  includeExecutiveReports: boolean;
  /** Bumped once per Search submit; every core fetch effect keys off this. */
  revision: number;
};

export const DEFAULT_SORT_BY = "created_at";
export const DEFAULT_SORT_ORDER: "asc" | "desc" = "desc";
export const DEFAULT_TIME_PERIOD = "all";
export const DEFAULT_STATUS = "all";
export const DEFAULT_EXPENSE_MONTH: ExpenseMonthValue = ALL_MONTHS;

/** A fresh, unfiltered applied query. Hierarchy defaults are supplied by the caller. */
export function defaultAppliedReviewQuery(
  overrides?: Partial<AppliedReviewQuery>,
): AppliedReviewQuery {
  return {
    employeeUserId: null,
    employeeDisplay: null,
    generalSearch: null,
    submittedSearch: null,
    status: DEFAULT_STATUS,
    sortBy: DEFAULT_SORT_BY,
    sortOrder: DEFAULT_SORT_ORDER,
    timePeriod: DEFAULT_TIME_PERIOD,
    expenseMonth: DEFAULT_EXPENSE_MONTH,
    customFilters: {},
    showOnlyActionable: false,
    includeTeamLeaderReports: false,
    includeExecutiveReports: false,
    revision: 0,
    ...overrides,
  };
}

/** True when the record has at least one field set to a concrete (non-"all") value. */
export function hasActiveCustomFilters(record: ReviewCustomFilterRecord | undefined): boolean {
  if (!record) return false;
  for (const value of Object.values(record)) {
    if (value && String(value).trim() !== "" && value !== CUSTOM_FIELD_FILTER_ALL) return true;
  }
  return false;
}

/** True only for the completely-default sort (created_at, descending). */
export function isDefaultSort(sortBy: string, sortOrder: string): boolean {
  return sortBy === DEFAULT_SORT_BY && sortOrder === DEFAULT_SORT_ORDER;
}

/**
 * THE mode decision (§14/§21). Server-query mode is active when ANY applied
 * server-supported modifier is set: employee, general search, a non-default
 * status, a non-default sort, a non-"all" time period, an exact expense
 * month, or any custom filter.
 *
 * The actionable toggle and the hierarchy-inclusion controls are DELIBERATELY
 * excluded — the actionable filter stays a client-side refinement over the
 * loaded page (§41) and hierarchy inclusion changes reviewer scope rather than
 * requesting server-filtered results (§42). A completely-default query (no
 * employee, no search, status "all", default sort, time "all", month "all",
 * no custom filters) is the ONLY normal-mode query (§21).
 */
export function isServerQueryActive(
  q: Pick<
    AppliedReviewQuery,
    | "employeeUserId"
    | "generalSearch"
    | "status"
    | "sortBy"
    | "sortOrder"
    | "timePeriod"
    | "expenseMonth"
    | "customFilters"
  >,
): boolean {
  return Boolean(
    q.employeeUserId ||
      (q.generalSearch && q.generalSearch.trim() !== "") ||
      q.status !== DEFAULT_STATUS ||
      !isDefaultSort(q.sortBy, q.sortOrder) ||
      q.timePeriod !== DEFAULT_TIME_PERIOD ||
      q.expenseMonth !== DEFAULT_EXPENSE_MONTH ||
      hasActiveCustomFilters(q.customFilters),
  );
}

/** Map the status dropdown to the server `p_statuses` array. "all" → null (no filter). */
export function statusToServerStatuses(status: string): string[] | null {
  if (!status || status === DEFAULT_STATUS) return null;
  return [status];
}

/** Map (sortBy, sortOrder) to the server sort enum. Mirrors filteredReviewFetch. */
export function appliedSortToServerSort(sortBy: string, sortOrder: string): ReviewQueueSort {
  const desc = sortOrder !== "asc";
  if (sortBy === "trip_start") return desc ? "expense_date_desc" : "expense_date_asc";
  return desc ? "created_desc" : "created_asc";
}

/**
 * Subtract calendar months from a UTC date, CLAMPING the day-of-month to the
 * last valid day of the target month instead of letting it overflow (the
 * final-pass correctness fix: raw `date.setUTCMonth(date.getUTCMonth() - n)`
 * overflows at month ends -- e.g. 2026-03-31 minus one month naively becomes
 * March 3, 2026, since February only has 28 days and JS's Date setters roll
 * the excess forward into the next month instead of clamping).
 *
 * `months` may be any non-negative integer (12 for one year, 36 for three
 * years, etc.) -- there is deliberately no separate year-subtraction path;
 * "1y" is just `subtractUtcMonthsClamped(d, 12)`, which is also what makes
 * 2024-02-29 minus one year correctly land on 2023-02-28 rather than
 * overflowing into March.
 */
export function subtractUtcMonthsClamped(date: Date, months: number): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();

  const totalMonths = year * 12 + month - months;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonth = ((totalMonths % 12) + 12) % 12;

  // Day 0 of the month AFTER the target month is the target month's last day.
  const lastDayOfTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const clampedDay = Math.min(day, lastDayOfTargetMonth);

  return new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      clampedDay,
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
}

/**
 * Derive an inclusive lower date bound from the time period. `all` means no
 * bound. UTC-based arithmetic keeps it timezone-stable and deterministic; `now`
 * is injected so tests need no clock control (and no date-fns mock).
 *
 * Recognizes BOTH desktop's values (week/month/year/all) and mobile's
 * (7d/30d/3m/6m/1y/all, from MobileReviewQueueView) -- previously this only
 * understood the desktop set, so every mobile relative-time option silently
 * produced NO date bound at all (§19-20 hardening pass). "week"/"7d" and
 * "year"/"1y" are deliberately synonymous (same underlying bound, different
 * control surfaced them under different values).
 *
 * 7d/30d use exact day-count subtraction (`setUTCDate`, immune to month-
 * length overflow by construction); month/3m/6m/year/1y use
 * `subtractUtcMonthsClamped` so a month-end date never overflows into the
 * following month (the final-pass calendar-arithmetic fix).
 */
export function deriveDateRange(
  timePeriod: string,
  now: Date,
): { from: string | null; to: string | null } {
  if (timePeriod === "week" || timePeriod === "7d") {
    const d = new Date(now.getTime());
    d.setUTCDate(d.getUTCDate() - 7);
    return { from: d.toISOString(), to: null };
  }
  if (timePeriod === "30d") {
    const d = new Date(now.getTime());
    d.setUTCDate(d.getUTCDate() - 30);
    return { from: d.toISOString(), to: null };
  }
  if (timePeriod === "month") {
    return { from: subtractUtcMonthsClamped(now, 1).toISOString(), to: null };
  }
  if (timePeriod === "3m") {
    return { from: subtractUtcMonthsClamped(now, 3).toISOString(), to: null };
  }
  if (timePeriod === "6m") {
    return { from: subtractUtcMonthsClamped(now, 6).toISOString(), to: null };
  }
  if (timePeriod === "year" || timePeriod === "1y") {
    return { from: subtractUtcMonthsClamped(now, 12).toISOString(), to: null };
  }
  return { from: null, to: null };
}

/**
 * Derive the server date range for an exact expense month, adapted to the
 * Review queue RPCs' existing INCLUSIVE `p_date_to` contract (they filter
 * `trip_start <= p_date_to`, not `< p_date_to`). "all" (or an invalid value)
 * yields no bound, matching `deriveDateRange`'s "all" shape.
 */
export function deriveExpenseMonthDateRange(
  expenseMonth: ExpenseMonthValue,
): { from: string | null; to: string | null } {
  const bounds = expenseMonthBounds(expenseMonth);
  if (!bounds) return { from: null, to: null };
  return { from: bounds.from, to: expenseMonthInclusiveEnd(bounds.toExclusive) };
}

/**
 * One resolved server custom-field definition. The legacy Review filter UI keys
 * selections by display label only, so the applied record must be translated to
 * the server `{ source, field_id, values }` contract using the server's own
 * filter-options (which carry field_key + label + source + field_id).
 */
export type ServerCustomFieldRef = { source: "template" | "branch"; field_id: string };

/** label (lower-cased/trimmed) → the server field(s) that share that label/key. */
export type CustomFieldResolver = (label: string) => ServerCustomFieldRef[];

/**
 * Translate the label-keyed applied custom filters to the server
 * `ReviewCustomFilter[]` contract (§19).
 *
 * The server ANDs across entries and ORs within `values`. A single selected
 * value per label is the norm, so we emit one entry per resolvable label. When a
 * label resolves to several server fields (a template and a branch sharing a
 * name), we deterministically take the FIRST (template before branch, then by
 * field_id) rather than AND them together — ANDing distinct fields would produce
 * an intersection the reviewer never asked for. Unresolvable labels are dropped
 * from the server filter (the broadened mode + enrichment guard still guarantee
 * zero client `expense_form_field_values` traffic).
 */
export function customFilterRecordToServer(
  record: ReviewCustomFilterRecord | undefined,
  resolve: CustomFieldResolver,
): ReviewCustomFilter[] {
  if (!record) return [];
  const out: ReviewCustomFilter[] = [];
  for (const [label, value] of Object.entries(record)) {
    if (!value || value === CUSTOM_FIELD_FILTER_ALL || String(value).trim() === "") continue;
    const refs = resolve(label);
    if (!refs || refs.length === 0) continue;
    const chosen = [...refs].sort((a, b) => {
      if (a.source !== b.source) return a.source === "template" ? -1 : 1;
      return a.field_id.localeCompare(b.field_id);
    })[0];
    out.push({ source: chosen.source, field_id: chosen.field_id, values: [String(value)] });
  }
  return out;
}

/**
 * Stable identity for the applied query. INCLUDES custom filters, the actionable
 * toggle, the hierarchy-inclusion controls (§37) and the exact expense month
 * (§14) so the return cache and the page fetch can never mistake one filter
 * shape — or one month — for another. Independent of `revision` (two
 * identical submits share a key).
 */
export function buildAppliedQueryKey(q: AppliedReviewQuery): string {
  const mode = isServerQueryActive(q) ? "server" : "normal";
  const customEntries = Object.entries(q.customFilters ?? {})
    .filter(([, v]) => v && v !== CUSTOM_FIELD_FILTER_ALL && String(v).trim() !== "")
    .map(([k, v]) => [k, v] as const)
    .sort((a, b) => a[0].localeCompare(b[0]));
  return JSON.stringify([
    mode,
    q.employeeUserId ?? "",
    (q.generalSearch ?? "").trim().toLowerCase(),
    q.status,
    q.timePeriod,
    q.expenseMonth,
    q.sortBy,
    q.sortOrder,
    customEntries,
    q.showOnlyActionable,
    q.includeTeamLeaderReports,
    q.includeExecutiveReports,
  ]);
}
