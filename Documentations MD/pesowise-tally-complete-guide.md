# PesoWise → TallyPrime: the complete guide

**Doc ID:** DOC-146  
**Status:** in progress  
**Last updated:** 2026-10-21  
**Owner / area:** Tally integration (architecture, operation, user manual, reuse)  

> This is the **only document** for the PesoWise → TallyPrime integration. Part A explains how the system works, Part B is the user manual, Part C is for whoever deploys and runs it, Part D explains how to reuse the design for another project, and Part E is the engineering log (what was built, found and fixed), Part F covers Sync from Tally, **Part G is the accountant's mapping reference**, and Part H covers deleted-expense corrections.

---

## 0) In one minute

**What it does.** An admin opens a PesoWise report, picks filters, clicks **Sync to Tally**. PesoWise reads the live data, maps employees and expense types to Tally ledgers, adds the amounts up, and delivers the result to TallyPrime through a small Windows program (the *connector*). Tally then shows the calculated **five-column report** and, for approved expenses, **Journal vouchers**. No Excel, no export, no import.

**What you see in Tally**

| Voucher Date (Tally) | Expense Ledger | Employe Ledger | Voucher ID | Total |
|---|---|---|---|---|

with a Grand Total. These five columns are exactly the accountant's workbook "Import Sheet" (the spelling "Employe" is the workbook's).

