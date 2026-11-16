# PesoWise → TallyPrime V2 (production)

## Architecture (one writer, one reader, one contract)

| Layer | Responsibility |
|-------|----------------|
| **PesoWise** | Existing report engines prepare rows → `tally_sync_job_items` |
| **Edge** | `mapPreparedJobItems` with **`presentation_only: true`** (default) → metadata **LEDGER** XML only |
| **PesoWiseSync.exe** | Paired device claims batches → Tally HTTP `:9000` → ack when Tally **Created/Altered** masters |
| **TDL** | Collections on **PesoWise Metadata** group → read **flat UDFs** (`PESOWISE_REPORT_FLAT_ROW`, DPR fields) — **never parse JSON at report time** |

## Deliberately removed from the default path

- Expense/balance **vouchers** for the four reports (no accounting side effects).
- PW-Emp / PW-Cat master + voucher bootstrap for report sync.
- Journal “metadata voucher” experiments.
- Multiple competing delivery semantics.

Opt-in legacy accounting: job parameter `tally_accounting_vouchers: true` (off by default).

## Data contract

Each report row → one **metadata ledger** under `PesoWise Metadata`:

- `PESOWISE_REPORT_TYPE` — filters TDL collection
- `PESOWISE_REPORT_FLAT_ROW` — pipe columns for Claim / Approval / Detailed
- `PESOWISE_DPR_*` — Daily Project columns
- `PESOWISE_SYNC_RUN` — snapshot id from PesoWise Sync click
- Optional `PESOWISE_METADATA_JSON` on **Create** only (audit; not read by TDL)

## Customer flow

1. `PesoWiseSync.exe` or `PesoWise-for-Tally-Setup.exe` (same file) — pair once.
2. Tally: load TDL from `C:\pesowise`, HTTP 9000.
3. Reports → **Sync to Tally**.

## Recovery tag

Before major changes: `git tag pre-tally-v2-rebuild` (local).
