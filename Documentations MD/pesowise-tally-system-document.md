# PesoWise ↔ TallyPrime: the complete system document

**Doc ID:** DOC-147  
**Status:** in progress  
**Last updated:** 2026-10-22  
**Owner / area:** Tally integration (system, mapping, operation, build history)  

---

## 1) Summary

PesoWise keeps employee expenses and balances. TallyPrime is the accountant's book. This system keeps the two in step **automatically**, in both directions:

- **PesoWise → Tally.** Approved expenses become **Journal vouchers** in Tally (one per month and expense type). If a synced expense is later **deleted or edited** in PesoWise, Tally is **corrected automatically**.
- **Tally → PesoWise.** Employee payments entered in Tally become **balance credits** in PesoWise.

A small Windows program, the **connector**, sits next to TallyPrime and does all the talking to Tally. The server never connects into a customer's PC. Everything that touches the books is **read back from Tally** before it is called done.

This document is the fresh, single reference: what the system is, how it works, every mapping the accountant needs, how it was built, how to run it, and what is still open. The older engineering log (DOC-146) is kept for its detailed dated history.

---

## 2) What the system does (feature list)

| # | Feature | In one line |
|---|---|---|
| 1 | **Sync to Tally** | One button on Reports → Detailed Expense posts approved expenses to the paired Tally company. |
| 2 | **Ledger mapping** | Each PesoWise expense type goes to a chosen Tally ledger; drop-down, **Auto map**, voucher number, N/A handling. |
| 3 | **Voucher date setting** | Voucher dated on the last day of the month (default) or the first day (for Tally editions that refuse month-end dates). |
| 4 | **No duplicates** | Every expense is posted once per Tally company, ever. Re-syncing or retrying never doubles anything. |
| 5 | **Large syncs** | A report of 12,000+ rows is prepared in short resumable slices (no "stuck at Preparing"). |
| 6 | **Company period handling** | If the Tally company starts after the expense month, the connector can move its start date earlier (only for a company that holds just PesoWise entries). |
| 7 | **Deleted-expense correction** | Delete a synced expense in PesoWise → its voucher is deleted, reduced or reversed in Tally, automatically. |
| 8 | **Edited-expense correction** | Edit amount / month / employee / category of a synced expense → the old entry is corrected and the new version is posted, automatically. |
| 9 | **Corrections tab** | Shows every correction, its Tally company, and what it is waiting for. |
| 10 | **Detailed Expense screen in Tally** | Gateway of Tally → PesoWise Reports → Detailed Expense lists the real PesoWise vouchers. |
| 11 | **Sync from Tally** | Payments entered in Tally become employee balance credits in PesoWise (Balances page). |
| 12 | **Payment voucher type** | The voucher type **PesoWise Payment** is created in every connected company automatically. |
| 13 | **Setup page** | `/admin/pwtally`: download the connector, get a pairing code, History, Corrections, Ledger mapping. |
| 14 | **Installer** | One download; no PowerShell; pairs, starts with Windows, runs in the background. |

---

## 3) Architecture

```
 PesoWise website (React, Vercel)                 Supabase (self-hosted, PesoWise project only)
 ┌─────────────────────────────┐   click   ┌───────────────────────────────────────────────────────┐
 │ Reports: "Sync to Tally"    │ ────────▶ │ edge fn  pwt-start-sync   admin check, creates a job   │
 │ /admin/pwtally  setup       │           │ edge fn  pwt-run-job      worker: reads, maps, plans   │
 │ Balances: "Sync from Tally" │           │ edge fn  pwt-connector    pair / heartbeat / claim / ack│
 └──────────▲──────────────────┘           │ edge fn  pwt-deletion     corrections for the connector │
            │ status (admin RPCs)          │ edge fn  pwt-inbound      Tally → PesoWise payments     │
            │                              │ Postgres  pwt_* tables, SECURITY DEFINER functions      │
            │                              └───────────────▲───────────────────────────────────────┘
            │                                              │ HTTPS, outbound only, device token
 ┌──────────┴──────────────────────────────────────────────┴──────────────┐
 │ Tally PC:  PesoWiseTally.exe  (connector, runs in the background)         │
 │   checks the ACTIVE company == the paired company before every write     │
 │   talks to TallyPrime at http://127.0.0.1:9000 (this PC only)             │
 └───────────────────────────────┬───────────────────────────────────────┘
                                 ▼
                       TallyPrime company: Journal vouchers, ledgers, voucher type, the PesoWise Reports screen (TDL)
```

