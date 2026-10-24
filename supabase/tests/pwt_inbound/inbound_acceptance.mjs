/**
 * Acceptance test for the Tally -> PesoWise inbound payments migration (20261017100000_pwt_inbound_payments.sql).
 * Runs the REAL balance migrations plus the pwt migrations in an in-process Postgres (PGlite) with minimal stubs for auth/orgs/profiles.
 *   npm i --no-save @electric-sql/pglite && node supabase/tests/pwt_inbound/inbound_acceptance.mjs
 * Prints PASS/FAIL per rule and exits non-zero on any failure. Touches no real database.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
const M = fileURLToPath(new URL("../../migrations/", import.meta.url));

// same setup as inb_setup.mjs (real balance migrations + stubs)
const db = new PGlite();
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create schema auth;
  create table auth.users(id uuid primary key, email text);
  create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('app.uid', true), '')::uuid $$;
  create type app_role as enum ('admin','employee','cashier','accountant','manager');
  create table public.organizations(id uuid primary key, name text);
  create table public.profiles(user_id uuid, organization_id uuid, name text, email text, employee_id text, balance numeric default 0, updated_at timestamptz, primary key(user_id, organization_id));
  create table public.organization_memberships(user_id uuid, organization_id uuid, role app_role, is_active boolean default true);
  create table public.expenses(id uuid primary key, organization_id uuid, approval_tier text, deleted_at timestamptz);
`);
for (const f of ["20260819160000_balance_ledger.sql", "20260819162000_balance_import_schema.sql", "20260824100000_historical_balance_anchors_schema.sql", "20260901120000_additive_credit_v3.sql", "20260901121500_additive_credit_v3_import.sql",
  "20261016120000_pwt_foundation.sql", "20261017100000_pwt_inbound_payments.sql"]) await db.exec(readFileSync(M + f, "utf8"));
// idempotent re-run of the new migration
await db.exec(readFileSync(M + "20261017100000_pwt_inbound_payments.sql", "utf8"));
await db.exec(readFileSync(M + "20261022160000_pwt_inbound_deleted_same_type.sql", "utf8"));
await db.exec(readFileSync(M + "20261023100000_pwt_inbound_match_by_code.sql", "utf8"));
await db.exec(readFileSync(M + "20261024100000_pwt_inbound_cash_parent_ci.sql", "utf8"));

const ORG = "11111111-1111-1111-1111-111111111111", OTHER_ORG = "99999999-9999-9999-9999-999999999999";
const ADMIN = "22222222-2222-2222-2222-222222222222", EMPL = "33333333-3333-3333-3333-333333333333";
const E = { a: "a0000000-0000-0000-0000-00000000000a", b: "b0000000-0000-0000-0000-00000000000b", c: "c0000000-0000-0000-0000-00000000000c", d1: "d0000000-0000-0000-0000-0000000000d1", d2: "d0000000-0000-0000-0000-0000000000d2", o: "e0000000-0000-0000-0000-0000000000e0", z: "f0000000-0000-0000-0000-0000000000f0" };
await db.exec(`
  insert into auth.users values ('${ADMIN}','a@x'),('${EMPL}','e@x'),('${E.a}','a1@x'),('${E.b}','b1@x'),('${E.c}','c1@x'),('${E.d1}','d1@x'),('${E.d2}','d2@x'),('${E.o}','o1@x'),('${E.z}','z1@x');
  insert into public.organizations values ('${ORG}','Org'),('${OTHER_ORG}','Other');
  insert into public.profiles(user_id, organization_id, name, employee_id, balance) values
    ('${E.a}','${ORG}','Amit Test','1001', 100), ('${E.b}','${ORG}','Bina Test','1002', 0), ('${E.c}','${ORG}','Chetan Test','1003', 50),
    ('${E.d1}','${ORG}','Dup One','7777', 0), ('${E.d2}','${ORG}','Dup Two','7777', 0),
    ('${E.o}','${OTHER_ORG}','Other Org Person','2001', 0), ('${E.z}','${ORG}','Zed Inactive','1009', 0);
  insert into public.organization_memberships values ('${ADMIN}','${ORG}','admin',true),('${EMPL}','${ORG}','employee',true),
    ('${E.a}','${ORG}','employee',true),('${E.b}','${ORG}','employee',true),('${E.c}','${ORG}','employee',true),
    ('${E.d1}','${ORG}','employee',true),('${E.d2}','${ORG}','employee',true),('${E.o}','${OTHER_ORG}','employee',true),('${E.z}','${ORG}','employee',false);
  insert into public.pwt_connectors(id, organization_id, device_name, tally_company, token_hash) values ('c0000000-0000-0000-0000-00000000c0c0','${ORG}','PC','Demo Co','h1');
`);
const CONN = "c0000000-0000-0000-0000-00000000c0c0";
const ok = (n, c, extra = "") => { console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + extra)); if (!c) process.exitCode = 1; };
const as = (u) => db.exec(`select set_config('app.uid','${u}',false)`);
const q = async (s, p) => (await db.query(s, p)).rows;
const one = async (s, p) => (await q(s, p))[0];
const bal = async (id) => Number((await one("select balance from public.profiles where user_id=$1", [id])).balance);
const ledgerRows = async (id) => (await q("select amount_delta::float, entry_type, source_type, note, idempotency_key from public.balance_ledger where user_id=$1 order by created_at", [id]));
const bad = async (s, p) => { try { await db.query(s, p); return null; } catch (e) { return e.message; } };

let n = 0;
const V = (over = {}) => ({
  guid: "G-" + (++n), number: String(n), date: "2026-10-16", type: "PesoWise Payment", narration: "advance", alter_id: 10, master_id: n,
  cancelled: false, optional: false,
  entries: [{ ledger: "Amit Test-1001", amount: -500, parent: "Sundry Debtors" }, { ledger: "Cash", amount: 500, parent: "Cash-in-Hand" }], ...over,
});
const pay = (name, amt, bank = "Cash", bp = "Cash-in-Hand") => [{ ledger: name, amount: -amt, parent: "Sundry Debtors" }, { ledger: bank, amount: amt, parent: bp }];

async function runSync(vouchers, { total = vouchers.length, company = "Demo Co" } = {}) {
  await as(ADMIN);
  const c = (await one("select public.pwt_inbound_create_job_v1($1) r", [ORG])).r;
  const claim = (await one("select public.pwt_inbound_claim_v1($1,$2) r", [CONN, company])).r;
  if (!claim || claim.blocked) return { c, claim };
  await db.query("select public.pwt_inbound_submit_v1($1,$2,0,$3::jsonb,$4)", [CONN, claim.job_id, JSON.stringify(vouchers), total]);
  const fin = (await one("select public.pwt_inbound_finish_v1($1,$2,$3,null) r", [CONN, claim.job_id, total])).r;
  const job = await one("select * from public.pwt_inbound_jobs where id=$1", [claim.job_id]);
  return { c, claim, fin, job };
}

// ---- Test 1: new payment
const v1 = V();                                               // Amit +500
const r1 = await runSync([v1]);
ok("T1 job completes", r1.job.status === "completed", JSON.stringify(r1.fin));
ok("T1 correct employee credited by exact amount (100 -> 600)", (await bal(E.a)) === 600);
ok("T1 other employees untouched", (await bal(E.b)) === 0 && (await bal(E.c)) === 50);
const lr = await ledgerRows(E.a);
ok("T1 ledger row via the existing engine (balance_credit, +500, note has voucher)", lr.length === 1 && lr[0].amount_delta === 500 && lr[0].entry_type === "balance_credit" && /Tally payment voucher/.test(lr[0].note));
const batch = await one("select * from public.balance_import_batches where id=$1", [r1.job.batch_id]);
ok("T1 appears in Import History as an applied balance_credit batch", batch && batch.status === "applied" && batch.mode === "balance_credit" && Number(batch.total_delta) === 500 && batch.row_count === 1);
const reg = await one("select * from public.pwt_inbound_payments where voucher_guid=$1", [v1.guid]);
ok("T1 audit trail links ledger entry to the Tally voucher", reg.state === "imported" && reg.ledger_entry_id && reg.voucher_number === v1.number && reg.tally_company === "Demo Co");
ok("T1 summary counts", r1.job.imported_count === 1 && Number(r1.job.imported_amount) === 500 && r1.job.vouchers_fetched === 1);

// ---- Test 2: duplicate protection
const r2 = await runSync([v1]);
ok("T2 second sync imports nothing", r2.job.imported_count === 0 && r2.job.already_imported_count === 1 && r2.job.status === "completed");
ok("T2 balance unchanged", (await bal(E.a)) === 600);
ok("T2 no empty batch left in history", r2.job.batch_id === null && Number((await one("select count(*) n from public.balance_import_batches")).n) === 1);
const dupKey = await one("select count(*) n from public.balance_ledger where user_id=$1", [E.a]);
ok("T2 still exactly one ledger row", Number(dupKey.n) === 1);

// ---- Test 3: multiple employees; two entries for one employee are summed
const v3 = V({ entries: [{ ledger: "Bina Test-1002", amount: -300, parent: "Sundry Debtors" }, { ledger: "Chetan Test-1003", amount: -120.5, parent: "Sundry Debtors" }, { ledger: "Bina Test-1002", amount: -50, parent: "Sundry Debtors" }, { ledger: "HDFC Bank", amount: 470.5, parent: "Bank Accounts" }] });
const r3 = await runSync([v3]);
ok("T3 multi-employee voucher: two payments, correct sums", r3.job.imported_count === 2 && (await bal(E.b)) === 350 && (await bal(E.c)) === 170.5, `b=${await bal(E.b)} c=${await bal(E.c)}`);
const r3b = await runSync([v3]);
ok("T3 repeat of the multi-employee voucher imports nothing", r3b.job.imported_count === 0 && r3b.job.already_imported_count === 2 && (await bal(E.b)) === 350);

// ---- Test 4: invalid data never changes a balance
const before = { a: await bal(E.a), b: await bal(E.b), c: await bal(E.c), o: await bal(E.o), z: await bal(E.z), d1: await bal(E.d1) };
const bads = [
  V({ entries: pay("Nobody Here-5555", 100) }),                               // unknown employee
  V({ entries: pay("Other Org Person-2001", 100) }),                          // employee of another organisation
  V({ entries: pay("Zed Inactive-1009", 100) }),                              // inactive member
  V({ entries: pay("Dup One-7777", 100) }),                                   // ambiguous code
  V({ type: "Payment", entries: pay("Amit Test-1001", 100) }),                // wrong voucher type
  V({ entries: [{ ledger: "Amit Test-1001", amount: 100, parent: "Sundry Debtors" }, { ledger: "Cash", amount: -100, parent: "Cash-in-Hand" }] }), // Cr employee = refund
  V({ entries: pay("Amit Test-1001", 0) }),                                   // zero amount
  V({ entries: [{ ledger: "Amit Test-1001", amount: -100, parent: "Sundry Debtors" }, { ledger: "Cash", amount: 90, parent: "Cash-in-Hand" }] }), // unbalanced
  V({ entries: [{ ledger: "Amit Test-1001", amount: -100, parent: "Sundry Debtors" }, { ledger: "Sales", amount: 100, parent: "Sales Accounts" }] }), // credit side not cash/bank
  V({ entries: [{ ledger: "Amit Test-1001", amount: -100, parent: "Sundry Debtors" }, { ledger: "Cash", amount: 100 }] }), // credit parent unknown
  V({ cancelled: true, entries: pay("Amit Test-1001", 100) }),
  V({ optional: true, entries: pay("Amit Test-1001", 100) }),
  V({ date: "not-a-date", entries: pay("Amit Test-1001", 100) }),
  V({ narration: "PWT PESO/08/02", entries: pay("Amit Test-1001", 100) }),    // PesoWise->Tally export must never come back
  V({ entries: pay("Expense Ledger", 100) }),                                  // not an employee ledger
];
const r4 = await runSync(bads);
ok("T4 no balance changed by any invalid voucher", (await bal(E.a)) === before.a && (await bal(E.b)) === before.b && (await bal(E.c)) === before.c && (await bal(E.o)) === before.o && (await bal(E.z)) === before.z && (await bal(E.d1)) === before.d1);
ok("T4 nothing imported", r4.job.imported_count === 0);
ok("T4 unmatched/ambiguous reported (4)", r4.job.unmatched_count === 4, `got ${r4.job.unmatched_count}`);
ok("T4 skipped reported (11)", r4.job.skipped_count === 11, `got ${r4.job.skipped_count}`);
ok("T4 job needs attention with a problem list", r4.job.status === "needs_attention");
const probs = (await one("select public.pwt_inbound_job_problems_v1($1,$2) p", [ORG, r4.claim.job_id])).p;
ok("T4 problems list names the reason", probs.length >= 15 && probs.some((p) => /more than one employee/.test(p.reason)) && probs.some((p) => /cancelled/.test(p.reason)));
ok("T4 refund (Cr on employee) is skipped with a reason, not imported", probs.some((p) => /not balanced or has no debit/.test(p.reason)));

// ---- wrong company / authorisation / incomplete upload
await as(ADMIN);
await db.query("select public.pwt_inbound_create_job_v1($1)", [ORG]);
const wrong = (await one("select public.pwt_inbound_claim_v1($1,'Some Other Company') r", [CONN])).r;
ok("T4 wrong active company: job not handed out", wrong && wrong.blocked === "wrong_company");
const claim = (await one("select public.pwt_inbound_claim_v1($1,'Demo Co') r", [CONN])).r;
await db.query("select public.pwt_inbound_submit_v1($1,$2,0,$3::jsonb,5)", [CONN, claim.job_id, JSON.stringify([V()])]);
const fin = (await one("select public.pwt_inbound_finish_v1($1,$2,5,null) r", [CONN, claim.job_id])).r;
ok("T5 incomplete upload fails and credits nothing", fin.failed === true && (await bal(E.a)) === 600);
await as(EMPL);
ok("T4 non-admin cannot start a sync", /not permitted/.test(await bad("select public.pwt_inbound_create_job_v1($1)", [ORG])));
await as(ADMIN);

// ---- Test 5: recovery. A repeated submit chunk is idempotent; a lost registry row cannot double-credit
const rv = V({ entries: pay("Amit Test-1001", 40) });
await as(ADMIN);
await db.query("select public.pwt_inbound_create_job_v1($1)", [ORG]);
const cl = (await one("select public.pwt_inbound_claim_v1($1,'Demo Co') r", [CONN])).r;
await db.query("select public.pwt_inbound_submit_v1($1,$2,0,$3::jsonb,1)", [CONN, cl.job_id, JSON.stringify([rv])]);
await db.query("select public.pwt_inbound_submit_v1($1,$2,0,$3::jsonb,1)", [CONN, cl.job_id, JSON.stringify([rv])]);  // connector retry of the same chunk
ok("T5 retried chunk stored once", Number((await one("select count(*) n from public.pwt_inbound_vouchers where job_id=$1", [cl.job_id])).n) === 1);
await db.query("select public.pwt_inbound_finish_v1($1,$2,1,null)", [CONN, cl.job_id]);
ok("T5 imported once (600 -> 640)", (await bal(E.a)) === 640);
await db.query("delete from public.pwt_inbound_payments where voucher_guid=$1", [rv.guid]);  // simulate a lost registry row
const r5 = await runSync([rv]);
ok("T5 lost registry row: ledger idempotency key prevents a second credit", (await bal(E.a)) === 640 && r5.job.already_imported_count === 1 && r5.job.imported_count === 0);
ok("T5 registry row repaired", (await one("select state from public.pwt_inbound_payments where voucher_guid=$1", [rv.guid])).state === "imported");

// ---- Test 6: edited and deleted vouchers are flagged, never auto-applied
const edited = { ...v1, alter_id: 11, entries: pay("Amit Test-1001", 900) };
const r6 = await runSync([edited, v3]);
ok("T6 edited voucher: balance NOT changed", (await bal(E.a)) === 640);
ok("T6 edited voucher flagged for reconciliation", (await one("select state, reason from public.pwt_inbound_payments where voucher_guid=$1", [v1.guid])).state === "changed_after_import" && r6.job.flagged_count >= 1 && r6.job.status === "needs_attention");
const r7 = await runSync([v3]);       // v1 and rv now missing from Tally
const st = await q("select voucher_guid, state from public.pwt_inbound_payments where state in ('deleted_in_tally','changed_after_import')");
ok("T6 deleted voucher flagged, balance NOT reversed", (await bal(E.a)) === 640 && st.some((x) => x.voucher_guid === rv.guid && x.state === "deleted_in_tally"), JSON.stringify(st));
const r8 = await runSync([]);        // empty but complete fetch: nothing else changes
ok("T6 empty fetch changes no balance", (await bal(E.a)) === 640 && (await bal(E.b)) === 350);

// ---- Test 7: one failing payment does not block the others
await db.exec(`update public.profiles set balance = 999999999999 where user_id = '${E.c}'`);   // credit would overflow the ledger columns
const hugeV = V({ entries: pay("Chetan Test-1003", 500000000) });
const absurd = V({ entries: pay("Amit Test-1001", 99999999999999.99) });
const okV = V({ entries: pay("Bina Test-1002", 25) });
const r9 = await runSync([hugeV, absurd, okV]);
ok("T7 failure isolated: other payment still imported", (await bal(E.b)) === 375 && r9.job.failed_count === 2 && r9.job.imported_count === 1, JSON.stringify(r9.fin));
ok("T7 failed payments changed nothing", (await bal(E.c)) === 999999999999 && (await bal(E.a)) === 640);

// ---- consistency: balance == sum of ledger deltas we caused
const sumDelta = async (id) => Number((await one("select coalesce(sum(amount_delta),0) s from public.balance_ledger where user_id=$1", [id])).s);
ok("reconciliation: Amit 100 + ledger credits == balance", 100 + (await sumDelta(E.a)) === (await bal(E.a)));
ok("reconciliation: Bina 0 + ledger credits == balance", 0 + (await sumDelta(E.b)) === (await bal(E.b)));
ok("reconciliation: Chetan (reset) unaffected by failed credit", (await sumDelta(E.c)) === 120.5);

// ---- existing reversal still works on a Tally batch (Import History)
await as(ADMIN);
const bId = r1.job.batch_id;
const rev = (await one("select public.balance_reverse_import_v3($1,'test reversal') r", [bId])).r;
ok("existing Import History reversal works on a Tally sync batch", rev.ok === true && (await bal(E.a)) === 140);

// ---- partial voucher: one employee unmatched first, fixed later => imports the rest, NOT treated as an edit
await db.exec("insert into auth.users values ('a1111111-1111-1111-1111-111111111111','n@x')");
const pv = V({ entries: [{ ledger: "Amit Test-1001", amount: -10, parent: "Sundry Debtors" }, { ledger: "Newbie Test-4444", amount: -20, parent: "Sundry Debtors" }, { ledger: "Cash", amount: 30, parent: "Cash-in-Hand" }] });
const before2 = await bal(E.a);
const p1 = await runSync([pv]);
ok("partial voucher: matched employee imported, unknown reported", p1.job.imported_count === 1 && p1.job.unmatched_count === 1 && (await bal(E.a)) === before2 + 10);
await db.exec("insert into public.profiles(user_id, organization_id, name, employee_id, balance) values ('a1111111-1111-1111-1111-111111111111','" + ORG + "','Newbie Test','4444',0); insert into public.organization_memberships values ('a1111111-1111-1111-1111-111111111111','" + ORG + "','employee',true);");
const p2 = await runSync([pv]);
ok("partial voucher: after the employee is added, only the missing payment imports (no double credit, no false edit flag)", p2.job.imported_count === 1 && p2.job.already_imported_count === 1 && p2.job.flagged_count === 0 && (await bal(E.a)) === before2 + 10 && Number((await one("select balance from public.profiles where user_id='a1111111-1111-1111-1111-111111111111'")).balance) === 20, JSON.stringify(p2.fin));

// ---- restored voucher: deleted flag clears when the identical voucher reappears; balance unchanged
const p3 = await runSync([]);                                   // pv vanished from Tally
ok("deleted voucher flagged", (await q("select 1 from public.pwt_inbound_payments where voucher_guid=$1 and state='deleted_in_tally'", [pv.guid])).length === 2);
const p4 = await runSync([pv]);
ok("restored identical voucher returns to imported, no new credit", p4.job.imported_count === 0 && (await q("select 1 from public.pwt_inbound_payments where voucher_guid=$1 and state='imported'", [pv.guid])).length === 2 && (await bal(E.a)) === before2 + 10);

// ---- cancelled in Tally after import => flagged, balance not touched
const p5 = await runSync([{ ...pv, cancelled: true }]);
ok("voucher cancelled after import is flagged, not silently kept", (await q("select 1 from public.pwt_inbound_payments where voucher_guid=$1 and state='changed_after_import'", [pv.guid])).length === 2 && (await bal(E.a)) === before2 + 10);

// ---- configurable exact voucher type
await as(ADMIN);
await db.query("select public.pwt_inbound_set_voucher_type_v1($1,$2)", [ORG, "PESO Wise Payment"]);
ok("voucher type setting is readable by an admin", (await one("select public.pwt_inbound_get_settings_v1($1) s", [ORG])).s.voucher_type === "PESO Wise Payment");
const before3 = await bal(E.b);
const old = V({ entries: pay("Bina Test-1002", 11) });                 // type "PesoWise Payment" no longer matches this organisation
const custom = V({ type: "PESO Wise Payment", entries: pay("Bina Test-1002", 22) });
const t1 = await runSync([old, custom]);
ok("only the configured exact voucher type is imported", (await bal(E.b)) === before3 + 22 && t1.job.imported_count === 1 && t1.job.skipped_count === 1);
ok("claim hands the connector the exact type to read", t1.claim.voucher_type === "PESO Wise Payment");
await as(EMPL);
ok("non-admin cannot change the voucher type", /not permitted/.test(await bad("select public.pwt_inbound_set_voucher_type_v1($1,$2)", [ORG, "X"])));
await as(ADMIN);
ok("empty voucher type rejected", (await bad("select public.pwt_inbound_set_voucher_type_v1($1,$2)", [ORG, "  "])) !== null);

// ---- Test 8: switching the voucher type must not flag the other type's payments as deleted
await db.query("select public.pwt_inbound_set_voucher_type_v1($1,$2)", [ORG, "Type A"]);
const tA = V({ type: "Type A", entries: pay("Amit Test-1001", 11) });
const a1 = await runSync([tA]);
ok("T8 payment of type A imported", a1.job.imported_count === 1);
await db.query("select public.pwt_inbound_set_voucher_type_v1($1,$2)", [ORG, "Type B"]);
const b1 = await runSync([]);          // Tally returns nothing of type B
ok("T8 switching type does not flag type A payment as deleted", b1.job.flagged_count === 0 && (await one("select state from public.pwt_inbound_payments where voucher_guid=$1", [tA.guid])).state === "imported");
await db.query("select public.pwt_inbound_set_voucher_type_v1($1,$2)", [ORG, "Type A"]);
const a2 = await runSync([]);          // same type, voucher really gone
ok("T8 same type and voucher gone: still flagged", a2.job.flagged_count === 1);

// ---- Test 9: the employee is identified by the code; a different name text does not matter
await db.query("select public.pwt_inbound_set_voucher_type_v1($1,$2)", [ORG, "PesoWise Payment"]);
const beforeA = await bal(E.a);
const wn = V({ entries: pay("Whatever Typed Manually-1001", 77) });
const w1 = await runSync([wn]);
ok("T9 right code + different name text credits that employee", w1.job.imported_count === 1 && (await bal(E.a)) === beforeA + 77);
const w2 = await runSync([V({ entries: pay("Whatever Typed Manually-5555", 10) })]);
ok("T9 unknown code is still refused", w2.job.imported_count === 0 && w2.job.unmatched_count === 1);

// ---- Test 10: the cash/bank group name is compared without regard to capital letters ("Cash-in-hand")
const ci = V({ entries: [{ ledger: "Amit Test-1001", amount: -33, parent: "Sundry Debtors" }, { ledger: "Cash", amount: 33, parent: "Cash-in-hand" }] });
const beforeCi = await bal(E.a);
const ci1 = await runSync([ci]);
ok("T10 'Cash-in-hand' (different capitals) is accepted as cash", ci1.job.imported_count === 1 && (await bal(E.a)) === beforeCi + 33);
const ci2 = await runSync([V({ entries: [{ ledger: "Amit Test-1001", amount: -9, parent: "Sundry Debtors" }, { ledger: "Sales", amount: 9, parent: "sales accounts" }] })]);
ok("T10 a non-cash group is still refused", ci2.job.imported_count === 0 && ci2.job.skipped_count === 1);
