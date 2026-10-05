# DOC-116 — Detailed Expense on the Canonical Additive V3 Balance Timeline

**Doc ID:** DOC-116 (renumbered from DOC-115 on merge to `main` — `main` had
independently registered DOC-115 for the Review Expenses work; see
[`index.md`](./index.md)'s Next ID history.)
**Last updated:** 2026-09-02
**Status:** deployed to Production; merged to `main`
**Branch:** `hotfix/detailed-expense-canonical-balance`
**Base:** `main` @ `4c668e4` (the merge that brought DOC-113 + DOC-114 into `main`), later merged forward onto `main` @ `064d353` (post Review Expenses merge) before this branch's own merge to `main`

---

## 1. Summary

Detailed Expense is now a real accounting ledger built on the **same canonical
event set as the V3 Balance Ledger**, instead of reconstructing balances with a
second, older algorithm of its own.

Both report shapes — one employee and all employees — now show, chronologically
and per employee:

- approved expense deductions,
- balance / Tally additions,
- negative additive entries,
- opening-balance credits,
- every other signed balance event in `balance_ledger`,

each with **Credit**, **Debit**, **Transaction #**, **Opening Balance** and
**Closing Balance after that event**.

The change is read/report architecture only. No financial value was modified.

---

## 2. Problem — the defect being retired

The worker (`supabase/functions/run-report-export-job/`) performed its own
balance reconstruction:

| Mode | Old sources | Old balance method |
| --- | --- | --- |
| Single employee | approved `expenses` + `report_expense_allocations_v1` (`cash_transfer_history`) | walked **backwards** from `rows[0].user_balance` |
| All employees | approved `expenses` only | none — Debit column only, **no closing balance at all** |

That architecture predates Additive Credit V3 (DOC-114). Because it never read
`balance_ledger`, it could not represent:

- V3 positive balance entries (`balance_credit`, `opening_credit`),
- V3 negative additive entries,
- opening-balance credits,
- Tally/balance additions,
- corrected reversals and the V3 reversed-pair visibility rules.

Worse, the backward walk started from the employee's **present** wallet balance
and subtracted only the events it knew about. Any event it could not see was
silently absorbed, so historical closing balances were wrong for exactly the
employees who had V3 activity — and "All employees", the mode most people run,
had no closing balance to be wrong about in the first place.

---

## 3. Solution — one accounting algorithm

A new forward-only migration introduces a single canonical event constructor
and rewires **both** consumers onto it:

```
_balance_timeline_events_v3          <- the one source of accounting truth
   |                                    (reversed-pair rules + event union)
   +-- _balance_unified_timeline_v3      V3 Balance Ledger (UI)
   +-- report_balance_timeline_rows_v3   Detailed Expense worker
```

`_balance_timeline_events_v3` is the event-construction logic lifted
semantics-for-semantics out of `_balance_unified_timeline_v3` (shipped in
`20260901123000_unified_balance_timeline_v3.sql`) and generalised from one
employee to a set of employees. The accounting itself is unchanged:

- the generic `hidden` CTE still excludes a reversed original **and** its
  reversal, for both the old anchor engine and the v3 credit engine;
- expense deductions still take their date from `expenses.trip_start` and their
  transaction number from `expenses.transaction_number` — approval time is
  never used for positioning;
- `day_position` is carried through untouched;
- same-day ordering is the same deterministic key.

`_balance_unified_timeline_v3` keeps its exact signature, return type, ordering
and `LIMIT/OFFSET` behaviour — only its body changed, to read the shared helper
instead of restating the CTEs. **Its row-for-row equivalence with the previous
body was proven against Production data before applying** (§7).

### Order of operations (the actual fix)

`report_balance_timeline_rows_v3`:

1. build the **complete** canonical event set — no date predicate,
2. rank it **per employee**,
3. run the balance forward per employee from that employee's own reconstructed
   baseline (`profiles.balance − Σ amount_delta`, the same reconstruction the
   Balance Ledger uses),
4. **only then** filter to the requested report window,
5. **only then** paginate.

Filtering first and summing from zero is precisely the bug this replaces: the
first in-period row would open at ₹0.00 instead of at its true carried-in
balance.

`PARTITION BY user_id` throughout means every employee has an independent
timeline. There is never one organisation-wide running balance.

### Signed accounting rule

Applied once, in SQL, and nowhere else:

| `amount_delta` | Column |
| --- | --- |
| `> 0` | **Credit** = `amount_delta` |
| `< 0` | **Debit** = `−amount_delta` |
| `= 0` | no-op — not displayed |

The **sign** decides the column. The event type never does. A `balance_credit`
carrying a negative delta is a Debit — the case the retired implementation got
wrong by branching on type.

`Opening Balance = calculated_balance_after − amount_delta`.
`Closing Balance = calculated_balance_after`.
No stored `balance_after` is ever read as historical truth.

---

## 4. Columns

Single employee:

> Date · Transaction # · Title · Type · Expense Type · Purpose · Destination ·
> Batch · *custom expense fields* · Credit · Debit · Notes · Opening Balance ·
> Closing Balance

All employees — the same, prefixed with:

> Employee · Employee ID

`Type` is the human event label (`Expense Deduction`, `Balance Credit`,
`Opening Balance Credit`, `Cash Transfer`, `Allocation`, `Adjustment`, …),
ported verbatim from `ledgerEntryTypeLabel()` in `EmployeeBalanceHistory.tsx`
so an exported row reads exactly like the same row in the Balance Ledger UI.
`Expense Type` keeps the expense's own category so nothing the old report
showed is lost. On non-expense balance events the expense-only cells and the
custom-field cells are blank.

`Transaction #` is TEXT end to end — leading zeros survive (verified: `00496`).

---

## 5. Known consequence the owner should confirm during QA

The canonical V3 timeline reads **`balance_ledger` + `expense_balance_deductions`
only**. A Production audit found:

- `cash_transfer_history` holds **395** rows,
- **0** of them are linked into `balance_ledger` by `source_id`.

So the ~395 cash transfers the *old* Detailed Expense listed as credits via
`report_expense_allocations_v1` **no longer appear as itemised rows** — because
they do not appear in the V3 Balance Ledger either. This is canonical parity,
which is the stated acceptance criterion (§27 of the request), not data loss:

- balances remain correct — whatever those transfers did to the wallet is
  absorbed into each employee's reconstructed carried-in baseline;
- the 10 transfer-type events that *are* ledger-backed
  (`cash_transfer_in` / `cash_transfer_out` / `allocation`) do still appear.

If the owner wants those 395 transfers itemised, the correct fix is to
backfill them into `balance_ledger` so **both** the Balance Ledger and Detailed
Expense gain them together — not to re-introduce a second accounting source in
the report. Flagged here deliberately rather than silently changed.

---

## 6. Key files touched

| File | Change |
| --- | --- |
| `supabase/migrations/20260902130000_report_balance_timeline_v3.sql` | **new** — shared helper, label function, rewired Balance Ledger, worker report RPC |
| `supabase/functions/run-report-export-job/expenseReports.ts` | Detailed Expense builder rewritten onto the canonical timeline; `AllocationRow` and the backward walk deleted |
| `supabase/functions/run-report-export-job/index.ts` | new `buildDetailedExpenseReport()`; `detailed_expense` routed to it; allocations RPC call removed |
| `src/lib/__tests__/detailedExpenseCanonicalLedger.test.ts` | **new** — 49 tests (behavioural + SQL contract) |
| `src/lib/__tests__/reportExportWorker.test.ts` | the two tests asserting the retired architecture replaced by six guarding the new one |

Not touched: `daily_project_report`, `claim_verification`, `claim_approval`,
the frontend enqueue path, any already-live V3 migration file, any table, RLS
policy, trigger or financial value.

---

## 7. Database / migrations

`20260902130000_report_balance_timeline_v3.sql` — **forward-only, additive.**
Four `CREATE OR REPLACE FUNCTION`s, no `DROP`, no `ALTER TABLE`, no DML, no
policy change.

### Security (spec §13)

| Function | PUBLIC / anon / authenticated | service_role |
| --- | --- | --- |
| `_balance_timeline_events_v3` | revoked | granted |
| `_balance_event_label_v3` | revoked | granted |
| `report_balance_timeline_rows_v3` | revoked | granted |

The worker RPC performs **no authorization of its own** — same contract as
`report_expense_rows_v1` and `report_daily_project_rows_v1` — because
permission is resolved from `auth.uid()` at enqueue in
`create_expense_report_export_job_v1`. It is therefore service_role-only and
organisation-scoped, and raises on a null organisation.

The two public V3 wrappers (`get_my_unified_balance_timeline_v3`,
`get_org_balance_timeline_v3`) are **not** modified or weakened.

### Pre-apply evidence (Production, rolled back)

Both suites ran inside a transaction that was forced to `ROLLBACK`, with a
post-check proving **0 objects survived**.

**Parity — rewired Balance Ledger vs the previously live one:**

| Metric | Result |
| --- | --- |
| employees compared | 266 |
| rows, old implementation | 13,430 |
| rows, new implementation | 13,430 |
| rows only in old | **0** |
| rows only in new | **0** |
| positional mismatches (event_id + calculated_balance_after) | **0** |

**Backup taken before applying** (spec §22):

| | |
| --- | --- |
| backup id | `pesowise_pre_report_timeline_20260902T074334Z` |
| size | 27,371,419 bytes |
| sha256 | `245a20fe064f60baeea87e6389d87e99d255b0642b97d6cdf41a12b7c8cd6b97` |
| `pg_restore -l` | parses, 2,341 TOC entries |
| health | `15.8`, not in recovery, 0 stuck DDL, 0 waiting locks, 0 idle-in-txn > 5 min |

> **Apply status:** the Production apply was **blocked by the environment's
> permission classifier** and has NOT been run. The backup above was taken and
> verified; the migration is written, dry-run-proven and committed. See §10.

---

## 8. Test plan and results

### Automated — 78 passing

`npx vitest run src/lib/__tests__/detailedExpenseCanonicalLedger.test.ts src/lib/__tests__/reportExportWorker.test.ts`

`expenseReports.ts` has no Deno-only imports, so the real builder and the real
pager are imported and executed against a fake RPC client — these assert the
bytes that land in the file, not source strings. The SQL half is guarded on the
authored migration source, matching the convention in
`serverSideReportGeneration.test.ts`.

### Production test matrix — all green (dry run, rolled back)

Subjects discovered from the data; nothing hardcoded to an employee,
organisation or transaction number. Subject org: MicroLink (largest by ledger
volume), 12,917 timeline rows.

| # | Check | Result |
| --- | --- | --- |
| M1 | All employees, one call, envelope shape | 12,917 rows, cursor present |
| M2 | Signed rule | 0 both-set, 0 neither-set, 0 zero-delta shown |
| M3 | `opening = closing − delta` | 0 mismatches / 500 |
| M4 | Positive credit → Credit | +₹13,981 · opening −₹4,944 → closing ₹9,037 |
| M5 | Negative additive → Debit | Debit ₹9,845 · opening −₹4,214 → closing −₹14,059 |
| M6 | Approved expense row | txn `15415`, Debit ₹80, closing −₹19,737 |
| M7 | Approved-only | 494 deduction rows, **all** `approved`, 0 violations |
| M8 | Transaction # is text | JSON type `string`, 155 leading-zero rows, e.g. `00496` |
| M9 | Reversals hidden | 52 reversal-pair rows in ledger, **0** shown |
| M10 | Per-employee independence | 0 broken chains, 0 cross-employee continuations |
| M11 | Pre-period history | first in-window row opened at **−₹12,825**, not 0 |
| M12 | Windowed vs full closing balance | 218 events compared, **0** differ |
| M13 | **Five-employee Balance Ledger parity** | 1,624 vs 1,624 events, **0** only-in-ledger, **0** only-in-report |
| M14 | Pagination independence, >1000 rows | 12,917 assembled over 350 pages of 37, 12,917 distinct ids, 0 lost/duplicated |
| M15 | Single vs all-employees mode | 69 = 69 rows, 0 differences |
| M16 | Custom fields | 494 expense rows populated; 0 balance rows carry custom fields or a txn # |
| M17 | Human labels | no raw internal string leaked |

### Performance (spec §29)

Set-based: **one RPC per page** over every requested employee, never one per
employee. Measured on Production data inside the rolled-back dry run, so live
traffic was never loaded:

| Path | Page size | Time |
| --- | --- | --- |
| Single employee, full timeline, with total | 250 | **274 ms** |
| All employees, page 1, with total | 250 | **504 ms** |
| All employees, a deep page (cursor near the end) | 250 | **143 ms** |
| **Full all-employees worker run** | 250 | **12,917 rows · 52 pages · 13.09 s · mean 252 ms/page** |

Comfortably inside the worker's soft deadline, and no N+1 anywhere: employee
count does not change the number of round trips.

**Balance Ledger UI path — honest regression note.** Rewiring
`_balance_unified_timeline_v3` onto the shared helper costs a little, because
the planner no longer inlines the event CTEs quite as aggressively:

| | 25-row page, mean of 20 runs |
| --- | --- |
| previously live body | 5.3 ms |
| rewired body | 9.2 ms |
| delta | **+3.9 ms** |

That is a ~74 % relative increase on a figure that is single-digit
milliseconds either way, on a paginated UI request. It was accepted knowingly:
the alternative is keeping two copies of the accounting logic, which is the
exact failure mode this change exists to remove. Flagged so it is a decision
on the record rather than a surprise later.

### Still to run (needs the migration applied)

- §25 single-employee E2E through the real worker
- §26 all-employees E2E through the real worker
- §24 edge-function deployment

---

## 9. No financial mutation (spec §21)

Fingerprints captured before and after every step of this work:

| | value |
| --- | --- |
| `profiles` | 488 rows, Σ ₹21,787,381.38, md5 `ea818fe1fbfc035c043945d4c49fb8fa` |
| `balance_ledger` | 287 rows, md5 `2f2caac30b60d641dd91e235b959ca05` |
| `expense_balance_deductions` | 13,195 rows, md5 `4aa07ae39e6c6e0913928529a8b72012` |
| approved expenses | 16,927 |

Unchanged throughout. The only movement anywhere in the database during this
work was organic live user traffic (one new `submitted` expense, ₹150,
MicroLink) with zero ledger writes, zero deduction writes and zero approvals.

---

## 10. Outstanding — needs owner action

1. **Apply the migration to Production.** Blocked by the environment's
   permission classifier, not by any technical problem. Backup already taken
   and verified (§7).
2. **Deploy `run-report-export-job`** — deliberately **not** deployed. The new
   worker calls `report_balance_timeline_rows_v3`; deploying it before the
   migration is applied would break Detailed Expense in Production. Migration
   first, then deploy.
3. Run the §25/§26 E2E exports once 1 and 2 are done.
4. Decide on the `cash_transfer_history` question in §5.

---

## 11. Re-verification at merge time (2026-09-02, later same day)

Before merging to `main`, Production was re-checked read-only rather than
trusting this doc's own "outstanding" section (§10) — which turned out to be
stale:

- **Migration is live.** All four functions'
  `pg_get_functiondef` output matches the migration file exactly (confirmed
  via direct text comparison of `report_balance_timeline_rows_v3`, and by
  definition-length/md5 for all four); grants match the security contract in
  §7 exactly (`anon`/`authenticated` denied on the three internal functions,
  `service_role` granted; the two public V3 wrappers unchanged).
- **The worker is deployed.** `expenseReports.ts` and `index.ts` on the
  edge-functions container are byte-for-byte identical (md5) to this branch's
  files, with the pre-deploy versions preserved as
  `*.bak.20260902T090930Z` (this project's standard rollback convention).
- **Real E2E already ran successfully** against Production data: an
  all-employees export (12,917 rows, matching the pre-apply dry-run's own
  count exactly), a single-employee export (387 rows), and a date-windowed
  export (8,097 rows) — all `completed`, zero errors. Spot-checked the
  all-employees CSV directly: header matches §4's column contract, and a
  sample employee's rows showed sequential Debit-only expense deductions with
  Closing Balance decrementing exactly by each Debit, transaction numbers with
  leading zeros intact.
- **Approved-only re-confirmed live:** `expense_balance_deductions` joined to
  `expenses.status` is 100% `approved` (13,254/13,254 rows), independent of
  the dry-run M7 check in §8.

### `cash_transfer_history` — root-caused, not just re-flagged

§5's finding (395 rows, 0 linked into `balance_ledger` by `source_id`) is
correct as far as it went, but was re-audited to its actual mechanism rather
than left as an open question:

- Of the 395 rows, only **22** involve an employee as either party
  (`admin_to_employee` / `cashier_to_employee` / `employee_to_cashier`). The
  other **373** are cash-custody handoffs between staff roles — admin,
  cashier, engineer — moving float between the people who manage cash, not
  transactions on any individual employee's expense wallet.
- The write path was traced directly: the legacy, pre-ledger
  `accept_balance_transfer_offer` RPC (the same one already flagged in prior
  security work as unledgered and since revoked from public execution)
  performs a raw `UPDATE public.profiles SET balance = ...` on both the
  transferrer and recipient, then logs the event to `cash_transfer_history` —
  with **no** `balance_ledger` row at all. That is exactly why 0 rows link by
  `source_id`: there was never a ledger row to link to, not a key-naming
  mismatch. (The newer, ledger-integrated transfer RPCs — e.g.
  `cashier_return_money_to_admin_v2` — do write `balance_ledger` and
  `cash_transfer_history` together in one transaction, and those transfers
  already appear correctly in both the Balance Ledger and this report.)
- Because the V3 baseline reconstruction is
  `profiles.balance − Σ(balance_ledger.amount_delta)`, every one of these
  pre-ledger events is, by construction, already absorbed into each affected
  employee's or staff member's reconstructed carried-in balance. **Calculated
  balances are therefore provably correct.** The only gap is presentational:
  these 373 historical events do not appear as itemised line items in either
  the canonical Balance Ledger or this report, exactly as before this change.
- **Decision: no backfill.** All four conditions for proceeding without one
  are met: (1) canonical balances are correct by construction, (2) no money is
  double- or under-counted in the calculated totals, (3) Detailed Expense
  matches the Balance Ledger exactly (§8 M13), (4) the omission is a proven
  itemized-history limitation, not an accounting defect. A backfill was
  deliberately not attempted — it would itself require adjusting the baseline
  formula to avoid double-counting money that `profiles.balance` already
  reflects, which is a separate, more invasive change than this report fix and
  was out of scope here.

No SQL was replayed and no financial value was modified during this
re-verification — every check above was read-only.

---

## Revision log

| Date | Change | By |
| --- | --- | --- |
| 2026-09-02 | Created. Detailed Expense moved onto the canonical Additive V3 timeline via a shared SQL event constructor consumed by both the Balance Ledger and a new worker-only report RPC. Old backward-walk / flat-list architecture retired. Balance Ledger parity proven row-for-row against Production (266 employees, 13,430 rows, 0 differences, 0 positional mismatches) in a rolled-back transaction; 17-point Production test matrix green including five-employee ledger parity, >1000-row pagination independence and the pre-period carried-in-balance proof. 78 automated tests. Production backup taken and checksum-verified; migration apply and edge-function deploy blocked by the permission classifier and left for the owner. No financial value modified. Not merged. | Claude Code |
| 2026-09-02 | Renumbered DOC-115 → DOC-116 (collision with `main`'s independently-registered DOC-115, Review Expenses). Re-verified Production rather than trusting §10: the migration and worker deploy the doc had recorded as blocked/outstanding were found already live, byte-identical to branch source; real E2E report jobs had already completed successfully. Root-caused the `cash_transfer_history` question in §5 down to the actual legacy write path (direct `profiles.balance` mutation with no ledger row) — added §11 proving calculated balances are correct and documenting the itemized-history limitation. No backfill performed. Merged current `main` into the branch; merged the branch into `main`. | Claude Code |