**Rules that hold everywhere**

1. The server **never connects into** the customer's PC. The connector only makes outbound HTTPS calls; the Tally port is never exposed.
2. **Completed is set only after Tally itself confirms** (read-back), never because an HTTP call succeeded.
3. **Idempotent everywhere.** Retries, double clicks and overlapping syncs never create a second voucher.
4. **Never guess.** A row that cannot be mapped is left out and shown with the reason.
5. **A connector only ever works on its paired company.** It re-checks the active Tally company immediately before writing.

**Pieces**

| Piece | What it is |
|---|---|
| Website | React app; the setup page, Sync control, Corrections list, Balances "Sync from Tally". |
| Edge functions | `pwt-start-sync`, `pwt-run-job`, `pwt-connector`, `pwt-deletion`, `pwt-inbound` (Deno). Shared engine in `_shared/pwt/`. |
| Database | Tables with prefix `pwt_`, RLS on with no browser policies; the website calls only admin-checked functions. |
| Connector | `PesoWiseTally.exe` (Node, packaged): polls about every 10 s, delivers batches, applies corrections, reads payments. |
| TDL | `PesoWise-Tally.tdl`: adds Gateway → PesoWise Reports → Detailed Expense. |
| Installer | `PesoWise-Tally-Setup.exe`: copies the connector and TDL, asks for the pairing code, starts it with Windows. |

---

## 4) Setting up a company (once)

1. **Setup page** (Admin → Tally integration): type the **exact Tally company name**, press **Get code** (valid 15 minutes).
2. On the Tally PC, download and run the installer, type the code. This **pairs that PC with that company**.
3. In TallyPrime add `PesoWise-Tally.tdl` (F1 Help → TDL & Add-On), enable the Tally port (F1 → Settings → Connectivity → Client/Server), open the company.
4. The connector creates the voucher type **PesoWise Payment** in that company (active, Payment type, automatic numbering).
5. Check **Ledger mapping** (the defaults are in section 7); press **Auto map** if new expense types exist.
6. Press **Sync to Tally** on Reports → Detailed Expense.

Tally must be **open on the paired company** for the connector to deliver. If not, work waits and runs when Tally is open.

---

## 5) PesoWise → Tally: how a sync works

1. **Click.** Reports → Detailed Expense → choose the dates → **Sync to Tally**. Only the Detailed Expense report syncs; Daily Project, Claim Verification and Claim Approval do not (their money is already in Detailed Expense).
2. **Job.** An admin-checked database function creates a job for the paired company. The same job running already is returned instead (double click safe).
3. **Preparation in short slices** (the server cancels any single request after about 12 s, so a large report is processed in resumable slices): *read* the report page by page → *normalise* in chunks of about 1,000 rows → *plan*. The page keeps asking for the next slice until done. This scales to about 25,000 rows per report.
4. **Plan.** Rows are mapped to ledgers, grouped, and turned into ordered XML batches: **masters** (missing ledgers) → **vouchers**.
5. **Delivery.** The connector claims a batch only while the paired company is the active Tally company, reads Tally first (imports only what is missing), imports, then **reads back** and checks every voucher exists once, is balanced, and has the right total.
6. **Completion.** The job becomes **Completed** only after the last batch is verified. A problem shows **Needs attention** with a plain message.

| Job status | Meaning |
|---|---|
| Queued / Preparing | PesoWise is reading and calculating. |
| Delivering | Ready; waiting for or running through the connector. |
| **Completed** | Tally confirmed everything. |
| Needs attention | Some rows were left out, or Tally refused something; the message says what to do. |
| Failed | Stopped before delivery. |

### Calculation rules

- **Rows used.** Detailed Expense: expense deductions with a debit above zero (credits and opening balances are skipped).
- **Group key.** Voucher date × expense type (serial) × employee ledger. The **total** is the exact 2-decimal sum.
- **Voucher date.** Last day of the expense month (default) or the first day (setting). The month of the expense is always kept.
- **Voucher ID.** `<prefix>/<MM>/<serial>`, for example `PESO/08/02`; a later posting into an already used month and serial gets `-S1`, `-S2`. The ID is stored in the voucher **narration** as `PWT PESO/08/02` (Tally auto-numbers Journals, so its own number is not used).
- **Left out and reported, never guessed:** unmapped expense type (but see N/A below), missing employee code, non-positive amount, bad date.
- **N/A.** An expense with an **empty category** is mapped as **N/A → Miscellaneous Expenses**, number 99 (`PESO/MM/99`), so nothing is left out.

