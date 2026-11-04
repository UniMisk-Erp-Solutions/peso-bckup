import { describe, expect, it } from "vitest";
import { fetchReportRowsSlice, FRESH_FETCH, runPrepSlice, type FetchResume, type SliceDeps } from "../index.ts";

type Row = Record<string, unknown>;
const ORG = "6709c1fe-e8c8-404d-bc68-d1edda923344";

/** Claim-approval report rows as the server returns them, in pages by cursor. */
const makeRow = (i: number): Row => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, transaction_number: `T-${i}`, total_amount: 100 + (i % 7), status: "approved",
  ho_status: "approved", employee_code: String(1000 + (i % 40)), employee_name: `Employee ${i % 40}`, category: "Food", trip_start: "2026-08-10",
  description: "x".repeat(200), custom_fields: { a: "b" },
});

function reportRpc(total: number, size = 250, log: string[] = []) {
  return async (name: string, args: Record<string, unknown>) => {
    log.push(name);
    if (name === "report_expense_rows_v1") {
      const from = Number((args.p_cursor as { n?: number } | null)?.n ?? 0);
      const n = Math.min(size, total - from);
      return {
        data: {
          rows: Array.from({ length: n }, (_, k) => makeRow(from + k + 1)), has_more: from + n < total,
          next_cursor: from + n < total ? { n: from + n } : null, total_count: args.p_with_total ? total : null,
        },
        error: null,
      };
    }
    if (name === "pwt_expense_meta_v1") return { data: {}, error: null };
    throw new Error("unexpected rpc " + name);
  };
}

describe("fetchReportRowsSlice (resumable page walk)", () => {
  it("stops after a page once past the deadline and resumes exactly where it stopped", async () => {
    const got: Row[] = [];
    let resume: FetchResume = FRESH_FETCH;
    let slices = 0;
    for (;;) {
      const r = await fetchReportRowsSlice({ rpc: reportRpc(1234), organizationId: ORG, report: "claim_approval", parameters: {}, onRows: async (x) => { got.push(...x); } }, resume, 0);
      resume = r.resume;
      slices += 1;
      if (r.done) break;
      expect(slices).toBeLessThan(50);
    }
    expect(slices).toBe(5);                                      // 1234 rows / 250 per page, one page per slice
    expect(got).toHaveLength(1234);
    expect(new Set(got.map((r) => r.id)).size).toBe(1234);      // no row twice, none missed
    expect(got[0].transaction_number).toBe("T-1");
    expect(got[1233].transaction_number).toBe("T-1234");
  });
  it("without a deadline it is one pass, and a short count is still caught at the end", async () => {
    const r = await fetchReportRowsSlice({ rpc: reportRpc(600), organizationId: ORG, report: "claim_approval", parameters: {}, onRows: async () => {} }, FRESH_FETCH, Infinity);
    expect(r.done).toBe(true);
    expect(r.resume.seen).toBe(600);
  });
});

/** In-memory stand-in for the database side of one job. */
function fakeBackend(total: number, pageSize = 250, opt: { parameters?: Row; posted?: Row; info?: Row } = {}) {
  const calls: string[] = [];
  const job: Row = {
    id: "job-1", organization_id: ORG, report_type: "claim_approval", parameters: opt.parameters ?? {}, tally_company: "Co", status: "queued",
    created_at: "2026-10-19T10:00:00Z", prep_phase: "read", prep_state: null, prep_seq: 0,
  };
  const rows = new Map<number, Row>();
  const txns = new Map<number, Row>();
  let leased = false;
  let completed: Row | null = null;
  const report = reportRpc(total, pageSize);
  let clock = 0;
  const deps: SliceDeps = {
    now: () => (clock += 5),                      // a little time passes with every call
    normChunkRows: 300, normSliceMs: 0,            // small chunks, one per slice: exercises many normalising slices
    newWorkerId: () => "w" + calls.length,
    dailyConfig: async () => ({}),
    mappingConfig: async () => null,
    rpc: async (name, args) => {
      calls.push(name);
      switch (name) {
        case "pwt_claim_slice_v1":
          if (leased || (job.status !== "queued" && job.status !== "preparing")) return { data: null, error: null };
          leased = true; job.status = "preparing";
          if (job.prep_state === null) { rows.clear(); txns.clear(); }
          return { data: { ...job }, error: null };
        case "pwt_store_rows_v1":
          for (const r of args.p_rows as Row[]) rows.set(Number(r.seq), r);
          return { data: (args.p_rows as Row[]).length, error: null };
        case "pwt_heartbeat_v1": return { data: null, error: null };
        case "pwt_store_txns_v1": txns.set(Number(args.p_seq), args.p_payload as Row); return { data: null, error: null };
        case "pwt_load_txns_v1": {
          const out: Row[] = [];
          for (let q = Number(args.p_from); q <= Number(args.p_to); q++) if (txns.has(q)) out.push(txns.get(q)!);
          return { data: out, error: null };
        }
        case "pwt_slice_save_v1":
          job.prep_phase = args.p_phase; job.prep_state = args.p_state; job.prep_seq = args.p_seq; leased = false;
          return { data: null, error: null };
        case "pwt_job_rows_compact_v1": {
          const out: Row[] = [];
          for (let s = Number(args.p_from); s <= Number(args.p_to); s++) {
            const p = rows.get(s)?.payload as Row | undefined;
            if (!p) continue;
            const o: Row = {};
            for (const k of args.p_keys as string[]) if (k in p) o[k] = p[k];
            out.push(o);
          }
          return { data: out, error: null };
        }
        case "pwt_registry_state_v1": return { data: { posted: opt.posted ?? {}, info: opt.info ?? {}, voucher_counts: {} }, error: null };
        case "pwt_complete_prep_v1": completed = args as Row; job.status = "delivering"; leased = false; return { data: { batches: 1 }, error: null };
        case "pwt_fail_job_v1": job.status = "failed"; job.error = args.p_error; return { data: null, error: null };
        default: return report(name, args);
      }
    },
  };
  return { deps, job, rows, txns, calls, done: () => completed };
}

