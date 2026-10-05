/**
 * Report export worker — claims a queued report_export_jobs row and
 * generates the file server-side for all four Reports tabs.
 *
 * WHY A WORKER AT ALL
 *   Generation used to happen in the browser: the tab pulled every page, held
 *   the whole report in memory and built the file itself. Here the browser
 *   does none of it — it enqueues a job, polls a status row, and is handed a
 *   download URL. Claim Verification/Approval/Detailed additionally had no
 *   pagination safety net at all (a plain, unbounded PostgREST query subject
 *   to this deployment's row cap), so moving them here also closes a real
 *   silent-truncation risk, not just a UX one.
 *
 * HOW IT READS DATA WITHOUT A USER
 *   `get_daily_project_report_page_v1` gates on `auth.uid()`, which a
 *   service-role worker does not have. `report_daily_project_rows_v1` and
 *   `report_expense_rows_v1` are the unrestricted cores those authenticated
 *   RPCs delegate to, granted to `service_role` alone with no auth gate.
 *   Authorization already happened when the job was created by a permitted
 *   user; re-checking a user context the worker does not have would be
 *   theatre.
 *
 * OUTPUT PARITY
 *   The Daily Project Report's grouping, sort order, percent split and
 *   header set below are a direct port of `finalizeDailyReportGroups` +
 *   `DAILY_PROJECT_REPORT_HEADERS`. A server-produced file must match what
 *   the browser produced, or the same report would differ depending on
 *   which path made it.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsPreflightResponse, jsonResponse } from "../_shared/cors.ts";
import {
  fetchAllExpenseRows,
  fetchAllDetailedExpenseRowsV4,
  buildClaimCsv,
  buildDetailedRows,
  matchesDetailedExpenseFilters,
  buildDetailedExpenseFilename,
  toCsv,
  assertCsvMatchesRows,
  REPORT_TOO_LARGE_MESSAGE,
} from "./expenseReports.ts";

/** Row objects per store_report_export_job_preview_chunk_v1 call. Keeps each
 *  RPC payload small and predictable regardless of report size. */
const PREVIEW_STORE_CHUNK_SIZE = 500;

/** Best-effort: freezes the exact rows/columns the CSV was built from into
 *  report_export_job_rows, so the on-page preview can never drift from the
 *  downloaded file (they are the SAME computed objects, not a re-query). A
 *  failure here must never fail the report itself -- the file already
 *  uploaded successfully is what matters; the preview degrades to
 *  "not available" (get_report_export_job_preview_v1 returns
 *  reason: no_preview_available) rather than blocking anything. */
async function storeDetailedExpensePreview(
  // deno-lint-ignore no-explicit-any
  svc: any,
  jobId: string,
  headers: string[],
  rows: Record<string, string>[],
): Promise<void> {
  try {
    await svc.rpc("clear_report_export_job_preview_v1", { p_job_id: jobId });
    for (let start = 0; start < rows.length; start += PREVIEW_STORE_CHUNK_SIZE) {
      const chunk = rows.slice(start, start + PREVIEW_STORE_CHUNK_SIZE);
      const { error } = await svc.rpc("store_report_export_job_preview_chunk_v1", {
        p_job_id: jobId,
        p_start_index: start,
        p_columns: headers,
        p_rows: chunk,
      });
      if (error) throw new Error(error.message);
    }
  } catch (err) {
    console.error(`storeDetailedExpensePreview failed for job ${jobId} (non-fatal):`, err);
  }
}

/** Statuses each report selects, mirroring the client loaders it replaces. */
const REPORT_STATUSES: Record<string, string[]> = {
  claim_verification: ["verified", "level_1_verified", "level_2_verified"],
  claim_approval: ["approved"],
  // Detailed Expense no longer selects expense rows at all -- it reads the
  // canonical Additive V3 balance timeline, in which the ONLY expenses that
  // appear are those with an expense_balance_deductions row, i.e. approved
  // ones. The approved-only rule is therefore enforced by the accounting
  // model itself rather than by a status list here.
  detailed_expense: ["approved"],
};

