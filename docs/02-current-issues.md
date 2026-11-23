# Current Issues (Summary)

> **Phase 2 complete (2026-10-08).** See [`Phase-2-Report.md`](Phase-2-Report.md) for proof.

## Confirmed root causes — empty Daily Project report

| ID | Root cause | Proof summary |
|----|------------|---------------|
| **RCA-A** | **Duplicate-only Tally ack** (`CREATED=0`, `ALTERED=0`, `EXCEPTIONS>0`) treated as success; **UDFs not updated** on existing ledgers; TDL filter **`PESOWISE_DPR_TRACK_DATE`** excludes rows | Job `3a4f4614…`: 88/88 batches XML has DPR UDFs; 88/88 acks duplicate-only; `_phase2-batch-udf-audit.mjs` |
| **RCA-B** | **SafeMenu TDL** — placeholder report, no ledger collection | `PesoWise-Reports-SafeMenu.tdl` + `00-safe-report-shells.tdl` |
| **RCA-C** | **All-skipped enqueue** (no `tally_force_refresh`) — zero XML sent | 1 skipped batch / 435 rows (initial job state) |
| **RCA-D** | **Tally HTTP company not bound** — imports don’t land in active company | Idle HTTP probe; metadata group export 0 |

**Phase 3 fix (2026-10-08):** Connector unified on `deliverClaimedBatch`; duplicate-only ack **fails** unless UDF refresh; UI tracks `tally_udf_refresh_unconfirmed`. See [`Phase-3-Report.md`](Phase-3-Report.md).

**Operator recovery for old jobs:** `node scripts/tally-integration/reset-duplicate-delivered-batches.mjs <job_id>` then re-deliver with updated connector.

## Other production blockers (unchanged from Phase 1)

See [`Phase-1-Report.md`](Phase-1-Report.md) § Production blockers.

## Active incident at Phase 2 audit

- Job **`7b6ae66e-805a-4b41-acc1-5fc91e3e5bdf`**: `waiting_for_connector`, **88 pending** — connector not running / not claiming (delivery stall, not empty-report RCA).