### Duplicate prevention

Every expense has a stable id `<org>:expense:<expense id>`. The registry (`pwt_registry`, one row per Tally company and expense) is **reserved** when a job is planned and becomes **posted** only after verified delivery. Syncing twice, syncing overlapping ranges, or a retry after a crash never posts an expense twice for the same company. The registry is **per Tally company**, so a new empty company gets everything.

### Company period handling

Tally refuses a voucher dated before the company's "Financial year beginning from" / "Books beginning from" ("Voucher date is missing"). Before importing, the connector reads those dates. If the earliest voucher is earlier **and the company holds only PesoWise entries**, it moves both dates earlier (same day and month, earlier year) and verifies by reading Tally back. A company that has **its own entries** is never changed: the sync stops with a plain instruction (Alt+F3, Alter, set the start date). Verified live in TallyPrime. If Tally still refuses a date although the books cover it (the Educational edition did), the page shows exactly what the connector read and advises the **First day of the month** voucher date.

---

## 6) What appears in Tally

| What | Tally object | Touches the books? |
|---|---|---|
| Employee | Ledger `<name>-<employee code>` under **Sundry Debtors** | yes (the employee advance account) |
| Expense type | Ledger under **Indirect Expenses** (see section 7) | yes |
| Approved expenses | **Journal** voucher: **Dr** expense ledger, **Cr** each employee ledger | yes |
| Employee payments typed in Tally | Voucher type **PesoWise Payment** (Payment type) | yes (the accountant enters these) |
| Corrections | deleted / reduced vouchers, or reversal vouchers narrated `PWT REV …` | yes |
| Report screen | Gateway → PesoWise Reports → Detailed Expense | no (display only) |

No GST, TDS, bill-wise allocations, cost centres or stock are created.

### The Detailed Expense screen (TDL)

It lists the **real vouchers** PesoWise created: Voucher Date, Expense Ledger, Employee Ledger, Voucher ID, Total, with a Grand Total, read live from the books, so it always matches the Day Book. Two rules keep it clean, both set on the **collection** (not on the line, because a line-level hide rule did not work on the real screen): only vouchers whose narration starts with `PWT PESO/` are read, and only their employee (credit) lines are listed. Manual vouchers, payments and debit lines never appear.

---

## 7) Mapping reference (for the accountant)

### Expense type → Tally ledger (defaults; editable on the Ledger mapping tab)

| No. | PesoWise expense type | Tally expense ledger |
|---|---|---|
| 1 | Travelling (Public and Private Transport) | Travelling Expenses |
| 2 | Material Purchase | Consumable Stores - URD |
| 3 | Other ( Xerox, Printing, Courier, Stationery & Medical ) (also "other" and the shorter spelling) | Site Expenses |
| 4 | Laptop Rent | Rent Expenses - Equipment |
| 5 | Hotel/Guest House | Lodging Expenses |
| 6 | Petrol Expense (Bike and Car) | Conveyance Expenses |
| 7 | Local Manpower | Labour Charges Expenses-URD |
| 8 | Mobile Recharges | Telephone Expenses |
| 9 | Food | Travelling Expenses (own voucher, shares the ledger of 1) |
| 10 | Incentive | Incentive Expenses |
| 99 | N/A (empty category) | Miscellaneous Expenses |

- The **Voucher no.** column is the last part of the Voucher ID and the accountant's reference; it must be unique per expense type (1–99).
- Two types may post to the same ledger (Tally adds them together there; their vouchers stay separate).
- **Changing a mapping affects new syncs only.** Vouchers already in Tally keep their old ledger and number. A mapping change is never treated as an edit of every expense.
- Ledgers that do not exist are created automatically.

### Expense voucher (PesoWise → Tally)

| Field | Value |
|---|---|
| Voucher type | **Journal** |
| Date | last (or first) day of the expense month |
| Reference | narration `PWT PESO/08/02`; Tally's own number is automatic |
| Debit | the expense ledger, total of all employees in the voucher |
| Credit | one line per employee ledger, that employee's total for the month and type |
| Grouping | one voucher per (month, expense type) |

