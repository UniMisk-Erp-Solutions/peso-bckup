# PesoWise → TallyPrime implementation handoff

**Purpose:** Preserve the integration investigation, the exact Tally report-rendering fix, and verified state so a future developer or AI can continue without repeating unsafe experiments.

**Last updated:** 2026-10-09  
**Scope of this handoff:** Local integration code and the `PesoWise Integration Test` Tally company only. This is not a production-readiness declaration.

## 1. Executive status

The Daily Project report is now opening in TallyPrime and the user confirmed that the report is finally visible. The previously blank report had two separate issues:

1. The TDL collection initially returned zero when it was scoped with `Child Of : "PesoWise Metadata"` on this TallyPrime 7 installation. The collection was changed to scan Ledger masters and filter using the persisted Daily Project track-date UDF. Tally then displayed a matching-ledger count of **5,093**.
2. The report columns still rendered blank because their formula chain attempted to use `$$StringPart` as a delimiter/token splitter. `$$StringPart` extracts a substring by character position and length; it does not split a pipe-delimited string into columns. The list grid was changed to read the persisted typed `PESOWISE_DPR_*` UDFs directly from each repeated Ledger object. Expense is calculated from the eight persisted cost UDFs.

The 5,093 number is the live count shown in the Tally report diagnostic, not a count of newly imported vouchers. A separate prior read-only ODBC check identified **5,048 rows for sync run `23436815-d6ec-4833-817f-6777e957a06a`** and 45 additional older Daily Project metadata ledgers, making 5,093 in the TDL collection. The user's later confirmation establishes that the report became visible. It does not establish that all 5,093 rows, every amount, or all four PesoWise reports were independently reconciled row-by-row after the final TDL change.

The integration stores report rows as **Ledger masters in the `PesoWise Metadata` group**, with report-specific UDF values. The custom TDL report reads those masters. These metadata masters are not accounting vouchers and should not be described as voucher transactions.

## 2. Important safety boundary

- Tally company used for validation: **PesoWise Integration Test**.
- Do not alter any real accounting company.
- Do not retry the historic failed/quarantined job `e4fde933-55d1-4be2-b498-d3f5ec60904e`. Keep it quarantined until its records have been reconciled.
- Do not run a new Sync/import merely to see whether the screen changes. Use an approved, controlled synthetic job with a unique test marker and reconcile its acknowledgement and resulting Tally records.
- Do not load `03-collections.tdl` as a standalone TDL when it is already included by `PesoWise-Load.tdl`; doing so previously caused duplicate collection definition error T0009.
- Do not run the `PesoWise-Reports-SafeMenu.tdl` recovery shell when expecting data. It intentionally contains no data collections.
- The shared secret and password values disclosed during the conversation are deliberately omitted from this document. Rotate any credentials that were exposed in chat or pasted prompts.

## 3. Architecture and data lifecycle

The intended path is:

1. An authorized PesoWise admin clicks **Sync to Tally**.
2. The application requests backend report generation for the selected/current report period. The generated rows are prepared as versioned report-metadata deliveries.
3. The job is divided into durable batches. Each batch has organization scope, delivery identity, content hash/revision, and a frozen XML payload.
4. The local Windows connector pairs to the intended PesoWise organization, reads the pending batch, and checks that local connector configuration agrees with the company frozen into the batch.
5. Before claiming a batch, and again immediately before delivery, the connector calls the non-mutating active-company verification path. It must prove the current Tally company equals the configured company. A missing, ambiguous, unavailable, or mismatched identity stops delivery.
6. The connector sends the frozen import XML once to the configured Tally endpoint. It does not switch companies, auto-load another company, or automatically retry an unknown outcome.
7. A successful, clean Tally import response is acknowledged to PesoWise with create/alter/delete/ignore/exception counts. A failed or unknown result is quarantined for reconciliation rather than silently replayed.
8. The Bootstrap TDL declares UDF slots. The imported Ledger masters carry the report metadata plus typed display UDF values. The TDL collection selects the masters and the report grid displays their UDFs.

Relevant implementation entry points found during this work:

