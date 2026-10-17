/**
 * PesoWise -> Tally (pwt) background worker. Service-role only.
 * queued -> preparing (read FULL report, immutable snapshot, map, aggregate, plan XML) -> delivering.
 * "completed" is only ever set by the connector acknowledgement after Tally readback (pwt_ack_batch_v1).
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsPreflightResponse, jsonResponse } from "../_shared/cors.ts";
import {
  buildJobPlan, DEFAULT_PWT_CONFIG, fetchReportRows, normalizeRow, rowContentHash,
  type PosterState, type PwtAccountingConfig, type PwtReportType,
} from "../_shared/pwt/index.ts";

type Row = Record<string, unknown>;
// deno-lint-ignore no-explicit-any
type Svc = ReturnType<typeof createClient<any>>;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflightResponse();
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return jsonResponse({ error: "Server misconfiguration" }, 500);
  if (req.headers.get("Authorization") !== `Bearer ${key}`) return jsonResponse({ error: "Unauthorized" }, 401);

  const { job_id } = await req.json().catch(() => ({}));
  if (!job_id) return jsonResponse({ error: "job_id required" }, 400);

  // deno-lint-ignore no-explicit-any
  const svc: Svc = createClient<any>(url, key, { auth: { persistSession: false } });
  const worker = `pwt-${crypto.randomUUID()}`;
  const { data: job, error: ce } = await svc.rpc("pwt_claim_job_v1", { p_job_id: job_id, p_worker: worker });
  if (ce) return jsonResponse({ error: ce.message }, 500);
  if (!job) return jsonResponse({ claimed: false });

  try {
    const org = String(job.organization_id);
    const report = job.report_type as PwtReportType;
    const rows = await snapshotRows(svc, job, worker);
    const cfg = await loadConfig(svc, org);

    // Registry conflict (another job reserved the same expense between read and reserve) => re-plan once.
    for (let attempt = 0;; attempt++) {
      const state = await registryState(svc, org, String(job.tally_company), report, rows);
      const plan = await buildJobPlan({
        organizationId: org,
        jobId: String(job.id),
        report,
        company: String(job.tally_company),
        rows,
        cfg,
        state,
        revision: Math.floor(Date.parse(String(job.created_at)) / 1000),
      });
      const { error } = await svc.rpc("pwt_complete_prep_v1", {
        p_job_id: job.id,
        p_worker: worker,
        p_batches: plan.batches,
        p_reservations: plan.reservations,
        p_vouchers: plan.vouchers,
        p_summary: { ...plan.summary, config: cfg },
      });
      if (!error) break;
      if (attempt >= 1 || !/duplicate key|23505/i.test(error.message)) throw new Error(error.message);
    }
    return jsonResponse({ claimed: true, ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("pwt-run-job failed", msg);
    await svc.rpc("pwt_fail_job_v1", { p_job_id: job.id, p_worker: worker, p_error: msg });
    return jsonResponse({ claimed: true, ok: false, error: msg.slice(0, 200) }, 500);
  }
});

async function snapshotRows(svc: Svc, job: Row, worker: string): Promise<Row[]> {
  const all: Row[] = [];
  let seq = 0;
  let buf: Row[] = [];
  const flush = async () => {
    if (!buf.length) return;
    const { error } = await svc.rpc("pwt_store_rows_v1", { p_job_id: job.id, p_worker: worker, p_rows: buf });
    if (error) throw new Error(error.message);
    buf = [];
  };
  let dailyConfig: Row | undefined;
  if (job.report_type === "daily_project") {
    const { data, error } = await svc.from("organization_settings").select("daily_expense_report_config")
      .eq("organization_id", job.organization_id).maybeSingle();
    if (error) throw new Error(error.message);
    dailyConfig = (data?.daily_expense_report_config ?? {}) as Row;
  }
  await fetchReportRows({
    rpc: (n, a) => svc.rpc(n, a) as never,
    organizationId: String(job.organization_id),
    report: job.report_type as PwtReportType,
    parameters: (job.parameters ?? {}) as Row,
    dailyConfig,
    onRows: async (rows) => {
      for (const r of rows) {
        seq += 1;
        all.push(r);
        buf.push({
          seq,
          source_key: String(r.id ?? r.event_id ?? seq),
          content_hash: await rowContentHash(r),
          payload: r,
        });
        if (buf.length >= 200) await flush();
      }
    },
    onProgress: async (cur, tot) => {
      await svc.rpc("pwt_heartbeat_v1", { p_job_id: job.id, p_worker: worker, p_current: cur, p_total: tot });
    },
  });
  await flush();
  return all;
}

async function loadConfig(svc: Svc, org: string): Promise<PwtAccountingConfig> {
  const { data, error } = await svc.from("pwt_mapping_config").select("config").eq("organization_id", org).maybeSingle();
  if (error) throw new Error(error.message);
  return { ...DEFAULT_PWT_CONFIG, ...((data?.config ?? {}) as Partial<PwtAccountingConfig>) };
}

async function registryState(svc: Svc, org: string, company: string, report: PwtReportType, rows: Row[]): Promise<PosterState> {
  const ids: string[] = [];
  if (report === "detailed_expense" || report === "claim_approval") {
    for (const r of rows) {
      const n = await normalizeRow(org, report, r);
      if (n.txn) ids.push(n.txn.sourceId);
    }
  }
  const posted: Record<string, number> = {};
  let counts: Record<string, number> = {};
  const parts: string[][] = [];
  for (let i = 0; i < ids.length; i += 2000) parts.push(ids.slice(i, i + 2000));
  if (!parts.length) parts.push([]);
  for (const part of parts) {
    const { data, error } = await svc.rpc("pwt_registry_state_v1", { p_org: org, p_tally_company: company, p_source_ids: part });
    if (error) throw new Error(error.message);
    Object.assign(posted, (data as Row).posted as Record<string, number>);
    counts = (data as Row).voucher_counts as Record<string, number>;
  }
  return { postedSourceIds: new Set(Object.keys(posted)), voucherCounts: counts, postedAmounts: posted };
}