Worked example (anonymised): five Material Purchase expenses of one employee in August (60 + 120 + 500 + 20 + 50) become one **Cr 750.00** line on `Employee A-1234` inside the voucher dated 31-Aug (or 1-Aug), **Dr Consumable Stores - URD**, narration `PWT PESO/08/02`.

### Payment voucher (Tally → PesoWise)

| Tally field | Becomes in PesoWise |
|---|---|
| Voucher type must be the configured name (default **PesoWise Payment**) | accepted; other types are ignored (see open item 14.2) |
| **Dr** on the employee ledger | **Balance credit** (+ amount) for that employee |
| **Cr** side | must be Cash-in-Hand or Bank Accounts ledgers, otherwise the voucher is skipped |
| Date | effective date of the credit |
| Several employees / entries | one payment per employee; same-employee entries are summed |

Skipped or flagged, never applied: cancelled or optional vouchers, unbalanced vouchers, non-employee ledgers, vouchers narrated `PWT …` (they came from the expense sync), employees not matched exactly (the code after the last hyphen must match one active employee and the name before it must equal the employee's name). A voucher **edited or deleted after import** is flagged for manual reconciliation; its balance is not changed automatically.

### Employee account, both directions

| Event | Tally entry | PesoWise balance |
|---|---|---|
| Expense approved and synced | Dr expense ledger, **Cr employee ledger** | decreases (expense deduction) |
| Payment / advance entered in Tally and synced | **Dr employee ledger**, Cr cash or bank | **increases** (Balance credit, "Tally sync") |

### Settings and where they are changed

| Setting | Where |
|---|---|
| Expense type → ledger, voucher no. | Admin → Tally integration → Ledger mapping |
| Voucher date (last / first day of the month) | the same tab |
| Payment voucher type name | Balances → Sync from Tally |
| Voucher prefix (`PESO`), side, parent groups | stored with the mapping; not editable on the page |

### Before using a real company, the accountant confirms

1. Expenses as Journal Dr expense / Cr employee, payments as Dr employee / Cr cash-bank.
2. The date convention (month end or first day).
3. The ledger map and parent groups (Sundry Debtors, Indirect Expenses), and that Food shares Travelling Expenses.
4. The voucher prefix and numbers, and the payment voucher type name.
5. That voucher dates fall inside the Tally company's books.

---

## 8) Automatic corrections

Both corrections use the **same engine in the connector**, so no connector update was needed when edit sync was added.

### Deleted expense

| Situation in Tally | What happens |
|---|---|
| The voucher holds **only** that expense | the voucher is **deleted** |
| It holds **other expenses too** | the voucher is **altered**: only that expense's amount is removed (the employee's line disappears at zero); its reference does not change |
| Tally **refuses** the change (for example a locked period) | a **reversal voucher** `PWT REV …` is posted on the same date |
| The voucher was changed by hand, is of another type, or no longer matches what PesoWise recorded | **blocked**; nothing changes; shown under Corrections with a Retry button |

Detection: a database trigger (soft delete or hard delete) plus a safety scan about every 5 minutes. One correction per expense per company. A **restored** expense cancels a still-waiting correction. Repeating is safe (an already-gone voucher, an already-applied change, or an already-posted reversal is recognised).

### Edited expense

An edit of a **synced** expense counts when its **amount, bill month, employee or category** changes. Anything else (description, notes) does nothing. Steps:

1. A trigger marks the expense `dirty` in `pwt_edit_queue`.
2. The planner compares each already-posted expense with what was recorded when it was posted (amount, voucher month, employee code, expense type). **Mapping-independent facts only**, so changing the ledger mapping or the voucher-date setting never looks like an edit.
3. A change queues a correction of the **old posting** (reason `edited`) using the deletion engine.
4. When it completes, the registry row is dropped and the expense is queued `repost`.
5. The connector heartbeat starts one **automatic job** (20 s after the last edit, at most one a minute, never while another sync of that company runs) over the dates of the last sync, **limited to the queued expenses**. It never posts other, unsynced expenses on its own.