const REPORT_FILENAMES: Record<string, string> = {
  claim_verification: "claim-verification-list",
  claim_approval: "claim-approval-list",
  detailed_expense: "detailed-expense-report",
};

const BUCKET = "generated-reports";
const PAGE_SIZE = 250;
/** Must track DAILY_REPORT_SCHEMA_VERSION in src/lib/dailyProjectReportPaging.ts. */
const DAILY_REPORT_SCHEMA_VERSION = 1;
/**
 * Stop before the edge runtime's wall clock does. The platform hard limit is
 * 60 s (workerTimeoutMs in the functions main service), NOT the 110 s this
 * used to assume -- past 60 s the request is cancelled without any failure
 * being recorded, so the job sat `running` until stale recovery and then
 * looped. 50 s leaves room to mark the job failed with a real reason.
 */
const SOFT_DEADLINE_MS = 50_000;

/** Ported verbatim from src/lib/dailyExpenseReportConfig.ts. Order matters. */
const HEADERS = [
  "Track Date", "Voucher No", "project id", "project name", "Employee",
  "Employee Code", "Location", "Total Resource", "Food", "Over Time",
  "Presence", "Remarks", "Other Remarks", "Petrol Cost", "Material Cost",
  "Travelling Cost", "Phone Exp.", "Hotel Exp.", "Transport Exp",
  "Contra Bill", "Other Exp.", "Site Id/RO Code", "percent",
] as const;

/**
 * Ported verbatim from src/lib/dailyExpenseReportConfig.ts
 * (resolveProjectIdCell / resolveProjectNameCell / the two marker strings).
 * Presentation only -- never written back to the database. The ambiguity
 * signal itself (`project_name_ambiguous`) comes from
 * get_daily_report_project_name_ambiguity_batch_v2, called per-page with
 * only that page's project ids -- the same RPC and the same page-scoped
 * batching src/lib/dailyProjectReportPaging.ts uses, so there is no second
 * source of truth to drift from.
 */
const NO_DATA_MARKER = "N/A - no data on record";
const AMBIGUOUS_NAME_MARKER = "Ambiguous - multiple names on record, unresolved";

function resolveProjectIdCell(projectId: string): string {
  const trimmed = String(projectId ?? "").trim();
  return trimmed || NO_DATA_MARKER;
}

function resolveProjectNameCell(projectName: string, isAmbiguous: boolean): string {
  const trimmed = String(projectName ?? "").trim();
  if (trimmed) return trimmed;
  return isAmbiguous ? AMBIGUOUS_NAME_MARKER : NO_DATA_MARKER;
}

const COST_COLUMNS: { key: string; label: string }[] = [
  { key: "petrol_cost", label: "Petrol Cost" },
  { key: "material_cost", label: "Material Cost" },
  { key: "travelling_cost", label: "Travelling Cost" },
  { key: "phone_exp", label: "Phone Exp." },
  { key: "hotel_exp", label: "Hotel Exp." },
  { key: "transport_exp", label: "Transport Exp" },
  { key: "contra_bill", label: "Contra Bill" },
  { key: "other_exp", label: "Other Exp." },
];

type Group = {
  trackDate: string;
  userId: string;
  projectId: string;
  projectName: string;
  /** From get_daily_report_project_name_ambiguity_batch_v2, merged in
   * per-page before toGroup runs. Only meaningful when projectName is blank
   * -- see resolveProjectNameCell. */
  projectNameAmbiguous: boolean;
  location: string;
  voucherNo: string;
  employeeName: string;
  employeeCode: string;
  costs: Record<string, number>;
  /** Every underlying expense's own free-text remark (base `purpose`), in the
   * order the RPC emits source_expenses. Joined into the "Remarks" column --
   * a report row groups a whole batch, so all of its lines' remarks belong on
   * that one row. Mirrors finalizeDailyReportGroups in
   * src/lib/buildDailyProjectExpenseReport.ts. */
  remarks: string[];
};

