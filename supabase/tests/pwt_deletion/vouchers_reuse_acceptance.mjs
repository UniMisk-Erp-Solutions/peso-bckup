/**
 * Acceptance test for 20261021160000_pwt_vouchers_reuse_released.sql: a sync after a failed delivery must not fail with
 * 'duplicate key value violates unique constraint "pwt_vouchers_pkey"'.
 *   npm i --no-save @electric-sql/pglite && node supabase/tests/pwt_deletion/vouchers_reuse_acceptance.mjs   (PWT_MIGRATIONS=<dir> overrides the folder)
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
for (const f of [
  "20261016120000_pwt_foundation.sql", "20261019100000_pwt_deletion_sync.sql", "20261019140000_pwt_registry_per_company.sql",
  "20261019150000_pwt_resumable_prepare.sql", "20261021140000_pwt_prepare_txns.sql", "20261021160000_pwt_vouchers_reuse_released.sql",
]) await db.exec(readFileSync(M + f, "utf8"));
await db.exec(readFileSync(M + "20261021160000_pwt_vouchers_reuse_released.sql", "utf8")); // idempotent

const ORG = "11111111-1111-1111-1111-111111111111";
const job = (n) => `a000000${n}-0000-0000-0000-00000000000a`;
const ok = (n, c, extra = "") => { console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + extra)); if (!c) process.exitCode = 1; };
const q = async (s, p) => (await db.query(s, p)).rows;
const one = async (s, p) => (await q(s, p))[0];
const bad = async (s, p) => { try { await db.query(s, p); return null; } catch (e) { return e.message; } };

for (const n of [1, 2, 3]) {
  await db.exec(`insert into public.pwt_sync_jobs(id, organization_id, report_type, parameters_hash, tally_company, status, worker_id)
                 values ('${job(n)}','${ORG}','detailed_expense','h${n}','Bug','preparing','w')`);
}
const batches = JSON.stringify([{ seq: 1, kind: "vouchers", xml: "x", item_count: 2, voucher_numbers: ["PESO/06/01", "PESO/06/05"], expected: {} }]);
const vouchers = JSON.stringify({ 1: [
  { date: "2026-06-30", number: "PESO/06/01", serial: 1, total: 6075 },
  { date: "2026-06-30", number: "PESO/06/05", serial: 5, total: 7950 }] });
const prep = (n) => bad("select public.pwt_complete_prep_v1($1,'w',$2::jsonb,'[]'::jsonb,$3::jsonb,'{}'::jsonb)", [job(n), batches, vouchers]);

ok("R1 the first sync plans its vouchers", (await prep(1)) === null);
// a failed delivery releases them (the rows stay)
await db.exec("update public.pwt_vouchers set status='released' where tally_company='Bug'");
const again = await prep(2);
ok("R2 the next sync can plan the same voucher date + number again (was: duplicate key)", again === null, String(again));
const rows = await q("select v.voucher_number, v.status, v.batch_id, b.job_id from public.pwt_vouchers v join public.pwt_batches b on b.id = v.batch_id where v.tally_company='Bug' order by voucher_number");
ok("R3 the released rows were reused by the new sync's batch", rows.length === 2 && rows.every((r) => r.status === "planned" && r.job_id === job(2)), JSON.stringify(rows));
// a posted voucher must never be overwritten by another sync
await db.exec("update public.pwt_vouchers set status='posted' where tally_company='Bug' and voucher_number='PESO/06/01'");
const clash = await prep(3);
ok("R4 a posted (or planned) voucher is still protected: a second sync cannot claim it", clash !== null);
ok("R5 nothing was overwritten by the rejected attempt",
  (await one("select status from public.pwt_vouchers where voucher_number='PESO/06/01'")).status === "posted");

console.log(process.exitCode ? "\nSOME CHECKS FAILED" : "\nALL VOUCHER-REUSE CHECKS PASSED");
