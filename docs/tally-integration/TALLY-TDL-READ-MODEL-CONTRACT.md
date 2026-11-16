# TallyPrime TDL read-model contract (Phase 5 → Phase 6 handoff)

**Purpose:** Exact contract for manually building TDL under **PesoWise Reports** after transport E2E is validated.  
**Source of truth for numbers/filters:** PesoWise report engine (`Reports.tsx`, export workers, RPC row producers) — TDL **reconstructs** persisted metadata only; it does not recompute business rules.

**Status:** Contract **COMPLETE** (repo). **Daily Project** TDL: `tally-extension/PesoWise-Reports.tdl` + install guide `PHASE-06-INSTALL-PESOWISE-REPORTS.md`. Other three menus **not started**.

---

## 1. Tally storage layout

| Layer | Name | Notes |
|-------|------|--------|
| **Group** | `PesoWise Metadata` | Parent: `Primary`. Created once via mapper bootstrap when first metadata ledger is emitted. |
| **Ledger** | `PW-META-{K12}-{H12}` | **Production:** immutable version per `(K, H)` — `K12` = SHA-256(`metadata_delivery_key`)[0:12], `H12` = `content_hash`[0:12]. Legacy unversioned `PW-META-{K12}` may exist from early validation only. |
| **UDF** | `PESOWISE_METADATA_JSON` | Type **String**, index **25001**. |

### 1.1 Current version selection (required for all four reports)

1. Collection: ledgers under **`PesoWise Metadata`** with non-empty UDF **25001**.
2. Parse JSON → read **`metadata_delivery_key`** (**K**) and **`metadata_revision`** (integer).
3. For each **K**, expose **exactly one** logical row: the version with **maximum `metadata_revision`** (never use `content_hash` ordering).
4. Ignore older physical ledgers for display (they remain audit history).

No vouchers, opening balance, or P&L impact on any metadata ledger.

**Accounting (separate):** Legitimate expenses use voucher type **PesoWise Expense** with stable key `{org}:acct:expense:{expense_id}`. Balance timeline events use **PesoWise Balance**. Metadata ledgers are **never** debit/credit lines and must not affect P&L or Balance Sheet.

---

## 2. JSON payload (`PesowiseTallyMetadataV1`)

Embedded in UDF after import. Schema version **1** (`schema_version: 1`).

| Field | Type | Required | Meaning |
|-------|------|----------|---------|
| `schema_version` | `1` | yes | Contract version |
| `organization_id` | UUID string | yes | Org scope |
| `report_type` | enum | yes | `claim_verification` \| `claim_approval` \| `detailed_expense` \| `daily_project_report` |
| `metadata_delivery_key` | string | yes | Logical key **K** — same as `reportMetadataDeliveryKey(org, report_type, source_key)` |
| `metadata_version_ledger_name` | string | yes | Physical Tally ledger for this **K+H** version |
| `source_key` | string | yes | Prepared item stable key (expense, timeline event, daily row) |
| `metadata_revision` | integer | yes | Monotonic per **K**; TDL current = **max(revision)** |
| `content_hash` | hex string | yes | **H** — idempotency / physical ledger suffix |
| `accounting_key` | string | no | Present when row ties to an expense voucher |
| `expense_id` | UUID | no | Expense primary key when applicable |
| `event_id` | UUID | no | Balance timeline event when applicable |
| `user_id` | UUID | no | Employee |
| `project_id` | UUID | no | Daily project row |
| `manager_approval` | string | no | Display label for manager column |
| `ho_approval` | string | no | Display label for HO column |
| `workflow_status` | string | no | Raw status from row |
| `fields` | object | yes | Report-specific frozen fields (see §4) |

**TDL read pattern:** Enumerate ledgers under group **PesoWise Metadata**, read UDF **25001**, parse JSON, filter `report_type`, sort/display per report section below.

---

## 3. Record separation

- **One ledger = one metadata delivery key = one row in one report context.**
- Same physical expense in Claim Verification, Claim Approval, and Detailed Expense → **three metadata ledgers** (different `report_type` / `source_key`) but **at most one** accounting voucher (`accounting_key` deduped in mapper).
- Daily Project rows → metadata only; `fields.derived: true`; **no** aggregate expense voucher for the row.

---

## 4. Per-report reconstruction

### 4.1 Claim Verification List

**Filter in TDL:** `report_type == "claim_verification"`.

**PesoWise inherent scope (for parity checks):** Org expenses with status ∈ `{ verified, level_1_verified, level_2_verified }` unless manager filter narrows (see PHASE-01). HO column in export is always **Pending**.

**`fields` (from mapper):**

| Key | Source row |
|-----|------------|
| `transaction_number` | expense |
| `purpose`, `destination`, `batch_ref`, `title` | expense |
| `trip_start`, `trip_end` | expense |
| `custom_fields` | org custom field map |