/**
 * supabase-js types `.rpc()` against a generated `Database` schema. Edge
 * functions in this project do not ship that generated type, so without an
 * explicit generic every rpc argument object infers as `undefined` and the file
 * cannot be type-checked at all. `any` here is a deliberate, scoped choice at
 * the client boundary — not an omission — so `deno check` can verify the rest.
 */
// deno-lint-ignore no-explicit-any
type ServiceClient = ReturnType<typeof createClient<any>>;

function serviceClient(): ServiceClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error("Server misconfiguration: missing Supabase service credentials");
  }
  // deno-lint-ignore no-explicit-any
  return createClient<any>(url, key, { auth: { persistSession: false } });
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** trip_start (YYYY-MM-DD...) -> DD-MM-YYYY, matching formatTrackDate. */
function formatTrackDate(tripStart: string | null): string {
  if (!tripStart) return "";
  const d = tripStart.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return "";
  const [y, m, day] = d.split("-");
  return `${day}-${m}-${y}`;
}

/** Mirrors payrollPercentForEmployeeDay: an employee-day splits 100% evenly. */
function payrollPercent(projectCount: number): number {
  return Math.round((100 / Math.max(1, projectCount)) * 100) / 100;
}

function toGroup(row: Record<string, unknown>): Group {
  const costsIn = (row.costs ?? {}) as Record<string, unknown>;
  const costs: Record<string, number> = {};
  for (const { key } of COST_COLUMNS) costs[key] = num(costsIn[key]);

  // source_expenses arrives already ordered by (trip_start, category, id) from
  // the RPC -- keep that order, keep duplicates (five real lines can share a
  // remark), and drop only genuinely empty ones so no stray comma appears.
  const srcRows = Array.isArray(row.source_expenses)
    ? (row.source_expenses as Record<string, unknown>[])
    : [];
  const remarks = srcRows
    .map((src) => String(src?.purpose ?? "").trim())
    .filter((p) => p !== "");

  return {
    trackDate: formatTrackDate((row.track_date as string) || null),
    userId: String(row.user_id ?? ""),
    projectId: String(row.project_id ?? "").trim(),
    projectName: String(row.project_name ?? "").trim(),
    projectNameAmbiguous: row.project_name_ambiguous === true,
    location: String(row.location ?? "").trim(),
    voucherNo: String(row.voucher_no ?? "").trim(),
    employeeName: String(row.employee_name ?? ""),
    employeeCode: String(row.employee_code ?? ""),
    costs,
    remarks,
  };
}

/** Direct port of finalizeDailyReportGroups — same sort, same percent split. */
function finalize(groups: Group[]): Record<string, string | number>[] {
  const perEmployeeDay = new Map<string, number>();
  for (const g of groups) {
    const k = `${g.trackDate}${g.userId}`;
    perEmployeeDay.set(k, (perEmployeeDay.get(k) ?? 0) + 1);
  }

  return [...groups]
    .sort((a, b) =>
      a.trackDate.localeCompare(b.trackDate) ||
      a.employeeName.localeCompare(b.employeeName) ||
      a.projectId.localeCompare(b.projectId) ||
      a.projectName.localeCompare(b.projectName))
    .map((g) => {
      const row: Record<string, string | number> = {};
      for (const h of HEADERS) row[h] = "";
      row["Track Date"] = g.trackDate;
      row["Voucher No"] = g.voucherNo;
      row["project id"] = resolveProjectIdCell(g.projectId);
      row["project name"] = resolveProjectNameCell(g.projectName, g.projectNameAmbiguous);
      row["Employee"] = g.employeeName;
      row["Employee Code"] = g.employeeCode;
      row["Location"] = g.location;
      row["Presence"] = "P";
      row["Remarks"] = g.remarks.join(", ");
      row["percent"] = payrollPercent(
        perEmployeeDay.get(`${g.trackDate}${g.userId}`) ?? 1,
      );
      for (const { key, label } of COST_COLUMNS) {
        if (g.costs[key] > 0) row[label] = g.costs[key];
      }
      return row;
    });
}