Live proof (Practice company): expense ₹120 edited to ₹130 → voucher `PESO/06/01` fell from 6,075 to 5,955 and a new `PESO/06/01-S1` for ₹130 appeared, in about a minute and a half with no click.

### Corrections tab

Lists every correction with its **Tally company**, the expense, the voucher, and the state. A correction for a company whose PC is offline reads "waiting for the connector of "X": its PC is offline"; for a company with no connector it says none is paired. Blocked ones show the reason and a Retry button.

---

## 9) Tally → PesoWise: Sync from Tally

On **Balances → Sync from Tally** the connector reads the vouchers of the configured payment type from the paired company and uploads them; the server re-validates everything (it never trusts the connector) and credits balances through PesoWise's existing balance engine, in one transaction with a separate sub-transaction per payment. Each voucher is identified by its Tally **GUID**, so it is never imported twice ("already imported"). Imported credits appear in **Balance credit history** marked "Tally sync" and in Import History, where a batch can be reversed.

---

## 10) The connector and installer

- **Commands:** `setup` (the installer runs this), `pair`, `run`, `doctor`, `install-startup`, `uninstall-startup`.
- **What it does while running:** heartbeat (also returns the payment voucher type name and drives automatic edit jobs); claims and delivers batches; applies corrections; creates the payment voucher type; reads payments for Sync from Tally; checks the company period before importing vouchers.
- **Install (version 1.2.6):** the installer is a self-extracting file that runs `PesoWiseTally.exe setup` directly (no cmd, no PowerShell, no VBScript). It copies the program and the TDL to `%LOCALAPPDATA%\Programs\PesoWiseTally`, asks for the pairing code in its own window, registers a per-user start-at-sign-in entry (no admin rights), starts it, and the installed copy runs with **no console window**. **The setup window never closes silently:** any failure is shown in plain words, written to `%LOCALAPPDATA%PesoWiseTallyConnectorconnector.log`, and the window waits for Enter. Copying retries for up to 15 seconds while an older connector is still stopping or antivirus is scanning the new file, and double-clicking the program with no arguments runs the setup.
- **Security of the file:** the installer embeds only the public API address and the publishable key. It is **not code-signed**, so some antivirus products flag it as a false positive. The lasting fix is a code-signing certificate; the build already signs when `PWT_SIGN_PFX` and `PWT_SIGN_PASSWORD` are set.

---

## 11) Data model

**Tables (prefix `pwt_`, RLS on, no browser policies):**

| Table | Holds |
|---|---|
| `pwt_mapping_config` | per-organisation mapping and settings (categories, prefix, voucher date policy, …) |
| `pwt_pairing_codes`, `pwt_connectors` | pairing codes (single use, 15 min) and paired PCs (device token hash, status, last seen) |
| `pwt_sync_jobs`, `pwt_job_rows`, `pwt_job_txns`, `pwt_batches` | jobs, the immutable report snapshot, staged normalised rows, XML batches |
| `pwt_registry` | every posted expense per Tally company (amount, voucher, date, ledgers, serial, expense type) |
| `pwt_vouchers` | planned / posted / released vouchers per company |
| `pwt_deletion_jobs`, `pwt_correction_log`, `pwt_deletion_state` | corrections (reason `deleted` or `edited`), their append-only audit trail, scan timing |
| `pwt_edit_queue` | expenses waiting to be checked, corrected or re-posted |
| `pwt_inbound_*` | Sync from Tally: settings, jobs, uploaded vouchers, imported payments |

**Migrations (all additive, applied in order):** `20261016120000_pwt_foundation`, `20261016130000_pwt_config_rpcs`, `20261017100000_pwt_inbound_payments`, `20261019100000_pwt_deletion_sync`, `20261019140000_pwt_registry_per_company`, `20261019150000_pwt_resumable_prepare`, `20261021100000_pwt_report_rows_setting`, `20261021140000_pwt_prepare_txns`, `20261021160000_pwt_vouchers_reuse_released`, `20261021180000_pwt_posting_date_setting`, `20261022100000_pwt_edit_sync`, `20261022140000_pwt_corrections_company`.

**Security model**

- The browser only calls `SECURITY DEFINER` functions that check the caller is an **admin of that organisation**.
- The connector authenticates with a **device token** (only its SHA-256 is stored); an admin can revoke it.
- Pairing codes are single-use and expire in 15 minutes.
- **Wrong-company protection** in two places: the server hands out work only when the connector reports the paired company active, and the connector re-checks before writing.
- Edge functions use the service role only on the server.

