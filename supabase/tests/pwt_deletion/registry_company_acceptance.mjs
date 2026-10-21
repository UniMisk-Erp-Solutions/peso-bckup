/**
 * Acceptance test for 20261019140000_pwt_registry_per_company.sql: the "already posted" record is per Tally company.
 *   npm i --no-save @electric-sql/pglite && node supabase/tests/pwt_deletion/registry_company_acceptance.mjs   (PWT_MIGRATIONS=<dir> overrides the folder)
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

const ORG = "11111111-1111-1111-1111-111111111111";
const J_A = "a0000000-0000-0000-0000-00000000000a", J_B = "b0000000-0000-0000-0000-00000000000b";
const id = (n) => `e${String(n).padStart(7, "0")}-0000-0000-0000-000000000000`;
const src = (n) => `${ORG}:expense:${id(n)}`;
const CONN_A = "c0000000-0000-0000-0000-00000000c0a1", CONN_B = "c0000000-0000-0000-0000-00000000c0b2";
await db.exec(`
  insert into public.pwt_connectors(id, organization_id, device_name, tally_company, token_hash, paired_at) values
    ('${CONN_A}','${ORG}','PC','Company A','hA','2026-01-01'), ('${CONN_B}','${ORG}','PC','Company B','hB','2026-02-01');
  insert into public.pwt_sync_jobs(id, organization_id, report_type, parameters_hash, tally_company, status) values
    ('${J_A}','${ORG}','detailed_expense','x','Company A','completed'), ('${J_B}','${ORG}','detailed_expense','y','Company B','completed');
  -- LEGACY registry rows (before the company column existed): one posted by a Company A job, one by a Company B job
  insert into public.pwt_registry(organization_id, source_id, state, job_id, amount, voucher_number, voucher_date, content_hash)
    values ('${ORG}','${src(1)}','posted','${J_A}',100,'PESO/08/01','2026-08-31','h'), ('${ORG}','${src(2)}','posted','${J_B}',50,'PESO/08/01','2026-08-31','h');
`);
const ok = (n, c, extra = "") => { console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + extra)); if (!c) process.exitCode = 1; };
const q = async (s, p) => (await db.query(s, p)).rows;
const one = async (s, p) => (await q(s, p))[0];
const bad = async (s, p) => { try { await db.query(s, p); return null; } catch (e) { return e.message; } };

await db.exec(readFileSync(M + "20261019140000_pwt_registry_per_company.sql", "utf8"));
await db.exec(readFileSync(M + "20261019140000_pwt_registry_per_company.sql", "utf8")); // idempotent

ok("M1 existing postings are tagged with the company their job posted to",
  (await one("select tally_company from public.pwt_registry where source_id=$1", [src(1)])).tally_company === "Company A" &&
  (await one("select tally_company from public.pwt_registry where source_id=$1", [src(2)])).tally_company === "Company B");

const state = async (company, ids) => (await one("select public.pwt_registry_state_v1($1,$2,$3) r", [ORG, company, ids])).r;
const sA = await state("Company A", [src(1), src(2)]);
const sB = await state("Company B", [src(1), src(2)]);
const sC = await state("Brand New Co", [src(1), src(2)]);
ok("S1 'already posted' is what THAT company has, not the whole organisation",
  Object.keys(sA.posted).join() === src(1) && Object.keys(sB.posted).join() === src(2) && Object.keys(sC.posted).length === 0, JSON.stringify([sA.posted, sB.posted, sC.posted]));

// a new company is filled from scratch, even for expenses posted to other companies
await db.exec(`insert into public.pwt_connectors(id, organization_id, device_name, tally_company, token_hash, paired_at) values ('c0000000-0000-0000-0000-00000000c0c3','${ORG}','PC','Brand New Co','hC','2026-03-01')`);
await db.exec(`insert into public.pwt_sync_jobs(id, organization_id, report_type, parameters_hash, tally_company, status, worker_id) values ('c0000000-0000-0000-0000-0000000000c3','${ORG}','detailed_expense','z','Brand New Co','preparing','w3')`);
const res = JSON.stringify([
  { source_id: src(1), amount: 100, voucher_number: "PESO/08/01", voucher_date: "2026-08-31", content_hash: "z", employee_ledger: "Amit-1", expense_ledger: "Site", serial: 3 },
  { source_id: src(2), amount: 50, voucher_number: "PESO/08/01", voucher_date: "2026-08-31", content_hash: "z", employee_ledger: "Bina-2", expense_ledger: "Site", serial: 3 }]);
const err = await bad("select public.pwt_complete_prep_v1($1,'w3','[]'::jsonb,$2::jsonb,'{}'::jsonb,'{}'::jsonb)", ["c0000000-0000-0000-0000-0000000000c3", res]);
ok("P1 the same expenses can be reserved for a new company while posted to others", err === null, String(err));
ok("P2 the reservations belong to the new company; the old companies' rows are unchanged",
  (await one("select count(*)::int n from public.pwt_registry where tally_company='Brand New Co'")).n === 2 &&
  (await one("select count(*)::int n from public.pwt_registry where tally_company='Company A'")).n === 1);
const dup = await bad("select public.pwt_complete_prep_v1($1,'w3','[]'::jsonb,$2::jsonb,'{}'::jsonb,'{}'::jsonb)", ["c0000000-0000-0000-0000-0000000000c3", res]);
ok("P3 inside ONE company a duplicate posting is still impossible", dup !== null);
await db.exec(`update public.pwt_sync_jobs set status='completed' where id='c0000000-0000-0000-0000-0000000000c3'; update public.pwt_registry set state='posted' where tally_company='Brand New Co'`);

// deletion: an expense posted to two companies is corrected in BOTH, each by its own connector
await db.query("insert into public.expenses(id, organization_id, transaction_number) values ($1,$2,'TXN-1')", [id(1), ORG]);
await db.query("update public.expenses set deleted_at = now() where id=$1", [id(1)]);
const jobs = await q("select tally_company, status from public.pwt_deletion_jobs where source_id=$1 order by tally_company", [src(1)]);
ok("D1 deleting an expense posted to two companies queues one correction per company", jobs.map((j) => j.tally_company).join() === "Brand New Co,Company A", JSON.stringify(jobs));
await db.query("insert into public.pwt_deletion_state(organization_id, last_scan_at) values ($1, now()) on conflict (organization_id) do update set last_scan_at = now()", [ORG]);
const claimA = (await one("select public.pwt_deletion_claim_v1($1,'Company A') r", [CONN_A])).r;
ok("D2 the Company A connector gets only the Company A correction", claimA && claimA.tally_company === "Company A", JSON.stringify(claimA));
const claimA2 = (await one("select public.pwt_deletion_claim_v1($1,'Company A') r", [CONN_A])).r;
ok("D3 ...and never the other company's", claimA2 === null);
await db.query("select public.pwt_deletion_ack_v1($1,$2,'completed','delete_voucher',null,null)", [CONN_A, claimA.job_id]);
const regs = await q("select tally_company, removed_at is not null removed from public.pwt_registry where source_id=$1 order by tally_company", [src(1)]);
ok("D4 completing Company A's correction stamps only Company A's posting",
  regs.find((r) => r.tally_company === "Company A").removed === true && regs.find((r) => r.tally_company === "Brand New Co").removed === false, JSON.stringify(regs));
await db.query("insert into public.expenses(id, organization_id, transaction_number) values ($1,$2,'TXN-2')", [id(2), ORG]);   // the other expense still exists (active)
ok("D5 a repeated scan queues nothing new", (await one("select public.pwt_deletion_scan_v1($1) n", [ORG])).n === 0);

console.log(process.exitCode ? "\nSOME CHECKS FAILED" : "\nALL PER-COMPANY REGISTRY CHECKS PASSED");
