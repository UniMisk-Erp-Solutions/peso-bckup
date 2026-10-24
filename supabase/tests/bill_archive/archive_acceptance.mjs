/**
 * Acceptance test for 20261024160000_deleted_bill_archive.sql (in-process Postgres, minimal stubs). Touches no real database.
 *   npm i --no-save @electric-sql/pglite && node supabase/tests/bill_archive/archive_acceptance.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
const M = process.env.PWT_MIGRATIONS ?? fileURLToPath(new URL("../../migrations/", import.meta.url));
const db = new PGlite();
let fails = 0;
const ok = (n, c, d = "") => { console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + d)); if (!c) fails++; };
const one = async (q, p) => (await db.query(q, p)).rows[0];

await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create table public.profiles(user_id uuid primary key, name text, employee_id text);
  create table public.expenses(id uuid primary key, user_id uuid, organization_id uuid, transaction_number text, total_amount numeric, status text);
  create table public.attachments(id uuid primary key, expense_id uuid, organization_id uuid, filename text, content_type text, file_size bigint,
    storage_path text, created_at timestamptz default now(), deleted_at timestamptz, deleted_by uuid, deletion_source text);
  insert into public.profiles values ('11111111-1111-1111-1111-111111111111','Amit Test','1001'),('22222222-2222-2222-2222-222222222222','Admin One','9000');
  insert into public.expenses values ('e0000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','99999999-9999-9999-9999-999999999999','30001',1700,'submitted');
  insert into public.attachments(id, expense_id, organization_id, filename, storage_path, deleted_at, deleted_by, deletion_source) values
    ('a0000000-0000-0000-0000-000000000001','e0000000-0000-0000-0000-000000000001','99999999-9999-9999-9999-999999999999','old.jpg','p/old.jpg', now(),'11111111-1111-1111-1111-111111111111','file_upload_component'),
    ('a0000000-0000-0000-0000-000000000002','e0000000-0000-0000-0000-000000000001','99999999-9999-9999-9999-999999999999','live.jpg','p/live.jpg', null, null, null);
`);
const sql = readFileSync(M + "20261024160000_deleted_bill_archive.sql", "utf8");
await db.exec(sql);
await db.exec(sql);   // idempotent

let r = await one("select count(*)::int n from bill_archive.deleted_bills");
ok("existing deleted bill copied once (and only the deleted one)", r.n === 1);
r = await one("select * from bill_archive.deleted_bills where attachment_id='a0000000-0000-0000-0000-000000000001'");
ok("archive row carries employee id, name, expense and amount", r.employee_code === "1001" && r.employee_name === "Amit Test" && r.transaction_number === "30001" && Number(r.expense_amount) === 1700 && r.expense_status === "submitted", JSON.stringify(r));
ok("archive row records who deleted it and the storage path", r.deleted_by_name === "Amit Test" && r.storage_path === "p/old.jpg" && r.bucket_id === "receipts");

await db.exec("update public.attachments set deleted_at = now(), deleted_by='22222222-2222-2222-2222-222222222222', deletion_source='file_upload_component' where id='a0000000-0000-0000-0000-000000000002'");
r = await one("select * from bill_archive.deleted_bills where attachment_id='a0000000-0000-0000-0000-000000000002'");
ok("a bill deleted later is archived by the trigger, with the deleter", r && r.employee_code === "1001" && r.deleted_by_name === "Admin One", JSON.stringify(r));

await db.exec("update public.attachments set deleted_at = now() where id='a0000000-0000-0000-0000-000000000002'");
r = await one("select count(*)::int n from bill_archive.deleted_bills");
ok("deleting again does not duplicate", r.n === 2);

let err = null;
try { await db.exec("delete from bill_archive.deleted_bills"); } catch (e) { err = e.message; }
ok("the archive refuses DELETE", /permanent/.test(err ?? ""), String(err));

r = await one("select has_table_privilege('authenticated','bill_archive.deleted_bills','select') a, has_table_privilege('anon','bill_archive.deleted_bills','select') b, has_table_privilege('service_role','bill_archive.deleted_bills','select') c, has_schema_privilege('authenticated','bill_archive','usage') d");
ok("website roles (anon, authenticated, service_role) have no access at all", !r.a && !r.b && !r.c && !r.d, JSON.stringify(r));

process.exit(fails ? 1 : 0);
