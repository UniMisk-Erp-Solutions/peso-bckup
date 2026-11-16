/**
 * Tally sync preparation worker (Phase 3) — resolves full datasets, stores
 * normalized items, marks jobs `prepared`. No external voucher/XML transport.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsPreflightResponse, jsonResponse } from "../_shared/cors.ts";
import { contentHash } from "../_shared/tallySync/contentHash.ts";
import { resolveDetailedExpenseRpcDates } from "../_shared/tallySync/detailedDates.ts";
import { enqueueDeliveryBatches } from "../_shared/tallySync/enqueueDeliveryBatches.ts";

const EXPENSE_PAGE = 250;
const DETAILED_PAGE = 500;
const DAILY_PAGE = 250;
const ITEM_CHUNK = 200;
const DAILY_SCHEMA = 1;

type Svc = ReturnType<typeof createClient<any>>;

function serviceClient(): Svc {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Server misconfiguration");
  // deno-lint-ignore no-explicit-any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createClient<any>(url, key, { auth: { persistSession: false } });
}

function parseParams(raw: Record<string, unknown>) {
  const custom =
    raw.custom_field_filters && typeof raw.custom_field_filters === "object"
      ? (raw.custom_field_filters as Record<string, string>)
      : null;
  return {
    category: raw.category ? String(raw.category) : null,
    userIds: raw.user_id
      ? [String(raw.user_id)]
      : Array.isArray(raw.user_ids) && raw.user_ids.length
        ? (raw.user_ids as string[])
        : null,
    engineerStatus: raw.engineer_status ? String(raw.engineer_status) : null,
    hoStatus: raw.ho_status ? String(raw.ho_status) : null,
    dateFrom: raw.date_from ? String(raw.date_from) : null,
    dateTo: raw.date_to ? String(raw.date_to) : null,
    customFieldFilters: custom,
  };
}

function verificationStatuses(engineerStatus: string | null): string[] {
  if (!engineerStatus || engineerStatus === "all") {
    return ["verified", "level_1_verified", "level_2_verified"];
  }
  return [engineerStatus];
}

function matchesCustomFields(row: Record<string, unknown>, filters: Record<string, string> | null): boolean {
  if (!filters || !Object.keys(filters).length) return true;
  const cf = (row.custom_fields ?? {}) as Record<string, string>;
  for (const [k, v] of Object.entries(filters)) {
    if (!v || v === "all") continue;
    if (String(cf[k] ?? "").trim() !== v) return false;
  }
  return true;
}

function matchesDetailedFilters(
  row: Record<string, unknown>,
  category: string | null,
  filters: Record<string, string> | null,
): boolean {
  if (row.event_type !== "expense_deduction") return true;
  if (category && String(row.category ?? "") !== category) return false;
  return matchesCustomFields(row, filters);
}

function tierForEngineerStatus(es: string): string | null {
  if (es === "verified") return "engineer";
  if (es === "level_1_verified") return "team_leader";
  if (es === "level_2_verified") return "executive";
  return null;
}

async function expenseMetaBatch(svc: Svc, orgId: string, ids: string[]): Promise<Record<string, { approval_tier?: string; deleted_at?: string }>> {
  if (!ids.length) return {};
  const { data, error } = await svc.rpc("tally_expense_meta_batch_v1", {
    p_organization_id: orgId,
    p_expense_ids: ids,
  });
  if (error) throw new Error(error.message);
  return (data ?? {}) as Record<string, { approval_tier?: string; deleted_at?: string }>;
}

function passesTallyExpenseFilters(
  row: Record<string, unknown>,
  reportType: string,
  params: ReturnType<typeof parseParams>,
  meta: Record<string, { approval_tier?: string; deleted_at?: string }>,
): boolean {
  const id = String(row.id);
  if (meta[id]?.deleted_at) return false;
  if (!matchesCustomFields(row, params.customFieldFilters)) return false;
  if (reportType === "claim_approval" && params.engineerStatus && params.engineerStatus !== "all") {
    const want = tierForEngineerStatus(params.engineerStatus);
    if (want && meta[id]?.approval_tier !== want) return false;
  }
  return true;
}

async function flushItems(
  svc: Svc,
  jobId: string,
  workerId: string,
  buffer: Record<string, unknown>[],
): Promise<void> {
  if (!buffer.length) return;
  const { error } = await svc.rpc("store_tally_sync_job_items_chunk_v1", {
    p_job_id: jobId,
    p_worker_id: workerId,
    p_items: buffer,
  });
  if (error) throw new Error(error.message);
  buffer.length = 0;
}

async function prepareClaimReport(
  svc: Svc,
  job: Record<string, unknown>,
  workerId: string,
  reportType: string,
): Promise<{ prepared: number; sourceExpenses: number }> {
  const orgId = String(job.organization_id);
  const jobId = String(job.id);
  const params = parseParams((job.parameters ?? {}) as Record<string, unknown>);
  const statuses = reportType === "claim_verification"
    ? verificationStatuses(params.engineerStatus)
    : ["approved"];

  if (reportType === "claim_approval" && params.hoStatus && params.hoStatus !== "approved") {
    throw new Error("Invalid HO status for Claim Approval.");
  }

  const buffer: Record<string, unknown>[] = [];
  let cursor: unknown = null;
  let total: number | null = null;
  let seq = 0;
  let pages = 0;
  let sourceExpenses = 0;

  for (;;) {
    const { data, error } = await svc.rpc("report_expense_rows_v1", {
      p_organization_id: orgId,
      p_statuses: statuses,
      p_category: params.category,
      p_user_ids: params.userIds,
      // Keep Sync aligned with the server generated CSV for this exact job.
      p_date_from: params.dateFrom,
      p_date_to: params.dateTo,
      p_sort_column: "created_at",
      p_cursor: cursor,
      p_page_size: EXPENSE_PAGE,
      p_with_total: pages === 0,
    });
    if (error) throw new Error(`expense page ${pages + 1}: ${error.message}`);

    const p = data as Record<string, unknown>;
    if (pages === 0) total = p.total_count == null ? null : Number(p.total_count);

    const rows = (p.rows ?? []) as Record<string, unknown>[];
    const ids = rows.map((r) => String(r.id));
    const meta = await expenseMetaBatch(svc, orgId, ids);

    for (const row of rows) {
      sourceExpenses += 1;
      if (!passesTallyExpenseFilters(row, reportType, params, meta)) continue;
      seq += 1;
      const normalized = {
        organization_id: orgId,
        report_type: reportType,
        expense_id: row.id,
        payload: row,
      };
      const hash = await contentHash(normalized.payload as Record<string, unknown>);
      buffer.push({
        seq,
        source_type: "expense",
        source_key: `${orgId}:expense:${row.id}`,
        content_hash: hash,
        payload: normalized,
      });
      if (buffer.length >= ITEM_CHUNK) await flushItems(svc, jobId, workerId, buffer);
    }

    pages += 1;
    await svc.rpc("tally_sync_job_heartbeat_v1", {
      p_job_id: jobId,
      p_worker_id: workerId,
      p_progress_current: seq,
      p_progress_total: total,
      p_checkpoint: null,
    });

    if (!p.has_more || !p.next_cursor) break;
    cursor = p.next_cursor;
  }

  await flushItems(svc, jobId, workerId, buffer);

  if (total != null && sourceExpenses !== total) {
    throw new Error(`Incomplete expense fetch: expected ${total}, got ${sourceExpenses}`);
  }

  return { prepared: seq, sourceExpenses };
}

async function prepareDetailed(
  svc: Svc,
  job: Record<string, unknown>,
  workerId: string,
): Promise<{ prepared: number; timelineRows: number }> {
  const orgId = String(job.organization_id);
  const jobId = String(job.id);
  const rawParams = (job.parameters ?? {}) as Record<string, unknown>;
  const params = parseParams(rawParams);
  const { dateFrom, dateTo } = resolveDetailedExpenseRpcDates(rawParams);
  const buffer: Record<string, unknown>[] = [];
  let cursor: unknown = null;
  let total: number | null = null;
  let pages = 0;
  let timelineRows = 0;
  let seq = 0;

  for (;;) {
    const { data, error } = await svc.rpc("report_detailed_expense_rows_v4", {
      p_organization_id: orgId,
      p_user_ids: params.userIds,
      p_date_from: dateFrom,
      p_date_to: dateTo,
      p_cursor: cursor,
      p_page_size: DETAILED_PAGE,
      p_with_total: pages === 0,
    });
    if (error) throw new Error(`timeline page ${pages + 1}: ${error.message}`);

    const p = data as Record<string, unknown>;
    if (pages === 0) total = p.total_count == null ? null : Number(p.total_count);

    for (const row of (p.rows ?? []) as Record<string, unknown>[]) {
      timelineRows += 1;
      if (!matchesDetailedFilters(row, params.category, params.customFieldFilters)) continue;
      seq += 1;
      const payload = {
        organization_id: orgId,
        report_type: "detailed_expense",
        event_id: row.event_id,
        payload: row,
      };
      const hash = await contentHash(row as Record<string, unknown>);
      buffer.push({
        seq,
        source_type: "balance_timeline",
        source_key: `${orgId}:balance_event:${row.event_id}`,
        content_hash: hash,
        payload,
      });
      if (buffer.length >= ITEM_CHUNK) await flushItems(svc, jobId, workerId, buffer);
    }

    pages += 1;
    await svc.rpc("tally_sync_job_heartbeat_v1", {
      p_job_id: jobId,
      p_worker_id: workerId,
      p_progress_current: seq,
      p_progress_total: total,
      p_checkpoint: null,
    });

    if (!p.has_more || !p.next_cursor) break;
    cursor = p.next_cursor;
  }

  await flushItems(svc, jobId, workerId, buffer);

  if (total != null && timelineRows !== total) {
    throw new Error(`Incomplete timeline: expected ${total}, got ${timelineRows}`);
  }

  return { prepared: seq, timelineRows };
}

async function loadDailyConfig(
  svc: Svc,
  orgId: string,
  job: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const snap = job.config_snapshot;
  if (snap && typeof snap === "object" && Object.keys(snap as object).length) {
    return snap as Record<string, unknown>;
  }
  const { data, error } = await svc
    .from("organization_settings")
    .select("daily_expense_report_config")
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data?.daily_expense_report_config ?? {}) as Record<string, unknown>;
}

async function prepareDaily(
  svc: Svc,
  job: Record<string, unknown>,
  workerId: string,
): Promise<{ prepared: number; reportRows: number }> {
  const orgId = String(job.organization_id);
  const jobId = String(job.id);
  const params = parseParams((job.parameters ?? {}) as Record<string, unknown>);
  const config = await loadDailyConfig(svc, orgId, job);
  const buffer: Record<string, unknown>[] = [];
  let cursor: unknown = null;
  let snapshotAt: string | null = null;
  let total: number | null = null;
  let pages = 0;
  let reportRows = 0;
  let seq = 0;

  for (;;) {
    const { data, error } = await svc.rpc("report_daily_project_rows_v1", {
      p_organization_id: orgId,
      p_config: config,
      p_date_from: params.dateFrom,
      p_date_to: params.dateTo,
      p_user_id: params.userIds?.length === 1 ? params.userIds[0] : null,
      p_user_ids: params.userIds && params.userIds.length > 1 ? params.userIds : null,
      p_snapshot_at: snapshotAt,
      p_cursor: cursor,
      p_page_size: DAILY_PAGE,
      p_with_total: snapshotAt === null,
    });
    if (error) throw new Error(`daily page ${pages + 1}: ${error.message}`);

    const p = data as Record<string, unknown>;
    if (Number(p.schema_version) !== DAILY_SCHEMA) {
      throw new Error(`Unsupported daily schema ${String(p.schema_version)}`);
    }
    if (snapshotAt === null) {
      snapshotAt = (p.snapshot_at as string) ?? null;
      total = p.total_count == null ? null : Number(p.total_count);
    }

    for (const row of (p.rows ?? []) as Record<string, unknown>[]) {
      reportRows += 1;
      seq += 1;
      const trackDate = String(row.track_date ?? "");
      const userId = String(row.user_id ?? "");
      const projectId = String(row.project_id ?? "");
      const payload = {
        organization_id: orgId,
        report_type: "daily_project_report",
        track_date: trackDate,
        user_id: userId,
        project_id: projectId,
        row,
      };
      const hash = await contentHash(row as Record<string, unknown>);
      buffer.push({
        seq,
        source_type: "daily_report_row",
        source_key: `${orgId}:daily_row:${trackDate}|${userId}|${projectId}`,
        content_hash: hash,
        payload,
      });
      if (buffer.length >= ITEM_CHUNK) await flushItems(svc, jobId, workerId, buffer);
    }

    pages += 1;
    await svc.rpc("tally_sync_job_heartbeat_v1", {
      p_job_id: jobId,
      p_worker_id: workerId,
      p_progress_current: seq,
      p_progress_total: total,
      p_checkpoint: null,
    });

    if (!p.has_more || !p.next_cursor) break;
    cursor = p.next_cursor;
  }

  await flushItems(svc, jobId, workerId, buffer);

  if (total != null && reportRows !== total) {
    throw new Error(`Incomplete daily report: expected ${total}, got ${reportRows}`);
  }

  return { prepared: seq, reportRows };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflightResponse();
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  let svc: Svc;
  try {
    svc = serviceClient();
  } catch (e) {
    return jsonResponse({ error: (e as Error).message }, 500);
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (token !== serviceKey) {
    const { data, error } = await svc.auth.getUser(token);
    if (error || !data?.user) return jsonResponse({ error: "Unauthorized" }, 401);
  }

  let body: Record<string, unknown> = {};
  try {
    const parsed = await req.json();
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    /* global drain */
  }
  const requestedJobId = typeof body.job_id === "string" ? body.job_id : null;

  if (body.delivery_only === true && requestedJobId && token === serviceKey) {
    try {
      const result = await enqueueDeliveryBatches(svc, requestedJobId);
      return jsonResponse({ ok: true, ...result });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "delivery enqueue failed";
      return jsonResponse({ error: msg }, 500);
    }
  }

  const workerId = `tally-edge-${crypto.randomUUID().slice(0, 8)}`;
  const { data: claim, error: claimErr } = await svc.rpc("claim_tally_sync_job_v1", {
    p_worker_id: workerId,
    p_job_id: requestedJobId,
  });
  if (claimErr) return jsonResponse({ error: claimErr.message }, 500);
  if (!claim?.claimed) return jsonResponse({ claimed: false }, 200);

  const job = claim.job as Record<string, unknown>;
  const jobId = String(job.id);
  const reportType = String(job.report_type);

  try {
    let prepared = 0;
    let reportRowCount: number | null = null;
    let sourceRecordCount: number | null = null;

    if (reportType === "claim_verification" || reportType === "claim_approval") {
      const r = await prepareClaimReport(svc, job, workerId, reportType);
      prepared = r.prepared;
      sourceRecordCount = r.sourceExpenses;
      reportRowCount = r.prepared;
    } else if (reportType === "detailed_expense") {
      const r = await prepareDetailed(svc, job, workerId);
      prepared = r.prepared;
      sourceRecordCount = r.timelineRows;
      reportRowCount = r.prepared;
    } else if (reportType === "daily_project_report") {
      const r = await prepareDaily(svc, job, workerId);
      prepared = r.prepared;
      sourceRecordCount = r.reportRows;
      reportRowCount = r.reportRows;
    } else {
      throw new Error(`Unsupported report type: ${reportType}`);
    }

    const { error: doneErr } = await svc.rpc("complete_tally_sync_preparation_v1", {
      p_job_id: jobId,
      p_worker_id: workerId,
      p_prepared_item_count: prepared,
      p_report_row_count: reportRowCount,
      p_source_record_count: sourceRecordCount,
    });
    if (doneErr) throw new Error(doneErr.message);

    // Phase 5: map + store delivery batches in-process (avoids short timeout on separate delivery fn).
    let delivery: Awaited<ReturnType<typeof enqueueDeliveryBatches>> | null = null;
    try {
      delivery = await enqueueDeliveryBatches(svc, jobId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Tally delivery batch build failed";
      console.error("enqueueDeliveryBatches:", e);
      await svc.rpc("fail_tally_sync_job_v1", {
        p_job_id: jobId,
        p_worker_id: workerId,
        p_error_code: "delivery_enqueue_error",
        p_error_message_safe: msg.slice(0, 300),
        p_retryable: true,
      });
      return jsonResponse({
        claimed: true,
        job_id: jobId,
        status: "failed",
        error: msg.slice(0, 200),
        prepared_item_count: prepared,
      });
    }

    return jsonResponse({
      claimed: true,
      job_id: jobId,
      status: delivery?.job_status ?? (delivery?.more_chunks ? "prepared" : "prepared"),
      prepared_item_count: prepared,
      delivery_batches: delivery?.batch_total ?? delivery?.batches ?? 0,
      delivery_more_chunks: delivery?.more_chunks === true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Preparation failed";
    await svc.rpc("fail_tally_sync_job_v1", {
      p_job_id: jobId,
      p_worker_id: workerId,
      p_error_code: "preparation_error",
      p_error_message_safe: message.slice(0, 300),
      p_retryable: true,
    });
    return jsonResponse({ claimed: true, job_id: jobId, status: "failed", error: message }, 500);
  }
});
