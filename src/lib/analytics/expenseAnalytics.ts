/**
 * Pure analytics helpers for the Expense Analytics Dashboard.
 * No Supabase, no React, no i18n — all functions are independently testable.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface AnalyticsExpenseRow {
  id: string;
  organization_id: string;
  user_id: string;
  title: string;
  transaction_number: string | null;
  status: string;
  total_amount: number | string | null;
  category: string | null;
  destination: string | null;
  trip_start: string | null;
  trip_end: string | null;
  created_at: string;
  updated_at: string | null;
  batch_id: string | null;
  approval_tier: string | null;
  assigned_engineer_id: string | null;
  assigned_reviewer_id: string | null;
}

export interface AnalyticsProfile {
  user_id: string;
  name: string;
  employee_id?: string | null;
}

export type DateBasis = "expense_date" | "submitted_date";
export type Granularity = "auto" | "daily" | "weekly" | "monthly";
export type DatePreset =
  | "7d"
  | "30d"
  | "90d"
  | "6m"
  | "12m"
  | "custom";

export type ExpenseStatusClass =
  | "pending"
  | "approved"
  | "rejected"
  | "draft"
  | "other";

export interface DateBucket {
  /** Stable ISO sort key: yyyy-MM-dd | yyyy-'W'ww | yyyy-MM */
  key: string;
  /** Human-readable label (computed in component with i18n) */
  label: string;
  amount: number;
  count: number;
  prevAmount?: number;
  prevCount?: number;
}

export interface CategoryBreakdown {
  category: string;
  amount: number;
  count: number;
  pct: number;
}

export interface StatusBreakdown {
  status: string;
  statusClass: ExpenseStatusClass;
  count: number;
  amount: number;
  pct: number;
  amountPct: number;
}

export interface DestinationBreakdown {
  destination: string;
  amount: number;
  count: number;
  pct: number;
}

export interface EmployeeBreakdown {
  user_id: string;
  name: string;
  employee_id?: string | null;
  totalAmount: number;
  count: number;
  avgAmount: number;
  approvedAmount: number;
  pendingAmount: number;
  rejectedAmount: number;
}

export interface PendingAgingBucket {
  label: string;
  minDays: number;
  maxDays: number | null;
  count: number;
  amount: number;
  pct: number;
}

export interface AmountHistogramBucket {
  label: string;
  min: number;
  max: number | null;
  count: number;
  amount: number;
}

export interface WeekdayBreakdown {
  /** 0 = Monday … 6 = Sunday */
  dayIndex: number;
  label: string;
  count: number;
  amount: number;
}

export interface KPIs {
  totalAmount: number;
  totalCount: number;
  avgAmount: number;
  medianAmount: number;
  pendingAmount: number;
  pendingCount: number;
  approvedAmount: number;
  approvedCount: number;
  rejectedAmount: number;
  rejectedCount: number;
  finalizedApprovalRate: number | null;
  activeSubmitters: number;
}

export interface ComparisonKPIs extends KPIs {
  prev: KPIs | null;
}