**Two directions.** *PesoWise → Tally* (this guide's Parts A-E): reports and expense vouchers. *Tally → PesoWise* (Part F): employee payments entered in Tally become employee balance credits. The second direction is separate code and tables and does not change the first.

**Four reports, one engine**

| Report | Shows aggregated rows | Creates vouchers |
|---|---|---|
| Detailed Expense | yes | **yes** (debit rows) |
| Claim Approval | yes | **yes**, only for expenses not already posted |
| Claim Verification | yes | never |
| Daily Project | yes | never |

---

# PART G: Accountant's mapping reference (start here if you are the accountant)

Everything the system creates or reads in TallyPrime, and exactly how each value is derived. The technical parts (A-F) explain how it works; this part tells you **what to expect in the books** and **what to confirm before using a real company**.

## G1) What appears in Tally

| What | Tally object | Where you see it | Touches the books? |
|---|---|---|---|
| Employee | Ledger `<name>-<employee code>` under **Sundry Debtors** | Chart of Accounts | yes (it is the employee advance account) |
| Expense category | Ledger (see G3) under **Indirect Expenses** | Chart of Accounts | yes |
| Approved expenses | **Journal** voucher, one per month and category | Day Book, Journal Register | yes |
| Report rows | Ledgers `PWT-…` in group **PesoWise Report Data** (under Suspense A/c), zero balance | Only feeds Gateway → PesoWise Reports | no (never carry an amount) |
| Employee payments typed in Tally | Voucher type **PESO Wise Payment** (Payment type; exact name is a setting) | Day Book | yes (you create these) |

All amounts are in the company currency. No GST, TDS, bill-wise allocations, cost centres or stock are created.

## G2) The two directions and the effect on the employee account

| Event | Tally entry | Employee ledger in Tally | Employee balance in PesoWise |
|---|---|---|---|
| Expense approved in PesoWise (synced to Tally) | **Dr** expense ledger, **Cr** employee ledger | advance reduced (Dr balance falls) | **decreases** (expense deduction) |
| Payment/advance to the employee (entered in Tally, synced to PesoWise) | **Dr** employee ledger, **Cr** cash or bank | advance increased (Dr balance rises) | **increases** (Balance/Tally Credit) |
| Refund from the employee (Cr on the employee ledger in a payment-type voucher) | n/a | n/a | **not imported**; reported as skipped |

So a **positive PesoWise balance corresponds to a Dr (advance outstanding) balance on that employee's Tally ledger**, provided both started from the same opening position and no other entries were posted outside these syncs.

## G3) Expense category → ledger map (PesoWise → Tally)

Default map (editable per organisation on **Admin → Tally connector → ledger mapping**). The serial is the last part of the Voucher ID.

| Serial | PesoWise expense type | Tally expense ledger |
|---|---|---|
| 1 | Travelling (Public and Private Transport) | Travelling Expenses |
| 2 | Material Purchase | Consumable Stores - URD |
| 3 | Other ( Xerox, Printing, Courier, Stationery & Medical ) **and** the spellings "Other ( Xerox, Printing, Courier & Stationery )" and "other" | Site Expenses |
| 4 | Laptop Rent | Rent Expenses - Equipment |
| 5 | Hotel/Guest House | Lodging Expenses |
| 6 | Petrol Expense (Bike and Car) | Conveyance Expenses |
| 7 | Local Manpower | Labour Charges Expenses-URD |
| 8 | Mobile Recharges | Telephone Expenses |
| 9 | Food | Travelling Expenses (shares ledger 1; separate voucher) |
| 10 | Incentive | Incentive Expenses |

Notes: the reference workbook spells serial 6's ledger "Conveyance Exepsnes"; the system uses the corrected "Conveyance Expenses". Ledgers that do not exist are created automatically. A category that is **not in this table** (including a blank one) is **never guessed**: that expense is left out and listed as "needs attention".

## G4) Employee ledger (both directions)

- Name = `<employee name>-<employee code>`, for example `Employee A-1234`. Parent group **Sundry Debtors** (configurable). Not bill-wise. Created automatically on the first expense voucher.
- **Matching a Tally ledger back to a PesoWise employee** (Tally → PesoWise): the text after the last hyphen is the employee code; it must match **exactly one active employee of the same organisation**, **and** the name before the hyphen must equal that employee's name (case and spacing ignored). Otherwise the payment is reported ("not matched" or "ambiguous"), never applied.

## G5) Expense voucher map (PesoWise → Tally)

| Voucher field | Value |
|---|---|
| Voucher type | **Journal** |
| Voucher date | **Last day of the month** of the expense date (the transaction's `effective_date` for Detailed Expense, trip start date for claims) |
| Voucher number | Tally auto-numbers Journals (1, 2, 3…) |
| **Voucher ID (reference)** | `PESO/<MM>/<serial>`, stored in the **narration** as `PWT PESO/08/02`. Later postings into an already-used month and serial get `-S1`, `-S2` |
| Debit line | the expense ledger, amount = total of all employees in the voucher |
| Credit lines | one per employee ledger, amount = that employee's total for the month and category |
| Grouping | one voucher per (month, category serial); all employees of that category share it |
| Amount | sum of the amounts, exact to 2 decimals |
| Which rows | **Detailed Expense**: expense deductions with a debit above zero (credits and opening balances are skipped). **Claim Approval**: claims that are approved and HO-approved. **Claim Verification** and **Daily Project** never create vouchers |
| Posted once | each PesoWise expense is posted once ever, even if it appears in several reports or is synced again |
| Never changed by a later sync | a later *sync* never edits or deletes a posted voucher. The only automatic change is the deletion correction (Part H): when a synced expense is deleted in PesoWise, its entry is removed from the voucher |

Worked example (anonymised): five Material Purchase expenses of one employee in August 2026 (60 + 120 + 500 + 20 + 50 = **750.00**) become one Credit line of 750.00 on `Employee A-1234` inside the voucher dated **31-08-2026** with Dr **Consumable Stores - URD** and narration `PWT PESO/08/02`.

## G6) Employee payment map (Tally → PesoWise)

| Tally field | Becomes in PesoWise |
|---|---|
| Voucher type must equal the configured name (default `PesoWise Payment`; this company uses `PESO Wise Payment`) | accepted; any other type is ignored |
| **Dr** entry on the employee ledger, amount | **Balance credit** (+ amount) for that employee |
| Cr entries | must all be **Cash-in-Hand** or **Bank Accounts** ledgers; otherwise the voucher is skipped |
| Voucher date | effective date of the credit |
| Voucher number, GUID, narration | kept in the audit record; the number appears in the balance-history note |
| Several entries for the same employee in one voucher | summed into one payment |
| Several employees in one voucher | one payment each |

Skipped or flagged (never applied): cancelled or optional vouchers; unbalanced vouchers; amount zero or at or above 1,000,000,000; non-employee ledgers; vouchers whose narration starts with `PWT ` (they came from the expense sync); employees not matched. A voucher **edited** after import (amount changed or an employee added) or **cancelled/deleted** after import is **flagged for reconciliation**; its balance is not changed automatically.

Worked example: Payment voucher dated 16-Oct-2026, Dr `Employee A-1234` 500.00, Cr Cash 500.00 gives the employee a **+500.00** "Balance/Tally Credit" dated 16-Oct-2026, shown in the balance history and in Import History as a "Tally sync" batch (reversible there).

## G7) Reconciling the books to PesoWise

| Check | Where | Should equal |
|---|---|---|
| Expenses posted for a month | Tally Journal Register (voucher narration `PWT …`) | PesoWise Detailed Expense total for that month (the report in Tally also shows its Grand Total) |
| Voucher count | Day Book | one voucher per category per month (plus `-S` supplements) |
| Employee advance | Tally employee ledger closing (Dr) | PesoWise Current Balance, if the opening balances matched and nothing else was posted to that ledger |
| Payments imported | PesoWise Import History ("Tally sync" batches) | the PESO Wise Payment vouchers in the Day Book |
| Items needing review | Sync from Tally result list | nothing flagged, or each item explained |

## G8) Decisions the accountant must confirm before a real company

1. **Direction and type:** expenses as Journal Dr expense / Cr employee, and payments as Dr employee / Cr cash-bank.
2. **Dating:** expense vouchers dated at month-end (the reference workbook used one chosen date per run).
3. **Ledger names and groups:** the table in G3, the parent groups (Sundry Debtors, Indirect Expenses) and whether "Food" belongs with Travelling Expenses.
4. **"Other" variants:** that "other" and "Other ( Xerox, Printing, Courier & Stationery )" belong under Site Expenses.
5. **Voucher prefix** (`PESO`) and serial numbers, which become part of every reference.
6. **Voucher type name** used for payments and that its type is Payment.
7. **Financial year:** voucher dates must fall inside the Tally company's books.
8. **Cash/bank ledgers** are directly under Cash-in-Hand or Bank Accounts (a custom sub-group is skipped).

## G9) Where each mapping is changed

| Mapping | Where |
|---|---|
| Expense type → ledger, serial, voucher prefix | **Admin → Tally connector → Check the ledger mapping** (web) |
| Voucher type name for payments | **Balances → Sync from Tally → Tally voucher type** (web) |
| Debit/credit side, Journal type, parent groups, month-end vs fixed date | developer-only settings (not in the web screens yet); saving the web mapping resets these to the defaults above |
| Employee ledger name format and matching rule | fixed in the system |

---

# PART A: How the system works

## A1) Architecture

```
 PesoWise website (React)                          Supabase on your server (PesoWise project only)
 ┌────────────────────────┐   1 click    ┌───────────────────────────────────────────────────────┐
 │ Reports page           │ ───────────▶ │ edge fn  pwt-start-sync   (checks admin, creates job) │
 │  "Sync to Tally"       │              │      │ hands job to                                   │
 │ /admin/pwtally  setup  │              │ edge fn  pwt-run-job      (worker)                    │
 └──────────▲─────────────┘              │   1 read full report (existing report RPCs, paginated) │
            │ status / history           │   2 map + aggregate (shared engine _shared/pwt)        │
            │ (admin RPCs)               │   3 build XML batches, reserve registry                │
            │                            │ Postgres: pwt_* tables  (jobs, batches, registry, …)  │
            │                            └───────────────▲───────────────────────────────────────┘
            │                                            │ HTTPS, outbound only, device token
            │                            edge fn  pwt-connector  (pair / heartbeat / claim / ack)
            │                                            │
 ┌──────────┴─────────────────────────────────────────────┴─────────────┐
 │ Tally PC:  PesoWiseTally.exe (connector, runs hidden at sign-in)       │
 │   checks the ACTIVE company == the paired company                      │
 │   POSTs XML to TallyPrime at http://127.0.0.1:9000 (local only)        │
 │   reads it back from Tally, confirms counts and totals                 │
 └───────────────────────────────┬─────────────────────────────────────┘
                                 ▼
                    TallyPrime  (company "…" )
                      • Journal vouchers  → Day Book
                      • report-row ledgers in group "PesoWise Report Data" → PesoWise Reports (TDL)
```

Design rules that hold everywhere:

1. **The server never connects into the customer's PC.** The connector only makes outbound HTTPS calls. The Tally port is never exposed.
2. **Job states are separate:** *created → preparing → delivering → completed*. **Completed is set only after Tally itself confirms every item (readback)**, never because an HTTP call succeeded.
3. **One engine, four reports.** All four reports go through the same mapping and aggregation code.
4. **Idempotent everywhere.** Retries, double clicks and overlapping reports never create a second voucher.
5. **Never guess.** A row that cannot be mapped is left out and shown to the user with the reason.

## A2) Where everything lives (file map)

| Area | Path | Purpose |
|---|---|---|
| Engine (pure TypeScript) | `supabase/functions/_shared/pwt/` | `types`, `util`, `config`, `canonical`, `aggregate`, `xml`, `reportRows`, `prepare`, `fetchRows` |
| Edge functions | `supabase/functions/pwt-start-sync`, `pwt-run-job`, `pwt-connector` | entry point, worker, connector API |
| Database | `supabase/migrations/20261016120000_pwt_foundation.sql`, `…130000_pwt_config_rpcs.sql` | tables and `pwt_*_v1` functions |
| Connector | `connector/pwtally/src/{engine,runtime,main}.ts` | batch engine, HTTP, CLI (`pair`, `run`, `doctor`, `install-startup`) |
| Connector build | `connector/pwtally/scripts/{build,gen-tdl,build-installer}.mjs` | EXE, TDL generator, installer |
| Installer script | `connector/pwtally/installer/install.ps1` | one-click setup (no admin rights) |
| TDL (generated) | `connector/pwtally/tdl/PesoWise-Tally.tdl` | the four Tally reports |
| Website | `src/lib/pwt/pwtSync.ts`, `src/components/PwtSyncControl.tsx`, `src/pages/AdminPwTally.tsx` | Sync control, setup page, mapping editor |
| Reverse sync (Tally → PesoWise balances) | see Part F | `pwt-inbound`, `connector/pwtally/src/inbound.ts`, `SyncFromTallyDialog.tsx` |
| Switch | `VITE_PWT_SYNC=1` | shows the new Sync control instead of the legacy one |

The integration is self-contained: every database object is prefixed `pwt_` and no other Tally code is needed.

## A3) The sync, step by step

1. **Click.** The Sync control sends the report type, organisation and the same filters the report uses to `pwt-start-sync`.
2. **Job.** `pwt_create_job_v1` checks the caller is an admin of that organisation, requires a paired connector, and creates a job. An identical job that is still running is returned instead (double-click safe).
3. **Worker** (`pwt-run-job`), job state *preparing*:
   - reads the **whole** report, page by page (see A4), stores an immutable snapshot (`pwt_job_rows`);
   - normalises rows, applies the mapping, aggregates (A5);
   - asks the registry which expenses are already posted (A6);
   - builds XML **batches** in a strict order: *masters* (missing ledgers) → *report rows* (what the TDL shows) → *vouchers*; reserves the new expenses in the registry; state becomes *delivering*.
4. **Connector** polls `pwt-connector` every ~10 s while the paired company is active in Tally. For each batch it:
   - re-checks the active company (wrong company ⇒ writes nothing);
   - reads Tally first (what already exists), imports only what is missing;
   - **reads back** and reconciles: every ledger present, every voucher present once, balanced, with the right total;
   - sends `ack verified` (or a retry/permanent-failure message).
5. **Completion.** When the last batch is verified, the registry rows become *posted* and the job becomes **Completed** (or **Needs attention** if some rows were excluded).
6. **Display.** The website polls the job and shows Queued → Preparing → Delivering → Completed / Needs attention / Failed, with plain-language messages and a history list.

Status meanings:

| Status | Meaning |
|---|---|
| Queued / Preparing | PesoWise is reading and calculating. |
| Delivering | Ready; waiting for or running through the connector. If the connector is offline the page says so. |
| **Completed** | Tally confirmed everything. |
| Needs attention | Some rows were excluded (see A5 issues) or delivery failed permanently. The message says why. |
| Failed | Stopped before delivery (for example the report could not be read completely). |

## A4) Data fetching

The worker reuses the website's own report functions, read-only, so Sync sees exactly what the report shows:

| Report | Database function | Rows are |
|---|---|---|
| Detailed Expense | `report_detailed_expense_rows_v4` | balance-timeline events; expense deductions are the postable ones |
| Claim Verification / Claim Approval | `report_expense_rows_v1` (statuses `verified, level_1_verified, level_2_verified` / `approved`) | one row per claim |
| Daily Project | `report_daily_project_rows_v1` (+ `organization_settings.daily_expense_report_config`) | one row per employee/day/project with cost columns |

Filters passed through unchanged: date range or year/month/week, employee, category, engineer/HO status, custom-field filters. Deleted claims are dropped (`pwt_expense_meta_v1`).

**Never truncates:** pages are walked with a cursor; if the rows read differ from the reported total, the job fails instead of syncing a partial report.

## A5) Calculation: mapping, aggregation, dates, voucher IDs

Reference: the accountant's workbook, *Original Data → Base Data for Working → Pivot → Import Sheet*. Only the **method** is used; no historical data.

**Mapping** (`aggregate.ts`, `config.ts`)
- **Employe Ledger** = `"<employee name>-<employee code>"` (`employeeLedgerName`). Ledgers not in Tally are created under *Sundry Debtors*.
- **Expense Ledger** = the Tally ledger configured for the PesoWise expense type (`findCategory`: case/space-insensitive match on the type or its aliases). Missing ledgers are created under *Indirect Expenses*.
- Each category has a **serial** (1–99) used in the Voucher ID. Default rules (editable per organisation):

| PesoWise expense type | Tally expense ledger | Serial |
|---|---|---|
| Travelling (Public and Private Transport) | Travelling Expenses | 1 |
| Material Purchase | Consumable Stores - URD | 2 |
| Other ( Xerox, Printing, Courier, Stationery & Medical ) (+ aliases "Other ( Xerox, Printing, Courier & Stationery )", "other") | Site Expenses | 3 |
| Laptop Rent | Rent Expenses - Equipment | 4 |
| Hotel/Guest House | Lodging Expenses | 5 |
| Petrol Expense (Bike and Car) | Conveyance Expenses | 6 |
| Local Manpower | Labour Charges Expenses-URD | 7 |
| Mobile Recharges | Telephone Expenses | 8 |
| Food | Travelling Expenses | 9 |
| Incentive | Incentive Expenses | 10 |

**Aggregation** (`planView` for display, `planPosting` for vouchers)
- Group key = **voucher date × expense ledger (serial) × employee ledger**.
- **Total** = sum of the amounts in the group, in exact 2-decimal arithmetic. Many transactions become one row.
- **Voucher date (Tally)** = last day of the month of the transaction date (`monthEnd`); can be fixed per organisation.
- **Voucher ID** = `<prefix>/<MM>/<serial>`, e.g. `PESO/08/02`. All rows with the same date and serial belong to one Journal voucher. A later posting into an already-used period/serial gets `-S1`, `-S2`, … so IDs never collide.

**Amount and date per report**

| Report | Amount | Date | Rows used |
|---|---|---|---|
| Detailed Expense | `debit` | `effective_date` | `expense_deduction` events with debit > 0 (credits, opening balances are skipped) |
| Claim Approval | `total_amount` | `trip_start` | approved + HO approved |
| Claim Verification | `total_amount` | `trip_start` | verified (display only) |
| Daily Project | cost columns (petrol, material, travelling, phone, hotel, food mapped to types) | `track_date` | display only; any other non-zero cost column is reported, not guessed |

**Voucher shape.** One **Journal** voucher per (date, serial): the expense ledger is **debited** with the total and each employee ledger is **credited** with their amount. (This follows the workbook's "sum of Debit" against the employee advance and is configurable via `expenseSide`; the customer's accountant must confirm it.)

**Rows that are left out and reported (never guessed)**

| Code | Cause |
|---|---|
| UNMAPPED_EXPENSE_TYPE | expense type has no ledger (including a blank category) |
| MISSING_EMPLOYEE_ID | no employee code |
| NON_POSITIVE_AMOUNT | amount zero, negative or not a number |
| BAD_DATE | date missing or invalid |
| BAD_ROW | an expense row without any identity |
| AMOUNT_MISMATCH | already posted with a different amount; **not** re-posted or altered |

**Worked example** (real August 2026 Detailed Expense rows of one employee; name and ID masked)

| Txn | Employee | Category | Date | Debit |
|---|---|---|---|---|
| 10005 | A. P. (…80) | Material Purchase | 07-08-2026 | 60 |
| 10950 | A. P. | Material Purchase | 11-08-2026 | 120 |
| 12909 | A. P. | Material Purchase | 18-08-2026 | 500 |
| 13614 | A. P. | Material Purchase | 19-08-2026 | 20 |
| 13615 | A. P. | Material Purchase | 19-08-2026 | 50 |

Category → rule serial 2, ledger *Consumable Stores - URD*; all five fall in August ⇒ date 31-08-2026; one group; total 60+120+500+20+50 = **750.00** ⇒

| Voucher Date (Tally) | Expense Ledger | Employe Ledger | Voucher ID | Total |
|---|---|---|---|---|
| 31-08-2026 | Consumable Stores - URD | A. P.-**80 | PESO/08/02 | 750.00 |

## A6) Duplicate prevention

- Every expense has a stable id `"<org>:expense:<expense id>"`, identical in Detailed Expense and Claim Approval.
- Table `pwt_registry (organization_id, source_id)` is unique. At prepare time the new expenses are **reserved** (a second job reserving the same id fails and re-plans). They become **posted** only after verified delivery; a failed job releases its reservations unless the voucher was already verified.
- The connector also reads Tally before importing, so a crash after the import never re-creates a voucher.
- Result: syncing twice, syncing two overlapping reports, or retrying never doubles anything. After Detailed posts 4,263 expenses, Claim Approval for the same range plans **0** vouchers.
- A posted voucher is **never** changed or deleted by a later sync, even if the PesoWise amount changes (that is flagged as AMOUNT_MISMATCH). Corrections are made manually in Tally.

## A7) What stays and what is replaced in Tally

| Data | After a new sync |
|---|---|
| **Vouchers** (Day Book, ledgers, trial balance) | **Kept.** Only new expenses add vouchers. |
| **PesoWise Reports (TDL) rows** | **Replaced for that report**: each report shows exactly its latest sync's selection. Other reports keep their own. |

Example: sync August then July ⇒ the Day Book holds both months; the Detailed Expense report shows July. To see several months in one report, sync one wider range.

## A8) How the reports are stored in Tally and displayed

- Each aggregated row is one **ledger** in the group **PesoWise Report Data** (parent *Suspense A/c*, zero balance, outside accounting). A UDF `PWTCELLS` holds one flat pipe-delimited string (date for sorting, display date, expense ledger, employee ledger, voucher id, total text, total number); `PWTREPORT` names the report.
- Ledger name = `PWT-<DP|DE|CV|CA>-<row key hash>-<content hash>`: unchanged rows are not re-created.
- Every sync ends with a **keep-list prune**: ledgers of that report that are not in the snapshot are deleted, so the display is exact.
- The TDL (generated by `gen-tdl.mjs`) adds **Gateway of Tally → PesoWise Reports** with the four reports: company name, title, row count, a bordered grid with exactly five columns (percent widths, Total right-aligned), rows sorted by date, and a **Grand Total**.
- Because Tally auto-numbers Journal vouchers, the stable Voucher ID lives in each voucher's **narration** (`PWT PESO/08/02`), and readback matches on it.

## A9) Security model

- Tables are RLS-protected with **no browser policies**; the website only calls `SECURITY DEFINER` functions that check `pwt_org_admin_v1(org)` (an active membership with role *admin*).
- The connector authenticates with a **device token** issued once at pairing (only its SHA-256 is stored); an admin can revoke it.
- Pairing codes are single-use and expire in 15 minutes.
- **Wrong-company protection** in two places: the server hands out work only when the connector reports the paired company as active, and the connector re-checks before writing.
- Only the public API key and URL are embedded in the installer; no secrets.
- The edge functions use the service role only on the server.

---

# PART B: User manual

## B1) What you need

- A Windows PC where **TallyPrime** runs.
- A PesoWise **admin** login.
- The **exact** name of the Tally company that will receive the data.
- Your accountant (once) to confirm the ledger names.

## B2) One-time setup

Everything is on **Admin → Tally connector** (`/admin/pwtally`, also linked under Sync to Tally on any report).

1. **Download** `PesoWise-Tally-Setup.exe` and `PesoWise-Tally.tdl` on that page, onto the Tally PC.
2. **Prepare TallyPrime**
   1. Open the company that should receive the data.
   2. **F1 (Help) → Settings → Connectivity → Client/Server configuration**: enable the local port (default 9000).
   3. **F1 → Settings → Product & Features → Manage Local TDLs**: set "Load TDL files on startup" to Yes and add the path of `PesoWise-Tally.tdl` (the installer copies it to `%LOCALAPPDATA%\Programs\PesoWiseTally`).
   4. Close TallyPrime completely, reopen it and the company. **Gateway of Tally → PesoWise Reports** now exists.
3. **Pair**: on the page type the exact company name and click **Generate pairing code** (valid 15 minutes, one use).
4. **Run the installer** on the Tally PC, enter the code. No admin rights needed. If Windows SmartScreen warns about an unknown publisher: *More info → Run anyway*. The last message must say **Connector is RUNNING**. If you run it again later it asks "already paired": **Yes** = pair again with a new code, **No** = keep the pairing and just restart the connector.
5. **Check the mapping** (same page, step 4): confirm each expense type → Tally ledger with your accountant, add missing types (types from recent syncs that could not be mapped appear as buttons), click **Save mapping**.

Setup is complete when the page shows the connector **Online** with no "wrong company" warning.

## B3) Every day

1. PesoWise → **Reports** → choose a report and filters as usual.
2. Click **Sync to Tally** and watch Queued → Preparing → Delivering → **Completed**.
3. In Tally: **Gateway of Tally → PesoWise Reports → (your report)**.

Keep TallyPrime open on the paired company. If Tally is closed, the sync waits and finishes by itself when Tally is back; no second click.

## B4) How to check that it works (and that nothing is lost)

1. **Day Book** (Gateway → Day Book, **Alt+F2** period = whole year): Journal vouchers dated month-end, narration `PWT PESO/MM/NN`.
2. **Journal Register** (Gateway → Display More Reports → Account Books → Journal Register): note the total.
3. Sync another month; Day Book keeps the old vouchers and adds the new ones; the register total rises by the new month only.
4. Sync the same range again; voucher count and total do not change.
5. The PesoWise Report in Tally shows the latest sync only; its **Grand Total** equals the report's total in PesoWise for those filters.

## B5) Troubleshooting

| What you see | What to do |
|---|---|
| Sync stays at **Delivering**; page says connector offline | The connector is not running. Sign in on the Tally PC (it starts at sign-in) or run the installer again (choose **No** at the paired prompt). |
| "Tally is on a different company" | Open the paired company in TallyPrime. Nothing is written to other companies. |
| "TallyPrime is not running or its port is off" | Start TallyPrime; check Client/Server configuration. |
| **Needs attention**: "expense type … has no ledger mapping" | Add the type on the Tally connector page (button), save, sync again. A **blank** category must be fixed in PesoWise. |
| **PesoWise Reports** menu missing | Re-check Manage Local TDLs and restart TallyPrime. |
| Report empty in Tally | Sync first, then reopen the report. |
| Voucher date rejected | The date is outside the company's financial year. |
| Downloaded installer "corrupted and unreadable" | The site served an HTML page instead of the file (dev server started before the file existed). Restart the dev server and download again; the file should be ~11 MB. |

## B6) Changing things

- **New category:** add it in the mapping, save, sync.
- **Another company or PC:** generate a new pairing code and run the installer there; revoke the old connector on the page.
- **Changing a ledger name or serial after posting:** old vouchers keep their old values. Ask your accountant first.
- **Correcting a posted voucher:** do it manually in Tally; syncs never edit or delete vouchers.
- **Uninstall:** `PesoWiseTally.exe uninstall-startup`, delete `%LOCALAPPDATA%\Programs\PesoWiseTally` and `%LOCALAPPDATA%\PesoWise`, revoke the connector in PesoWise.

---

# PART C: For the person deploying and operating it

## C1) Deploy checklist (self-hosted Supabase on Coolify, as done for PesoWise)

1. **Migrations**, in order, to the project's own database only: `20261016120000_pwt_foundation.sql`, `20261016130000_pwt_config_rpcs.sql`, then `NOTIFY pgrst, 'reload schema'`. Both are additive. They need the tables `organization_memberships` and `expenses` and the report functions listed in A4.
2. **Edge functions**: copy `pwt-start-sync`, `pwt-run-job`, `pwt-connector` and `_shared/pwt` into the project's **edge-runtime container** (`/home/deno/functions`). The Coolify volume is root-owned, so stream a tar through the container: `tar -cf - --exclude=__tests__ pwt-start-sync pwt-run-job pwt-connector _shared/pwt | ssh <host> 'docker exec -i <edge container> tar -xf - -C /home/deno/functions'`. No restart is needed. `VERIFY_JWT` must be `false` (the connector uses its own device token). Check: each function returns `401` when called without credentials.
3. **Website**: set `VITE_PWT_SYNC=1` and rebuild/redeploy.
4. **Installer**: `PWT_API_BASE=https://<supabase host> node connector/pwtally/scripts/build-installer.mjs` after `build.mjs` and `gen-tdl.mjs`. It embeds only that URL and the publishable key and writes the EXE and TDL to `public/downloads/` (git-ignored; host them on your CDN or storage in production and keep the links on the setup page).
5. **First customer**: the admin follows Part B; nothing else to configure per customer (pairing and mapping are self-service).

Isolation rule used here: on a shared server only the project's own containers and database are touched (`supabase-db-<id>`, `supabase-edge-functions-<id>`), and all data reads during development were read-only.

## C2) Test commands

```
npx vitest run supabase/functions/_shared/pwt connector/pwtally src/lib/pwt
npx tsc -p connector/pwtally/tsconfig.json
npx tsc --noEmit --strict --target es2022 --module esnext --moduleResolution bundler --allowImportingTsExtensions --skipLibCheck --lib es2022,dom supabase/functions/_shared/pwt/index.ts
```

## C3) Evidence (2026-10)

- 54 engine / connector / client tests; existing panel suite 48/48 unchanged; migration lifecycle 20/20 and config RPCs 14/14 in an isolated Postgres.
- Live August 2026 data (MicroLink organisation), per report, aggregated total = independent source total:

| Report | Source lines | Five-column rows | Aggregated total | Independent source total |
|---|---|---|---|---|
| Detailed Expense | 4,263 | 267 | 902,537.56 | 902,537.56 |
| Claim Approval | 4,263 | 267 | 902,537.56 | 902,537.56 |
| Claim Verification | 2,341 | 210 | 605,777.07 | 605,777.07 |
| Daily Project (mapped cost columns) | 8,340 | 227 | 874,513.56 | 874,513.56 |

- July 2026 Detailed Expense: 8,323 lines → 435 rows, total 19,45,987.71 (equal to the source sum).
- Real TallyPrime: vouchers balanced, no duplicates across Detailed/Claim Approval, Day Book keeps older months after a later sync; July supplementary posting (`-S1`) added only the newly mapped rows (July total 19,45,987.71 matches).

## C4) Known limits

- The Dr/Cr direction, *Journal* voucher type and month-end dating come from the reference workbook; each customer's accountant must confirm them.
- The mapping editor covers categories, prefix and (via API) voucher side/type; there is no Tally-side filtering (filters are chosen in PesoWise).
- Installer is unsigned (SmartScreen warning); the one-click installer has been verified on the development PC only.
- A report in Tally shows one sync's selection at a time (by design).
- A blank category cannot be posted until it is fixed in PesoWise.

---

# PART D: Reusing this for another project

## D1) What is generic and what is project-specific

| Layer | Reuse as is? | Notes |
|---|---|---|
| Job and batch pipeline (`pwt_sync_jobs`, `pwt_batches`, claim/ack, retries, leases, statuses) | **Yes** | Rename the `pwt_` prefix if you want one namespace per product. |
| Registry (duplicate prevention) | **Yes** | Only the `source_id` format is yours. |
| Connector (pairing, active-company lock, import, readback, offline handling, startup, installer) | **Yes** | Only the API base URL changes. |
| Tally XML builders, response parsers, reconciliation (`xml.ts`, `reportRows.ts`) | **Yes** | Generic to TallyPrime. |
| TDL generator | **Yes** | Edit the column list in `gen-tdl.mjs`. |
| Setup page, mapping editor, Sync control | Mostly | Text and the mapping fields. |
| **Data fetching** (`fetchRows.ts`) | **No** | Replace with your data source. |
| **Normalisation** (`canonical.ts`) | **No** | Map your rows to the canonical transaction. |
| **Mapping config** (`config.ts`) | **No** | Your categories, ledgers, prefix. |
| Posting eligibility (`isPostable`) | Review | Your approval rules. |

## D2) The only contract you must implement

`CanonicalTxn` (in `types.ts`):

```
sourceId        stable, unique id of the source transaction, same everywhere it appears
employeeId, employeeName     -> party ledger name
expenseType     -> looked up in the mapping
amount          positive number
billDate        ISO yyyy-mm-dd
origin          which report/source it came from
status, hoApproved, isLedgerDebit   -> used only by your isPostable rule
```

Everything after this (aggregation, voucher ids, XML, delivery, registry, readback, TDL) is unchanged.

## D3) Porting checklist

1. **Decide the report output.** Keep the five columns, or edit `FIVE_COLUMNS` and the token layout in `reportRows.ts` and `gen-tdl.mjs` together.
2. **Write the fetcher** for your source (paginated, with a completeness check like `fetchReportRows`).
3. **Write `normalizeRow`** for each of your reports; decide which rows may post (`isPostable`) and which are display-only.
4. **Set the mapping** (`DEFAULT_PWT_CONFIG` or the per-organisation table): your categories, ledgers, serials, voucher prefix, voucher type, Dr/Cr side, date policy (`month_end` or `fixed`).
5. **Get the accounting rules signed off** by the accountant before any real company.
6. **Authorisation**: point `pwt_assert_admin_v1` at your own admin check.
7. **Run the same deploy checklist** (Part C) and the same tests; add tests for your normalisers (see `pwt.test.ts`).
8. **Test in an empty Tally demo company first**, then reconcile: aggregated total must equal an independent sum of the source rows (the dry-run script pattern used here), then check Day Book, duplicates, offline and wrong-company behaviour.
9. **Customer docs**: copy Part B and change the names.

If your target is not Tally, keep the pipeline (jobs, registry, connector loop, reconciliation) and replace `xml.ts`, `reportRows.ts`, the TDL and the engine's `TallyIO` implementation with that system's API.

## D4) Lessons learned from real TallyPrime (avoid repeating them)

| Lesson | What to do |
|---|---|
| An inline-report probe for the active company returned an empty reply | Use a Company collection with `COMPUTE PWTCurCo:$$CurrentCompany`. |
| Journal vouchers are auto-numbered, so your voucher number is ignored | Put the stable id in the **narration** and match readback on it. |
| Real XML has type attributes (`<DATE TYPE="Date">`, `<AMOUNT TYPE="Amount">`) | Parsers must accept attributes. Test against real Tally output, not hand-written XML. |
| A clean import response does not prove the data is there | Always read back; treat duplicates as an error. |
| `$$CollCount:` / `$$CollNumTotal:` fail on collection names with spaces | Use space-free collection names. |
| TDL crashed Tally when evaluating large JSON | Store a flat string and read tokens. |
| `Child Of` on a Ledger collection returned zero rows in TallyPrime 7 | Filter a global Ledger collection by a UDF. |
| Squeezed text in a wide report | Use percent-of-page widths and only the columns you need. |
| Task Scheduler logon tasks need admin | Use the `HKCU\…\Run` key. |
| A packaged (pkg) exe cannot start a copy of itself | Start the connector from the installer script (outside the exe). |
| Vite dev server ignores files added to `public/downloads` after start | Restart it; production builds are fine. |

---

# PART F: Tally → PesoWise: Sync from Tally (employee payments → balances)

## F1) What it does

An accountant saves a voucher of the Tally type **PesoWise Payment** (Dr employee ledger, Cr cash or bank). In PesoWise, an admin opens **Balances → Sync from Tally**. The connector reads those vouchers from the paired company; the database validates them, finds each employee, and adds the amount to that employee's balance **through the existing balance engine**. The Current Balance column and the employee's balance history update, and Import History shows a "Tally sync" batch.

## F2) Direction rule (taken from the existing accounting, not assumed)

| Meaning in PesoWise | Effect on Current Balance |
|---|---|
| Credit: money advanced to the employee (cash transfer, bank transfer, manual add, Tally credit) | increases |
| Deduction: an approved expense | decreases |

Tally side: **Dr on the employee ledger** (a Payment voucher: Dr employee, Cr cash/bank) means money paid to the employee, so it is a PesoWise **credit**. This matches the existing "Import from Tally", which treats a Tally debit on the employee ledger as a Balance Credit. A **Cr** on an employee ledger is a refund and is **never imported** (skipped and reported). The PesoWise → Tally sync posts expenses as Cr on the employee ledger, so the two directions are consistent.

## F3) How a payment is recorded

`_balance_apply_credit_core_v3` (the same function the existing Tally/file imports use) with kind `balance_credit`: it locks the profile row, adds the amount, and writes an immutable `balance_ledger` row ("Balance/Tally Credit", dated the voucher date, note "Tally payment voucher N (company)"). Nothing writes `profiles.balance` directly and there is no second balance engine. Each sync that imports something also creates one `balance_import_batches` row (mode `balance_credit`, "Tally sync: <company> <time>") with one row per payment, so it appears in **Import History** and can be reversed there with the existing reversal.

## F4) Flow

```
Balances page → "Sync from Tally"
  → pwt-inbound (start): admin check, creates job (needs a paired connector)
  → connector (polls every ~10 s when no outbound work is pending): verifies the ACTIVE company is the paired one,
    reads ledger parents and all vouchers of the exact type, uploads in chunks of 100 (idempotent), then "finish"
  → database (one transaction, per-payment sub-transactions): validate → match employee → dedupe → credit → audit
  → page: progress, result tiles, reasons for anything not imported; the balances table reloads once
```

## F5) Rules applied to every voucher (checked again in the database; the connector is not trusted)

| Check | Result if it fails |
|---|---|
| Type equals the organisation's configured exact name (default `PesoWise Payment`) | skipped |
| Narration starts with `PWT ` (created by the PesoWise → Tally sync) | skipped (prevents loops) |
| Cancelled or optional voucher; invalid date | skipped |
| Debits equal credits, and every credit is a cash/bank ledger (parent Cash-in-Hand / Bank Accounts) | skipped |
| Ledger is not "name-code", or amount is zero/negative/at or above 1,000,000,000 | skipped / failed with reason |
| Employee: code matches exactly one **active** employee of this organisation **and** the ledger name equals that employee's name (case/space-insensitive) | otherwise reported as *not matched* or *ambiguous*; never guessed, never another organisation |

Several entries for the same employee ledger in one voucher are summed. A voucher with several employees creates one payment per employee.

## F6) Duplicates, edits and deletes

- **Identity:** company + voucher GUID + employee ledger, unique in `pwt_inbound_payments`. The ledger entry also carries the idempotency key `tally:<company>:<guid>:<ledger>` (unique per organisation), so even a lost registry row cannot double-credit.
- Clicking Sync again, connector retries, repeated chunks and a crash in the middle are all safe. A failed payment does not block the others.
- **Edited after import** (an imported entry's amount changed or disappeared, or a new employee entry was added): flagged *changed after import*; the balance is not touched. **Cancelled** after import: flagged. **Deleted** in Tally: flagged *deleted in Tally* (only when the fetch was complete); the credit is **not** reversed automatically. Reverse it deliberately in Import History if needed. An identical voucher that reappears clears its flag.
- An entry that was skipped, unmatched or failed earlier is not an "edit" and is retried on later syncs (for example after the employee is added).

## F7) Setup (once per Tally company)

1. The voucher type **PesoWise Payment** (type of voucher: Payment) is **created automatically** in the paired company by the connector (version 1.2.0 and later) when it is missing; nothing is created by hand. The backend sends the organisation's configured name in the connector's regular check-in; an existing voucher type is never changed, and nothing is written unless the paired company is the one open in Tally.
2. Enter a payment: voucher type PesoWise Payment; the cash/bank ledger on the credit side; the employee ledger (named `<name>-<employee code>`, as created by the expense sync) on the debit side; amount; date.
3. The exact type name is an organisation setting: **Balances → Sync from Tally → Tally voucher type (exact name)**. Change it there if the company uses a different spelling.

## F8) Where it lives

| Area | Path |
|---|---|
| Migration (separate tables, calls the existing engine) | `supabase/migrations/20261017100000_pwt_inbound_payments.sql`: `pwt_inbound_jobs / vouchers / payments / settings`, `pwt_inbound_*_v1`, `_pwt_inbound_process_v1` |
| Edge function | `supabase/functions/pwt-inbound` (start, claim, submit, finish) |
| Connector | `connector/pwtally/src/inbound.ts` (read-only fetch and parse), loop hook in `main.ts` |
| Website | `src/lib/pwt/pwtInbound.ts`, `src/components/balances/SyncFromTallyDialog.tsx`, button in `src/pages/Balances.tsx` (shown when `VITE_PWT_SYNC=1`) |
| Tests | `supabase/tests/pwt_inbound/inbound_acceptance.mjs` (47 checks against the real balance migrations), connector and client tests |

## F9) Deployment

Apply the migration to the project's database, deploy `pwt-inbound` next to the other `pwt-*` functions, upgrade the connector EXE (older connectors keep working; they simply never poll for reverse-sync jobs). The existing functions and tables are not modified.

## F10) Known limits

- The cash/bank check uses the ledger's immediate parent group (Cash-in-Hand, Bank Accounts); a custom sub-group under Bank Accounts is skipped with a reason.
- Edited or deleted vouchers are flagged, not auto-corrected; there is no in-app "resolve" action yet.
- Only the voucher type configured for the organisation is read; Receipt-type refunds are not imported.

## F-extra) Balance credit history (Balances → Transfer History)

Admins now see a **Balance credit history** card under the transfer table on **Balances → Transfer History**. It lists every balance credit from the immutable balance ledger (opening credits, balance credits and their reversals) with a **Source** label: **Manual entry** (typed by an admin), **Tally sync** (imported by Sync from Tally; recognised by its `tally:` idempotency key) or **Import** (file import), plus employee, amount, date, who entered it and the note. It can be filtered by source and searched by employee or note, and is read-only: it never changes a balance. Files: `src/components/balances/BalanceCreditHistory.tsx` (+ test), mounted in `src/pages/Balances.tsx`. The Date column shows the Tally voucher date (the stored UTC calendar day, not shifted by the viewer timezone); the line under it shows when the sync ran. No migration (admins already have read access to the ledger by RLS).

---

# PART H: Deleted expenses are corrected in Tally automatically

## H1) What it does

When an expense that was **already posted to Tally** is deleted in PesoWise, the system removes that expense's accounting effect from TallyPrime by itself: no button, no approval. An expense that was never synced is never touched in Tally.

| Situation in Tally | What happens | Result in Tally |
|---|---|---|
| The voucher holds **only that expense** | the voucher is **deleted** | the voucher disappears from the Day Book |
| The voucher holds **other expenses too** | the voucher is **altered**: only this expense's amount is taken off its two ledgers (the expense ledger and the employee's ledger); an employee's line disappears when it reaches zero | the voucher stays, with a smaller total; its reference (narration `PWT PESO/08/02`) does not change |
| Tally **refuses** the delete or alter (for example the period is locked) | a **compensating reversal** Journal is posted on the same date, narration `PWT REV <voucher ID> <expense number>` (mirror image of the original: employee Dr, expense ledger Cr) | the original voucher stays and the reversal cancels the amount; an audit-friendly trail |
| The voucher was **changed in Tally by hand**, appears twice, is of another type, is unbalanced, or the ledgers of the expense are not known | **blocked**: nothing in Tally is changed | the correction shows "Needs attention" on **Admin → Tally connector → Deleted-expense corrections** with the reason, and has a Retry button for after it was sorted out |

The correction is only reported done after **TallyPrime itself shows the corrected state** (read back), never on the strength of a request being accepted.

## H2) How PesoWise deletes expenses (audit findings)

- A user's "Delete" is a **soft delete**: `trash_expense_v1` sets `expenses.deleted_at` (30-day Recycle Bin) and only works on **drafts**. A draft has never been approved, so it has never been synced.
- A row is physically removed only by the daily purge (also drafts), a database clean-up, or removing a user or organisation.
- An **approved** expense (the only kind that is synced) cannot be deleted by an ordinary user: the system refuses ("balance deduction on record"). So in daily use a correction is rare: it covers an admin or database delete, a restore from a backup, or a future change that allows deleting approved expenses. The feature is built to be correct for all of them.

## H3) How it works

1. **Detection (database).** Two triggers on `public.expenses`: one when `deleted_at` changes from empty to set, one when a row is deleted. Each looks the expense up in `pwt_registry` (the record of what was posted). Not found, or not yet delivered: nothing happens. Found: one row is added to `pwt_deletion_jobs`. The trigger can never block or fail the deletion itself (errors are swallowed and logged).
2. **Safety net.** About every 5 minutes (when the connector asks for work) a scan queues any synced expense that is deleted or gone but has no correction (a missed trigger, a restored backup). Idempotent.
3. **One correction per expense, ever.** `UNIQUE (organization_id, tally_company, source_id)` makes a repeated delete, a double trigger or a scan unable to queue a second one.
4. **The connector claims the job** through the new `pwt-deletion` edge function (same device token as the rest), only while Tally's active company is the paired one. Before handing it out the database checks the expense is still deleted (a **restored** expense cancels the job). Two corrections to the same voucher never run at once.
5. **The connector finds the voucher in Tally** by date and exact narration, decides delete / alter / reversal / blocked (`connector/pwtally/src/deletion.ts`, a pure function plus read-back), applies it, then reads Tally again to prove it.
6. **The outcome is acknowledged.** `completed` stamps `pwt_registry.removed_at`, updates the recorded voucher total, and writes the step to the append-only `pwt_correction_log`.
7. **Offline or failing.** Tally closed or the wrong company open: the job stays queued and is retried automatically (a Tally outage does not use up attempts). A real failure is retried with a growing delay, and after 5 attempts is **blocked**, never retried forever.

**Repeating is safe.** A job run twice never deletes or reverses twice: a voucher already gone is "already gone"; an alteration already applied is recognised (PesoWise's recorded total minus this amount) and not applied again; a reversal already in Tally is found by its own reference and not posted again. After a reversal has been used on a voucher it is flagged and that voucher is never deleted or altered again.

## H4) What needed to change in the existing sync

Each posting now also records the **employee ledger, expense ledger and serial** it hit (new columns on `pwt_registry`); without them one expense could not be taken out of a shared voucher. For expenses posted **before** this feature the migration backfills them from the stored job snapshot (best effort). Anything it cannot resolve is handled safely: a voucher holding only that expense can still be deleted; anything else is blocked, never guessed. Nothing in PesoWise → Tally or Tally → PesoWise changed otherwise.

## H5) For the accountant

- A deleted synced expense **disappears from the Day Book** (single-expense voucher), **reduces the voucher** (shared voucher) or is **offset by a reversal** (only if Tally refuses). Voucher IDs are never reused.
- The five-column **report rows** shown in the Tally reports refresh on the next sync of that report (a deleted expense is then no longer in the data); the correction itself does not wait for that.
- A correction is never made to a voucher whose total is no longer what PesoWise recorded; that is flagged for you instead.

## H6) Key files and migration

| Piece | File |
|---|---|
| Migration (tables, triggers, scan, claim/ack, admin RPCs, registry backfill) | `supabase/migrations/20261019100000_pwt_deletion_sync.sql` |
| Connector API | `supabase/functions/pwt-deletion/index.ts` (+ `[functions.pwt-deletion]` in `supabase/config.toml`) |
| Planner records ledgers | `supabase/functions/_shared/pwt/aggregate.ts`, `prepare.ts`, `types.ts` |
| Tally logic | `connector/pwtally/src/deletion.ts`; polled from `main.ts` after delivery |
| Website | `src/lib/pwt/pwtDeletion.ts`, `src/components/PwtDeletionHistory.tsx` (on `/admin/pwtally`) |
| Tests | `supabase/tests/pwt_deletion/deletion_acceptance.mjs` (Postgres), `connector/pwtally/src/__tests__/deletion.test.ts`, `src/components/__tests__/PwtDeletionHistory.test.tsx` |

**Deploy (needs the owner's approval, PesoWise stack only, in this order):** apply the migration; deploy `pwt-deletion` **and redeploy `pwt-run-job`** (so new postings record their ledgers); replace the connector on the Tally PC with the new build. Until the connector is replaced, deletions queue safely and wait.

## H7) Test evidence (2026-10-19)

- **Postgres acceptance test** (in-process Postgres, real migrations): unsynced delete queues nothing; soft and hard delete queue exactly one correction; reserved (still being delivered) is picked up by the scan; a failing trigger never blocks a delete; wrong company is blocked; claims are exclusive; same-voucher corrections are serialised; offline retries refund the attempt; 5 real failures block; restore cancels; only admins of the organisation can list or retry; browser roles are denied the connector functions; the registry backfill resolves legacy rows. All pass.
- **Live TallyPrime** (`PesoWise Integration Demo`, throw-away `ZZ Del Test` ledgers and `PWT PESO/09/9x` vouchers, all removed afterwards): single-expense voucher deleted and verified gone; a shared voucher reduced from 350 to 300 (employee line 150 to 100, others unchanged, reference unchanged); an employee's last expense removes that line; the last remaining expense deletes the voucher; the reversal voucher posted with the mirrored lines and the original untouched; repeating each job changed nothing; a voucher whose total differed was blocked and left untouched; Tally offline queued the retry. The real PesoWise vouchers (PESO/07/xx, 08/xx) were verified unchanged afterwards.
- **Deployed 2026-10-19 (owner-approved, PesoWise stack only):** migration applied (2 triggers; all 12,586 existing registry rows backfilled with employee ledger, expense ledger and serial; first scan queued 0 corrections), `pwt-deletion` and `pwt-run-job` deployed (both answer 401 without credentials), local connector replaced and polling. **End-to-end on the deployed stack (2026-10-19, run by the agent with throw-away test records, all removed afterwards):** a single-expense voucher was deleted and a shared voucher reduced from 200 to 140 by the real connector within 12 s of detection, both read back from TallyPrime; the real `expenses` trigger queued a job on a soft delete (inside a rolled-back transaction); a job queued while the connector was stopped stayed queued and was completed 2 s after the connector restarted; a second full scan changed nothing; the production tables returned to their exact baseline (12,586 registry rows, 19 vouchers, 0 corrections).
- **Regression note:** the full existing suite has failures only in the legacy Tally metadata/delivery tests (`tallyMetadata*`, `tallyMappingMetadataLedger`, `tallyDeliveryUpdates`, `tallyPhase53Delivery`) and one maintenance-admin test; none of them import the pwt code.

## H8) Known limits

- Only **vouchers** are corrected. Deleted expenses are not removed from report rows until that report is synced again.
- An **edited amount** of a synced expense is not corrected (not a deletion); it is reported as a mismatch by the next sync, as before.
- Ledgers created for an employee or category are not removed when their last voucher goes.
- A correction waits while TallyPrime is closed or the wrong company is open; it needs the same connector as the rest.

---

# PART E: Engineering log

## E1) Build history

| Date | What happened |
|---|---|
| 2026-10-16 | Decision: build a fresh integration in its own `pwt` namespace. Engine, migration, three edge functions, connector, TDL generator, installer and website control built and tested offline. |
| 2026-10-16 | Reports changed from the original 20/23/24 PesoWise columns to the workbook's exact **five columns** for all four reports (`planView`, keep-list prune, Daily Project cost mapping). |
| 2026-10-16 | **Deployed to the PesoWise stack only:** migration `20261016120000_pwt_foundation.sql` (8 tables, 17 functions); edge functions copied into the PesoWise edge container (`VERIFY_JWT=false`; unauthenticated calls return 401); connector paired and running; `VITE_PWT_SYNC=1` set locally. |
| 2026-10-16 | Customer-ready: guided setup page, per-organisation mapping editor, migration `20261016130000_pwt_config_rpcs.sql` (14/14 checks in an isolated Postgres), installer and TDL published to `public/downloads`. |
| 2026-10-17 | Mapped two spelling variants of the "Other" category ("Other ( Xerox, Printing, Courier & Stationery )", "other") to Site Expenses (serial 3) at the owner's request; shared engine redeployed. |

## E2) Defects found only by real TallyPrime or real use, and fixed

| Defect | Fix |
|---|---|
| Active-company probe (inline report) returned an empty reply | Company collection with `COMPUTE $$CurrentCompany`. |
| Journal vouchers are auto-numbered; readback by voucher number saw none, and a first run re-imported 9 vouchers | Match on the narration id; duplicates are now a hard "manual review" error; the 18 test vouchers were deleted and the run repeated. |
| Readback parser rejected `<DATE TYPE="Date">` / `<AMOUNT TYPE="Amount">` | Parser accepts attributes; the fake Tally in tests now mimics real output. |
| TDL "Bad formula" on collection names with spaces and on joined text | Space-free collection names, numbers instead of concatenation. |
| TDL squeezed 24 columns on one screen | Five columns, percent widths. |
| Logon task creation needs admin rights | `HKCU\...\Run` entry. |
| Connector never started after install (a packaged exe cannot start a copy of itself) | The installer script starts it and verifies it is running. |
| Installer download was the website's HTML page | Dev server ignores files added to `public/downloads` after start; restart it. |
| Opening-balance ledger rows were reported as bad rows and blocked a job | Non-expense events are skipped before the identity check. |

## E3) Records created in the demo company during verification

Test vouchers created while verifying were deleted before the owner's own tests. Later syncs by the owner created the real test data: Journal vouchers for August and July 2026 and the report rows in group "PesoWise Report Data" in `PesoWise Integration Demo`. Only objects created by this integration are ever removed by the cleanup script (vouchers whose narration starts with `PWT `, `PWT-…` ledgers, employee ledgers under Sundry Debtors, the nine expense ledgers under Indirect Expenses, and the report group).

## E4) Owner decisions on record

- Use the PesoWise Integration Demo company only for testing; never another company.
- Build the integration in its own `pwt` namespace.
- Do not modify other projects on server `.46`; work only on the PesoWise containers and database.
- Map the two "Other" spelling variants to Site Expenses.

---

## Revision log

| Date | Change |
|------|--------|
| 2026-10-17 | Created as the single document for the whole integration (architecture, calculation, user manual, operations, reuse, engineering log). |
| 2026-10-17 | Added Part F: Sync from Tally (employee payments entered in Tally become balance credits through the existing balance engine). Separate tables, function and connector module; the PesoWise → Tally path is unchanged. |
| 2026-10-17 | Added Part G: accountant's mapping reference (every ledger, voucher, date, reference and Dr/Cr rule in both directions, reconciliation checks, and the decisions to confirm before a real company). |
| 2026-10-17 | Balances → Transfer History now shows a Balance credit history (Manual entry / Tally sync / Import). |
| 2026-10-17 | Credit history shows the voucher date, not a timezone-shifted day. |
| 2026-10-19 | Added Part H: automatic correction in Tally when a synced expense is deleted in PesoWise (audit, design, rules, tests, deploy order, limits). Updated G5. |
| 2026-10-19 | Connector and setup installer rebuilt as version 1.1.0 (includes deletion sync). `/downloads/PesoWise-Tally-Setup.exe` and `PesoWise-Tally.tdl` serve the new files; the setup page states the version and how to update an installed PC (run the new setup, answer No to keep the pairing). |
| 2026-10-19 | `/admin/pwtally` redesigned as the dedicated Tally integration setup page: live status banner with a 4-point checklist, the three things it automates, four numbered step cards (downloads, prepare Tally, pairing code with copy and 15-minute countdown plus connected PCs, ledger mapping), first-sync card, and tabs for sync history, deleted-expense corrections and troubleshooting. Admin sidebar link "Tally integration" added (shown only when `VITE_PWT_SYNC=1`). |
| 2026-10-19 | `/admin/pwtally` simplified: status line, three short steps (Download, Connect with a code, Set up TallyPrime) and three tabs (History, Deleted expenses, Ledger mapping). The explanatory tiles, checklist and troubleshooting text were removed. |
| 2026-10-19 | Connector 1.2.0: creates the payment voucher type used by Sync from Tally in the paired company automatically (heartbeat now returns the configured name). F7 updated. Unit-tested and verified live in TallyPrime (a throwaway voucher type was created as a Payment type, a repeat run changed nothing, the existing "PESO Wise Payment" was left alone, a wrong company was refused, and the test type was removed). |
| 2026-10-19 | Connector 1.2.1: the auto-created payment voucher type is now created ACTIVE and automatically numbered, and an existing inactive one is switched on (it was created inactive in 1.2.0, so TallyPrime hid it from the voucher type list; found when the owner could not see it). |
| 2026-10-19 | **The "already posted" record is now per Tally company** (migration `20261019140000_pwt_registry_per_company.sql`, applied to the PesoWise DB with a safety copy `pwt_registry_bak_20261019`). Before, an expense posted to one company counted as posted for every company of the organisation, so a new empty company was never filled (found when a sync into a fresh company created no vouchers). Now each company has its own history; the same expense can be posted once to each company; duplicates inside one company stay impossible. Existing 12,586 + 15 postings were tagged with the company of their sync job. Deletion corrections are per company too. Tested in Postgres (10 + 41 checks). |
| 2026-10-19 | **Large syncs no longer get stuck in "Preparing".** The server cancels any single request after about 12 s, so reading and planning a 12,000+ row report in one request was killed part-way (no error recorded). Preparation now runs in short resumable slices (migration `20261019150000_pwt_resumable_prepare.sql`: `prep_phase`/`prep_state`/`prep_seq`/`slice_lease_until`, `pwt_claim_slice_v1`, `pwt_slice_save_v1`, `pwt_job_rows_compact_v1`; worker `_shared/pwt/slice.ts`; `pwt-start-sync` action `continue`). Each slice reads or plans for about 7 s, saves its position and returns; the Sync control on the Reports page asks for the next slice until the job is ready. The planner reads only the compact fields it needs. A job stuck by the old worker restarts cleanly. Tested: unit (6), Postgres (13). Limit: while a job is preparing the Reports page must stay open (it drives the slices). |
| 2026-10-21 | **Report rows in Tally are now OFF by default** (organisation setting `reportRowsInTally`, migration `20261021100000_pwt_report_rows_setting.sql`; switch on Admin → Tally integration → Ledger mapping). The hidden `PWT-CA/DE/DP-…` ledgers (one per report row, group "PesoWise Report Data") appeared in every ledger picker. With the switch off a sync writes only real vouchers and one prune-only batch that removes leftovers of that report; Daily Project and Claim Verification (display-only) hide their Sync button; the job message no longer mentions report rows. The 675 existing report ledgers and the group were removed from `Pesowise Testing` (real ledgers and vouchers untouched). The PesoWise Reports screens inside Tally are therefore empty unless the switch is turned on. Tests: planner, engine, page (116). |
| 2026-10-21 | **Large Detailed Expense syncs stuck at "Preparing" (second cause).** The edge runtime allows only about 2 s of CPU per request; turning 12,609 rows into canonical transactions (hashing every row) needed ~2.6 s, so the planning request was cancelled, and the Reports page gave up after one error. Preparation is now read (slices) -> normalise (slices of ~1,000 rows, staged in `pwt_job_txns`) -> plan (grouping only), migration `20261021140000_pwt_prepare_txns.sql`; `normalizeRows` / `buildJobPlanFromNormalized` in `prepare.ts` (chunked planning equals one-shot planning, tested); the page keeps asking for the next slice and retries after a cut-off instead of stopping. A job already in the old planning phase is sent back through normalising. Scales to roughly 25,000 rows per report; beyond that the grouping step would also need splitting. |
| 2026-10-21 | **Expenses with an empty category are mapped as "N/A"** instead of being left out as UNMAPPED_EXPENSE_TYPE: serial 99 -> ledger "Miscellaneous Expenses" (Indirect Expenses), Voucher ID `PESO/MM/99`; aliases na / none / -. A saved organisation mapping that predates it gets the rule added automatically (`withNaRule`); a rule the organisation already has for N/A is respected. The ledger can be changed on the Ledger mapping tab. This replaces the earlier "a blank category is never guessed" rule in G3 at the owner's direction. |
| 2026-10-21 | **Re-syncs of large reports no longer stall in planning.** Every already-posted row produces a notice and the planner compared each new notice with all earlier ones (quadratic: 12,601 notices took seconds of CPU and the request was cancelled). Now a set lookup (12,609 rows planned in ~0.2 s, tested). Verified: the Detailed Expense re-sync completed and posted the one N/A row. |
| 2026-10-21 | **The PesoWise Detailed Expense and Claim Approval screens in Tally now show the REAL vouchers.** Instead of hidden report-row ledgers they read the Journal vouchers straight from the books: one row per employee line of each `PWT PESO/..` voucher (Voucher Date, Expense Ledger, Employee Ledger, Voucher ID without the PWT tag, Total) with a Grand Total of the employee lines. No sync and no switch is needed for these two screens, they always match the Day Book (including after a deleted-expense correction), and reversal vouchers (`PWT REV ...`) and payment vouchers are excluded. Daily Project and Claim Verification still use synchronised rows and need the "report rows in Tally" switch. Validated against the live voucher data through Tally's export interface (707 rows, total 28,64,538.27); the on-screen look must be checked by loading the new TDL. Connector/installer 1.2.2 carry the new TDL. |
| 2026-10-21 | The "report rows in Tally" switch now applies to Daily Project and Claim Verification only (Detailed Expense and Claim Approval read the real vouchers, so they store no report rows and clear any left over). The switch was turned ON for the organisation so Daily Project can be synced into its Tally screen; Daily Project creates no vouchers, so it cannot duplicate any accounting. |
| 2026-10-21 | **Detailed Expense is now the only report used with Tally.** Daily Project, Claim Verification and Claim Approval were checked: every money column of Daily Project is already booked through Detailed Expense (June-August match to the rupee; Contra Bill = Labour Charges, Other Exp. = Site + Rent Equipment + second Travelling type), and Claim Verification / Claim Approval add nothing new. Changes: the custom TDL now has a single screen, Detailed Expense (Gateway of Tally -> PesoWise Reports -> Detailed Expense, reads the real vouchers); the **Sync to Tally** button appears only on the Detailed Expense report (`ServerReportExportPanel.tsx`, `PwtSyncControl.tsx`; the display-only branch and the report-rows switch check were removed from the button). The switch "Also show the PesoWise Reports screens inside Tally" no longer has a screen to feed. Installer rebuilt with the one-screen TDL. Found while checking: one Daily Project row dated 25-09-2026 holds Other Exp. 24,78,570 (looks like a data-entry error); not booked, left for correction in PesoWise. |
| 2026-10-21 | **Ledger mapping tab: the Tally ledger is now a drop-down** (the nine expense ledgers plus Miscellaneous Expenses; "New ledger..." lets a different name be typed). A saved mapping that predates the N/A rule now shows the N/A -> Miscellaneous Expenses (99) row on the page as well (`withNaRow`), and a new row's number never takes 99. Why N/A exists: an expense with no category cannot be matched to any ledger, so instead of being left out of the books (and the totals not matching PesoWise) it is posted to Miscellaneous Expenses and the accountant reclassifies it later. `AdminPwTally.tsx`, `pwtSync.ts`. |
| 2026-10-21 | **Ledger mapping: Auto map button and shared-ledger warning.** "Auto map" reads the organisation's PesoWise expense categories (plus types the last syncs could not map), adds a row for each one that has no mapping with a keyword-suggested ledger (Hotel -> Lodging, Fuel/Petrol -> Conveyance, Mobile -> Telephone, ...; unknown -> Miscellaneous Expenses) and the next free number (never 99), and fills blank ledgers; existing rows are never changed. The result is only a proposal until Save. When two expense types post to the same ledger (e.g. Incentive and N/A both to Miscellaneous Expenses) an amber notice says Tally will add them together in that ledger; it is a warning, not an error, because sharing is allowed (default mapping already shares Travelling Expenses between types 1 and 9). A permanent note says a mapping change affects new syncs only; vouchers already in Tally keep their old ledger. `pwtSync.ts` (`suggestLedger`, `autoMapRules`, `sharedLedgers`), `AdminPwTally.tsx`, test `autoMap.test.ts`. |
| 2026-10-21 | **Ledger mapping: confirm before changing a ledger that already has vouchers.** When a sync has already posted vouchers and Save would change the Tally ledger of an existing row, a confirm box names the changed types and says vouchers already in Tally keep the old ledger. New rows are not treated as changes. `changedLedgers` in `pwtSync.ts`, `AdminPwTally.tsx`, test in `autoMap.test.ts`. |
| 2026-10-21 | **Ledger mapping: the number column is kept and renamed "Voucher no.".** It is the last part of the Voucher ID (`PESO/MM/NN`) that the accountant uses to reference and reconcile vouchers, so it stays visible and editable (unique per expense type, 1-99; 99 is N/A). A briefly removed column was restored at the accountant requirement. `AdminPwTally.tsx`. |
| 2026-10-21 | **Ledger mapping: live warning when a mapping is changed after a sync.** Once a sync has posted vouchers, any edit to an existing row's ledger or voucher number shows an amber banner on the page ("Vouchers already in Tally will not change. After you press Save, the new mapping is used from the next sync only") and Save asks for confirmation. Existing Tally vouchers are never altered: already-posted expenses are skipped by the registry, so only expenses not yet synced use the new mapping. N/A is always kept on number 99. `pwtSync.ts` (`changedSerials`, `withNaRow`), `AdminPwTally.tsx`. |
| 2026-10-21 | **Ledger mapping warning is now on the page, not a browser pop-up.** The amber box sits directly above the Save button as soon as a posted mapping is edited; pressing Save turns it into an in-page question ("Yes, use it from the next sync" / Cancel). No `window.confirm`. Test added in `AdminPwTally.test.tsx`. |
| 2026-10-21 | **Ledger mapping page simplified.** One plain intro line ("Choose the Tally ledger each expense type is booked to. Not sure? Press Auto map."), clearer headings (Expense type / Goes to Tally ledger / Voucher no.), the Voucher ID shown as a live example with the prefix inline, the several shared-ledger boxes merged into one short note, the permanent note removed (the change warning already says it), the buttons in one row (Auto map, Add row, Reset, Save on the right), and the "Also show the PesoWise Reports screens inside Tally" checkbox removed from the page because only Detailed Expense is used now (the stored value is kept). `AdminPwTally.tsx`. |
| 2026-10-21 | **Ledger mapping page: Voucher ID example line (with the prefix box), the shared-ledger note and the "You changed" warning/confirmation were removed at the owner's request.** Save now saves directly. Existing Tally vouchers are still never altered by a mapping change (posted expenses are skipped by the registry; only unsynced expenses use the new mapping). The voucher prefix is no longer editable on the page (stays as saved, default PESO). Helper functions (`changedLedgers`, `sharedLedgers`) remain in `pwtSync.ts`, unused by the page. `AdminPwTally.tsx`. |
| 2026-10-21 | **Safety: the .tdl download was removed from the website.** The setup page now offers only the connector installer (the installer carries the TDL and puts it in `%LOCALAPPDATA%ProgramsPesoWiseTally`). `public/downloads/PesoWise-Tally.tdl` was deleted and `build-installer.mjs` no longer publishes it. The source stays in `connector/pwtally/tdl/`. `AdminPwTally.tsx`. |
| 2026-10-21 | **Fix: the installer download on the deployed site returned an HTML page.** `public/downloads/` was git-ignored, so the .exe never reached Vercel and the single-page-app fallback served `index.html`. The installer `PesoWise-Tally-Setup.exe` (connector 1.2.2, embeds only the public API URL and the publishable key) is now committed in `public/downloads/` with a narrow `.gitignore` exception; everything else in that folder (including the .tdl) stays ignored. Rebuild with `node connector/pwtally/scripts/build-installer.mjs` and commit the new .exe to publish a new connector version. |