describe("runPrepSlice (sliced job preparation)", () => {
  it("prepares a large report across several short slices, reading every row once, then plans", async () => {
    const b = fakeBackend(1234);
    const outcomes = [];
    for (let i = 0; i < 20; i++) {
      const o = await runPrepSlice(b.deps, "job-1", 0);
      outcomes.push(o);
      if (o.done) break;
    }
    expect(outcomes.at(-1)?.done).toBe(true);
    expect(outcomes.filter((o) => !o.done).length).toBeGreaterThanOrEqual(8);   // 5 reading slices + 5 normalising slices, none the whole job
    expect(outcomes.map((o) => o.phase)).toContain("norm");
    expect(b.txns.size).toBe(5);                                                  // 1234 rows normalised in chunks of 300
    expect(b.rows.size).toBe(1234);
    expect([...b.rows.keys()].sort((x, y) => x - y)[1233]).toBe(1234);          // contiguous seq 1..1234, no duplicates
    const done = b.done()!;
    expect((done.p_reservations as Row[]).length).toBe(1234);                    // every approved claim planned
    expect((done.p_summary as Row).row_count).toBe(1234);
    expect(b.job.status).toBe("delivering");
    expect(b.calls.filter((c) => c === "pwt_complete_prep_v1")).toHaveLength(1);
  });

  it("the planner only ever receives the compact fields, not the full rows", async () => {
    const b = fakeBackend(300);
    for (let i = 0; i < 20; i++) if ((await runPrepSlice(b.deps, "job-1", 0)).done) break;
    const compact = await b.deps.rpc("pwt_job_rows_compact_v1", { p_job_id: "job-1", p_from: 1, p_to: 1, p_keys: ["id", "total_amount", "description"] });
    expect(Object.keys((compact.data as Row[])[0])).toEqual(["id", "total_amount", "description"]);
    const done = b.done()!;
    expect(JSON.stringify(done.p_reservations)).not.toContain("xxxxxxxx");     // the long description never travels with the plan
  });

  it("a second caller while a slice is running gets nothing to do", async () => {
    const b = fakeBackend(300);
    const first = b.deps.rpc("pwt_claim_slice_v1", { p_job_id: "job-1", p_worker: "other" });
    await first;                                                                  // another worker holds the lease
    expect(await runPrepSlice(b.deps, "job-1", 0)).toEqual({ claimed: false, done: false });
  });

  it("an error is recorded as a failed job (never left preparing)", async () => {
    const b = fakeBackend(300);
    const orig = b.deps.rpc;
    b.deps.rpc = async (n, a) => (n === "pwt_store_rows_v1" ? { data: null, error: { message: "disk full" } } : orig(n, a));
    await expect(runPrepSlice(b.deps, "job-1", 0)).rejects.toThrow(/disk full/);
    expect(b.job.status).toBe("failed");
    expect(String(b.job.error)).toMatch(/disk full/);
  });
});

describe("automatic edit job (only the expenses it was given)", () => {
  const id = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
  const sid = (i: number) => `${ORG}:expense:${id(i)}`;
  it("looks at only the listed expenses, reports an edit for a changed posted one and passes it on", async () => {
    // expense 1 was posted as 100 (now 101 in the report: edited); expense 2 is listed but unchanged; expense 3 is NOT listed
    const posted = { [sid(1)]: 100, [sid(2)]: 102 };
    const info = {
      [sid(1)]: { amount: 100, month: "2026-08", code: "1001", type: "Food" },
      [sid(2)]: { amount: 102, month: "2026-08", code: "1002", type: "Food" },
    };
    const b = fakeBackend(3, 250, { parameters: { auto: true, only_source_ids: [sid(1), sid(2)] }, posted, info });
    for (let i = 0; i < 20; i++) if ((await runPrepSlice(b.deps, "job-1", 0)).done) break;
    const done = b.done()!;
    expect((done.p_edits as Row[]).map((e) => e.source_id)).toEqual([sid(1)]);
    expect(((done.p_edits as Row[])[0].changed as string[])).toEqual(["amount"]);
    expect((done.p_reservations as Row[])).toEqual([]);                          // expense 3 (not listed) was not posted by this automatic job
    expect((done.p_summary as Row).row_count).toBe(2);
  });
  it("a normal job (no list) still looks at everything", async () => {
    const b = fakeBackend(3, 250, {});
    for (let i = 0; i < 20; i++) if ((await runPrepSlice(b.deps, "job-1", 0)).done) break;
    expect((b.done()!.p_reservations as Row[]).length).toBe(3);
    expect(b.done()!.p_edits).toEqual([]);
  });
});
