# PesoWise Tally UI redesign (v2)

Four native TallyPrime reports under **Gateway → PesoWise Reports (O)**. Each report uses a **list view** (6–8 columns) and **Enter** opens a **detail view** with all PesoWise fields from the flat row / ledger UDFs / JSON.

## Layout

| Layer | Behavior |
|-------|----------|
| Header | PesoWise brand, report title, “Synced from PesoWise”, period note |
| Column header | Fixed widths, separated labels (no concatenation) |
| Body | Scrollable rows, Tally selection |
| Empty | Centered message — not inside the grid |
| Footer | Record count + report total (amount / expense) |

## Source files

| File | Role |
|------|------|
| `tally-extension/PesoWise-Bootstrap.tdl` | UDF indices (unchanged transport contract) |
| `tally-extension/PesoWise-Reports.tdl` | Entry — includes `tdl/*.tdl` |
| `tally-extension/tdl/01-menu.tdl` | Gateway menu |
| `tally-extension/tdl/02-common.tdl` | Formulas, shell header/empty, totals |
| `tally-extension/tdl/03-collections.tdl` | Latest-revision collections |
| `tally-extension/tdl/04–07-*.tdl` | List + detail per report |

Mirror copy for manual install: `docs/tally-integration/tdl-proposed/` (see `BUILD-GUIDE.md`).

## Data parity

- Row values come from **`PESOWISE_REPORT_FLAT_ROW`** and ledger UDFs written by the mapper — same as before; only presentation changed.
- **Latest revision only:** collection filter `PW Is Latest Row` (max `metadata_revision` per `metadata_delivery_key`). TypeScript mirror: `dedupeLatestMetadataRevisions()`.
- **Cross-report / cross-org:** collections filter by `report_type` in JSON; tests in `tallyReportUiContract.test.ts`.

## List columns (contract)

Defined in `src/lib/tallyMapping/tallyReportUiContract.ts` — must stay aligned with TDL.

## Not in v2 TDL (documented gaps)

- **Frozen sync job filters** in header (period/project/employee) — metadata does not yet store job `parameters`; header shows generic period note until `sync_snapshot` is added to metadata.
- **Sync history / multiple snapshots** — all synced rows for that report type appear; job identity not grouped in UI yet.
- **Parse error banner** — if JSON/flat row missing on a ledger, row may show blank fields; full diagnostic part is planned when `PESOWISE_META_JSON_PLAIN` validation formula is confirmed on TP7.
- **Daily Project** PesoWise-only columns (Total Resource, Food, Over Time, Site Id/RO Code, Other Remarks) — remain in JSON / web export; detail view shows synced cost columns + remarks (same as prior TDL scope).

## Install

See [PHASE-06-INSTALL-PESOWISE-REPORTS.md](./PHASE-06-INSTALL-PESOWISE-REPORTS.md) and [tdl-proposed/BUILD-GUIDE.md](./tdl-proposed/BUILD-GUIDE.md).