export interface AnalyticsResult {
  kpis: ComparisonKPIs;
  trend: DateBucket[];
  categoryBreakdown: CategoryBreakdown[];
  categoryTrend: Array<{ key: string; label: string; [category: string]: number | string }>;
  statusBreakdown: StatusBreakdown[];
  destinationBreakdown: DestinationBreakdown[];
  employeeBreakdown: EmployeeBreakdown[];
  pendingAging: PendingAgingBucket[];
  amountHistogram: AmountHistogramBucket[];
  weekdayBreakdown: WeekdayBreakdown[];
  cumulativeSpend: Array<{ key: string; label: string; cumulative: number; prevCumulative?: number }>;
  topExpenses: AnalyticsExpenseRow[];
  quickInsights: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Status classification
// ─────────────────────────────────────────────────────────────────────────────

const PENDING_STATUSES = new Set([
  "submitted",
  "under_review",
  "level_1_verified",
  "level_2_verified",
  "verified",
  "edited",
]);

const APPROVED_STATUSES = new Set(["approved", "paid"]);
const REJECTED_STATUSES = new Set(["rejected"]);
const DRAFT_STATUSES = new Set(["draft"]);

export function classifyExpenseStatus(status: string): ExpenseStatusClass {
  if (DRAFT_STATUSES.has(status)) return "draft";
  if (PENDING_STATUSES.has(status)) return "pending";
  if (APPROVED_STATUSES.has(status)) return "approved";
  if (REJECTED_STATUSES.has(status)) return "rejected";
  return "other";
}

export function getExpenseStatusOrder(status: string): number {
  const ORDER: Record<string, number> = {
    submitted: 0,
    under_review: 1,
    level_1_verified: 2,
    level_2_verified: 3,
    verified: 4,
    edited: 5,
    approved: 6,
    paid: 7,
    rejected: 8,
    draft: 9,
  };
  return ORDER[status] ?? 100;
}

// ─────────────────────────────────────────────────────────────────────────────
// Amount utilities
// ─────────────────────────────────────────────────────────────────────────────

export function safeAmount(v: number | string | null | undefined): number {
  const n = typeof v === "string" ? parseFloat(v) : (v ?? 0);
  return isFinite(n) ? n : 0;
}

export function computeMedian(amounts: number[]): number {
  if (amounts.length === 0) return 0;
  const sorted = [...amounts].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : ((sorted[mid - 1]! + sorted[mid]!) / 2);
}

// ─────────────────────────────────────────────────────────────────────────────
// Date utilities
// ─────────────────────────────────────────────────────────────────────────────

export function resolveGranularity(
  granularity: Granularity,
  dateFrom: Date,
  dateTo: Date,
): "daily" | "weekly" | "monthly" {
  if (granularity !== "auto") return granularity;
  const days = Math.ceil((dateTo.getTime() - dateFrom.getTime()) / 86_400_000);
  if (days <= 45) return "daily";
  if (days <= 180) return "weekly";
  return "monthly";
}

/** ISO week number (1-based, Monday start) */
function isoWeek(d: Date): number {
  const temp = new Date(d);
  temp.setHours(0, 0, 0, 0);
  temp.setDate(temp.getDate() + 3 - ((temp.getDay() + 6) % 7));
  const week1 = new Date(temp.getFullYear(), 0, 4);
  return (
    1 +
    Math.round(
      ((temp.getTime() - week1.getTime()) / 86400000 -
        3 +
        ((week1.getDay() + 6) % 7)) /
        7,
    )
  );
}

/** Return the ISO key for a date given granularity */
export function dateToKey(
  date: Date,
  granularity: "daily" | "weekly" | "monthly",
): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  if (granularity === "daily") return `${y}-${m}-${d}`;
  if (granularity === "weekly") {
    const w = String(isoWeek(date)).padStart(2, "0");
    // Week belongs to the year of the Thursday
    const thu = new Date(date);
    thu.setDate(thu.getDate() + 3 - ((thu.getDay() + 6) % 7));
    return `${thu.getFullYear()}-W${w}`;
  }
  return `${y}-${m}`;
}

/** Generate all bucket keys in chronological order */
export function generateBucketKeys(
  dateFrom: Date,
  dateTo: Date,
  granularity: "daily" | "weekly" | "monthly",
): string[] {
  const keys: string[] = [];
  const cursor = new Date(dateFrom);
  cursor.setHours(0, 0, 0, 0);
  const end = new Date(dateTo);
  end.setHours(23, 59, 59, 999);

  while (cursor <= end) {
    const key = dateToKey(cursor, granularity);
    if (!keys.length || keys[keys.length - 1] !== key) {
      keys.push(key);
    }
    if (granularity === "daily") {
      cursor.setDate(cursor.getDate() + 1);
    } else if (granularity === "weekly") {
      cursor.setDate(cursor.getDate() + 7);
    } else {
      cursor.setMonth(cursor.getMonth() + 1);
    }
  }
  return keys;
}

/** Human-readable label for a bucket key */
export function bucketKeyToLabel(key: string): string {
  if (key.includes("-W")) {
    const [y, w] = key.split("-W");
    return `W${w} ${y}`;
  }
  if (/^\d{4}-\d{2}$/.test(key)) {
    const [y, m] = key.split("-");
    const months = [
      "Jan","Feb","Mar","Apr","May","Jun",
      "Jul","Aug","Sep","Oct","Nov","Dec",
    ];
    return `${months[parseInt(m!, 10) - 1]} ${y}`;
  }
  // daily: yyyy-MM-dd → MM/DD
  const [, m, d] = key.split("-");
  return `${m}/${d}`;
}