---

## 12) How it was built

### Method

Every step was built test-first against **real TallyPrime** (through its XML interface), with an in-process Postgres for the database parts, a fake Tally for the engine, and real-data checks that read the stored data without changing it. Anything that writes to the live PesoWise database or the server was done only with the owner's approval, on the PesoWise stack only.

### Timeline

| Date | Step |
|---|---|
| 2026-10-16 | Decision to **rebuild fresh** in its own `pwt` namespace. Engine, database foundation, three edge functions, connector, TDL generator, installer. |
| 2026-10-17 | **Sync from Tally** (payments → balances); accountant's mapping reference; balance credit history. |
| 2026-10-19 | **Deletion sync**; payment voucher type created automatically; dedicated setup page; per-company registry; large syncs in short resumable slices. |
| 2026-10-21 | Detailed Expense becomes the only report; screen reads real vouchers; **N/A** mapping; Ledger mapping drop-down, Auto map, simpler page; company period handling; voucher date setting; duplicate-key fix on retries. |
| 2026-10-22 | Installer without PowerShell; signing hook; **edit sync**; Corrections tab with company names; this document. |

### Problems found in real use, and the fix

| Problem | Cause | Fix |
|---|---|---|
| Large report stuck at "Preparing" | one request cancelled after about 12 s or 2 s of CPU; page gave up on one error | short resumable slices, normalise in chunks, the page retries |
| New empty company would not get already-posted expenses | registry was per organisation | registry per Tally company |
| Report-row ledgers cluttered Tally's ledger list | hidden ledgers per report row | off by default; screen reads real vouchers instead |
| Empty category expenses were left out | mapping needs a category | N/A → Miscellaneous Expenses |
| "Voucher date is missing" | date before the company's books begin | connector reads and moves the period; plain message; voucher date setting for editions that refuse month-end |
| Retry after a failed delivery failed with duplicate key | released voucher rows collided with the re-plan | released rows are reused |
| Screen listed manual vouchers and debit lines | a line-level hide rule does not work on the real screen | filters on the collection |
| Installer flagged as a virus | PowerShell with execution-policy bypass, hidden launcher, no signature | no scripts; signing hook; certificate still needed |
| Edited expenses were not followed | only deletion was automatic | edit sync |

### Lessons from real TallyPrime

| Lesson | Practice |
|---|---|
| Journal vouchers are auto-numbered | put the stable id in the **narration**; match read-back on it |
| A clean import response does not prove the data is there | always read back |
| Real XML has type attributes (`<DATE TYPE="Date">`) | parse with attributes; test against real Tally output |
| A filter on a walked collection ignores some natives | filter on a computed field (`$PWTDeem = "No"`); filter vouchers by narration |
| `Child Of` on Ledger collections returned nothing in TallyPrime 7 | filter a global collection by a field |
| A packaged exe cannot start a copy of itself | start the connector from outside, with the marker variable cleared |
| Task Scheduler logon tasks need admin | use the per-user `HKCU` Run entry |
| An XML company alteration needs both dates | set Financial year and Books beginning together |

---

## 13) Operating it

### Deploy checklist (self-hosted Supabase on Coolify, PesoWise project only)

1. Apply the migrations in order to the project's own database.
2. Copy `pwt-*` functions and `_shared/pwt` into the project's edge-runtime container (stream a file into the container; the host volume is root-owned). Check each file's checksum against the repository.
3. Website: `VITE_PWT_SYNC=1`, redeploy.
4. Installer: `node connector/pwtally/scripts/build.mjs`, `gen-tdl.mjs`, `build-installer.mjs`; commit the new installer in `public/downloads/` (the only file of that folder that is committed).
5. Per customer: pair with a code, load the TDL, map ledgers; nothing else.

### Troubleshooting

