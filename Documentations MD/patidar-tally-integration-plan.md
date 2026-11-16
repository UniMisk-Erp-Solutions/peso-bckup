# Patidar Travels ↔ TallyPrime: analysis and end-to-end plan

**Doc ID:** DOC-160  
**Status:** draft (plan only; nothing deployed, nothing written to any database or Tally company)  
**Last updated:** 2026-11-04  
**Owner / area:** Tally integration, Patidar Travels rollout  

---

## 1) Summary

The two-way PesoWise ↔ TallyPrime system (DOC-147, the `pwt` integration) is already built and merged. It is organisation-agnostic: nothing in it is specific to one company. Rolling it out to **Patidar Travels** is therefore mainly **data preparation, mapping and a staged pilot**, not a new build. This document analyses how Patidar's data is generated, which format it takes on the way to Tally and back, what has to be verified first, and the staged plan with a stop-and-confirm gate before every step that touches a database or a Tally company.

**What is not yet verified.** The live database on server `.46` was not reachable during this analysis (SSH and ping time out; most likely the office VPN is off). All Patidar figures below come from earlier documents (dated 2026-09-23) and from the code, and must be re-counted against the live database in Phase 0 before anything else.

---

## 2) How the data is generated (verified in code)

### 2.1 Expense flow

1. An employee submits an **expense** (`expenses`: `title`, `trip_start`, `trip_end`, `destination`, `purpose`, `total_amount`, free-text `category`, `status`, `organization_id`, `user_id`, `deleted_at`).
2. Approval follows the organisation's workflow (statuses `submitted`, `under_review`, `verified`, `level_1_verified`, `level_2_verified`, `approved`, and so on; tiers `team_leader`, `executive`, `engineer`, `admin`).
3. On final approval, `review_approve_expense_v2` runs in **one transaction**: it locks the expense and the employee's profile, subtracts `total_amount` from `profiles.balance`, and writes one `expense_balance_deductions` row (unique per expense).
4. Every balance movement is also an append-only row in `balance_ledger` (`amount_delta`, `balance_before`, `balance_after`, `entry_type`, `source_type`, idempotency key).
5. Money handed **to** an employee (cash transfer, opening credit, Tally payment) is a **balance credit** created by `_balance_apply_credit_core_v3`, idempotent by key.

### 2.2 Where the fields Tally needs come from

| Tally needs | PesoWise source |
|---|---|
| Employee ledger name | `<profile name>-<profiles.employee_id>` (code unique per organisation) |
| Expense ledger | `expenses.category` (free text, not a foreign key) mapped by name or alias in `pwt_mapping_config` |
| Amount | `expenses.total_amount` |
| Voucher date | expense date, taken to the month end (default) or first day |
| Identity of each posting | `<org>:expense:<expense id>` (stable, used for duplicate prevention) |

### 2.3 Which rows the sync reads

`report_detailed_expense_rows_v4`: every expense with `status = 'approved'` and `deleted_at IS NULL`, joined to a profile of the same organisation, dated by `trip_start`, plus non-expense balance events (credits are ignored by the sync). Only these become vouchers: debit rows of the Detailed Expense report. Recycle-bin (deleted) expenses are excluded, and later deletion or edit of a synced expense is corrected in Tally automatically.

---

## 3) Patidar-specific facts and risks

Figures are from DOC (detailed-expense-report-preview, 2026-09-23) and must be **re-counted live** (Phase 0).

| Fact | Why it matters |
|---|---|
| About 2,924 valid approved expenses (2,836 in 2026) | The first sync would create thousands of postings, grouped into one voucher per (month × expense type). Large but within the tested scale (about 25,000 rows). |
| Only 650 of them have a modern deduction row; about 2,274 are legacy approvals | The Tally sync uses the **debit column**, not the balance, so legacy expenses still post. But **voucher totals will not equal changes in PesoWise balances** for legacy rows. The accountant must understand this before sign-off. |
| 83 cash transfers and 1 opening credit in `balance_ledger`, no reconciliation anchors | Money given to employees in PesoWise today is not in Tally. Decide how opening balances start (see 6, decision D3). |
| Free-text categories | Any category not in the mapping blocks posting (`UNMAPPED_EXPENSE_TYPE`). Patidar's real category list must be compared against the mapping. |
| Employee codes (`profiles.employee_id`) | Blank, duplicate or non-matching codes block posting (`MISSING_EMPLOYEE_ID`) or make inbound payments ambiguous. Every Patidar employee needs a unique code. |
| Patidar is currently viewed on the **backup** site (`peso-backup.vercel.app`) | Decide whether the pilot runs on the backup or on production (decision D1). The backup holds a restored copy; production is a different Supabase stack. |

---

## 4) The formats

**PesoWise → Tally** (already implemented). The connector on the Tally PC posts XML to TallyPrime's local port (`127.0.0.1:9000`):

- **Masters first:** missing ledgers (one per employee under Sundry Debtors; one per mapped expense type under Indirect Expenses).
- **Vouchers:** one **Journal** per (month × expense type). Dr expense ledger (total); Cr one line per employee. Narration `PWT PESO/MM/<serial>` is the reference; Tally numbers Journals itself.
- **Read-back:** after import the connector reads the vouchers back and checks existence, balance and total before the job is marked completed.

