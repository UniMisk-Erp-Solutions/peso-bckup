/**
 * DOC-101 — Daily Project Report server-paged retrieval + export coordination.
 *
 * Replaces the browser-side pipeline in buildDailyProjectExpenseReport.ts's
 * `fetchDailyProjectExpenseReportRows`, which issued one unbounded
 * `expenses` request (silently capped by PostgREST at 1000 rows) followed by
 * one `expense_form_field_values` request per 75 expense ids (51,386 such calls
 * on Production, max 7,984.9 ms against an 8,000 ms statement_timeout).
 *
 * Here the server returns whole, already-enriched report ROWS — not raw
 * entities — one bounded page at a time inside a single jsonb envelope that
 * PostgREST cannot truncate. The client's only remaining work is the
 * locale-sensitive sort and workbook shaping, which deliberately stay on the
 * client so the produced file matches the previous implementation exactly.
 */
import { supabase } from "@/integrations/supabase/client";
import {
  costColumnToHeader,
  formatTrackDate,
  type DailyReportGroup,
  type DailyReportSourceExpense,
  type DailyProjectExpenseReportBuildResult,
  finalizeDailyReportGroups,
} from "@/lib/buildDailyProjectExpenseReport";
import type { DailyReportCostColumnKey } from "@/lib/dailyExpenseReportConfig";

/** Contract version this client understands. A server bump must be explicit. */
export const DAILY_REPORT_SCHEMA_VERSION = 1;

/**
 * Rows requested per server call.
 *
 * Benchmarked on Production (MicroLink, 10,111 approved expenses → 4,160 report
 * rows) against the `authenticated` role's 8,000 ms statement_timeout. The full
 * grouped computation measures ~545 ms, so every candidate size cleared the
 * ceiling by more than 13×; 250 was chosen because it keeps the per-page
 * payload near ~0.6 MB while holding the page count to 17. See DOC-101 §9.
 */
export const DAILY_REPORT_PAGE_SIZE = 250;

/** Server hard clamp — mirrored here so the client cannot ask for more. */
export const DAILY_REPORT_MAX_PAGE_SIZE = 500;

export type DailyReportCursor = {
  track_date: string;
  user_id: string;
  project_id: string;
};

type ServerSourceExpense = {
  id: string;
  category: string | null;
  total_amount: number | string | null;
  trip_start: string | null;
  title: string | null;
  transaction_number: string | null;
  voucher_no: string | null;
  cost_column: string | null;
  /** Base `purpose` column. Optional: the currently-installed RPC (before
   * the pending daily-report-remarks-column migration is applied) does not
   * emit this key at all, so this must degrade to an empty Remarks column,
   * never throw. */
  purpose?: string | null;
};

type ServerReportRow = {
  track_date: string;
  user_id: string;
  project_id: string;
  project_name: string;
  /** Optional: the currently-installed RPC (before this pending migration is
   * applied) does not emit this key, so it must degrade to "not ambiguous"
   * (a blank name still renders as the plain "no data" marker), never throw. */
  project_name_ambiguous?: boolean;
  location: string;
  voucher_no: string;
  employee_name: string;
  employee_code: string;
  projects_in_employee_day: number;
  costs: Record<string, number | string | null>;
  source_expenses: ServerSourceExpense[] | null;
};

export type DailyReportPage = {
  schemaVersion: number;
  snapshotAt: string;
  pageSize: number;
  /** Authoritative population size. Server sends it on the FIRST page only. */
  totalCount: number | null;
  returned: number;
  hasMore: boolean;
  nextCursor: DailyReportCursor | null;
  rows: ServerReportRow[];
};

export type DailyReportPageParams = {
  organizationId: string;
  dateFrom?: string | null;
  dateTo?: string | null;
  userId?: string | null;
  userIds?: string[] | null;
  teamScoped?: boolean;
  snapshotAt?: string | null;
  cursor?: DailyReportCursor | null;
  pageSize?: number;
  signal?: AbortSignal;
};

/** Stable identity of one logical report row — the server's keyset tuple. */
export function dailyReportRowIdentity(row: {
  track_date: string;
  user_id: string;
  project_id: string;
}): string {
  return [row.track_date, row.user_id, row.project_id].join("");
}

export class DailyReportExportError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "DailyReportExportError";
    this.code = code;
  }
}