| What you see | Cause and action |
|---|---|
| "Waiting for the connector" | The Tally PC is off, Tally is closed, or the wrong company is open. Open Tally on the paired company. |
| "Voucher date is missing" | The company's books start after the expense month. A PesoWise-only company is fixed by the connector; otherwise Alt+F3 → Alter and set both dates earlier, or use First day of the month. |
| "Needs attention" | Read the message: unmapped type, missing employee code, or Tally refused something. |
| "Already imported" on Sync from Tally | The voucher was already imported, **or** it is not of the payment voucher type (plain Payment is ignored). |
| Correction "Needs attention" | The voucher was changed in Tally by hand or its total differs from what PesoWise recorded; sort it out and press Retry. |
| Antivirus blocks the installer | Unsigned file; allow it in Windows Security, or sign it (section 10). |
| The installer window opens and closes at once (old 1.2.5 installer) | The setup failed and the window vanished before the reason could be read. Download the 1.2.6 installer: it keeps the window open, shows the reason, and logs it. If it still ends at once with no window, the antivirus is removing the file: check Windows Security → Protection history and allow it. |

### Tests

```
npx vitest run supabase/functions/_shared/pwt connector/pwtally src/lib/pwt
node supabase/tests/pwt_deletion/*_acceptance.mjs        (in-process Postgres, needs @electric-sql/pglite)
```

---

## 14) Status and open items

### 14.1 Working and verified

Sync, mapping, N/A, voucher date setting, large syncs, per-company registry, company period handling, deletion corrections and edit corrections (live), Corrections tab, payment voucher type auto-creation, Sync from Tally for the PesoWise Payment type, the Detailed Expense screen (collection filters, verified through Tally's export with a manual voucher present).

### 14.2 Open items

1. **Plain Payment vouchers are not read by Sync from Tally.** Only the configured type (PesoWise Payment) is read, so a manual employee payment entered as a normal Payment voucher shows "already imported" for the old one and ignores the new one. A fix that also reads every voucher type under Payment was started and is **not finished or deployed**; a decision is pending because it would credit any Payment to an employee ledger.
2. **Code signing.** The installer is unsigned; some antivirus products flag it. A certificate is needed.
3. **The new TDL** (collection filters) was verified through Tally's export; it should be loaded and looked at on the real screen of each Tally PC.
4. **A restored expense** (from the Recycle Bin) after its correction has completed is not re-posted automatically.
5. **The accountant's confirmations** in section 7 are still to be signed off for a real company.

### 14.3 Known limits

- Only vouchers are corrected; edits made in Tally itself are not sent back.
- A category edit is detected only where the expense type was recorded (all new postings and most older ones).
- The re-post needs the expense to appear in the Detailed Expense dates of the last sync.
- No GST, TDS, bill-wise or cost-centre data is created.

---

## 15) Key files

```
supabase/functions/_shared/pwt/           engine: types, util, config, canonical, aggregate, prepare, slice, fetchRows, xml
supabase/functions/pwt-start-sync | pwt-run-job | pwt-connector | pwt-deletion | pwt-inbound
supabase/migrations/20261016120000_pwt_foundation.sql … 20261022140000_pwt_corrections_company.sql
connector/pwtally/src/                    engine, main, runtime, setup, period, deletion, inbound, voucherType
connector/pwtally/scripts/                build, gen-tdl, build-installer
connector/pwtally/tdl/PesoWise-Tally.tdl  generated (do not edit by hand)
public/downloads/PesoWise-Tally-Setup.exe the installer
src/pages/AdminPwTally.tsx   src/components/PwtSyncControl.tsx   src/components/PwtDeletionHistory.tsx   src/lib/pwt/
supabase/tests/pwt_deletion/              database acceptance tests
```

---

## 16) Related docs

- [DOC-146: the earlier engineering log with the full dated history](./pesowise-tally-complete-guide.md)
- [Sensitive data policy](./sensitive-local-data-policy.md)

---

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-10-22 | 1.2 | Agent | Sync from Tally: a previously imported payment is flagged "Deleted in Tally" only when the sync that last saw it read the same voucher type (switching Payment / PesoWise Payment no longer flags the other type's payments); the dialog now shows the server's real reason when a sync cannot start. Migration 20261022160000_pwt_inbound_deleted_same_type.sql (apply manually). |
| 2026-10-22 | 1.1 | Agent | Connector 1.2.6: installer never closes silently (error shown, logged, waits for Enter), retries while the file is held, no-argument run = setup; troubleshooting row added. |
| 2026-10-22 | 1.0 | Agent | Fresh single document: features, architecture, setup, sync, calculation, mapping, automatic corrections (delete and edit), Sync from Tally, connector and installer, data model, build history, operations, status and open items. |