- `src/lib/tallyMapping/dailyProjectLedgerUdks.ts` builds Daily Project display UDF values and indices.
- `src/lib/tallyMapping/metaDisplayUdks.ts` builds shared report type, revision, delivery key, flat row and sync-run UDF values.
- `src/lib/tallyMapping/identities.ts` defines the `PesoWise Metadata` parent group name, append-only/versioned Tally ledger naming, and transport revision.
- `connector/tally/src/deliverBatch.ts` injects/verifies the intended company and sends a claimed batch once, followed by an acknowledgement. A failed acknowledgement is not intended to requeue the batch.
- `tally-extension/PesoWise-Bootstrap.tdl` declares UDF names and numeric slots.
- `tally-extension/tdl/03-collections.tdl` defines Ledger collections for the custom reports.
- `tally-extension/tdl/07-daily-project.tdl` defines the Daily Project report layout and its repeated data line.

The exact UI-to-backend job-generation path depends on the deployment's configured Supabase project and currently deployed functions. This document does not assert that a fresh browser click was performed after the final TDL rendering fix.

## 4. How rows are represented in Tally

### 4.1 One metadata row becomes a Ledger master

For report metadata, the connector's XML mapping creates a Ledger master under:

```text
PesoWise Metadata
```

The mapping sets `LEDGER ACTION="Create"` for a new version and writes the metadata UDFs. The design is append-only/versioned: stable delivery identity plus content hash/transport revision determines a deterministic physical Ledger name. This avoids silently altering an earlier imported version. Duplicate prevention and updates are handled by the delivery identity/revision protocol, not by creating a Tally voucher for every report row.

The import payload has been checked offline in the focused preflight test for the expected envelope/report type, company placeholder injection, parent group, Ledger Create action, metadata JSON UDF, sync-run UDF, and absence of `VOUCHER` elements. Do not infer from that unit test alone that a new live import was performed.

### 4.2 UDF field layout

`tally-extension/PesoWise-Bootstrap.tdl` assigns these UDF slots:

| UDF name | Index | Purpose |
| --- | ---: | --- |
| `PESOWISE_METADATA_JSON` | 25001 | Full versioned report metadata payload |
| `PESOWISE_REPORT_TYPE` | 25002 | Report discriminator |
| `PESOWISE_META_REVISION` | 25003 | Metadata schema revision |
| `PESOWISE_STABLE_KEY` | 25004 | Stable identity field |
| `PESOWISE_META_DELIVERY_KEY` | 25005 | Organization/report/source delivery identity |
| `PESOWISE_DPR_TRACK_DATE` | 25010 | Daily Project date displayed and used for selection |
| `PESOWISE_DPR_VOUCHER_NO` | 25011 | Daily Project source voucher/reference |
| `PESOWISE_DPR_PROJECT_ID` | 25012 | Project identifier |
| `PESOWISE_DPR_PROJECT_NAME` | 25013 | Project display name |
| `PESOWISE_DPR_EMPLOYEE` | 25014 | Employee display name |
| `PESOWISE_DPR_EMPLOYEE_CODE` | 25015 | Employee code |
| `PESOWISE_DPR_LOCATION` | 25016 | Site/location |
| `PESOWISE_DPR_REMARKS` | 25017 | Report remarks |
| `PESOWISE_DPR_PETROL_COST` | 25018 | Petrol cost |
| `PESOWISE_DPR_MATERIAL_COST` | 25019 | Material cost |
| `PESOWISE_DPR_TRAVELLING_COST` | 25020 | Travelling cost |
| `PESOWISE_DPR_PHONE_EXP` | 25021 | Phone expense |
| `PESOWISE_DPR_HOTEL_EXP` | 25022 | Hotel expense |
| `PESOWISE_DPR_TRANSPORT_EXP` | 25023 | Transport expense |
| `PESOWISE_DPR_CONTRA_BILL` | 25024 | Contra-bill amount |
| `PESOWISE_DPR_OTHER_EXP` | 25025 | Other expense |
| `PESOWISE_DPR_PERCENT` | 25026 | Percentage/share value |
| `PESOWISE_DPR_PRESENCE` | 25027 | Presence marker |
| `PESOWISE_REPORT_FLAT_ROW` | 25028 | Pipe-separated display representation, retained for compatibility/details |
| `PESOWISE_META_JSON_PLAIN` | 25029 | Plain JSON compatibility UDF |
| `PESOWISE_SYNC_RUN_ID` | 25030 | Sync-run correlation value |

