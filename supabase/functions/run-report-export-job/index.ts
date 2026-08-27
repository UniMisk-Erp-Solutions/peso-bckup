/**
 * DOC-104 — Daily Project Report export worker.
 *
 * This is the piece DOC-102 was missing. `report_export_jobs` and its full
 * lifecycle (create / claim / heartbeat / complete / fail / recover / cancel)
 * were applied to the database, but nothing ever claimed a job, so every
 * enqueued export sat at `queued` forever and the feature stayed dormant.
 *
 * WHY A WORKER AT ALL
 *   Generation used to happen in the browser: the tab pulled every page, held
 *   the whole report in memory and built the file itself. On Production that is
 *   ~4,141 rows. Here the browser does none of it — it enqueues a job, polls a
 *   status row, and is handed a download URL.
 *
 * HOW IT READS DATA WITHOUT A USER
 *   `get_daily_project_report_page_v1` gates on `auth.uid()`, which a service
 *   -role worker does not have. DOC-102 left the correct seam: that RPC is only
 *   an auth wrapper around `report_daily_project_rows_v1`, which is granted to
 *   `service_role` alone and carries no auth gate. Authorization already
 *   happened when the job was created by a permitted user; re-checking a user
 *   context the worker does not have would be theatre.
 *
 * OUTPUT PARITY
 *   The grouping, sort order, percent split and header set below are a direct
 *   port of `finalizeDailyReportGroups` + `DAILY_PROJECT_REPORT_HEADERS`. A
 *   server-produced file must match what the browser produced, or the same
 *   report would differ depending on which path made it.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsPreflightResponse, jsonResponse } from "../_shared/cors.ts";
import {
  fetchAllExpenseRows,
  buildClaimCsv,
  buildDetailedCsv,
  type AllocationRow,
} from "./expenseReports.ts";

/** Statuses each report selects, mirroring the client loaders it replaces. */
const REPORT_STATUSES: Record<string, string[]> = {
  claim_verification: ["verified", "level_1_verified", "level_2_verified"],
  claim_approval: ["approved"],
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
/** Stop before the edge runtime's wall clock does; the job stays claimable. */
const SOFT_DEADLINE_MS = 110_000;

/** Ported verbatim from src/lib/dailyExpenseReportConfig.ts. Order matters. */
const HEADERS = [
  "Track Date", "Voucher No", "project id", "project name", "Employee",
  "Employee Code", "Location", "Total Resource", "Food", "Over Time",
  "Presence", "Remarks", "Other Remarks", "Petrol Cost", "Material Cost",
  "Travelling Cost", "Phone Exp.", "Hotel Exp.", "Transport Exp",
  "Contra Bill", "Other Exp.", "Site Id/RO Code", "percent",
] as const;

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
      row["project id"] = g.projectId;
      row["project name"] = g.projectName;
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

function toCsv(rows: Record<string, string | number>[]): string {
  const lines = [HEADERS.map(csvCell).join(",")];
  for (const r of rows) lines.push(HEADERS.map((h) => csvCell(r[h])).join(","));
  // BOM so Excel reads Hindi/Gujarati employee names as UTF-8 rather than mojibake.
  return "﻿" + lines.join("\r\n") + "\r\n";
}

/**
 * DOC-105 — build one of the three expense-based reports.
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

  if (reportType === "claim_verification" || reportType === "claim_approval") {
    const built = buildClaimCsv(rows, reportType);
    return { ...built, pages };
  }

  // Detailed: a single employee gets the credit/debit ledger; "All employees"
  // has no one wallet to walk, so it stays a flat list — the split the UI makes.
  let allocations: AllocationRow[] = [];
  if (singleUserId) {
    const { data, error } = await svc.rpc("report_expense_allocations_v1", {
      p_organization_id: orgId,
      p_user_id: singleUserId,
      p_date_from: params.date_from ? String(params.date_from) : null,
      p_date_to: params.date_to ? String(params.date_to) : null,
    });
    if (error) throw new Error(`allocations: ${error.message}`);
    allocations = (data ?? []) as AllocationRow[];
  }

  const closingBalance = singleUserId ? Number(rows[0]?.user_balance ?? 0) : 0;
  const built = buildDetailedCsv(rows, allocations, singleUserId, closingBalance);
  return { ...built, pages };
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

  const workerId = `edge-${crypto.randomUUID().slice(0, 8)}`;
  const startedAt = Date.now();

  const { data: claim, error: claimErr } = await svc.rpc("claim_report_export_job_v1", {
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

  // DOC-105 — the three expense-based reports. Same claim/heartbeat/upload/
  // complete lifecycle; only the row source and the file body differ.
  if (reportType !== "daily_project_report") {
    try {
      const result = await buildExpenseReport(svc, {
        reportType, jobId, orgId, workerId, params,
        deadline: () => Date.now() - startedAt > SOFT_DEADLINE_MS,
      });
      const bytes = new TextEncoder().encode(result.csv);
      const stamp = new Date().toISOString().slice(0, 10);
      const filename = `${REPORT_FILENAMES[reportType] ?? "report"}_${stamp}.csv`;
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
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Export failed";
      await svc.rpc("fail_report_export_job_v1", {
        p_job_id: jobId,
        p_worker_id: workerId,
        p_error_code: "worker_error",
        p_error_message_safe: message.slice(0, 300),
        p_retryable: true,
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
        throw new Error(`Exceeded soft deadline after ${pages} pages`);
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

      for (const r of (p.rows ?? []) as Record<string, unknown>[]) groups.push(toGroup(r));
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
    const body = toCsv(rows);
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
      p_retryable: true,
    });
    return jsonResponse({ claimed: true, job_id: jobId, status: "failed", error: message }, 500);
  }
});