/** RFC 4180 escaping. A stray quote or comma in a project name must not shift columns. */
function csvCell(v: string | number): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Named distinctly on purpose: this module ALSO imports the shared
// toCsv(headers, rows) from ./expenseReports.ts. A same-named local function
// here silently shadowed that import and turned every Detailed Expense CSV
// into this report's fixed header line plus blank rows (2026-09-24 incident).
function toDailyProjectCsv(rows: Record<string, string | number>[]): string {
  const lines = [HEADERS.map(csvCell).join(",")];
  for (const r of rows) lines.push(HEADERS.map((h) => csvCell(r[h])).join(","));
  // BOM so Excel reads Hindi/Gujarati employee names as UTF-8 rather than mojibake.
  return "﻿" + lines.join("\r\n") + "\r\n";
}

/**
 * Build one of the three expense-based reports.
 *
 * The engineer-status filter narrows Claim Verification to a single verified
 * stage; absent or "all" it keeps every stage, matching the tab's default.
 */
async function buildExpenseReport(
  svc: ServiceClient,
  args: {
    reportType: string;
    jobId: string;
    orgId: string;
    workerId: string;
    params: Record<string, unknown>;
    deadline: () => boolean;
  },
): Promise<{ csv: string; rowCount: number; pages: number }> {
  const { reportType, jobId, orgId, workerId, params, deadline } = args;

  const engineerStatus = params.engineer_status ? String(params.engineer_status) : "all";
  const statuses = reportType === "claim_verification" && engineerStatus !== "all"
    ? [engineerStatus]
    : REPORT_STATUSES[reportType];
  if (!statuses) throw new Error(`Unsupported report type: ${reportType}`);

  const userIds = Array.isArray(params.user_ids) && params.user_ids.length
    ? (params.user_ids as string[])
    : null;
  const singleUserId = params.user_id ? String(params.user_id) : null;
  const effectiveUserIds = singleUserId ? [singleUserId] : userIds;

  const { rows, total, pages } = await fetchAllExpenseRows(
    svc,
    {
      organizationId: orgId,
      statuses,
      category: params.category ? String(params.category) : null,
      userIds: effectiveUserIds,
      dateFrom: params.date_from ? String(params.date_from) : null,
      dateTo: params.date_to ? String(params.date_to) : null,
      sortColumn: reportType === "detailed_expense" ? "trip_start" : "created_at",
    },
    async (received, runningTotal) => {
      await svc.rpc("report_export_job_heartbeat_v1", {
        p_job_id: jobId,
        p_worker_id: workerId,
        p_progress_current: received,
        p_progress_total: runningTotal,
        p_snapshot_at: null,
      });
    },
    deadline,
  );

  // Same invariant as the Daily worker: never write a partial file.
  if (total != null && rows.length !== total) {
    throw new Error(`Incomplete: expected ${total} rows, assembled ${rows.length}`);
  }

  const built = buildClaimCsv(rows, reportType as "claim_verification" | "claim_approval");
  return { ...built, pages };
}

/**
 * Detailed Expense.
 *
 * A proper accounting ledger on the canonical Additive V3 timeline: approved
 * expense deductions, balance/Tally additions, negative additive entries,
 * opening credits and every other signed balance event, each with Credit,
 * Debit, Opening Balance and Closing Balance — for a single employee or for
 * every employee, each on their OWN independent running balance.
 *
 * No balance arithmetic happens here. report_balance_timeline_rows_v3 builds
 * the complete timeline, computes the running balance per employee, and only
 * then applies the report window — so the first in-period row opens at its
 * true carried-in balance instead of at zero.
 */