The Bootstrap intentionally declares UDFs only; it does not hook large JSON values into the standard Ledger alter form. That form hook had previously been removed because it was associated with a Tally access violation during large payload use.

### 4.3 Daily Project report selection and rendering

`PWDPRLatest` in `tally-extension/tdl/03-collections.tdl`:

- has `Type : Ledger`;
- fetches the Ledger name, report type, flat row, and typed Daily Project UDFs;
- filters on the non-empty `PESOWISE_DPR_TRACK_DATE` UDF;
- deliberately does not use `Child Of` for this collection.

The `Child Of` scope was removed because the user's TallyPrime 7 report collection remained empty under that scope despite the ledgers' parent being verified separately. The diagnostic field `$$NumItems:PWDPRLatest` was added to distinguish an empty collection from a row-layout problem. Tally subsequently displayed **5,093** matching records, establishing that the collection itself was no longer empty.

The final Daily Project list line in `tally-extension/tdl/07-daily-project.tdl` reads typed values directly:

```tdl
Set as : $PESOWISE_DPR_TRACK_DATE
Set as : $PESOWISE_DPR_VOUCHER_NO
Set as : $PESOWISE_DPR_PROJECT_NAME
Set as : $PESOWISE_DPR_EMPLOYEE
Set as : $PESOWISE_DPR_LOCATION
Set as : $PESOWISE_DPR_PRESENCE
Set as : @@PWDPRRowTotal
Set as : $PESOWISE_DPR_REMARKS
```

`PWDPRRowTotal` adds the eight typed cost UDFs after converting their string values to numbers. These choices avoid runtime parsing of the JSON UDF and avoid using the broken flat-string extraction path for the visible list.

## 5. The blank-data bug: investigation and actual fix

The screen symptoms evolved and each symptom indicated a distinct layer:

| Screen/evidence | What it established |
| --- | --- |
| Gateway popup `Cannot understand. Bad formula: ''` | A TDL formula evaluation/parsing failure occurred when opening a report. |
| Daily Project report showed diagnostic count `0` | The report shell loaded, but the TDL collection did not match the stored masters. |
| After changing the collection scope, report count showed `5,093` but rows were blank | The collection now matched records; the remaining failure was in rendering column values, not record existence. |
| User later confirmed the report was finally visible after the direct-UDF row change | Visible report rendering was achieved in the test company. |

The key data-display mistake was treating `$$StringPart` as a token/split function. Tally's official reference describes `$$StringPart` in terms of string positions/length; it does not extract token N from a delimiter-separated list. Adding quotes to the pipe delimiter alone was not a sufficient fix. The reliable fix for the Daily Project list was to avoid parsing the flat string and display the separately persisted typed UDF fields directly.

This matters for future maintenance: if another report or the Daily Project drill-down still uses `@@PWFlatN`, inspect it separately. Do not assume those expressions are valid token extraction simply because the list is now visible. Replace them with direct typed UDFs where available, or implement and validate a TDL `FOR TOKEN` helper against this Tally version and a mock/test company before relying on it.

There was also a separate collection issue: restricting the Daily Project Ledger collection with `Child Of` returned no repeated rows in the user's installation even though metadata masters existed. Filtering the Ledger collection by the populated track-date UDF and fetching that UDF before the filter produced the observed 5,093 count. This is why “data is in Tally” and “custom report shows data” had to be diagnosed independently.

## 6. Company and data verification evidence

### Company isolation

All reported visual verification was in **PesoWise Integration Test**. Do not switch or load another company to reproduce. The connector code in `connector/tally/src/deliverBatch.ts` requires configured and backend company names to match and calls `verifyActiveCompany` before claim/delivery, then rechecks before XML import. This is code-path evidence, not proof that every company verification failure scenario was retested during the UI report work.

### Record counts

