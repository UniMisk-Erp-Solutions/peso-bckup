/**
 * Full, paginated read of the four existing report RPCs (read-only reuse of the app's own report logic,
 * so Sync always sees exactly what the report shows). `rpc` is injected: Supabase client in the worker,
 * a fake in tests.
 */
import type { PwtReportType } from "./types.ts";

export type Rpc = (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
type Row = Record<string, unknown>;

export interface ReportParams {
  category: string | null;
  userIds: string[] | null;
  engineerStatus: string | null;
  hoStatus: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  customFieldFilters: Record<string, string> | null;
}

export function parseParams(raw: Row): ReportParams {
  const custom = raw.custom_field_filters && typeof raw.custom_field_filters === "object"
    ? (raw.custom_field_filters as Record<string, string>)
    : null;
  return {
    category: raw.category ? String(raw.category) : null,
    userIds: raw.user_id ? [String(raw.user_id)]
      : Array.isArray(raw.user_ids) && raw.user_ids.length ? (raw.user_ids as string[]) : null,
    engineerStatus: raw.engineer_status ? String(raw.engineer_status) : null,
    hoStatus: raw.ho_status ? String(raw.ho_status) : null,
    dateFrom: raw.date_from ? String(raw.date_from) : null,
    dateTo: raw.date_to ? String(raw.date_to) : null,
    customFieldFilters: custom,
  };
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad2(m)}-${pad2(d)}`;

function isoWeekRange(year: number, week: number): { from: string; to: string } {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const day = jan4.getUTCDay() || 7;
  const start = new Date(jan4);
  start.setUTCDate(jan4.getUTCDate() - (day - 1) + (week - 1) * 7);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  return {
    from: iso(start.getUTCFullYear(), start.getUTCMonth() + 1, start.getUTCDate()),
    to: iso(end.getUTCFullYear(), end.getUTCMonth() + 1, end.getUTCDate()),
  };
}

/** Detailed Expense lets the UI pick year/month/week instead of explicit dates. */
export function resolveDates(raw: Row): { dateFrom: string | null; dateTo: string | null } {
  if (raw.date_from || raw.date_to) {
    return { dateFrom: raw.date_from ? String(raw.date_from) : null, dateTo: raw.date_to ? String(raw.date_to) : null };
  }
  const year = raw.year ? parseInt(String(raw.year), 10) : NaN;
  if (!Number.isFinite(year)) return { dateFrom: null, dateTo: null };
  const week = raw.week ? String(raw.week) : "all";
  const month = raw.month ? String(raw.month) : "all";
  if (week !== "all") {
    const r = isoWeekRange(year, parseInt(week, 10));
    return { dateFrom: r.from, dateTo: r.to };
  }
  if (month !== "all") {
    const m = parseInt(month, 10);
    return { dateFrom: iso(year, m, 1), dateTo: iso(year, m, new Date(year, m, 0).getDate()) };
  }
  return { dateFrom: iso(year, 1, 1), dateTo: iso(year, 12, 31) };
}

function verificationStatuses(es: string | null): string[] {
  return !es || es === "all" ? ["verified", "level_1_verified", "level_2_verified"] : [es];
}

function customOk(row: Row, filters: Record<string, string> | null): boolean {
  if (!filters) return true;
  const cf = (row.custom_fields ?? {}) as Record<string, string>;
  return Object.entries(filters).every(([k, v]) => !v || v === "all" || String(cf[k] ?? "").trim() === v);
}

const tierFor = (es: string) => es === "verified" ? "engineer" : es === "level_1_verified" ? "team_leader" : es === "level_2_verified" ? "executive" : null;

export interface FetchOptions {
  rpc: Rpc;
  organizationId: string;
  report: PwtReportType;
  parameters: Row;
  /** daily_expense_report_config for Daily Project */
  dailyConfig?: Row;
  onRows: (rows: Row[]) => Promise<void>;
  onProgress?: (current: number, total: number | null) => Promise<void>;
  pageSize?: number;
}

/** Where a page walk stopped, so the next slice can continue from exactly there. */
export interface FetchResume {
  cursor: unknown;
  total: number | null;
  pages: number;
  seen: number;
  delivered: number;
  snapshotAt: string | null;
}

export const FRESH_FETCH: FetchResume = { cursor: null, total: null, pages: 0, seen: 0, delivered: 0, snapshotAt: null };

export interface SliceResult {
  done: boolean;
  resume: FetchResume;
}

/** Returns the number of rows delivered to onRows. Throws if the page walk is incomplete. */
export async function fetchReportRows(o: FetchOptions): Promise<number> {
  const r = await fetchReportRowsSlice(o, FRESH_FETCH, Infinity);
  return r.resume.delivered;
}

/**
 * Walks pages from `resume` and stops cleanly (done=false) after the first page that finishes past `deadline` (epoch ms), so a short-lived
 * worker never gets cut off mid-page. Call again with the returned `resume` to continue. The final slice (done=true) verifies the row count.
 */
export async function fetchReportRowsSlice(o: FetchOptions, from: FetchResume, deadline: number): Promise<SliceResult> {
  const params = parseParams(o.parameters);
  const size = o.pageSize ?? 250;
  let cursor: unknown = from.cursor;
  let total: number | null = from.total;
  let pages = from.pages;
  let seen = from.seen;
  let delivered = from.delivered;
  let snapshotAt: string | null = from.snapshotAt;
  const state = (): FetchResume => ({ cursor, total, pages, seen, delivered, snapshotAt });

  for (;;) {
    let name: string;
    let args: Row;
    if (o.report === "claim_verification" || o.report === "claim_approval") {
      if (o.report === "claim_approval" && params.hoStatus && params.hoStatus !== "approved") {
        throw new Error("Invalid HO status for Claim Approval.");
      }
      name = "report_expense_rows_v1";
      args = {
        p_organization_id: o.organizationId,
        p_statuses: o.report === "claim_verification" ? verificationStatuses(params.engineerStatus) : ["approved"],
        p_category: params.category, p_user_ids: params.userIds,
        p_date_from: params.dateFrom, p_date_to: params.dateTo,
        p_sort_column: "created_at", p_cursor: cursor, p_page_size: size, p_with_total: pages === 0,
      };
    } else if (o.report === "detailed_expense") {
      const d = resolveDates(o.parameters);
      name = "report_detailed_expense_rows_v4";
      args = {
        p_organization_id: o.organizationId, p_user_ids: params.userIds, p_date_from: d.dateFrom, p_date_to: d.dateTo,
        p_cursor: cursor, p_page_size: Math.max(size, 500), p_with_total: pages === 0,
      };
    } else {
      name = "report_daily_project_rows_v1";
      args = {
        p_organization_id: o.organizationId, p_config: o.dailyConfig ?? {},
        p_date_from: params.dateFrom, p_date_to: params.dateTo,
        p_user_id: params.userIds?.length === 1 ? params.userIds[0] : null,
        p_user_ids: params.userIds && params.userIds.length > 1 ? params.userIds : null,
        p_snapshot_at: snapshotAt, p_cursor: cursor, p_page_size: size, p_with_total: snapshotAt === null,
      };
    }

    const { data, error } = await o.rpc(name, args);
    if (error) throw new Error(`${name} page ${pages + 1}: ${error.message}`);
    const p = (data ?? {}) as Row;
    if (pages === 0 || (o.report === "daily_project" && total === null)) {
      if (p.total_count != null) total = Number(p.total_count);
    }
    if (o.report === "daily_project" && snapshotAt === null) snapshotAt = (p.snapshot_at as string) ?? null;

    const rows = ((p.rows ?? []) as Row[]).filter(Boolean);
    seen += rows.length;
    const keep = rows.filter((r) => {
      if (o.report === "detailed_expense") {
        // category / custom-field filters apply to expense events only (balance events always stay)
        if (r.event_type !== "expense_deduction") return true;
        if (params.category && String(r.category ?? "") !== params.category) return false;
        return customOk(r, params.customFieldFilters);
      }
      if (o.report === "daily_project") return true;
      return customOk(r, params.customFieldFilters);
    });
    const dropped: Row[] = [];
    let out = keep;

    if (o.report === "claim_verification" || o.report === "claim_approval") {
      const ids = keep.map((r) => String(r.id));
      const { data: meta, error: me } = ids.length
        ? await o.rpc("pwt_expense_meta_v1", { p_organization_id: o.organizationId, p_expense_ids: ids })
        : { data: {}, error: null };
      if (me) throw new Error(`expense meta: ${me.message}`);
      const m = (meta ?? {}) as Record<string, { approval_tier?: string; deleted_at?: string }>;
      const want = o.report === "claim_approval" && params.engineerStatus && params.engineerStatus !== "all"
        ? tierFor(params.engineerStatus) : null;
      out = keep.filter((r) => {
        const x = m[String(r.id)];
        if (x?.deleted_at) return false;
        if (want && x?.approval_tier !== want) return false;
        return true;
      });
      dropped.push(...keep.filter((r) => !out.includes(r)));
    }

    if (out.length) await o.onRows(out);
    delivered += out.length;
    pages += 1;
    await o.onProgress?.(seen, total);
    if (!p.has_more || !p.next_cursor) break;
    cursor = p.next_cursor;
    if (pages > 5000) throw new Error("pagination did not terminate");
    if (Date.now() >= deadline) return { done: false, resume: state() };
  }

  if (total !== null && seen !== total) throw new Error(`Incomplete fetch: expected ${total} rows, read ${seen}`);
  return { done: true, resume: state() };
}