function num(value: number | string | null | undefined): number {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

const COST_KEYS: DailyReportCostColumnKey[] = [
  "petrol_cost",
  "material_cost",
  "travelling_cost",
  "phone_exp",
  "hotel_exp",
  "transport_exp",
  "contra_bill",
  "other_exp",
];

function isCostKey(value: string | null): value is DailyReportCostColumnKey {
  return !!value && (COST_KEYS as string[]).includes(value);
}

/**
 * Reject anything that is not a well-formed envelope of THIS schema version.
 *
 * A malformed or unexpectedly-versioned response must abort the export rather
 * than be coerced into a partial workbook.
 */
export function parseDailyReportPage(raw: unknown): DailyReportPage {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new DailyReportExportError("malformed_response", "Report page response was not an object.");
  }
  const obj = raw as Record<string, unknown>;

  const schemaVersion = Number(obj.schema_version);
  if (schemaVersion !== DAILY_REPORT_SCHEMA_VERSION) {
    throw new DailyReportExportError(
      "schema_version_mismatch",
      `Report contract version ${String(obj.schema_version)} is not supported by this client.`,
    );
  }

  const snapshotAt = typeof obj.snapshot_at === "string" ? obj.snapshot_at : "";
  if (!snapshotAt) {
    throw new DailyReportExportError("malformed_response", "Report page response had no snapshot.");
  }

  if (!Array.isArray(obj.rows)) {
    throw new DailyReportExportError("malformed_response", "Report page response had no rows array.");
  }

  const rawCursor = obj.next_cursor;
  let nextCursor: DailyReportCursor | null = null;
  if (rawCursor != null) {
    const c = rawCursor as Record<string, unknown>;
    if (
      typeof c.track_date !== "string" ||
      typeof c.user_id !== "string" ||
      typeof c.project_id !== "string"
    ) {
      throw new DailyReportExportError("malformed_cursor", "Report page returned an unusable cursor.");
    }
    nextCursor = { track_date: c.track_date, user_id: c.user_id, project_id: c.project_id };
  }

  const rows = obj.rows as ServerReportRow[];
  const returned = Number(obj.returned ?? rows.length);
  const hasMore = obj.has_more === true;

  if (hasMore && !nextCursor) {
    throw new DailyReportExportError(
      "missing_cursor",
      "Report page claimed more data but returned no cursor.",
    );
  }

  return {
    schemaVersion,
    snapshotAt,
    pageSize: Number(obj.page_size ?? rows.length),
    totalCount: obj.total_count == null ? null : Number(obj.total_count),
    returned,
    hasMore,
    nextCursor,
    rows,
  };
}

/** Fetch exactly one bounded page. */
export async function fetchDailyProjectReportPage(
  params: DailyReportPageParams,
): Promise<DailyReportPage> {
  const {
    organizationId,
    dateFrom = null,
    dateTo = null,
    userId = null,
    userIds = null,
    teamScoped = false,
    snapshotAt = null,
    cursor = null,
    pageSize = DAILY_REPORT_PAGE_SIZE,
  } = params;

  const builder = supabase.rpc("get_daily_project_report_page_v1", {
    p_organization_id: organizationId,
    p_date_from: dateFrom,
    p_date_to: dateTo,
    p_user_id: userId,
    p_user_ids: userIds,
    p_team_scoped: teamScoped,
    p_snapshot_at: snapshotAt,
    p_cursor: cursor,
    p_page_size: Math.min(Math.max(pageSize, 1), DAILY_REPORT_MAX_PAGE_SIZE),
  });

  // AbortController is threaded all the way to the HTTP request so Cancel
  // actually stops the in-flight page, not just the loop around it.
  const { data, error } = params.signal
    ? await builder.abortSignal(params.signal)
    : await builder;

  if (error) {
    throw new DailyReportExportError("page_failed", error.message);
  }
  return parseDailyReportPage(data);
}

/**
 * Page-scoped ambiguity lookup. Calls get_daily_report_project_name_ambiguity_batch_v2
 * with only the project ids actually present on the rows in hand -- never
 * the organization's full project population. See
 * 20260829120000_daily_report_remarks_and_batch_ambiguity.sql for why this
 * replaced a whole-population computation inside the report core itself
 * (that design caused two separate Production incidents).
 */