- TallyPrime report screen diagnostic: **5,093 matching Daily Project Ledger masters**.
- Prior read-only ODBC inspection: **5,048 records** for sync run `23436815-d6ec-4833-817f-6777e957a06a`; 5,048 distinct ledger names; the rows were under `PesoWise Metadata`, marked `daily_project_report`, and carried `PESOWISE_DPR_TRACK_DATE`.
- Same prior ODBC inspection found 45 other older Daily Project records in addition to those 5,048, consistent with the 5,093 report count.
- No new XML import, fresh synthetic test, row-by-row value reconciliation, or total reconciliation was done as part of the UI rendering fix.

The displayed count is a collection count. It does not mean 5,093 new rows were imported in the most recent click, and the imported masters are not automatically accounting vouchers.

## 7. Local files and installed TDL layout

Repository source and bundled copies:

- `tally-extension/PesoWise-Bootstrap.tdl`
- `tally-extension/PesoWise-Load.tdl`
- `tally-extension/PesoWise-Reports.tdl`
- `tally-extension/tdl/02-common.tdl`
- `tally-extension/tdl/03-collections.tdl`
- `tally-extension/tdl/07-daily-project.tdl`
- `connector/tally/bundle/tdl/02-common.tdl`
- `connector/tally/bundle/tdl/07-daily-project.tdl`
- `src/lib/__tests__/tallyMetadataE2EPreflight.test.ts`

At the time of the local test, `C:\Program Files\TallyPrime (8)\tally.ini` contained:

```ini
User TDL=Yes
TDL=C:\pesowise\PesoWise-Bootstrap.tdl
TDL=C:\pesowise\PesoWise-Load.tdl
Data=C:\Users\Public\TallyPrime\data
```

`C:\pesowise\PesoWise-Load.tdl` includes `PesoWise-Reports.tdl`, which includes `tdl\01-menu.tdl` through `tdl\07-daily-project.tdl`. The installed `C:\pesowise\tdl\02-common.tdl` and `C:\pesowise\tdl\07-daily-project.tdl` were synchronized from repository source. Repository, bundle, and installed copies were hash-checked for equality during the fix.

The process must restart/reload after a TDL file change because the running Tally process evaluates its loaded in-memory TDL set. A restart performed before the latest file copy does not load that latest version.

## 8. Tests and their limits

Focused automated test command:

```powershell
npx vitest run src/lib/__tests__/tallyMetadataE2EPreflight.test.ts
```

Latest run after the direct-field rendering change: **5 tests passed**. The test checks collection/filter expectations, typed-UDF use in the Daily Project list, a representative offline metadata XML mapping, and connector preflight protections. It is not a Tally TDL compiler, it does not launch Tally, and it does not prove the 5,093 cells were all populated.

Earlier attempts that failed the focused test were corrected before the final passing run. Do not cite those intermediate test failures as the final test status.

## 9. Known remaining work (do not conceal)

1. **Validate the actual report fields/totals:** the user confirmed the report is visible, but there is not yet recorded evidence of a sample row checked against its source, sum totals, or all 5,093 rows traversed/reconciled.
2. **Check drill-down formulas:** `PWFlat1`–`PWFlat23` and report detail views still use the flat-row extraction scheme. `$$StringPart` is not a delimiter token extractor. The visible list was corrected to direct UDF values; drill-downs and the other three reports still require their own validation/fix where they depend on `@@PWFlatN`.
3. **Test all four report families:** Daily Project, Claim Verification, Claim Approval, and Detailed Expense need controlled, mock/synthetic end-to-end validation for row count, amount totals, repeat sync, content updates, and duplicate prevention.
4. **Perform a fresh controlled Sync:** after authorization and company/readiness preflight, run a uniquely tagged synthetic report job in the test company. Capture job ID, sync-run ID, batch acknowledgements, Tally import counts, Tally row values and totals. Do not use or retry the historical quarantined job.
5. **Verify current installed version/TDL load state:** confirm the final file timestamps/hashes and loaded TDL list after a fresh restart. Do not assume the TDL Management screen's “Loaded” status identifies the exact path/content hash.
6. **Do not claim production readiness:** a complete browser-click-to-database-to-connector-to-Tally controlled E2E, production database migration/deployment status, EXE/installer package validation, and live company safety proof remain separate gates.

## 10. Recommended next run for another AI/developer