async function buildDetailedExpenseReport(
  svc: ServiceClient,
  args: {
    jobId: string;
    orgId: string;
    workerId: string;
    params: Record<string, unknown>;
    deadline: () => boolean;
  },
): Promise<{
  csv: string;
  rowCount: number;
  pages: number;
  filename: string;
  expenseRowCount: number;
  modernExpenseRowCount: number;
  legacyExpenseRowCount: number;
}> {
  const { jobId, orgId, workerId, params, deadline } = args;

  const singleUserId = params.user_id ? String(params.user_id) : null;
  const listedUserIds = Array.isArray(params.user_ids) && params.user_ids.length
    ? (params.user_ids as string[])
    : null;
  const userIds = singleUserId ? [singleUserId] : listedUserIds;
  const dateFrom = params.date_from ? String(params.date_from) : null;
  const dateTo = params.date_to ? String(params.date_to) : null;

  const { rows, total, pages } = await fetchAllDetailedExpenseRowsV4(
    svc,
    {
      organizationId: orgId,
      userIds,
      dateFrom,
      dateTo,
    },
    async (received, runningTotal) => {
      await svc.rpc("report_export_job_heartbeat_v1", {
        p_job_id: jobId,
        p_worker_id: workerId,
        p_progress_current: received,
        p_progress_total: runningTotal,
        p_snapshot_at: null,
      });
    },
    deadline,
  );

  // Same invariant as every other report here: never write a partial file. A
  // silently short accounting ledger is worse than no ledger. This check runs
  // against the FULL fetched timeline, before any presentation filter below.
  if (total != null && rows.length !== total) {
    throw new Error(`Incomplete: expected ${total} rows, assembled ${rows.length}`);
  }

  // Expense Type / custom-field filters narrow which rows are PRESENTED --
  // applied after the complete, correctly-balanced timeline is in hand, never
  // by asking report_balance_timeline_rows_v3 for a partial event set (that
  // would recompute Opening/Closing Balance as if the hidden events never
  // happened, which is wrong).
  const category = params.category ? String(params.category) : null;
  const customFieldFilters =
    params.custom_field_filters && typeof params.custom_field_filters === "object"
      ? (params.custom_field_filters as Record<string, string>)
      : null;
  const filteredRows = (category || customFieldFilters)
    ? rows.filter((r) => matchesDetailedExpenseFilters(r, category, customFieldFilters))
    : rows;

  const { headers, rows: builtRows } = buildDetailedRows(filteredRows);
  // Freeze the exact same row objects the CSV is about to be built from into
  // the on-page preview store -- one computation, two consumers.
  await storeDetailedExpensePreview(svc, jobId, headers, builtRows);

  // Employee name/code are already server-resolved onto every timeline row
  // (report_balance_timeline_rows_v3 joins profiles) -- reuse them rather
  // than trust anything the browser sent, and rather than run a second query.
  // Rare fallback: the selected employee has zero events in this date range,
  // so no timeline row carries their name -- resolve it directly instead of
  // falling back to the generic "Employee" for a perfectly identifiable person.
  let employeeName = singleUserId ? rows.find((r) => r.user_id === singleUserId)?.employee_name ?? null : null;
  let employeeCode = singleUserId ? rows.find((r) => r.user_id === singleUserId)?.employee_code ?? null : null;
  if (singleUserId && !employeeName && !employeeCode) {
    const { data: prof } = await svc
      .from("profiles")
      .select("name, employee_id")
      .eq("user_id", singleUserId)
      .eq("organization_id", orgId)
      .maybeSingle();
    employeeName = prof?.name ?? null;
    employeeCode = prof?.employee_id ?? null;
  }
  const filename = buildDetailedExpenseFilename({
    singleUserId,
    employeeName,
    employeeCode,
    dateFrom,
    dateTo,
  });

  // Diagnostic split, proving the legacy population is genuinely included --
  // not exposed as a CSV column, just surfaced in the completion response.
  const expenseTypeRows = filteredRows.filter((r) => r.event_type === "expense_deduction");
  const modernExpenseRowCount = expenseTypeRows.filter((r) => r.modern_deduction_present === true).length;
  const legacyExpenseRowCount = expenseTypeRows.length - modernExpenseRowCount;

  const csv = toCsv(headers, builtRows);
  // Fail loudly rather than upload a file whose header/body cannot be the
  // rows we just counted -- a "completed" job with an unusable file is worse
  // than a failed one with a reason.
  assertCsvMatchesRows(csv, headers, builtRows.length);

  return {
    csv,
    rowCount: builtRows.length,
    pages,
    filename,
    expenseRowCount: expenseTypeRows.length,
    modernExpenseRowCount,
    legacyExpenseRowCount,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflightResponse();
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  let svc: ServiceClient;
  try {
    svc = serviceClient();
  } catch (err) {
    return jsonResponse({ error: (err as Error).message }, 500);
  }

  // Any authenticated caller may drain the queue. They never see another org's
  // output: the file lands in that job's org path and reads are gated by the
  // job row's RLS. Authorization for the report itself happened at enqueue.
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (token !== serviceKey) {
    const { data, error } = await svc.auth.getUser(token);
    if (error || !data?.user) return jsonResponse({ error: "Unauthorized" }, 401);
  }

  // Stale-job recovery: recover_stale_report_export_jobs_v1 already existed
  // in the schema (20260827150000_report_export_jobs.sql) but was never
  // called from anywhere -- a job whose worker died mid-run (crash, network
  // partition, platform kill) without ever reaching complete/fail would stay
  // `running` forever, since claim_report_export_job_v1 only looks at
  // `queued` rows. Piggybacking one cheap, SKIP LOCKED, best-effort call
  // here means every invocation of this function -- the frontend's
  // triggerExportWorker() nudge AND the cron backstop -- also sweeps stale
  // jobs back to `queued` (or to `failed` once attempts are exhausted), with
  // no separate schedule or endpoint needed. A failure here must never block
  // this request's own claim attempt.
  try {
    await svc.rpc("recover_stale_report_export_jobs_v1", {});
  } catch {
    /* best-effort; the next invocation tries again */
  }

  const workerId = `edge-${crypto.randomUUID().slice(0, 8)}`;
  const startedAt = Date.now();

  // Targeted nudge: the browser sends the job it just enqueued so THIS
  // invocation works on the caller's own report instead of whatever happens
  // to be the oldest queued job in any organization. No job_id (the cron
  // backstop) keeps the original global oldest-first claim.
  let requestedJobId: string | null = null;
  try {
    const body = await req.json();
    const candidate = body && typeof body === "object" ? (body as Record<string, unknown>).job_id : null;
    if (typeof candidate === "string" && /^[0-9a-fA-F-]{36}$/.test(candidate)) requestedJobId = candidate;
  } catch {
    /* empty or non-JSON body == global drain */
  }

  const { data: claim, error: claimErr } = requestedJobId
    ? await svc.rpc("claim_report_export_job_v2", {
        p_worker_id: workerId,
        p_job_id: requestedJobId,
        p_max_per_org: 1,
      })
    : await svc.rpc("claim_report_export_job_v1", {
        p_worker_id: workerId,
        p_max_per_org: 1,
      });
  if (claimErr) return jsonResponse({ error: claimErr.message }, 500);
  if (!claim?.claimed) return jsonResponse({ claimed: false }, 200);

  const job = claim.job as Record<string, unknown>;
  const jobId = String(job.id);
  const orgId = String(job.organization_id);
  const params = (job.parameters ?? {}) as Record<string, unknown>;
  const format = String(job.format ?? "csv");
  const config = (job.config_snapshot ?? {}) as Record<string, unknown>;
  const reportType = String(job.report_type ?? "daily_project_report");

  // The three expense-based reports. Same claim/heartbeat/upload/
  // complete lifecycle; only the row source and the file body differ.
  if (reportType !== "daily_project_report") {
    try {
      const deadline = () => Date.now() - startedAt > SOFT_DEADLINE_MS;
      // Detailed Expense is an accounting ledger off the canonical V3
      // timeline; Claim Verification and Claim Approval remain expense-row
      // reports and are untouched by this change.
      const result = reportType === "detailed_expense"
        ? await buildDetailedExpenseReport(svc, { jobId, orgId, workerId, params, deadline })
        : await buildExpenseReport(svc, { reportType, jobId, orgId, workerId, params, deadline });
      const bytes = new TextEncoder().encode(result.csv);
      // Detailed Expense identifies the employee + actual requested date
      // range (never today's generation date) -- every other report type
      // keeps its existing generic name.
      const stamp = new Date().toISOString().slice(0, 10);
      const filename = "filename" in result && result.filename
        ? result.filename
        : `${REPORT_FILENAMES[reportType] ?? "report"}_${stamp}.csv`;
      const storagePath = `${orgId}/${jobId}/${filename}`;

      const { error: upErr } = await svc.storage
        .from(BUCKET)
        .upload(storagePath, bytes, { contentType: "text/csv", upsert: true });
      if (upErr) throw new Error(`upload: ${upErr.message}`);

      const { error: doneErr } = await svc.rpc("complete_report_export_job_v1", {
        p_job_id: jobId,
        p_worker_id: workerId,
        p_storage_path: storagePath,
        p_filename: filename,
        p_mime_type: "text/csv",
        p_file_size_bytes: bytes.byteLength,
        p_row_count: result.rowCount,
      });
      if (doneErr) throw new Error(`complete: ${doneErr.message}`);

      return jsonResponse({
        claimed: true, job_id: jobId, status: "completed",
        report_type: reportType, row_count: result.rowCount,
        pages: result.pages, bytes: bytes.byteLength, format,
        // Detailed Expense only: proves the V4 legacy population is genuinely
        // included, not just a bigger total. Undefined for every other report type.
        ...("expenseRowCount" in result ? {
          expense_row_count: result.expenseRowCount,
          modern_expense_row_count: result.modernExpenseRowCount,
          legacy_expense_row_count: result.legacyExpenseRowCount,
        } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Export failed";
      await svc.rpc("fail_report_export_job_v1", {
        p_job_id: jobId,
        p_worker_id: workerId,
        p_error_code: "worker_error",
        p_error_message_safe: message.slice(0, 300),
        p_retryable: message !== REPORT_TOO_LARGE_MESSAGE,
      });
      return jsonResponse(
        { claimed: true, job_id: jobId, status: "failed", error: message },
        500,
      );
    }
  }

  try {
    const groups: Group[] = [];
    let cursor: unknown = null;
    let snapshotAt: string | null = null;
    let total: number | null = null;
    let pages = 0;

    for (;;) {
      if (Date.now() - startedAt > SOFT_DEADLINE_MS) {
        throw new Error(REPORT_TOO_LARGE_MESSAGE);
      }

      const { data: page, error } = await svc.rpc("report_daily_project_rows_v1", {
        p_organization_id: orgId,
        p_config: config,
        p_date_from: params.date_from ?? null,
        p_date_to: params.date_to ?? null,
        p_user_id: params.user_id ?? null,
        p_user_ids: params.user_ids ?? null,
        p_snapshot_at: snapshotAt,
        p_cursor: cursor,
        p_page_size: PAGE_SIZE,
        p_with_total: snapshotAt === null,
      });
      if (error) throw new Error(`page ${pages + 1}: ${error.message}`);

      const p = page as Record<string, unknown>;
      // The browser coordinator refuses an unknown contract version rather than
      // guessing at the shape; a worker writing a file nobody reviews must too.
      if (Number(p.schema_version) !== DAILY_REPORT_SCHEMA_VERSION) {
        throw new Error(
          `Report contract version ${String(p.schema_version)} is not supported by this worker`,
        );
      }
      if (snapshotAt === null) {
        snapshotAt = (p.snapshot_at as string) ?? null;
        total = p.total_count == null ? null : Number(p.total_count);
      }

      // Page-scoped ambiguity: same RPC, same semantics, same index-bounded
      // batch the browser uses -- see
      // src/lib/dailyProjectReportPaging.ts#fetchProjectNameAmbiguityBatch
      // and 20260829120000_daily_report_remarks_and_batch_ambiguity.sql.
      // Never a separate full-organization scan; a parity test asserts the
      // worker and the browser reach the same ambiguity decision for the
      // same project ids.
      const pageRows = (p.rows ?? []) as Record<string, unknown>[];
      const pageProjectIds = Array.from(
        new Set(pageRows.map((r) => String(r.project_id ?? "").trim()).filter(Boolean)),
      );
      let ambiguityByProjectId = new Map<string, boolean>();
      if (pageProjectIds.length > 0) {
        const { data: ambigRows, error: ambigErr } = await svc.rpc(
          "get_daily_report_project_name_ambiguity_batch_v2",
          { p_organization_id: orgId, p_project_ids: pageProjectIds },
        );
        if (ambigErr) throw new Error(`page ${pages + 1} ambiguity: ${ambigErr.message}`);
        for (const row of (ambigRows ?? []) as Record<string, unknown>[]) {
          ambiguityByProjectId.set(String(row.project_id), row.project_name_ambiguous === true);
        }
      }

      for (const r of pageRows) {
        const projectId = String(r.project_id ?? "").trim();
        groups.push(toGroup({ ...r, project_name_ambiguous: ambiguityByProjectId.get(projectId) ?? false }));
      }
      pages += 1;

      await svc.rpc("report_export_job_heartbeat_v1", {
        p_job_id: jobId,
        p_worker_id: workerId,
        p_progress_current: groups.length,
        p_progress_total: total,
        p_snapshot_at: snapshotAt,
      });

      if (!p.has_more || !p.next_cursor) break;
      cursor = p.next_cursor;
    }

    // Same invariant the browser coordinator enforces: never emit a partial file.
    if (total != null && groups.length !== total) {
      throw new Error(`Incomplete: expected ${total} rows, assembled ${groups.length}`);
    }

    const rows = finalize(groups);
    const body = toDailyProjectCsv(rows);
    const bytes = new TextEncoder().encode(body);

    const stamp = (snapshotAt ?? new Date().toISOString()).slice(0, 10);
    const filename = `daily-project-report_${stamp}.csv`;
    const storagePath = `${orgId}/${jobId}/${filename}`;

    const { error: upErr } = await svc.storage
      .from(BUCKET)
      .upload(storagePath, bytes, {
        // The bucket's allowed_mime_types lists a bare "text/csv"; Storage
        // compares the whole header, so "text/csv; charset=utf-8" is rejected.
        // Encoding is carried by the BOM above, not by this parameter.
        contentType: "text/csv",
        upsert: true,
      });
    if (upErr) throw new Error(`upload: ${upErr.message}`);

    const { error: doneErr } = await svc.rpc("complete_report_export_job_v1", {
      p_job_id: jobId,
      p_worker_id: workerId,
      p_storage_path: storagePath,
      p_filename: filename,
      p_mime_type: "text/csv",
      p_file_size_bytes: bytes.byteLength,
      p_row_count: rows.length,
    });
    if (doneErr) throw new Error(`complete: ${doneErr.message}`);

    return jsonResponse({
      claimed: true, job_id: jobId, status: "completed",
      row_count: rows.length, pages, bytes: bytes.byteLength, format,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Export failed";
    // Message is our own text, never a raw driver payload — it surfaces in the UI.
    await svc.rpc("fail_report_export_job_v1", {
      p_job_id: jobId,
      p_worker_id: workerId,
      p_error_code: "worker_error",
      p_error_message_safe: message.slice(0, 300),
      p_retryable: message !== REPORT_TOO_LARGE_MESSAGE,
    });
    return jsonResponse({ claimed: true, job_id: jobId, status: "failed", error: message }, 500);
  }
});
