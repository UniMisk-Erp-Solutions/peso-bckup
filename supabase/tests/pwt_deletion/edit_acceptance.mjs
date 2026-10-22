/**
 * Acceptance test for 20261022100000_pwt_edit_sync.sql: an expense edited after it was synced is corrected in Tally and re-posted.
 *   npm i --no-save @electric-sql/pglite && node supabase/tests/pwt_deletion/edit_acceptance.mjs   (PWT_MIGRATIONS=<dir> overrides the folder)
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
  create table public.expenses(id uuid primary key, organization_id uuid, approval_tier text, deleted_at timestamptz, transaction_number text, total_amount numeric, category text);
`);
for (const f of [
  "20261016120000_pwt_foundation.sql", "20261016130000_pwt_config_rpcs.sql", "20261019100000_pwt_deletion_sync.sql",
  "20261019140000_pwt_registry_per_company.sql", "20261019150000_pwt_resumable_prepare.sql", "20261021100000_pwt_report_rows_setting.sql",
  "20261021140000_pwt_prepare_txns.sql", "20261021160000_pwt_vouchers_reuse_released.sql", "20261022100000_pwt_edit_sync.sql",
]) await db.exec(readFileSync(M + f, "utf8"));
await db.exec(readFileSync(M + "20261022100000_pwt_edit_sync.sql", "utf8")); // idempotent

const ORG = "11111111-1111-1111-1111-111111111111", CO = "Bug";
const CONN = "c0000000-0000-0000-0000-00000000c0a1";
const eid = (n) => `e${String(n).padStart(7, "0")}-0000-0000-0000-000000000000`;
const src = (n) => `${ORG}:expense:${eid(n)}`;
const ok = (n, c, extra = "") => { console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + extra)); if (!c) process.exitCode = 1; };
const q = async (s, p) => (await db.query(s, p)).rows;
const one = async (s, p) => (await q(s, p))[0];

await db.exec(`
  insert into public.pwt_connectors(id, organization_id, device_name, tally_company, token_hash, paired_at) values ('${CONN}','${ORG}','PC','${CO}','h','2026-01-01');
  insert into public.pwt_sync_jobs(id, organization_id, report_type, parameters, parameters_hash, tally_company, status) values
    ('a0000000-0000-0000-0000-00000000000a','${ORG}','detailed_expense','{"date_from":"2026-01-01","date_to":"2026-12-31"}','p0','${CO}','completed');
  insert into public.pwt_batches(id, job_id, seq, kind, xml, item_count, status) values ('b0000000-0000-0000-0000-00000000000b','a0000000-0000-0000-0000-00000000000a',1,'vouchers','x',1,'verified');
  -- expense 1 and 2 are posted (voucher PESO/08/01 holds both, 100 + 50), expense 3 is posted alone
  insert into public.pwt_registry(organization_id, tally_company, source_id, state, job_id, amount, voucher_number, voucher_date, content_hash, employee_ledger, expense_ledger, serial, expense_type) values
    ('${ORG}','${CO}','${src(1)}','posted','a0000000-0000-0000-0000-00000000000a',100,'PESO/08/01','2026-08-31','h','Amit-1001','Travelling Expenses',1,'Travelling'),
    ('${ORG}','${CO}','${src(2)}','posted','a0000000-0000-0000-0000-00000000000a',50,'PESO/08/01','2026-08-31','h','Bina-1002','Travelling Expenses',1,'Travelling'),
    ('${ORG}','${CO}','${src(3)}','posted','a0000000-0000-0000-0000-00000000000a',70,'PESO/08/02','2026-08-31','h','Amit-1001','Site Expenses',3,NULL);
  insert into public.pwt_vouchers(organization_id, tally_company, voucher_date, voucher_number, serial, batch_id, total, status) values
    ('${ORG}','${CO}','2026-08-31','PESO/08/01',1,'b0000000-0000-0000-0000-00000000000b',150,'posted'),
    ('${ORG}','${CO}','2026-08-31','PESO/08/02',3,'b0000000-0000-0000-0000-00000000000b',70,'posted');
  insert into public.expenses(id, organization_id, total_amount, category) values ('${eid(1)}','${ORG}',100,'Travelling'), ('${eid(2)}','${ORG}',50,'Travelling'), ('${eid(3)}','${ORG}',70,'Other'), ('${eid(9)}','${ORG}',10,'Food');
`);

// ---- 1) trigger
await db.exec(`update public.expenses set total_amount = 120 where id = '${eid(1)}'`);
await db.exec(`update public.expenses set total_amount = 11 where id = '${eid(9)}'`); // never synced
let rows = await q("select source_id, state from public.pwt_edit_queue order by source_id");
ok("E1 editing a synced expense marks it dirty; an unsynced one is ignored", rows.length === 1 && rows[0].source_id === src(1) && rows[0].state === "dirty", JSON.stringify(rows));
await db.exec(`update public.expenses set deleted_at = now() where id = '${eid(3)}'`);
rows = await q("select source_id from public.pwt_edit_queue where source_id=$1", [src(3)]);
ok("E1b deleting an expense is the deletion path, not an edit", rows.length === 0 && (await q("select reason from public.pwt_deletion_jobs where source_id=$1", [src(3)]))[0]?.reason === "deleted");
await db.exec(`update public.expenses set deleted_at = null where id = '${eid(3)}'`);
await db.exec(`delete from public.pwt_edit_queue where source_id = '${src(3)}'; delete from public.pwt_deletion_jobs where source_id = '${src(3)}'`); // test housekeeping

// ---- 2) registry state gives the planner what was posted
const st = (await one("select public.pwt_registry_state_v1($1,$2,$3) r", [ORG, CO, [src(1), src(3), src(9)]])).r;
ok("E2 registry state returns amount, month, employee code and type of posted expenses",
  st.info[src(1)].amount == 100 && st.info[src(1)].month === "2026-08" && st.info[src(1)].code === "1001" && st.info[src(1)].type === "Travelling" && st.info[src(3)].type === null && !st.info[src(9)],
  JSON.stringify(st.info));

// ---- 3) the planner reports an edit -> an 'edited' correction of the OLD posting is queued
const JOB = "a1000000-0000-0000-0000-00000000000a";
await db.exec(`insert into public.pwt_sync_jobs(id, organization_id, report_type, parameters, parameters_hash, tally_company, status, worker_id)
               values ('${JOB}','${ORG}','detailed_expense','{"date_from":"2026-01-01","date_to":"2026-12-31"}','p1','${CO}','preparing','w')`);
const edit = JSON.stringify([{ source_id: src(1), changed: ["amount"], was: { amount: 100 }, now: { amount: 120 } }]);
const prepErr = await one("select public.pwt_complete_prep_v1($1,'w','[]'::jsonb,'[]'::jsonb,'{}'::jsonb,'{}'::jsonb,$2::jsonb) r", [JOB, edit]).then(() => null, (e) => e.message);
ok("E3 completing a plan with an edit does not fail", prepErr === null, String(prepErr));
const dj = await one("select reason, status, amount, voucher_number, employee_ledger, detected_via from public.pwt_deletion_jobs where source_id=$1", [src(1)]);
ok("E3b a correction of the OLD posting is queued (old amount, old voucher), reason edited",
  dj && dj.reason === "edited" && dj.status === "queued" && Number(dj.amount) === 100 && dj.voucher_number === "PESO/08/01" && dj.detected_via === "edit", JSON.stringify(dj));
ok("E3c the queue shows it as correcting and the registry row is untouched",
  (await one("select state from public.pwt_edit_queue where source_id=$1", [src(1)])).state === "correcting" &&
  (await one("select state, removed_at from public.pwt_registry where source_id=$1", [src(1)])).removed_at === null);

// ---- 4) the connector claims it even though the expense is active (a deletion would be cancelled as 'restored')
const claim = (await one("select public.pwt_deletion_claim_v1($1,$2) r", [CONN, CO])).r;
ok("E4 the connector gets the edit correction (not cancelled as restored); it says reason edited",
  claim && claim.job_id === dj && claim.job_id || (claim && claim.reason === "edited" && Number(claim.amount) === 100), JSON.stringify(claim));

// ---- 5) completed -> registry row dropped (re-post), unique key freed, expense queued for re-post, voucher total reduced
const ack = (await one("select public.pwt_deletion_ack_v1($1,$2,'completed','alter_voucher','{}'::jsonb,null) r", [CONN, claim.job_id])).r;
ok("E5 completing the correction succeeds", ack.completed === true, JSON.stringify(ack));
ok("E5b the old registry row is gone so the next sync posts the current version", (await q("select 1 from public.pwt_registry where source_id=$1", [src(1)])).length === 0);
ok("E5c the expense is queued for re-post", (await one("select state from public.pwt_edit_queue where source_id=$1", [src(1)])).state === "repost");
ok("E5d the voucher total drops by the old amount", Number((await one("select total from public.pwt_vouchers where voucher_number='PESO/08/01'")).total) === 50);
ok("E5e the history row stays, with its key freed for a later edit",
  (await q("select 1 from public.pwt_deletion_jobs where id=$1 and status='completed' and source_id like $2", [claim.job_id, src(1) + "#edit:%"])).length === 1);

// ---- 6) automatic job: created from the queue, only for those expenses; never while another sync runs; debounced
await db.exec("update public.pwt_edit_queue set updated_at = now()");
ok("E6 a fresh edit waits 20 seconds (one job for a burst of edits)", (await one("select public.pwt_edit_job_v1($1) r", [CONN])).r === null);
await db.exec("update public.pwt_edit_queue set updated_at = now() - interval '1 minute'");
await db.exec(`update public.pwt_edit_queue set state='dirty' where source_id='${src(1)}'`); // dirty and repost are both picked up
await db.exec(`insert into public.pwt_edit_queue(organization_id, tally_company, source_id, state, updated_at) values ('${ORG}','${CO}','${src(2)}','dirty', now() - interval '1 minute')`);
const auto = (await one("select public.pwt_edit_job_v1($1) r", [CONN])).r;
ok("E6b an automatic job is created", auto && auto.started === true && auto.expenses === 2, JSON.stringify(auto));
const aj = await one("select parameters, report_type, status from public.pwt_sync_jobs where id=$1", [auto.job_id]);
ok("E6c it is a Detailed Expense job over the last sync's dates, limited to the queued expenses, flagged auto",
  aj.report_type === "detailed_expense" && aj.parameters.auto === true && aj.parameters.date_from === "2026-01-01" && aj.parameters.only_source_ids.length === 2, JSON.stringify(aj.parameters));
const again = (await one("select public.pwt_edit_job_v1($1) r", [CONN])).r;
ok("E6d asking again returns the same job (to keep preparing it), never a second one", again && again.job_id === auto.job_id && again.started === false);
await db.exec(`update public.pwt_sync_jobs set status='delivering' where id='${auto.job_id}'`);
ok("E6e nothing new starts while a sync of this company is running", (await one("select public.pwt_edit_job_v1($1) r", [CONN])).r === null);

// ---- 7) that job completes: src(2) unchanged (leaves the queue), src(1) re-posted with its type (reservation) and leaves the queue
await db.exec(`update public.pwt_sync_jobs set status='preparing', worker_id='w' where id='${auto.job_id}'`);
const res = JSON.stringify([{ source_id: src(1), amount: 120, voucher_number: "PESO/08/01-S1", voucher_date: "2026-08-31", content_hash: "z", employee_ledger: "Amit-1001", expense_ledger: "Travelling Expenses", serial: 1, expense_type: "Travelling" }]);
const err7 = await one("select public.pwt_complete_prep_v1($1,'w','[]'::jsonb,$2::jsonb,'{}'::jsonb,'{}'::jsonb,'[]'::jsonb) r", [auto.job_id, res]).then(() => null, (e) => e.message);
ok("E7 the automatic job completes", err7 === null, String(err7));
ok("E7b the new version is reserved with its expense type", (await one("select expense_type, amount from public.pwt_registry where source_id=$1", [src(1)])).expense_type === "Travelling");
ok("E7c both expenses left the queue", (await q("select 1 from public.pwt_edit_queue")).length === 0);

// ---- 8) a second edit of the same expense can be corrected again
await db.exec(`update public.pwt_registry set state='posted' where source_id='${src(1)}'`);
const J2 = "a2000000-0000-0000-0000-00000000000a";
await db.exec(`insert into public.pwt_sync_jobs(id, organization_id, report_type, parameters, parameters_hash, tally_company, status, worker_id) values ('${J2}','${ORG}','detailed_expense','{}','p2','${CO}','preparing','w')`);
const e2 = JSON.stringify([{ source_id: src(1), changed: ["amount"], was: { amount: 120 }, now: { amount: 90 } }]);
const err8 = await one("select public.pwt_complete_prep_v1($1,'w','[]'::jsonb,'[]'::jsonb,'{}'::jsonb,'{}'::jsonb,$2::jsonb) r", [J2, e2]).then(() => null, (x) => x.message);
ok("E8 an expense can be edited, corrected and edited again", err8 === null &&
  (await q("select 1 from public.pwt_deletion_jobs where source_id=$1 and status='queued' and reason='edited'", [src(1)])).length === 1, String(err8));

// ---- 9) a real deletion still marks the registry row removed (and is not treated as an edit)
await db.exec(`update public.expenses set deleted_at = now() where id = '${eid(2)}'`);
const del = await one("select reason, status from public.pwt_deletion_jobs where source_id=$1", [src(2)]);
ok("E9 deleting an expense still queues a plain deletion correction", del && del.reason === "deleted" && del.status === "queued", JSON.stringify(del));

console.log(process.exitCode ? "\nSOME CHECKS FAILED" : "\nALL EDIT-SYNC DATABASE CHECKS PASSED");
