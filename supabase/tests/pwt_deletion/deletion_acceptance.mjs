/**
 * Acceptance test for the deletion-sync migration (20261019100000_pwt_deletion_sync.sql).
 * Runs the pwt migrations in an in-process Postgres (PGlite) with minimal stubs for auth / orgs / expenses. Touches no real database.
 *   npm i --no-save @electric-sql/pglite && node supabase/tests/pwt_deletion/deletion_acceptance.mjs
 *   (PWT_MIGRATIONS=<dir> overrides the migrations folder.)
 * Prints PASS/FAIL per rule and exits non-zero on any failure.
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
await db.exec(readFileSync(M + "20261016120000_pwt_foundation.sql", "utf8"));
await db.exec(readFileSync(M + "20261019100000_pwt_deletion_sync.sql", "utf8"));
await db.exec(readFileSync(M + "20261019100000_pwt_deletion_sync.sql", "utf8")); // idempotent re-run

const ORG = "11111111-1111-1111-1111-111111111111", OTHER = "99999999-9999-9999-9999-999999999999";
const ADMIN = "22222222-2222-2222-2222-222222222222", EMPL = "33333333-3333-3333-3333-333333333333", OTHER_ADMIN = "44444444-4444-4444-4444-444444444444";
const CONN = "c0000000-0000-0000-0000-00000000c0c0";
const id = (n) => `e${String(n).padStart(7, "0")}-0000-0000-0000-000000000000`;
const JOB = "a0000000-0000-0000-0000-00000000000a";
await db.exec(`
  insert into public.organization_memberships values ('${ADMIN}','${ORG}','admin',true),('${EMPL}','${ORG}','employee',true),('${OTHER_ADMIN}','${OTHER}','admin',true);
  insert into public.pwt_connectors(id, organization_id, device_name, tally_company, token_hash) values ('${CONN}','${ORG}','PC','Demo Co','h1');
  insert into public.pwt_sync_jobs(id, organization_id, report_type, parameters_hash, tally_company, status, config_snapshot)
    values ('${JOB}','${ORG}','detailed_expense','x','Demo Co','completed',
      '{"categories":[{"serial":2,"expenseLedger":"Consumable Stores - URD"}],"employeeLedgerOverrides":{"9":"Override Name-9"}}');
`);
const ok = (n, c, extra = "") => { console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + extra)); if (!c) process.exitCode = 1; };
const as = (u) => db.exec(`select set_config('app.uid','${u ?? ""}',false)`);
const q = async (s, p) => (await db.query(s, p)).rows;
const one = async (s, p) => (await q(s, p))[0];
const bad = async (s, p) => { try { await db.query(s, p); return null; } catch (e) { return e.message; } };
const src = (n) => `${ORG}:expense:${id(n)}`;
const jobOf = (n) => one("select * from public.pwt_deletion_jobs where source_id=$1", [src(n)]);
const logOf = async (jobId) => (await q("select event from public.pwt_correction_log where job_id=$1 order by id", [jobId])).map((r) => r.event);
const claim = async (active = "Demo Co") => (await one("select public.pwt_deletion_claim_v1($1,$2) r", [CONN, active])).r;
const ack = async (jobId, outcome, action, result = null, error = null) =>
  (await one("select public.pwt_deletion_ack_v1($1,$2,$3,$4,$5::jsonb,$6) r", [CONN, jobId, outcome, action, result && JSON.stringify(result), error])).r;

// a synced expense = an expense row + a posted registry row + its voucher
async function synced(n, { amount = 100, voucher = "PESO/08/02", date = "2026-08-31", emp = "Amit Test-1001", state = "posted", total = null } = {}) {
  await db.query("insert into public.expenses(id, organization_id, transaction_number) values ($1,$2,$3) on conflict do nothing", [id(n), ORG, `TXN-${n}`]);
  await db.query(`insert into public.pwt_registry(organization_id, source_id, state, job_id, amount, voucher_number, voucher_date, content_hash, employee_ledger, expense_ledger, serial)
                  values ($1,$2,$3,$4,$5,$6,$7,'h',$8,'Consumable Stores - URD',2)`, [ORG, src(n), state, JOB, amount, voucher, date, emp]);
  if (total !== null) {
    const batch = (await one("insert into public.pwt_batches(job_id, seq, kind, xml) values ($1,$2,'vouchers','x') returning id", [JOB, 1000 + n])).id;
    await db.query(`insert into public.pwt_vouchers(organization_id, tally_company, voucher_date, voucher_number, serial, batch_id, total)
                    values ($1,'Demo Co',$2,$3,2,$4,$5) on conflict do nothing`, [ORG, date, voucher, batch, total]);
  }
}
const noScan = () => db.query("insert into public.pwt_deletion_state(organization_id, last_scan_at) values ($1, now()) on conflict (organization_id) do update set last_scan_at = now()", [ORG]);
const softDelete = (n) => db.query("update public.expenses set deleted_at = now() where id=$1", [id(n)]);

// ---- detection
await db.query("insert into public.expenses(id, organization_id) values ($1,$2)", [id(1), ORG]);
await softDelete(1);
ok("D1 deleting an expense that was never synced queues nothing", (await one("select count(*)::int n from public.pwt_deletion_jobs")).n === 0);

await synced(2, { amount: 100, total: 100 });
await softDelete(2);
let j2 = await jobOf(2);
ok("D2 soft-deleting a synced expense queues a correction automatically", j2 && j2.status === "queued" && j2.detected_via === "trigger");
ok("D2 job carries the exact voucher, amount and ledgers", j2.voucher_number === "PESO/08/02" && new Date(j2.voucher_date).toISOString().slice(0,10) === "2026-08-31" && Number(j2.amount) === 100 && j2.employee_ledger === "Amit Test-1001" && j2.expense_ledger === "Consumable Stores - URD" && j2.tally_company === "Demo Co" && j2.transaction_number === "TXN-2");
ok("D2 detection is audited", (await logOf(j2.id)).join() === "detected");

await synced(3, { voucher: "PESO/08/03" });
await db.query("delete from public.expenses where id=$1", [id(3)]);
ok("D3 physically deleting a synced expense also queues a correction", (await jobOf(3))?.status === "queued");

await db.query("update public.expenses set deleted_at = null where id=$1", [id(2)]);
await softDelete(2);
await db.query("delete from public.expenses where id=$1", [id(2)]);
ok("D4 repeated / combined deletions never queue a second correction", (await one("select count(*)::int n from public.pwt_deletion_jobs where source_id=$1", [src(2)])).n === 1);

await synced(5, { state: "reserved", voucher: "PESO/08/05" });
await softDelete(5);
ok("D5 an expense still being delivered (reserved) is not queued by the trigger", (await jobOf(5)) === undefined);
await db.query("update public.pwt_registry set state='posted' where source_id=$1", [src(5)]);
ok("D5b ...but the safety-net scan queues it once it is posted", (await one("select public.pwt_deletion_scan_v1($1) n", [ORG])).n === 1 && (await jobOf(5))?.detected_via === "scan");
ok("D5c scan is idempotent", (await one("select public.pwt_deletion_scan_v1($1) n", [ORG])).n === 0);

// a deletion must never be blocked by a detection failure
await db.exec("alter table public.pwt_deletion_jobs rename to pwt_deletion_jobs_x");
await synced(6, { voucher: "PESO/08/06" });
const err = await bad("update public.expenses set deleted_at = now() where id=$1", [id(6)]);
ok("D6 a failure inside detection never blocks the deletion itself", err === null && (await one("select deleted_at from public.expenses where id=$1", [id(6)])).deleted_at !== null, String(err));
await db.exec("alter table public.pwt_deletion_jobs_x rename to pwt_deletion_jobs");
ok("D6b the scan recovers the missed deletion", (await one("select public.pwt_deletion_scan_v1($1) n", [ORG])).n === 1 && (await jobOf(6)) !== undefined);

// ---- claim
await db.exec("delete from public.pwt_deletion_jobs where source_id <> '" + src(2) + "'");
await db.exec("delete from public.pwt_registry where source_id <> '" + src(2) + "'");
await db.exec("update public.pwt_deletion_jobs set status='queued', attempts=0, not_before=null");
await noScan();
let c = await claim("Some Other Co");
ok("C1 wrong active Tally company: blocked, job stays queued", c?.blocked === "wrong_company" && (await jobOf(2)).status === "queued");
c = await claim();
ok("C2 right company: job handed out with everything the connector needs",
  c && c.job_id === j2.id && c.voucher_number === "PESO/08/02" && Number(c.amount) === 100 && Number(c.known_total) === 100 && c.siblings === 0 && c.force_reversal === false &&
  c.voucher_type === "Journal" && c.expense_side === "debit" && c.narration_tag === "PWT" && c.employee_ledger === "Amit Test-1001", JSON.stringify(c));
ok("C3 a job is handed out only once while claimed", (await claim()) === null && (await jobOf(2)).status === "claimed" && (await jobOf(2)).attempts === 1);
ok("C4 claim is logged", (await logOf(j2.id)).includes("claimed"));

// ---- ack: delete
let a = await ack(j2.id, "completed", "delete_voucher", { tally_voucher_number: "5" });
ok("A1 completed: job done, registry stamped, voucher total zeroed", a.completed === true && (await jobOf(2)).status === "completed" && (await jobOf(2)).action === "delete_voucher" &&
  (await one("select removed_at from public.pwt_registry where source_id=$1", [src(2)])).removed_at !== null &&
  Number((await one("select total from public.pwt_vouchers where voucher_number='PESO/08/02'")).total) === 0);
ok("A2 a repeated / stale acknowledgement is harmless", (await ack(j2.id, "completed", "delete_voucher")).ignored === true && (await logOf(j2.id)).filter((e) => e === "completed").length === 1);
ok("A3 the audit trail is complete", (await logOf(j2.id)).join() === "detected,claimed,completed");
ok("A4 a corrected expense is never re-queued (trigger, scan)", (await one("select public.pwt_deletion_scan_v1($1) n", [ORG])).n === 0);

// ---- grouped voucher: two expenses in one voucher, alter then delete, serialised per voucher
await synced(10, { amount: 60, voucher: "PESO/09/05", date: "2026-09-30", total: 200, emp: "Amit Test-1001" });
await synced(11, { amount: 140, voucher: "PESO/09/05", date: "2026-09-30", emp: "Bina Test-1002" });
await softDelete(10); await softDelete(11);
await noScan();
const g1 = await claim();
ok("G1 first correction for a shared voucher sees the sibling", g1 && Number(g1.amount) === 60 && g1.siblings === 1 && Number(g1.known_total) === 200, JSON.stringify(g1));
ok("G2 two corrections to the same voucher never run at once", (await claim()) === null);
await ack(g1.job_id, "completed", "alter_voucher", { new_total: 140 });
ok("G3 alter reduces the recorded voucher total by exactly the amount", Number((await one("select total from public.pwt_vouchers where voucher_number='PESO/09/05'")).total) === 140);
const g2 = await claim();
ok("G4 the next correction now sees no sibling and the reduced total", g2 && Number(g2.amount) === 140 && g2.siblings === 0 && Number(g2.known_total) === 140, JSON.stringify(g2));
await ack(g2.job_id, "completed", "delete_voucher");
ok("G5 both expenses removed from the registry", (await one("select count(*)::int n from public.pwt_registry where voucher_number='PESO/09/05' and removed_at is null")).n === 0);

// ---- retries
await synced(20, { voucher: "PESO/10/01", date: "2026-10-31", total: 100 });
await softDelete(20);
await noScan();
let r = await claim();
await ack(r.job_id, "retry", null, { offline: true }, "TallyPrime is not reachable");
let jr = await jobOf(20);
ok("R1 Tally offline: job is queued again, attempt refunded, backed off", jr.status === "queued" && jr.attempts === 0 && jr.not_before !== null && jr.error === "TallyPrime is not reachable");
ok("R2 not offered again until the backoff passes", (await claim()) === null);
await db.query("update public.pwt_deletion_jobs set not_before = now() - interval '1 second' where id=$1", [jr.id]);
r = await claim();
ok("R3 offered again after the backoff (processed automatically after reconnection)", r && r.job_id === jr.id && r.attempt === 1);
for (let i = 0; i < 4; i++) {
  await ack(r.job_id, "retry", null, { offline: false }, "boom");
  await db.query("update public.pwt_deletion_jobs set not_before = null where id=$1", [jr.id]);
  r = await claim();
}
await ack(r.job_id, "retry", null, { offline: false }, "boom");
jr = await jobOf(20);
ok("R4 after 5 real failures the job is BLOCKED, not retried forever", jr.status === "blocked" && /boom/.test(jr.error));
ok("R5 a blocked job changes nothing else (registry still unremoved)", (await one("select removed_at from public.pwt_registry where source_id=$1", [src(20)])).removed_at === null);

// ---- blocked + admin retry
await as(EMPL);
ok("B1 an employee cannot retry or list", /not permitted/.test((await bad("select public.pwt_retry_deletion_v1($1,$2)", [ORG, jr.id])) ?? "") && /not permitted/.test((await bad("select public.pwt_list_deletions_v1($1)", [ORG])) ?? ""));
await as(OTHER_ADMIN);
ok("B2 an admin of another organisation cannot see or retry it", /not permitted/.test((await bad("select public.pwt_retry_deletion_v1($1,$2)", [ORG, jr.id])) ?? ""));
await as(ADMIN);
ok("B3 the organisation's admin can retry a blocked correction", (await one("select public.pwt_retry_deletion_v1($1,$2) r", [ORG, jr.id])).r === true && (await jobOf(20)).status === "queued");
const lst = (await one("select public.pwt_list_deletions_v1($1) r", [ORG])).r;
ok("B4 admin list shows status, voucher and amount", Array.isArray(lst) && lst.length >= 3 && lst.some((x) => x.voucher_number === "PESO/10/01" && x.status === "queued"));
const lg = (await one("select public.pwt_deletion_log_v1($1,$2) r", [ORG, jr.id])).r;
ok("B5 admin can read the audit history of a correction", lg.some((e) => e.event === "blocked") && lg.some((e) => e.event === "retry_requested"));
await as("");
await noScan();
r = await claim();
await ack(r.job_id, "blocked", null, null, "the Tally voucher total (90) is not what PesoWise recorded (100); it was changed outside PesoWise");
ok("B6 the connector can mark a correction blocked with the reason", (await jobOf(20)).status === "blocked" && /changed outside/.test((await jobOf(20)).error));

// ---- restore, reversal flag, permissions, planner
await synced(30, { voucher: "PESO/11/01", date: "2026-11-30", total: 50 });
await softDelete(30);
await db.query("update public.expenses set deleted_at = null where id=$1", [id(30)]);
await noScan();
ok("X1 expense restored before the connector got to it: correction cancelled", (await claim()) === null && (await jobOf(30)).status === "cancelled" && (await logOf((await jobOf(30)).id)).includes("cancelled"));

await synced(40, { amount: 70, voucher: "PESO/12/01", date: "2026-12-31", total: 200 });
await synced(41, { amount: 130, voucher: "PESO/12/01", date: "2026-12-31" });
await softDelete(40);
await noScan();
const x40 = await claim();
await ack(x40.job_id, "completed", "reversal_voucher", { reversal: "PWT REV PESO/12/01 TXN-40" });
await softDelete(41);
const x41 = await claim();
ok("X2 once a voucher was corrected by a reversal it is flagged so it is never deleted/altered", x41 && x41.force_reversal === true && Number(x41.known_total) === 200, JSON.stringify(x41));

await as(ADMIN);
await db.exec("set role authenticated");
const denied = await Promise.all([
  bad("select public.pwt_deletion_claim_v1($1,'x')", [CONN]), bad("select public.pwt_deletion_ack_v1($1,$2,'completed','delete_voucher',null,null)", [CONN, x41.job_id]),
  bad("select public.pwt_deletion_scan_v1($1)", [ORG]), bad("select public.pwt_enqueue_deletion_v1($1,$2,'x')", [ORG, id(99)]),
  bad("select * from public.pwt_deletion_jobs"), bad("select * from public.pwt_correction_log"),
]);
await db.exec("reset role");
ok("P1 browser roles are denied every connector/worker function and both tables", denied.every((m) => /permission denied/i.test(m ?? "")), JSON.stringify(denied));

// ---- the planner records the ledgers (new postings) and the backfill fills legacy ones
await db.exec(`insert into public.pwt_sync_jobs(id, organization_id, report_type, parameters_hash, tally_company, status, worker_id)
               values ('b0000000-0000-0000-0000-00000000000b','${ORG}','detailed_expense','y','Demo Co','preparing','w1')`);
await db.query("select public.pwt_complete_prep_v1($1,'w1','[]'::jsonb,$2::jsonb,'{}'::jsonb,'{}'::jsonb)", ["b0000000-0000-0000-0000-00000000000b",
  JSON.stringify([{ source_id: src(50), amount: 10, voucher_number: "PESO/01/09", voucher_date: "2026-01-31", content_hash: "z", employee_ledger: "Cara Test-1003", expense_ledger: "Site Expenses", serial: 3 }])]);
const reg50 = await one("select employee_ledger, expense_ledger, serial from public.pwt_registry where source_id=$1", [src(50)]);
ok("M1 new postings record employee ledger, expense ledger and serial", reg50.employee_ledger === "Cara Test-1003" && reg50.expense_ledger === "Site Expenses" && reg50.serial === 3);

// legacy rows (posted before this migration): no ledgers recorded, but the job's row snapshot and voucher still exist
const L = (n) => `${ORG}:expense:${id(n)}`;
await db.query(`insert into public.pwt_registry(organization_id, source_id, state, job_id, amount, voucher_number, voucher_date, content_hash) values
  ($1,$2,'posted',$3,5,'PESO/07/02','2026-07-31','h'), ($1,$4,'posted',$3,6,'PESO/07/02','2026-07-31','h')`, [ORG, L(60), JOB, L(61)]);
const batch = (await one("insert into public.pwt_batches(job_id, seq, kind, xml) values ($1,2000,'vouchers','x') returning id", [JOB])).id;
await db.query("insert into public.pwt_vouchers(organization_id, tally_company, voucher_date, voucher_number, serial, batch_id, total) values ($1,'Demo Co','2026-07-31','PESO/07/02',2,$2,11)", [ORG, batch]);
await db.query("insert into public.pwt_job_rows(job_id, seq, source_key, content_hash, payload) values ($1,1,'a','a',$2::jsonb), ($1,2,'b','b',$3::jsonb)", [JOB,
  JSON.stringify({ expense_id: id(60), employee_name: "  Dina   Test ", employee_code: "1004", category: "Material Purchase" }),
  JSON.stringify({ id: id(61), user_name: "Ravi", employee_id: "9" })]);
await db.exec(readFileSync(M + "20261019100000_pwt_deletion_sync.sql", "utf8")); // backfill runs on (re)apply
const l60 = await one("select employee_ledger, expense_ledger, serial from public.pwt_registry where source_id=$1", [L(60)]);
const l61 = await one("select employee_ledger from public.pwt_registry where source_id=$1", [L(61)]);
ok("M2 backfill resolves legacy rows (serial from voucher, expense ledger from the job's config, employee ledger from the row snapshot)",
  l60.employee_ledger === "Dina Test-1004" && l60.expense_ledger === "Consumable Stores - URD" && l60.serial === 2, JSON.stringify(l60));
ok("M3 backfill honours employee ledger overrides", l61.employee_ledger === "Override Name-9", JSON.stringify(l61));

console.log(process.exitCode ? "\nSOME CHECKS FAILED" : "\nALL DELETION-SYNC DATABASE CHECKS PASSED");