/** Compute the previous period dates (same duration immediately before) */
export function computePreviousPeriod(
  dateFrom: Date,
  dateTo: Date,
): { prevFrom: Date; prevTo: Date } {
  const duration = dateTo.getTime() - dateFrom.getTime();
  const prevTo = new Date(dateFrom.getTime() - 1);
  const prevFrom = new Date(prevTo.getTime() - duration);
  return { prevFrom, prevTo };
}

/** Get the date value of an expense according to dateBasis */
export function getExpenseDate(
  row: AnalyticsExpenseRow,
  dateBasis: DateBasis,
): Date | null {
  const raw = dateBasis === "expense_date" ? row.trip_start : row.created_at;
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

// ─────────────────────────────────────────────────────────────────────────────
// KPI computation
// ─────────────────────────────────────────────────────────────────────────────

export function computeKPIs(
  expenses: AnalyticsExpenseRow[],
): KPIs {
  const amounts = expenses.map((e) => safeAmount(e.total_amount));
  const totalAmount = amounts.reduce((s, a) => s + a, 0);
  const totalCount = expenses.length;
  const avgAmount = totalCount > 0 ? totalAmount / totalCount : 0;
  const medianAmount = computeMedian(amounts);

  let pendingAmount = 0;
  let pendingCount = 0;
  let approvedAmount = 0;
  let approvedCount = 0;
  let rejectedAmount = 0;
  let rejectedCount = 0;

  for (const e of expenses) {
    const amt = safeAmount(e.total_amount);
    const cls = classifyExpenseStatus(e.status);
    if (cls === "pending" || cls === "other") {
      pendingAmount += amt;
      pendingCount += 1;
    } else if (cls === "approved") {
      approvedAmount += amt;
      approvedCount += 1;
    } else if (cls === "rejected") {
      rejectedAmount += amt;
      rejectedCount += 1;
    }
  }

  const finalizedTotal = approvedCount + rejectedCount;
  const finalizedApprovalRate =
    finalizedTotal > 0 ? (approvedCount / finalizedTotal) * 100 : null;

  const activeSubmitters = new Set(expenses.map((e) => e.user_id)).size;

  return {
    totalAmount,
    totalCount,
    avgAmount,
    medianAmount,
    pendingAmount,
    pendingCount,
    approvedAmount,
    approvedCount,
    rejectedAmount,
    rejectedCount,
    finalizedApprovalRate,
    activeSubmitters,
  };
}

/** Change % (null when previous = 0 and current > 0 → "New") */
export type Change =
  | { type: "pct"; value: number }
  | { type: "new" }
  | { type: "zero" }
  | { type: "none" };

export function computeChange(current: number, prev: number | undefined): Change {
  if (prev === undefined || prev === null) return { type: "none" };
  if (prev === 0 && current === 0) return { type: "zero" };
  if (prev === 0 && current > 0) return { type: "new" };
  return { type: "pct", value: ((current - prev) / Math.abs(prev)) * 100 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Trend
// ─────────────────────────────────────────────────────────────────────────────

export function buildTrend(
  expenses: AnalyticsExpenseRow[],
  prevExpenses: AnalyticsExpenseRow[] | null,
  dateFrom: Date,
  dateTo: Date,
  granularity: "daily" | "weekly" | "monthly",
  dateBasis: DateBasis,
): DateBucket[] {
  const keys = generateBucketKeys(dateFrom, dateTo, granularity);
  const bucketMap = new Map<string, { amount: number; count: number }>();
  for (const k of keys) bucketMap.set(k, { amount: 0, count: 0 });

  for (const e of expenses) {
    const d = getExpenseDate(e, dateBasis);
    if (!d) continue;
    const k = dateToKey(d, granularity);
    const b = bucketMap.get(k);
    if (b) {
      b.amount += safeAmount(e.total_amount);
      b.count += 1;
    }
  }

  let prevBucketMap: Map<string, { amount: number; count: number }> | null = null;
  if (prevExpenses) {
    const { prevFrom, prevTo } = computePreviousPeriod(dateFrom, dateTo);
    const prevKeys = generateBucketKeys(prevFrom, prevTo, granularity);
    prevBucketMap = new Map();
    for (const k of prevKeys) prevBucketMap.set(k, { amount: 0, count: 0 });
    for (const e of prevExpenses) {
      const d = getExpenseDate(e, dateBasis);
      if (!d) continue;
      const k = dateToKey(d, granularity);
      const b = prevBucketMap.get(k);
      if (b) {
        b.amount += safeAmount(e.total_amount);
        b.count += 1;
      }
    }
  }

  const prevKeysSorted = prevBucketMap
    ? Array.from(prevBucketMap.keys()).sort()
    : [];

  return keys.map((key, i) => {
    const b = bucketMap.get(key)!;
    const prevKey = prevKeysSorted[i];
    const prevB = prevKey ? prevBucketMap?.get(prevKey) : undefined;
    return {
      key,
      label: bucketKeyToLabel(key),
      amount: b.amount,
      count: b.count,
      prevAmount: prevB?.amount,
      prevCount: prevB?.count,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Category aggregation
// ─────────────────────────────────────────────────────────────────────────────

const OTHER_CATEGORY = "Other categories";
const TOP_N_CATEGORIES = 10;
const TREND_TOP_N = 5;

export function buildCategoryBreakdown(
  expenses: AnalyticsExpenseRow[],
): CategoryBreakdown[] {
  const map = new Map<string, { amount: number; count: number }>();
  for (const e of expenses) {
    const cat = e.category?.trim() || "Uncategorized";
    const amt = safeAmount(e.total_amount);
    const cur = map.get(cat) ?? { amount: 0, count: 0 };
    map.set(cat, { amount: cur.amount + amt, count: cur.count + 1 });
  }

  const sorted = Array.from(map.entries())
    .map(([category, d]) => ({ category, ...d }))
    .sort((a, b) => b.amount - a.amount);

  const total = sorted.reduce((s, c) => s + c.amount, 0);

  const top = sorted.slice(0, TOP_N_CATEGORIES);
  const rest = sorted.slice(TOP_N_CATEGORIES);
  const restAmount = rest.reduce((s, c) => s + c.amount, 0);
  const restCount = rest.reduce((s, c) => s + c.count, 0);

  const result: CategoryBreakdown[] = top.map((c) => ({
    ...c,
    pct: total > 0 ? (c.amount / total) * 100 : 0,
  }));

  if (restAmount > 0) {
    result.push({
      category: OTHER_CATEGORY,
      amount: restAmount,
      count: restCount,
      pct: total > 0 ? (restAmount / total) * 100 : 0,
    });
  }

  return result;
}

export function buildCategoryTrend(
  expenses: AnalyticsExpenseRow[],
  topCategories: string[],
  dateFrom: Date,
  dateTo: Date,
  granularity: "daily" | "weekly" | "monthly",
  dateBasis: DateBasis,
): Array<{ key: string; label: string; [category: string]: number | string }> {
  const keys = generateBucketKeys(dateFrom, dateTo, granularity);
  const topSet = new Set(topCategories.slice(0, TREND_TOP_N));

  type BucketRow = { [cat: string]: number };
  const buckets = new Map<string, BucketRow>();
  for (const k of keys) buckets.set(k, {});

  for (const e of expenses) {
    const d = getExpenseDate(e, dateBasis);
    if (!d) continue;
    const k = dateToKey(d, granularity);
    const b = buckets.get(k);
    if (!b) continue;
    const cat = e.category?.trim() || "Uncategorized";
    const displayCat = topSet.has(cat) ? cat : OTHER_CATEGORY;
    b[displayCat] = (b[displayCat] ?? 0) + safeAmount(e.total_amount);
  }

  return keys.map((key) => ({
    key,
    label: bucketKeyToLabel(key),
    ...buckets.get(key),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Status aggregation
// ─────────────────────────────────────────────────────────────────────────────

export function buildStatusBreakdown(
  expenses: AnalyticsExpenseRow[],
): StatusBreakdown[] {
  const map = new Map<string, { count: number; amount: number }>();
  for (const e of expenses) {
    const cur = map.get(e.status) ?? { count: 0, amount: 0 };
    map.set(e.status, {
      count: cur.count + 1,
      amount: cur.amount + safeAmount(e.total_amount),
    });
  }

  const total = expenses.length;
  const totalAmt = expenses.reduce((s, e) => s + safeAmount(e.total_amount), 0);

  return Array.from(map.entries())
    .map(([status, d]) => ({
      status,
      statusClass: classifyExpenseStatus(status),
      count: d.count,
      amount: d.amount,
      pct: total > 0 ? (d.count / total) * 100 : 0,
      amountPct: totalAmt > 0 ? (d.amount / totalAmt) * 100 : 0,
    }))
    .sort((a, b) => getExpenseStatusOrder(a.status) - getExpenseStatusOrder(b.status));
}

// ─────────────────────────────────────────────────────────────────────────────
// Destination aggregation
// ─────────────────────────────────────────────────────────────────────────────

const UNSPECIFIED = "Unspecified";
const TOP_N_DESTINATIONS = 10;

export function buildDestinationBreakdown(
  expenses: AnalyticsExpenseRow[],
): DestinationBreakdown[] {
  const map = new Map<string, { amount: number; count: number }>();
  for (const e of expenses) {
    const dest = e.destination?.trim() || UNSPECIFIED;
    const cur = map.get(dest) ?? { amount: 0, count: 0 };
    map.set(dest, { amount: cur.amount + safeAmount(e.total_amount), count: cur.count + 1 });
  }

  const total = expenses.reduce((s, e) => s + safeAmount(e.total_amount), 0);
  return Array.from(map.entries())
    .map(([destination, d]) => ({
      destination,
      amount: d.amount,
      count: d.count,
      pct: total > 0 ? (d.amount / total) * 100 : 0,
    }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, TOP_N_DESTINATIONS);
}

// ─────────────────────────────────────────────────────────────────────────────
// Employee aggregation
// ─────────────────────────────────────────────────────────────────────────────

export function buildEmployeeBreakdown(
  expenses: AnalyticsExpenseRow[],
  profiles: AnalyticsProfile[],
): EmployeeBreakdown[] {
  const profileMap = new Map(profiles.map((p) => [p.user_id, p]));
  const map = new Map<
    string,
    {
      totalAmount: number;
      count: number;
      approvedAmount: number;
      pendingAmount: number;
      rejectedAmount: number;
    }
  >();

  for (const e of expenses) {
    const amt = safeAmount(e.total_amount);
    const cls = classifyExpenseStatus(e.status);
    const cur = map.get(e.user_id) ?? {
      totalAmount: 0,
      count: 0,
      approvedAmount: 0,
      pendingAmount: 0,
      rejectedAmount: 0,
    };
    cur.totalAmount += amt;
    cur.count += 1;
    if (cls === "approved") cur.approvedAmount += amt;
    else if (cls === "pending" || cls === "other") cur.pendingAmount += amt;
    else if (cls === "rejected") cur.rejectedAmount += amt;
    map.set(e.user_id, cur);
  }

  return Array.from(map.entries())
    .map(([user_id, d]) => {
      const profile = profileMap.get(user_id);
      return {
        user_id,
        name: profile?.name ?? "Unknown",
        employee_id: profile?.employee_id,
        totalAmount: d.totalAmount,
        count: d.count,
        avgAmount: d.count > 0 ? d.totalAmount / d.count : 0,
        approvedAmount: d.approvedAmount,
        pendingAmount: d.pendingAmount,
        rejectedAmount: d.rejectedAmount,
      };
    })
    .sort((a, b) => b.totalAmount - a.totalAmount)
    .slice(0, 10);
}

// ─────────────────────────────────────────────────────────────────────────────
// Pending aging
// ─────────────────────────────────────────────────────────────────────────────

const AGING_BUCKETS: Array<{ label: string; minDays: number; maxDays: number | null }> = [
  { label: "0–2 days", minDays: 0, maxDays: 2 },
  { label: "3–7 days", minDays: 3, maxDays: 7 },
  { label: "8–14 days", minDays: 8, maxDays: 14 },
  { label: "15–30 days", minDays: 15, maxDays: 30 },
  { label: "Over 30 days", minDays: 31, maxDays: null },
];

export function buildPendingAging(
  expenses: AnalyticsExpenseRow[],
  now: Date = new Date(),
): PendingAgingBucket[] {
  const pending = expenses.filter(
    (e) => classifyExpenseStatus(e.status) === "pending",
  );

  const totalPendingAmount = pending.reduce(
    (s, e) => s + safeAmount(e.total_amount),
    0,
  );

  const buckets: PendingAgingBucket[] = AGING_BUCKETS.map((b) => ({
    ...b,
    count: 0,
    amount: 0,
    pct: 0,
  }));

  for (const e of pending) {
    const submitted = new Date(e.created_at);
    if (isNaN(submitted.getTime())) continue;
    const ageDays = Math.floor(
      (now.getTime() - submitted.getTime()) / 86_400_000,
    );
    for (const bucket of buckets) {
      if (
        ageDays >= bucket.minDays &&
        (bucket.maxDays === null || ageDays <= bucket.maxDays)
      ) {
        bucket.count += 1;
        bucket.amount += safeAmount(e.total_amount);
        break;
      }
    }
  }

  for (const b of buckets) {
    b.pct = totalPendingAmount > 0 ? (b.amount / totalPendingAmount) * 100 : 0;
  }

  return buckets;
}

// ─────────────────────────────────────────────────────────────────────────────
// Amount histogram
// ─────────────────────────────────────────────────────────────────────────────

const AMOUNT_BUCKETS: Array<{ label: string; min: number; max: number | null }> = [
  { label: "Under ₹500", min: 0, max: 499.99 },
  { label: "₹500–₹999", min: 500, max: 999.99 },
  { label: "₹1,000–₹4,999", min: 1000, max: 4999.99 },
  { label: "₹5,000–₹9,999", min: 5000, max: 9999.99 },
  { label: "₹10,000–₹24,999", min: 10000, max: 24999.99 },
  { label: "₹25,000+", min: 25000, max: null },
];

export function buildAmountHistogram(
  expenses: AnalyticsExpenseRow[],
): AmountHistogramBucket[] {
  const buckets: AmountHistogramBucket[] = AMOUNT_BUCKETS.map((b) => ({
    ...b,
    count: 0,
    amount: 0,
  }));

  for (const e of expenses) {
    const amt = safeAmount(e.total_amount);
    for (const b of buckets) {
      if (amt >= b.min && (b.max === null || amt <= b.max)) {
        b.count += 1;
        b.amount += amt;
        break;
      }
    }
  }

  return buckets;
}

// ─────────────────────────────────────────────────────────────────────────────
// Weekday distribution
// ─────────────────────────────────────────────────────────────────────────────

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function buildWeekdayBreakdown(
  expenses: AnalyticsExpenseRow[],
  dateBasis: DateBasis,
): WeekdayBreakdown[] {
  const buckets: WeekdayBreakdown[] = WEEKDAY_LABELS.map((label, i) => ({
    dayIndex: i,
    label,
    count: 0,
    amount: 0,
  }));

  for (const e of expenses) {
    const d = getExpenseDate(e, dateBasis);
    if (!d) continue;
    // JS getDay: 0=Sun…6=Sat → remap to Mon=0…Sun=6
    const jsDay = d.getDay();
    const monFirst = jsDay === 0 ? 6 : jsDay - 1;
    buckets[monFirst]!.count += 1;
    buckets[monFirst]!.amount += safeAmount(e.total_amount);
  }

  return buckets;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cumulative spend
// ─────────────────────────────────────────────────────────────────────────────

export function buildCumulativeSpend(
  trend: DateBucket[],
): Array<{ key: string; label: string; cumulative: number; prevCumulative?: number }> {
  let cum = 0;
  let prevCum = 0;
  return trend.map((b) => {
    cum += b.amount;
    prevCum += b.prevAmount ?? 0;
    return {
      key: b.key,
      label: b.label,
      cumulative: cum,
      prevCumulative: b.prevAmount !== undefined ? prevCum : undefined,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Quick insights (deterministic, no AI)
// ─────────────────────────────────────────────────────────────────────────────

export interface QuickInsight {
  key: string;
  /** Template string — caller substitutes values for i18n */
  data: Record<string, string | number>;
}

export function buildQuickInsights(
  kpis: ComparisonKPIs,
  categoryBreakdown: CategoryBreakdown[],
  weekdayBreakdown: WeekdayBreakdown[],
  topExpenses: AnalyticsExpenseRow[],
): QuickInsight[] {
  const insights: QuickInsight[] = [];

  // Largest category
  if (categoryBreakdown.length > 0) {
    const top = categoryBreakdown[0]!;
    if (top.pct >= 10) {
      insights.push({
        key: "topCategory",
        data: { category: top.category, pct: Math.round(top.pct) },
      });
    }
  }

  // Period comparison
  if (kpis.prev && kpis.prev.totalAmount > 0 && kpis.totalAmount > 0) {
    const change = ((kpis.totalAmount - kpis.prev.totalAmount) / kpis.prev.totalAmount) * 100;
    insights.push({
      key: change >= 0 ? "spendIncreased" : "spendDecreased",
      data: { pct: Math.abs(Math.round(change)) },
    });
  }

  // Pending share
  if (kpis.totalCount > 0) {
    const pendingPct = (kpis.pendingCount / kpis.totalCount) * 100;
    if (pendingPct >= 20) {
      insights.push({
        key: "pendingShare",
        data: { pct: Math.round(pendingPct) },
      });
    }
  }

  // Highest spend weekday
  const topDay = [...weekdayBreakdown].sort((a, b) => b.amount - a.amount)[0];
  if (topDay && topDay.count > 0) {
    insights.push({ key: "topWeekday", data: { day: topDay.label } });
  }

  // Category concentration
  if (categoryBreakdown.length >= 3) {
    const top3Pct = categoryBreakdown.slice(0, 3).reduce((s, c) => s + c.pct, 0);
    if (top3Pct >= 60) {
      insights.push({ key: "categoryConcentration", data: { pct: Math.round(top3Pct) } });
    }
  }

  // Largest single expense
  if (topExpenses.length > 0) {
    const largest = topExpenses[0]!;
    if (largest.total_amount) {
      insights.push({
        key: "largestExpense",
        data: { amount: safeAmount(largest.total_amount) },
      });
    }
  }

  return insights.slice(0, 6);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main computation entry point
// ─────────────────────────────────────────────────────────────────────────────

export function computeAnalytics(
  expenses: AnalyticsExpenseRow[],
  prevExpenses: AnalyticsExpenseRow[] | null,
  profiles: AnalyticsProfile[],
  dateFrom: Date,
  dateTo: Date,
  resolvedGranularity: "daily" | "weekly" | "monthly",
  dateBasis: DateBasis,
): AnalyticsResult {
  const kpis: ComparisonKPIs = {
    ...computeKPIs(expenses),
    prev: prevExpenses ? computeKPIs(prevExpenses) : null,
  };

  const trend = buildTrend(
    expenses,
    prevExpenses,
    dateFrom,
    dateTo,
    resolvedGranularity,
    dateBasis,
  );

  const categoryBreakdown = buildCategoryBreakdown(expenses);
  const topCatNames = categoryBreakdown
    .filter((c) => c.category !== OTHER_CATEGORY)
    .slice(0, TREND_TOP_N)
    .map((c) => c.category);
  const categoryTrend = buildCategoryTrend(
    expenses,
    topCatNames,
    dateFrom,
    dateTo,
    resolvedGranularity,
    dateBasis,
  );

  const statusBreakdown = buildStatusBreakdown(expenses);
  const destinationBreakdown = buildDestinationBreakdown(expenses);
  const employeeBreakdown = buildEmployeeBreakdown(expenses, profiles);
  const pendingAging = buildPendingAging(expenses);
  const amountHistogram = buildAmountHistogram(expenses);
  const weekdayBreakdown = buildWeekdayBreakdown(expenses, dateBasis);
  const cumulativeSpend = buildCumulativeSpend(trend);

  const topExpenses = [...expenses]
    .sort((a, b) => safeAmount(b.total_amount) - safeAmount(a.total_amount))
    .slice(0, 10);

  const quickInsightData = buildQuickInsights(kpis, categoryBreakdown, weekdayBreakdown, topExpenses);
  const quickInsights = quickInsightData.map((ins) => {
    // Return serializable strings; components will use i18n keys
    return `${ins.key}:${JSON.stringify(ins.data)}`;
  });

  return {
    kpis,
    trend,
    categoryBreakdown,
    categoryTrend,
    statusBreakdown,
    destinationBreakdown,
    employeeBreakdown,
    pendingAging,
    amountHistogram,
    weekdayBreakdown,
    cumulativeSpend,
    topExpenses,
    quickInsights,
  };
}

export { OTHER_CATEGORY, UNSPECIFIED };
