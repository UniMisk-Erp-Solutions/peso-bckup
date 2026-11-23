# Live Tally report visibility and Claim Verification rows

## What was wrong

On 12 October 2026, the connector log showed job `fd5c7c53-457b-4297-be77-fc43300d8150` completed with one batch and no delivery failures. The app showed Tally's clean import response (`5 created, 0 altered`). A read-only Export request to Tally's already-loaded `PW Claim Ver Latest` collection then returned five ledger objects in the active `PesoWise Integration Test` company. Each had `PESOWISE_REPORT_TYPE=claim_verification` and a non-empty `PESOWISE_REPORT_FLAT_ROW` containing the claim data.

The same export did not include the per-column `PESOWISE_CLAIM_*` UDF values. The Claim Verification TDL list rendered those UDFs directly, so the report body appeared empty even though the records existed. In addition, an already-open Tally report keeps a screen data snapshot until refreshed; a successful XML import does not itself redraw that UI.

## Changes made

- Claim Verification and Claim Approval fields now use the typed UDF first and fall back to their matching one-based token in `PESOWISE_REPORT_FLAT_ROW`. This lets the existing five rows display without replaying or altering them.
- The claim flat-row serializer now includes the LPO number as field 19 for future generated rows.
- All four PesoWise list reports start a 10-second `Refresh Data` timer when opened. Pressing Esc on the report list stops that timer and exits the report. Therefore a report left open should pick up a completed Sync without closing and reopening Tally or manually refreshing the screen.
- The connector now performs a read-only Tally Export after a clean import. Its request is filtered to the exact `PW-META-*` ledger names in that batch, rechecks the active company first, and verifies report type plus non-empty flat-row data. A mismatch is acknowledged as a failure for reconciliation rather than presented as a completed import. The Reports status can display the read-back row count.
- Updated source TDL was copied to the PesoWise-only install directory `C:\pesowise` and the connector bundle. No other Tally company or Coolify project was accessed or modified.

## Activate the TDL update once

The running Tally process keeps loaded TDL definitions in memory. Copying a `.tdl` file does not replace the definitions already loaded in that process. Reload the PesoWise TDL set once using TallyPrime's Manage Local TDLs/Refresh TDL action, or restart TallyPrime once. Confirm `PesoWise-Bootstrap.tdl` and `PesoWise-Load.tdl` show Loaded, then reopen Claim Verification. This one-time activation is needed for the new fallback and refresh timer; routine Syncs after that do not need a screen refresh or Tally restart.

## Evidence and limits

- Active company verification through the local connector returned `PesoWise Integration Test`.
- Read-only Export of `PW Claim Ver Latest` returned 5 `LEDGER` objects, all with report type `claim_verification` and populated flat rows. This is proof of stored data, not proof that the updated TDL is loaded in the current GUI session.
- The connector's new batch-filtered inline collection Export request was validated against official Tally XML/TDL collection examples and unit tests, then sent read-only to the verified test company: HTTP 200, **5 expected / 5 found**, no missing ledger names.
- Connector log recorded `batches_attempted=1`, `batches_succeeded=1`, and `batches_failed=0` for the job above.
- The modified TDL has not yet been reloaded and visually confirmed in TallyPrime. The new connector source is built, but the existing bridge process still needs a controlled restart to load the read-back gate. After those one-time activations, verify that the five current claim rows populate and that a later Sync appears within the timer interval. If Tally reports a TDL syntax error, capture it; the installed TDL parser is the final compatibility check.

## References

- [Tally XML interface](https://help.tallysolutions.com/article/DeveloperReference/integration-capabilities/using_XML_interface.htm) documents Export requests for collections.
- [TDL timer and Refresh Data action](https://help.tallysolutions.com/actions-events-buttons-keys-in-tdl/) documents refreshing a report from a timer event.
- [TDL procedural `FOR TOKEN`](https://help.tallysolutions.com/what-are-tdl-procedural-capabilities/) documents extracting pipe-delimited values.

## Follow-up after the blank Claim Verification screen — 12 October 2026

The user reported that horizontal and vertical scrolling still showed no claim values, and the Claim Approval list was also blank. New read-only Exports were sent only after the local bridge health check confirmed the active company as `PesoWise Integration Test`. The exports omitted `SVCURRENTCOMPANY`, so they did not select or switch companies. Tally returned status `1`: **5 Claim Verification** and **68 Claim Approval** ledger rows were present under `PesoWise Metadata`, and all 73 had non-empty `PESOWISE_REPORT_FLAT_ROW` values. None exported a typed `PESOWISE_CLAIM_EMPLOYEE` value. This confirms the data remains stored and the visible failure is in TDL field materialization/rendering, not scrolling or missing records.

The flat-row fallback previously compared its requested field number with `$$LoopIndex`. Replaced that ambient index dependency with a function-local numeric counter incremented inside the documented `FOR TOKEN` loop. Updated the source, connector bundle, and `C:\pesowise\tdl\02-common.tdl`; all three SHA256 values match. Added an offline assertion for the explicit counter; `tallyMetadataE2EPreflight.test.ts` passes 9/9.

This edit has not been compiled by TallyPrime's TDL parser or visually confirmed in the live report. The currently running Tally process must load this revised `02-common.tdl` and the related report files before the open Claim Verification grid can evaluate the fallback. Tally documents `Refresh TDL` for reloading files in-session, and `Refresh Data` for refreshing report data; the report timer is intended to handle later Syncs once that TDL set is active. The current blank screen is therefore still a FAIL pending runtime reload and visual row confirmation; do not treat the successful XML read-back or offline test as proof that the screen now renders.

A scoped attempt to fill the missing display UDFs using a direct Import Data request returned `Unknown Request, cannot be processed`; subsequent read-only Export still showed all 73 rows without typed employee values. No ledger or voucher was altered by that attempt. The unsupported request was discarded; do not retry it. Tally's documented master-import format must be used through the connector's verified delivery path after the active TDL schema is loaded.