Start by reading this handoff and the exact listed files. Do not reset the implementation, delete Tally company data, or retry quarantined batches.

1. Verify current Tally company is still exactly `PesoWise Integration Test`; use only non-mutating identity verification and read-only queries at first.
2. Compare source, bundle, and installed TDL file hashes. Verify the installed Bootstrap and Load paths in `tally.ini` and the include chain. Do not separately load included files.
3. Read a small set of exact Daily Project Ledger masters via read-only ODBC. Compare `Name`, report type, track date, project, employee, all cost UDFs, remarks, and sync-run UDF against source rows. Record redacted evidence and totals.
4. Open Daily Project after the installed TDL has been reloaded. Verify at least first/middle/last visible row samples, total expense calculation, and scrolling/pagination. Confirm the screen count and database query count have a defined scope and reconcile the 45-row difference.
5. Fix the detail view using direct UDFs. For Claim Verification, Claim Approval and Detailed Expense, use their stored metadata/schema and a real safe row sample. Avoid using `$$StringPart` as a pipe split function. If using a TDL `FOR TOKEN` helper, validate its Tally 7 behavior in a controlled test before packaging it.
6. Run offline tests first. Then run the authorized synthetic test through the full app → backend → job → batch → connector preflight → claim → XML → Tally response → acknowledgment path in the test company. Capture clean import response and verify the resulting Ledger rows/TDL screens.
7. Repeat synchronization and update cases to verify idempotency/versioning. Inject timeout, wrong company, unavailable company, duplicate acknowledgement, expired claim, and manual review cases without risking production data.
8. Build/inspect the Windows package only after connector safety tests pass. Verify `version` and `doctor`; confirm startup does not replay old pending batches. Do not distribute the artifact until it is validated.
9. Update the runbook with measured PASS/FAIL evidence, exact versions and hashes. Keep production deployment separate and require explicit authorization.

## 11. References

- Official Tally TDL symbols/functions reference, including `$$StringPart` parameter behavior and function argument syntax: <https://help.tallysolutions.com/symbols-and-prefixes-in-tdl/>
- Official Tally TDL procedural capabilities reference, including the `FOR TOKEN` loop: <https://help.tallysolutions.com/what-are-tdl-procedural-capabilities/>
- Repository runbook: `docs/E2E-PRODUCTION-RUNBOOK.md`

## 12. Report layout alignment (2026-10-12)

The report list layouts were expanded to present all standardized PesoWise fields as row columns, with horizontal and vertical scrolling. Each report retains Enter-to-open detail view. The fixed column counts now match the persisted connector row contracts: Claim Verification 19 (18 pipe-row fields plus mapped LPO), Claim Approval 19, Detailed Expense 15, and Daily Project 23 (exactly `DAILY_PROJECT_REPORT_HEADERS`). Claim trip-start appears once, and Detailed Expense shows credit/debit without inventing a duplicate derived-amount source column.

The claim and detailed-expense connector mapping previously emitted only the common metadata UDFs even though the bootstrap schema and TDL expected typed report UDFs. Both the frontend mapper and Supabase Edge `_shared` mapper now emit those typed UDFs. An offline parity regression test asserts the two implementations produce identical UDF payloads and checks representative employee and amount values. Daily Project already emitted its additional typed fields through `buildDailyProjectLedgerUdks`.

Source TDL, EXE bundle TDL, and the explicit local install at `C:\pesowise` were synchronized. The current Bootstrap, Claim Verification, Claim Approval, Detailed Expense, and Daily Project source and bundle hashes match; the installed `C:\pesowise\tdl\07-daily-project.tdl` matches source. A backup of the previous root install files is under `C:\pesowise\backup\report-layout-20261012`.

Verification: five focused Vitest files pass 34/34; application `npx tsc --noEmit --pretty false` passes. This is source and file-install evidence only. Tally must reload/restart to evaluate the new grid layout. The current run did not perform a Tally import or prove live values in all four report screens. Existing metadata rows created before this mapper fix may not have the new claim/detailed typed display UDF values; those reports need a controlled refresh/sync after Tally is reloaded. Organization-specific dynamic custom fields are stored in metadata but are not enumerated as fixed TDL grid columns; the layouts cover standardized PesoWise columns only.