export async function fetchProjectNameAmbiguityBatch(
  organizationId: string,
  projectIds: string[],
  signal?: AbortSignal,
): Promise<Map<string, boolean>> {
  const ids = Array.from(new Set(projectIds.map((id) => id.trim()).filter(Boolean)));
  if (ids.length === 0) return new Map();

  const builder = supabase.rpc("get_daily_report_project_name_ambiguity_batch_v2", {
    p_organization_id: organizationId,
    p_project_ids: ids,
  });
  const { data, error } = signal ? await builder.abortSignal(signal) : await builder;

  if (error) {
    throw new DailyReportExportError("ambiguity_batch_failed", error.message);
  }

  const result = new Map<string, boolean>();
  for (const row of (data ?? []) as Array<{ project_id: string; project_name_ambiguous: boolean }>) {
    result.set(row.project_id, row.project_name_ambiguous === true);
  }
  return result;
}

/** Convert one server row into the shared pre-shaping group. */
export function serverRowToGroup(row: ServerReportRow): DailyReportGroup {
  const trackDate = formatTrackDate(row.track_date || null);
  const projectId = String(row.project_id ?? "").trim();
  const projectName = String(row.project_name ?? "").trim();
  const location = String(row.location ?? "").trim();

  const costs = {} as Record<DailyReportCostColumnKey, number>;
  for (const key of COST_KEYS) costs[key] = num(row.costs?.[key]);

  const sourceExpenses: DailyReportSourceExpense[] = (row.source_expenses ?? []).map((src) => {
    const costColumn: DailyReportCostColumnKey = isCostKey(src.cost_column)
      ? src.cost_column
      : "other_exp";
    return {
      id: src.id,
      category: src.category ?? null,
      total_amount: num(src.total_amount),
      trip_start: src.trip_start ?? null,
      title: src.title ?? null,
      transaction_number: src.transaction_number ?? null,
      voucherNo: String(src.voucher_no ?? "").trim(),
      costColumn,
      costColumnLabel: String(costColumnToHeader(costColumn)),
      projectId,
      projectName,
      location,
      purpose: src.purpose ?? null,
    };
  });

  return {
    trackDate,
    userId: row.user_id,
    projectId,
    projectName,
    projectNameAmbiguous: row.project_name_ambiguous === true,
    location,
    voucherNo: String(row.voucher_no ?? "").trim(),
    employeeName: String(row.employee_name ?? ""),
    employeeCode: String(row.employee_code ?? ""),
    costs,
    sourceExpenses,
  };
}

export type DailyReportExportProgress = {
  received: number;
  total: number | null;
  pages: number;
};

export type DailyReportExportOptions = Omit<
  DailyReportPageParams,
  "cursor" | "snapshotAt" | "signal"
> & {
  signal?: AbortSignal;
  onProgress?: (progress: DailyReportExportProgress) => void;
  /** Transient-failure retries per page. Default 2 (3 attempts total). */
  maxRetriesPerPage?: number;
  /** Injected in tests. */
  fetchPage?: (params: DailyReportPageParams) => Promise<DailyReportPage>;
  /** Injected in tests. Defaults to fetchProjectNameAmbiguityBatch. */
  fetchAmbiguityBatch?: (
    organizationId: string,
    projectIds: string[],
    signal?: AbortSignal,
  ) => Promise<Map<string, boolean>>;
  /** Injected in tests to avoid real timers. */
  delay?: (ms: number) => Promise<void>;
};

export type DailyReportExportOutcome = {
  results: DailyProjectExpenseReportBuildResult[];
  totalCount: number;
  pages: number;
  snapshotAt: string;
};

const defaultDelay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Retrieve EVERY page of one report snapshot, prove the set is complete, and
 * only then shape it into workbook rows.
 *
 * Guarantees, in order of importance:
 *  - never returns a partial dataset: any gap, duplicate, count mismatch,
 *    snapshot change or page failure throws instead of resolving;
 *  - one snapshot for the whole export, pinned from page 1;
 *  - the authoritative `total_count` from page 1 is asserted against the number
 *    of DISTINCT logical row identities actually received;
 *  - retries re-request the SAME cursor under the SAME snapshot, so a retry can
 *    neither skip nor duplicate a page;
 *  - sequential paging (concurrency 1) — the shared database is never fanned
 *    out against, and the keyset cursor is inherently sequential anyway.
 */
