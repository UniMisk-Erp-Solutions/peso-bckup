/**
 * One SLICE of job preparation: read part of the report (resuming where the last slice stopped), then, once everything is read, plan the
 * vouchers. Each slice stays within a short time budget because the edge runtime cancels any single request after ~12 seconds; the caller
 * (browser) simply asks again until `done`. Pure orchestration over injected RPC functions, so it is unit-tested without a database.
 */
import { buildJobPlanFromNormalized, mergeNormalized, normalizeRows, type NormalizedRows } from "./prepare.ts";
import { COMPACT_KEYS } from "./compact.ts";
import { fetchReportRowsSlice, FRESH_FETCH, type FetchResume, type Rpc } from "./fetchRows.ts";
import { DEFAULT_PWT_CONFIG, withNaRule } from "./config.ts";
import type { PostedInfo, PosterState, PwtAccountingConfig, PwtReportType } from "./types.ts";
import { rowContentHash } from "./prepare.ts";

type Row = Record<string, unknown>;

export interface SliceDeps {
  rpc: Rpc;
  /** daily_expense_report_config of the organisation (Daily Project only). */
  dailyConfig(org: string): Promise<Row>;
  /** The organisation's saved ledger mapping, if any. */
  mappingConfig(org: string): Promise<Partial<PwtAccountingConfig> | null>;
  now?: () => number;
  newWorkerId?: () => string;
  /** Test hooks: rows per normalising chunk and the allowance of one normalising slice. */
  normChunkRows?: number;
  normSliceMs?: number;
}

export interface SliceOutcome {
  claimed: boolean;
  done: boolean;
  phase?: "read" | "norm" | "plan";
  progress?: { current: number; total: number | null };
}

/** Wall-clock budget of one slice. The runtime's per-request cap is ~12 s; leave room for the final saves. */
export const SLICE_BUDGET_MS = 7000;
const STORE_BATCH = 200;
/** Rows normalised per chunk, and the wall-clock allowance of one normalising slice (the edge runtime allows about 2 s of CPU per request). */
export const NORM_CHUNK_ROWS = 1000;
export const NORM_SLICE_MS = 1000;

interface ReadState { resume: FetchResume; seq: number; norm?: { nextRow: number; chunk: number } }

