/**
 * Acceptance test for 20261021180000_pwt_posting_date_setting.sql: the saved mapping accepts postingDatePolicy (month_end | month_start) only.
 *   npm i --no-save @electric-sql/pglite && node supabase/tests/pwt_deletion/posting_date_acceptance.mjs   (PWT_MIGRATIONS=<dir> overrides the folder)
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
  "20261016120000_pwt_foundation.sql", "20261016130000_pwt_config_rpcs.sql", "20261019100000_pwt_deletion_sync.sql",
  "20261019140000_pwt_registry_per_company.sql", "20261019150000_pwt_resumable_prepare.sql", "20261021100000_pwt_report_rows_setting.sql",
  "20261021140000_pwt_prepare_txns.sql", "20261021180000_pwt_posting_date_setting.sql",
]) await db.exec(readFileSync(M + f, "utf8"));
await db.exec(readFileSync(M + "20261021180000_pwt_posting_date_setting.sql", "utf8")); // idempotent

const ORG = "11111111-1111-1111-1111-111111111111", ADMIN = "22222222-2222-2222-2222-222222222222";
await db.exec(`insert into public.organization_memberships(user_id, organization_id, role) values ('${ADMIN}','${ORG}','admin'); select set_config('app.uid','${ADMIN}', false)`);
const ok = (n, c, extra = "") => { console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + extra)); if (!c) process.exitCode = 1; };
const q = async (s, p) => (await db.query(s, p)).rows;
const bad = async (s, p) => { try { await db.query(s, p); return null; } catch (e) { return e.message; } };
const cats = [{ serial: 1, expenseType: "Food", expenseLedger: "Travelling Expenses" }];
const save = (extra) => bad("select public.pwt_save_config_v1($1,$2::jsonb)", [ORG, JSON.stringify({ categories: cats, ...extra })]);

ok("P1 month_start is accepted and stored", (await save({ postingDatePolicy: "month_start" })) === null &&
  (await q("select config->>'postingDatePolicy' p from public.pwt_mapping_config where organization_id=$1", [ORG]))[0].p === "month_start");
ok("P2 month_end is accepted", (await save({ postingDatePolicy: "month_end" })) === null);
ok("P3 anything else is refused", (await save({ postingDatePolicy: "tomorrow" })) !== null);
ok("P4 leaving it out keeps the default (nothing stored)", (await save({})) === null &&
  (await q("select config ? 'postingDatePolicy' h from public.pwt_mapping_config where organization_id=$1", [ORG]))[0].h === false);

console.log(process.exitCode ? "\nSOME CHECKS FAILED" : "\nALL POSTING-DATE CHECKS PASSED");