**Tally → PesoWise** (already implemented). The connector reads vouchers of type **PesoWise Payment** (Dr employee ledger, Cr cash or bank) and uploads them; the server validates and credits balances through the existing balance engine, once per Tally GUID.

No new file format is needed. If the accountant also wants a **file-based** exchange (Excel/CSV, no connector), that would be a separate small feature and is not part of this plan unless requested (decision D5).

---

## 5) Staged plan (a gate after every phase)

| Phase | What happens | Touches | Gate |
|---|---|---|---|
| **0. Read-only analysis** | Reconnect to the live Patidar database (VPN) and run read-only counts: approved expenses by category and month; categories not in the mapping; employees without a unique code; employees whose Tally ledger name would clash; balance_ledger summary. Produce a short data-readiness report. | database (SELECT only) | You review the report |
| **1. Accountant sign-off** | The accountant confirms the section 7 checklist of DOC-147: Journal Dr expense / Cr employee, date convention, ledger map and parent groups, voucher prefix, payment voucher type, and the Tally company's books-beginning date. | nothing | Written confirmation |
| **2. Fix data** | Add missing employee codes and any missing category aliases (done through the admin screens or a reviewed script you run yourself). | database (writes, by you) | You confirm |
| **3. Pilot on a copy** | On the backup site, a **Tally test company** (a copy, never the live books): enable the "Tally integration" feature for Patidar in Master Admin, pair the connector, run Auto map, sync **one month**, compare the Tally Day Book with the PesoWise Detailed Expense total for that month, rupee by rupee. | backup DB, Tally test company | Totals match exactly |
| **4. Full history on the test company** | Sync the whole history; test an edit and a delete of a synced expense (automatic correction); enter a **PesoWise Payment** in Tally and run Sync from Tally; confirm the balance credit and the "already imported" protection. | same | Accountant approves |
| **5. Production decision** | If production Patidar is on a different stack, apply the pwt migrations there (additive, manual, in order), deploy the edge functions, set `VITE_PWT_SYNC=1`, tick the feature for Patidar only, pair the real Tally company, sync a month first. | production DB, real Tally | Your explicit approval of the exact scope |
| **6. Hand-over** | Customer guide, who runs the connector, what to do when a sync shows "Needs attention". | docs | Done |

**Hard rules for every phase:** no write to any database without your approval of the exact statements; no write to a real Tally company before Phase 3 and 4 pass; never touch the other stacks on server `.46`; no secrets in documents or chat.

---

## 6) Decisions needed from you

| ID | Decision | Recommendation |
|---|---|---|
| D1 | Pilot on the backup database or on production? | Backup first (Phase 3 and 4), production only after approval |
| D2 | Voucher date: last day of the month or first day? | Last day (default); first day only if the Tally edition refuses month-end |
| D3 | Opening balances: should existing PesoWise employee balances be created in Tally, or start from zero? | Ask the accountant; the sync does not create openings |
| D4 | Which history to post: all expenses, or only from a start date? | Start with one recent month, then widen |
| D5 | Is the connector-based sync acceptable, or does the accountant need a plain Excel/CSV export? | Connector (already built) |
| D6 | Is the Patidar Tally company a copy for testing, and who is the accountant who signs off? | Needed before Phase 3 |

---

## 7) Test plan

1. Phase 0 counts reproduce the documented figures (or the differences are explained).
2. One-month sync: number of vouchers = distinct (month × expense type); total of credits = total of debits = the PesoWise Detailed Expense total for that month.
3. Re-sync the same range: nothing new is created (duplicate protection).
4. Edit the amount of one synced expense: Tally is corrected without a click; delete one: voucher deleted, reduced or reversed.
5. Payment in Tally → balance credit in PesoWise once; a second Sync from Tally imports nothing new.
6. Wrong company active in Tally: the connector refuses to write.

---

## 8) Key files (existing system)

```
Documentations MD/pesowise-tally-system-document.md   (DOC-147, the full system reference)
supabase/functions/_shared/pwt/                        (engine: fetchRows, canonical, aggregate, config)
supabase/functions/pwt-{start-sync,run-job,connector,deletion,inbound}/
connector/pwtally/                                     (the Windows connector)
src/pages/AdminPwTally.tsx                             (setup page)
src/lib/pwtSyncGate.ts                                 (per-company feature flag)
```

---

## 9) Database / migrations

None for this plan document. The existing pwt migrations (`20261016120000_pwt_foundation` through `20261030130000_pwt_inbound_list_batch`) must be present on whichever database is used; which of them are applied on the backup and on production is **not yet verified** (several inbound files redefine the same function, so the latest applied version must be confirmed in Phase 0). The user runs all SQL manually.

---

## 10) Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-11-04 | 0.1 | Agent | Plan only: data-generation analysis, formats, risks, staged plan with gates and decisions. Live database not reachable; Patidar figures are from older documents. |