**Top-level metadata:** `expense_id`, `user_id`, `manager_approval`, `ho_approval`, `workflow_status`, `accounting_key`.

**Columns to mirror CSV (`CLAIM_HEADERS_FIXED` + custom + balances):** Use export worker column order from `expenseReports.ts` — employee, dates, amounts, category, custom fields, opening/closing balance columns as persisted in prepared row (worker computes balances; metadata `fields` must contain values present in prepared payload).

**Dates:** No date filter on verification tab in PesoWise UI.

---

### 4.2 Claim Approval List

**Filter:** `report_type == "claim_approval"`.

**Inherent scope:** `status = approved`. HO export cell **Approved**; manager column **Verified** (presentation).

**`fields`:** Same shape as claim verification.

**Dates:** None on tab.

---

### 4.3 Detailed Expense Report

**Filter:** `report_type == "detailed_expense"`.

**Inherent scope:** Timeline rows from `report_detailed_expense_rows_v4` (deductions, credits, balance events — see PHASE-01 §5).

**`fields`:** Event-specific (event type, debit/credit, labels, trip fields, custom fields) as frozen in prepared payload.

**Top-level:** `event_id` when timeline; `expense_id` when tied to expense; `accounting_key` when voucher emitted.

**Accounting:** Only rows classified to emit vouchers in mapper (`classifyTimelineEvent`); metadata always emitted when not SKIP.

**Date filters:** Match job `parameters.date_from` / `date_to` stored on job — TDL should filter using dates inside `fields` (effective/trip/created) consistent with prepared row.

---

### 4.4 Daily Project Report

**Filter:** `report_type == "daily_project_report"`.

**Inherent scope:** One metadata ledger per **daily row** (`source_type: daily_report_row`), key pattern `{org}:daily_row:{track_date}|{user_id}|{project_id}`.

**`fields`:**

| Key | Meaning |
|-----|---------|
| `track_date` | Report date |
| `location` | Site/location |
| `costs` | Category → amount map |
| `percent` | Category → percent map |
| `remarks` | Row remarks |
| `voucher_no` | Optional voucher reference |
| `source_expenses` | Underlying expense refs (read-only linkage) |
| `derived` | Always `true` |

**Top-level:** `user_id`, `project_id`. **No** `accounting_key` for aggregate row.

**Totals:** Sum `fields.costs` across filtered rows; percent columns from `fields.percent` — same semantics as in-browser Daily table after full paged load (PHASE-01 §6).

**Date filters:** Job `track_date` or range from enqueue parameters.

---

## 5. Filters and job parameters

TDL does not read PesoWise Postgres. For parity with a synced job:

1. Prefer embedding filter snapshot inside metadata when added to prepared payload / job record (future enhancement).
2. Until then, TDL menus may offer user filters on **metadata fields** (employee, project, date in JSON) that approximate UI filters applied at sync time.

**Frozen filters:** At sync click, backend stores job `parameters` jsonb; connector delivery is for that job only. TDL sees **resulting** metadata set, not live PesoWise.

---

## 6. XML / security expectations (transport)

- Metadata import uses **All Masters** envelope with **LEDGER** Create/Alter only.
- JSON is XML-escaped in UDF; malicious characters in remarks cannot break envelope (covered by automated escaping tests).
- TDL reads persisted UDF only — no HTTP from TDL to PesoWise required.

---

## 7. Phase 6 menu shape (reference)

```
TallyPrime → PesoWise Reports
  ├── Claim Verification List
  ├── Claim Approval List
  ├── Detailed Expense Report
  └── Daily Project Report
```

Each menu: collection from **PesoWise Metadata** / `PW-META-*` / UDF 25001 filtered by `report_type`.

---

## 8. Validation checklist (before shipping TDL)

- [ ] Ledger count stable on re-sync (SKIP → no new ledgers)
- [ ] Alter updates UDF JSON (`content_hash` change) on same `PW-META-*` name
- [ ] No opening balance on metadata ledgers
- [ ] Four menus match export column semantics (spot-check against CSV for same job)
- [ ] Daily Project shows no expense voucher duplication for aggregate rows

---

## 9. References

- [PHASE-01-REPORT-AUDIT.md](./PHASE-01-REPORT-AUDIT.md) — filters, columns, pagination
- [PHASE-04-TALLY-MAPPING-XML.md](./PHASE-04-TALLY-MAPPING-XML.md) — mapper + XML
- [PHASE-05-METADATA-LEDGER-ARCHITECTURE.md](./PHASE-05-METADATA-LEDGER-ARCHITECTURE.md) — ledger model
- `src/lib/tallyMapping/metadataSchema.ts` — TypeScript schema