export async function runPrepSlice(deps: SliceDeps, jobId: string, budgetMs = SLICE_BUDGET_MS): Promise<SliceOutcome> {
  const now = deps.now ?? Date.now;
  const t0 = now();
  const deadline = t0 + budgetMs;
  const worker = (deps.newWorkerId ?? (() => `pwt-${crypto.randomUUID()}`))();
  const rpc = deps.rpc;

  const claimed = await rpc("pwt_claim_slice_v1", { p_job_id: jobId, p_worker: worker });
  if (claimed.error) throw new Error(claimed.error.message);
  const job = claimed.data as Row | null;
  if (!job) return { claimed: false, done: false };

  try {
    const org = String(job.organization_id);
    const report = job.report_type as PwtReportType;
    let phase: "read" | "norm" | "plan" = (job.prep_phase as string) === "plan" ? "plan" : (job.prep_phase as string) === "norm" ? "norm" : "read";
    const state: ReadState = (job.prep_state as ReadState | null) ?? { resume: FRESH_FETCH, seq: Number(job.prep_seq ?? 0) };
    let seq = state.seq;
    const progress = () => ({ current: state.resume.seen, total: state.resume.total });

    if (phase === "read") {
      let buf: Row[] = [];
      const flush = async () => {
        if (!buf.length) return;
        const { error } = await rpc("pwt_store_rows_v1", { p_job_id: jobId, p_worker: worker, p_rows: buf });
        if (error) throw new Error(error.message);
        buf = [];
      };
      const dailyConfig = report === "daily_project" ? await deps.dailyConfig(org) : undefined;
      const res = await fetchReportRowsSlice({
        rpc, organizationId: org, report, parameters: (job.parameters ?? {}) as Row, dailyConfig,
        onRows: async (rows) => {
          for (const r of rows) {
            seq += 1;
            buf.push({ seq, source_key: String(r.id ?? r.event_id ?? seq), content_hash: await rowContentHash(r), payload: r });
            if (buf.length >= STORE_BATCH) await flush();
          }
        },
        onProgress: async (cur, tot) => {
          await rpc("pwt_heartbeat_v1", { p_job_id: jobId, p_worker: worker, p_current: cur, p_total: tot });
        },
      }, state.resume, deadline);
      await flush();
      state.resume = res.resume;
      state.seq = seq;
      phase = res.done ? "norm" : "read";
      if (res.done) state.norm = { nextRow: 1, chunk: 0 };
      const saved = await rpc("pwt_slice_save_v1", {
        p_job_id: jobId, p_worker: worker, p_phase: phase, p_state: state, p_seq: seq,
        p_current: state.resume.seen, p_total: state.resume.total,
      });
      if (saved.error) throw new Error(saved.error.message);
      // The next slice continues (reading or normalising) with a fresh time budget.
      return { claimed: true, done: false, phase: res.done ? "norm" : "read", progress: progress() };
    }

    if (phase === "norm") {
      const nstate = state.norm ?? { nextRow: 1, chunk: 0 };
      const cfg = withNaRule({ ...DEFAULT_PWT_CONFIG, ...((await deps.mappingConfig(org)) ?? {}) } as PwtAccountingConfig);
      const normStart = now();
      const chunkRows = deps.normChunkRows ?? NORM_CHUNK_ROWS;
      const sliceMs = deps.normSliceMs ?? NORM_SLICE_MS;
      // At least one chunk per slice (so it always makes progress), then more while the time allowance lasts.
      do {
        const to = Math.min(nstate.nextRow + chunkRows - 1, seq);
        const rows = await loadCompactRows(rpc, jobId, nstate.nextRow, to);
        const n = await normalizeRows(org, report, rows, cfg);
        const stored = await rpc("pwt_store_txns_v1", { p_job_id: jobId, p_worker: worker, p_seq: nstate.chunk, p_payload: packNormalized(n) });
        if (stored.error) throw new Error(stored.error.message);
        nstate.nextRow = to + 1;
        nstate.chunk += 1;
      } while (nstate.nextRow <= seq && now() - normStart < sliceMs);
      state.norm = nstate;
      const done = nstate.nextRow > seq;
      const saved = await rpc("pwt_slice_save_v1", {
        p_job_id: jobId, p_worker: worker, p_phase: done ? "plan" : "norm", p_state: state, p_seq: seq,
        p_current: Math.min(nstate.nextRow - 1, seq), p_total: seq,
      });
      if (saved.error) throw new Error(saved.error.message);
      return { claimed: true, done: false, phase: done ? "plan" : "norm", progress: { current: Math.min(nstate.nextRow - 1, seq), total: seq } };
    }

    if (seq > 0 && (state.norm?.chunk ?? 0) === 0) throw new Error("nothing was staged for planning (normalising did not run)");
    await planAndComplete(deps, job, worker, state.norm?.chunk ?? 0);
    return { claimed: true, done: true, phase: "plan", progress: progress() };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await rpc("pwt_fail_job_v1", { p_job_id: jobId, p_worker: worker, p_error: msg });
    throw e;
  }
}

async function loadCompactRows(rpc: Rpc, jobId: string, from: number, to: number): Promise<Row[]> {
  const { data, error } = await rpc("pwt_job_rows_compact_v1", { p_job_id: jobId, p_from: from, p_to: to, p_keys: COMPACT_KEYS });
  if (error) throw new Error(error.message);
  return (data ?? []) as Row[];
}

