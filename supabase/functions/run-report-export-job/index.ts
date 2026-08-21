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
        contentType: "text/csv; charset=utf-8",
        upsert: true,
      });
    if (upErr) throw new Error(`upload: ${upErr.message}`);

    const { error: doneErr } = await svc.rpc("complete_report_export_job_v1", {
      p_job_id: jobId,
      p_worker_id: workerId,
      p_storage_path: storagePath,
      p_filename: filename,
      p_mime_type: "text/csv; charset=utf-8",
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