export async function runDailyProjectReportExport(
  options: DailyReportExportOptions,
): Promise<DailyReportExportOutcome> {
  const {
    signal,
    onProgress,
    maxRetriesPerPage = 2,
    fetchPage = fetchDailyProjectReportPage,
    fetchAmbiguityBatch = fetchProjectNameAmbiguityBatch,
    delay = defaultDelay,
    ...pageParams
  } = options;

  const groups: DailyReportGroup[] = [];
  const seen = new Set<string>();

  let cursor: DailyReportCursor | null = null;
  let snapshotAt: string | null = null;
  let totalCount: number | null = null;
  let pages = 0;

  // Bound the loop independently of `has_more` so a server that always reports
  // more can never spin forever.
  const maxPages = 10_000;

  for (;;) {
    if (signal?.aborted) {
      throw new DailyReportExportError("cancelled", "Report generation was cancelled.");
    }
    if (pages >= maxPages) {
      throw new DailyReportExportError("too_many_pages", "Report exceeded the maximum page count.");
    }

    let page: DailyReportPage | null = null;
    let lastError: unknown = null;

    for (let attempt = 0; attempt <= maxRetriesPerPage; attempt++) {
      if (signal?.aborted) {
        throw new DailyReportExportError("cancelled", "Report generation was cancelled.");
      }
      try {
        page = await fetchPage({ ...pageParams, cursor, snapshotAt, signal });
        break;
      } catch (err) {
        // A cancellation or a contract violation is terminal — only transient
        // transport failures are worth re-requesting.
        if (err instanceof DailyReportExportError && err.code !== "page_failed") throw err;
        if (signal?.aborted) {
          throw new DailyReportExportError("cancelled", "Report generation was cancelled.");
        }
        lastError = err;
        if (attempt < maxRetriesPerPage) await delay(300 * (attempt + 1));
      }
    }

    if (!page) {
      throw new DailyReportExportError(
        "page_failed",
        lastError instanceof Error ? lastError.message : "A report page failed to load.",
      );
    }

    if (snapshotAt === null) {
      snapshotAt = page.snapshotAt;
      if (page.totalCount == null) {
        throw new DailyReportExportError(
          "missing_total",
          "The report did not return an authoritative row count.",
        );
      }
      totalCount = page.totalCount;
    } else if (page.snapshotAt !== snapshotAt) {
      throw new DailyReportExportError(
        "snapshot_changed",
        "The report data changed while it was being prepared.",
      );
    }

    // Page-scoped ambiguity: only the project ids on THIS page, never the
    // whole organization. A failure here must not silently render wrong
    // ambiguity markers -- it aborts the export like any other page failure.
    const pageProjectIds = Array.from(
      new Set(page.rows.map((row) => String(row.project_id ?? "").trim()).filter(Boolean)),
    );
    let ambiguityByProjectId: Map<string, boolean>;
    try {
      ambiguityByProjectId = await fetchAmbiguityBatch(
        pageParams.organizationId,
        pageProjectIds,
        signal,
      );
    } catch (err) {
      if (err instanceof DailyReportExportError) throw err;
      throw new DailyReportExportError(
        "ambiguity_batch_failed",
        err instanceof Error ? err.message : "Ambiguity lookup failed.",
      );
    }

    for (const row of page.rows) {
      const identity = dailyReportRowIdentity(row);
      if (seen.has(identity)) {
        throw new DailyReportExportError(
          "duplicate_row",
          "The report returned the same row twice.",
        );
      }
      seen.add(identity);
      const projectId = String(row.project_id ?? "").trim();
      groups.push(serverRowToGroup({
        ...row,
        project_name_ambiguous: ambiguityByProjectId.get(projectId) ?? false,
      }));
    }

    pages += 1;
    onProgress?.({ received: groups.length, total: totalCount, pages });

    if (!page.hasMore || !page.nextCursor) break;
    cursor = page.nextCursor;
  }

  if (totalCount == null) {
    throw new DailyReportExportError("missing_total", "The report did not return a row count.");
  }
  // The invariant the whole design exists to protect.
  if (seen.size !== totalCount || groups.length !== totalCount) {
    throw new DailyReportExportError(
      "incomplete",
      `The report is incomplete: expected ${totalCount} rows but assembled ${seen.size}.`,
    );
  }

  return {
    results: finalizeDailyReportGroups(groups),
    totalCount,
    pages,
    snapshotAt: snapshotAt as string,
  };
}