/** Stored form of one normalised chunk. For most reports the view is exactly the posting list, so it is stored once. */
interface PackedNormalized { post: unknown[]; view: unknown[] | null; issues: unknown[]; unmapped: [string, number][]; rows: number }
function packNormalized(n: NormalizedRows): PackedNormalized {
  const same = n.view.length === n.post.length && n.view.every((t, i) => t === n.post[i]);
  return { post: n.post, view: same ? null : n.view, issues: n.issues, unmapped: n.unmappedDaily, rows: n.rowCount };
}
function unpackNormalized(p: PackedNormalized): NormalizedRows {
  return { post: p.post as NormalizedRows["post"], view: (p.view ?? p.post) as NormalizedRows["view"], issues: p.issues as NormalizedRows["issues"], unmappedDaily: p.unmapped, rowCount: p.rows };
}

async function planAndComplete(deps: SliceDeps, job: Row, worker: string, chunks: number): Promise<void> {
  const rpc = deps.rpc;
  const org = String(job.organization_id);
  const report = job.report_type as PwtReportType;
  const company = String(job.tally_company);
  const parts: NormalizedRows[] = [];
  for (let from = 0; from < chunks; from += 20) {
    const { data, error } = await rpc("pwt_load_txns_v1", { p_job_id: job.id, p_from: from, p_to: Math.min(from + 19, chunks - 1) });
    if (error) throw new Error(error.message);
    for (const p of (data ?? []) as PackedNormalized[]) parts.push(unpackNormalized(p));
  }
  let norm = mergeNormalized(parts);
  // An automatic edit job looks at ONLY the expenses that changed (never posts unrelated new expenses on its own).
  const only = (job.parameters as Row | null | undefined)?.only_source_ids;
  if (Array.isArray(only) && only.length) norm = onlyThese(norm, new Set(only.map(String)));
  const cfg: PwtAccountingConfig = withNaRule({ ...DEFAULT_PWT_CONFIG, ...((await deps.mappingConfig(org)) ?? {}) });

  // Registry conflict (another job reserved the same expense for this company between read and reserve) => re-plan once.
  for (let attempt = 0;; attempt++) {
    const state = await registryState(rpc, org, company, report, norm);
    const plan = await buildJobPlanFromNormalized({
      organizationId: org, jobId: String(job.id), report, company, cfg, state,
      revision: Math.floor(Date.parse(String(job.created_at)) / 1000),
    }, norm);
    const { error } = await rpc("pwt_complete_prep_v1", {
      p_job_id: job.id, p_worker: worker, p_batches: plan.batches, p_reservations: plan.reservations,
      p_vouchers: plan.vouchers, p_summary: { ...plan.summary, config: cfg }, p_edits: plan.edits,
    });
    if (!error) return;
    if (attempt >= 1 || !/duplicate key|23505/i.test(error.message)) throw new Error(error.message);
  }
}

/** Keep only the postings whose source id is in the set (the view rows are display-only and kept as they are). */
function onlyThese(n: NormalizedRows, ids: ReadonlySet<string>): NormalizedRows {
  const post = n.post.filter((t) => ids.has(t.sourceId));
  return { ...n, post, view: n.view === n.post ? post : n.view.filter((t) => ids.has(t.sourceId)), rowCount: post.length };
}

async function registryState(rpc: Rpc, org: string, company: string, report: PwtReportType, norm: NormalizedRows): Promise<PosterState> {
  const ids: string[] = report === "detailed_expense" || report === "claim_approval" ? norm.post.map((t) => t.sourceId) : [];
  const posted: Record<string, number> = {};
  const info: Record<string, PostedInfo> = {};
  let counts: Record<string, number> = {};
  const parts: string[][] = [];
  for (let i = 0; i < ids.length; i += 2000) parts.push(ids.slice(i, i + 2000));
  if (!parts.length) parts.push([]);
  for (const part of parts) {
    const { data, error } = await rpc("pwt_registry_state_v1", { p_org: org, p_tally_company: company, p_source_ids: part });
    if (error) throw new Error(error.message);
    Object.assign(posted, (data as Row).posted as Record<string, number>);
    Object.assign(info, ((data as Row).info ?? {}) as Record<string, PostedInfo>);
    counts = (data as Row).voucher_counts as Record<string, number>;
  }
  return { postedSourceIds: new Set(Object.keys(posted)), voucherCounts: counts, postedAmounts: posted, postedInfo: info };
}
