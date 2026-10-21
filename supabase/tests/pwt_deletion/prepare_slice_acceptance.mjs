/**
 * Acceptance test for 20261019150000_pwt_resumable_prepare.sql: preparation runs in resumable slices.
 *   npm i --no-save @electric-sql/pglite && node supabase/tests/pwt_deletion/prepare_slice_acceptance.mjs   (PWT_MIGRATIONS=<dir> overrides the folder)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
const M = process.env.PWT_MIGRATIONS ?? fileURLToPath(new URL("../../migrations/", import.meta.url));

const db = new PGlite();
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create schema auth;
  create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('app.uid', true), '')::uuid $$;
  create type app_role as enum ('admin','employee','cashier','accountant','manager');
  create table public.organization_memberships(user_id uuid, organization_id uuid, role app_role, is_active boolean default true);
  create table public.expenses(id uuid primary key, organization_id uuid, approval_tier text, deleted_at timestamptz, transaction_number text);
`);
for (const f of ["20261016120000_pwt_foundation.sql", "20261019100000_pwt_deletion_sync.sql", "20261019140000_pwt_registry_per_company.sql", "20261019150000_pwt_resumable_prepare.sql", "20261021140000_pwt_prepare_txns.sql"]) {
  await db.exec(readFileSync(M + f, "utf8"));
}
await db.exec(readFileSync(M + "20261019150000_pwt_resumable_prepare.sql", "utf8")); // idempotent
await db.exec(readFileSync(M + "20261021140000_pwt_prepare_txns.sql", "utf8")); // idempotent

const ORG = "11111111-1111-1111-1111-111111111111";
const J = "a0000000-0000-0000-0000-00000000000a";
const ok = (n, c, extra = "") => { console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + extra)); if (!c) process.exitCode = 1; };
const q = async (s, p) => (await db.query(s, p)).rows;
const one = async (s, p) => (await q(s, p))[0];
const bad = async (s, p) => { try { await db.query(s, p); return null; } catch (e) { return e.message; } };
const claim = async (w) => (await one("select public.pwt_claim_slice_v1($1,$2) r", [J, w])).r;
const rows = (from, to) => JSON.stringify(Array.from({ length: to - from + 1 }, (_, k) => ({ seq: from + k, source_key: "k" + (from + k), content_hash: "h", payload: { id: "e" + (from + k), total_amount: 10, description: "long text", status: "approved" } })));

await db.exec(`insert into public.pwt_sync_jobs(id, organization_id, report_type, parameters_hash, tally_company, status) values ('${J}','${ORG}','claim_approval','x','Co','queued')`);

let c = await claim("w1");
ok("S1 the first claim starts the job (preparing, phase read, nothing saved yet)", c && c.status === "preparing" && c.prep_phase === "read" && c.prep_state === null && c.prep_seq === 0, JSON.stringify(c));
ok("S2 only ONE slice runs at a time (a second claim gets nothing)", (await claim("w2")) === null);

await db.query("select public.pwt_store_rows_v1($1,'w1',$2::jsonb)", [J, rows(1, 5)]);
await db.query("select public.pwt_slice_save_v1($1,'w1','read',$2::jsonb,5,5,12)", [J, JSON.stringify({ resume: { cursor: { n: 5 }, seen: 5, total: 12 }, seq: 5 })]);
let j = await one("select prep_phase, prep_seq, progress_current, progress_total, slice_lease_until from public.pwt_sync_jobs where id=$1", [J]);
ok("S3 saving records the position and releases the lease", j.prep_phase === "read" && j.prep_seq === 5 && j.progress_current === 5 && j.progress_total === 12 && j.slice_lease_until === null, JSON.stringify(j));

c = await claim("w2");
ok("S4 the next slice resumes with the saved state, and the rows already read are kept",
  c && c.prep_state.resume.cursor.n === 5 && c.prep_seq === 5 && (await one("select count(*)::int n from public.pwt_job_rows where job_id=$1", [J])).n === 5, JSON.stringify(c));
ok("S5 only the slice's owner can save", /not owned/.test((await bad("select public.pwt_slice_save_v1($1,'w1','read',$2::jsonb,5,5,12)", [J, "{}"])) ?? ""));
ok("S6 a bad phase is refused", /bad phase/.test((await bad("select public.pwt_slice_save_v1($1,'w2','nonsense','{}'::jsonb,5,5,12)", [J])) ?? ""));

// a slice that died: its lease expires and the next claim simply continues
await db.query("update public.pwt_sync_jobs set slice_lease_until = now() - interval '1 second' where id=$1", [J]);
c = await claim("w3");
ok("S7 a dead slice (expired lease) is taken over and continues from the last saved state", c && c.prep_seq === 5 && c.prep_state !== null, JSON.stringify(c));
await db.query("select public.pwt_store_rows_v1($1,'w3',$2::jsonb)", [J, rows(5, 12)]);          // seq 5 again: the retry re-reads page 2 -> ignored, not duplicated
ok("S8 re-storing rows after a lost slice never duplicates (same seq is ignored)", (await one("select count(*)::int n from public.pwt_job_rows where job_id=$1", [J])).n === 12);

const compact = (await one("select public.pwt_job_rows_compact_v1($1,3,6,$2::text[]) r", [J, ["id", "total_amount", "nokey"]])).r;
ok("S9 the compact read returns only the requested fields, in seq order", compact.length === 4 && compact.every((r) => Object.keys(r).sort().join() === "id,total_amount") && compact[0].id === "e3" && compact[3].id === "e6", JSON.stringify(compact));

// fresh start: a job that never saved state discards stale rows of an abandoned attempt
const J2 = "b0000000-0000-0000-0000-00000000000b";
await db.exec(`insert into public.pwt_sync_jobs(id, organization_id, report_type, parameters_hash, tally_company, status, worker_id) values ('${J2}','${ORG}','claim_approval','y','Co','preparing','old')`);
await db.exec(`insert into public.pwt_job_rows(job_id, seq, source_key, content_hash, payload) values ('${J2}',1,'k','h','{}'),('${J2}',2,'k','h','{}')`);
const c2 = (await one("select public.pwt_claim_slice_v1($1,'w9') r", [J2])).r;
ok("F1 a job stuck from the OLD one-shot worker (no saved state) is restarted cleanly", c2 && c2.prep_seq === 0 && (await one("select count(*)::int n from public.pwt_job_rows where job_id=$1", [J2])).n === 0, JSON.stringify(c2));

// finishing: complete_prep works for the slice owner and leaves the job delivering/completed (not preparing)
await db.query("update public.pwt_sync_jobs set status='preparing', worker_id='w3', slice_lease_until=now()+interval '30 seconds' where id=$1", [J]);
await db.query("select public.pwt_complete_prep_v1($1,'w3','[]'::jsonb,'[]'::jsonb,'{}'::jsonb,'{}'::jsonb)", [J]);
j = await one("select status from public.pwt_sync_jobs where id=$1", [J]);
ok("F2 planning completes the job (it leaves 'preparing')", j.status === "completed", JSON.stringify(j));
ok("F3 a finished job cannot be claimed again", (await claim("w4")) === null);

// staged normalised transactions
await db.query("update public.pwt_sync_jobs set status='preparing', worker_id='w3' where id=$1", [J]);
await db.query("select public.pwt_store_txns_v1($1,'w3',0,$2::jsonb)", [J, JSON.stringify({ post: [{ sourceId: "a" }], view: null, issues: [], unmapped: [], rows: 1 })]);
await db.query("select public.pwt_store_txns_v1($1,'w3',1,$2::jsonb)", [J, JSON.stringify({ post: [{ sourceId: "b" }], view: null, issues: [], unmapped: [], rows: 1 })]);
await db.query("select public.pwt_store_txns_v1($1,'w3',1,$2::jsonb)", [J, JSON.stringify({ post: [{ sourceId: "b2" }], view: null, issues: [], unmapped: [], rows: 1 })]);
const loaded = (await one("select public.pwt_load_txns_v1($1,0,19) r", [J])).r;
ok("T1 normalised chunks are staged and re-storing a chunk replaces it (a retried slice never duplicates)", loaded.length === 2 && loaded[1].post[0].sourceId === "b2" && loaded[0].post[0].sourceId === "a", JSON.stringify(loaded));
ok("T2 only the slice's owner can stage chunks", /not owned/.test((await bad("select public.pwt_store_txns_v1($1,'intruder',2,'{}'::jsonb)", [J])) ?? ""));
await db.query("select public.pwt_slice_save_v1($1,'w3','norm','{}'::jsonb,12,6,12)", [J]);
ok("T3 the normalising phase can be saved", (await one("select prep_phase from public.pwt_sync_jobs where id=$1", [J])).prep_phase === "norm");
const J3 = "c0000000-0000-0000-0000-00000000000c";
await db.exec(`insert into public.pwt_sync_jobs(id, organization_id, report_type, parameters_hash, tally_company, status) values ('${J3}','${ORG}','claim_approval','z','Co','preparing')`);
await db.exec(`insert into public.pwt_job_txns(job_id, seq, payload) values ('${J3}',0,'{}')`);
await db.query("select public.pwt_claim_slice_v1($1,'w7')", [J3]);
ok("T4 a fresh start also clears staged transactions of an abandoned attempt", (await one("select count(*)::int n from public.pwt_job_txns where job_id=$1", [J3])).n === 0);

ok("P1 browser roles cannot call the slice functions", await (async () => {
  await db.exec("set role authenticated");
  const e = await Promise.all([bad("select public.pwt_claim_slice_v1($1,'x')", [J]), bad("select public.pwt_slice_save_v1($1,'x','read','{}'::jsonb,0,0,0)", [J]), bad("select public.pwt_job_rows_compact_v1($1,1,2,'{}'::text[])", [J]), bad("select public.pwt_store_txns_v1($1,'x',0,'{}'::jsonb)", [J]), bad("select public.pwt_load_txns_v1($1,0,1)", [J])]);
  await db.exec("reset role");
  return e.every((m) => /permission denied/i.test(m ?? ""));
})());

console.log(process.exitCode ? "\nSOME CHECKS FAILED" : "\nALL SLICED-PREPARATION DATABASE CHECKS PASSED");
