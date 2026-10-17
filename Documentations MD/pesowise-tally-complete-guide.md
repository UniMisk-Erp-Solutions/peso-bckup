# PesoWise → TallyPrime: the complete guide

**Doc ID:** DOC-144  
**Status:** in progress  
**Last updated:** 2026-10-17  
**Owner / area:** Tally integration (architecture, operation, user manual, reuse)  

> This is the **only document** for the PesoWise → TallyPrime integration. Part A explains how the system works, Part B is the user manual, Part C is for whoever deploys and runs it, Part D explains how to reuse the design for another project, and Part E is the engineering log (what was built, found and fixed).

---

## 0) In one minute

**What it does.** An admin opens a PesoWise report, picks filters, clicks **Sync to Tally**. PesoWise reads the live data, maps employees and expense types to Tally ledgers, adds the amounts up, and delivers the result to TallyPrime through a small Windows program (the *connector*). Tally then shows the calculated **five-column report** and, for approved expenses, **Journal vouchers**. No Excel, no export, no import.

**What you see in Tally**

| Voucher Date (Tally) | Expense Ledger | Employe Ledger | Voucher ID | Total |
|---|---|---|---|---|

with a Grand Total. These five columns are exactly the accountant's workbook "Import Sheet" (the spelling "Employe" is the workbook's).

**Four reports, one engine**

| Report | Shows aggregated rows | Creates vouchers |
|---|---|---|
| Detailed Expense | yes | **yes** (debit rows) |
| Claim Approval | yes | **yes**, only for expenses not already posted |
| Claim Verification | yes | never |
| Daily Project | yes | never |

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

**Worked example** (August 2026 Detailed Expense rows of one employee, taken from live data and anonymised)

| Row | Employee | Category | Date | Debit |
|---|---|---|---|---|
| 1 | Employee A | Material Purchase | 07-08-2026 | 60 |
| 2 | Employee A | Material Purchase | 11-08-2026 | 120 |
| 3 | Employee A | Material Purchase | 18-08-2026 | 500 |
| 4 | Employee A | Material Purchase | 19-08-2026 | 20 |
| 5 | Employee A | Material Purchase | 19-08-2026 | 50 |

Category → rule serial 2, ledger *Consumable Stores - URD*; all five fall in August ⇒ date 31-08-2026; one group; total 60+120+500+20+50 = **750.00** ⇒

| Voucher Date (Tally) | Expense Ledger | Employe Ledger | Voucher ID | Total |
|---|---|---|---|---|
| 31-08-2026 | Consumable Stores - URD | Employee A-1234 | PESO/08/02 | 750.00 |

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
- Live August 2026 data (one live organisation), per report, aggregated total = independent source total:

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
