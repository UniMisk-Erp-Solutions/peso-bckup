# Phase 6 — See PesoWise reports inside TallyPrime

**Sync to Tally** (Phase 5) stores report rows as metadata ledgers (`PW-META-…` under **PesoWise Metadata**). That is **not** the same as the Excel-style grid in PesoWise until you load the **TDL** in this repo.

## Daily Project Report (available now)

### 1. One-time: load TDL in TallyPrime

Configure **two local TDL files** (same folder, e.g. `C:\pesowise\`):

| File | Purpose |
|------|---------|
| `PesoWise-Bootstrap.tdl` | UDF 25001 + ledger screen |
| `PesoWise-Reports.tdl` | Daily Project report menu |

1. **F12** → **TDL Configuration** → **F4: Manage Local TDLs**.
2. Add **both** files with **Load = Yes**.
3. **Do not** put `[Include : …Reports.tdl]` inside Bootstrap if Reports is also in this list (causes **T0009 duplicate report**).
4. TDL Management must show **2 Loaded, 0 errors**.
5. **Ctrl+Alt+R** or restart Tally.

### 2. Sync from PesoWise (with flat columns)

After you **deploy edge** (mapper writes display UDFs on each daily row ledger):

```powershell
node scripts/tally-integration/deploy-e2e-controlled-stack.mjs
```

Then in PesoWise: **Reports → Daily Project → Sync to Tally** and wait for **Delivered to Tally (N/N)**.

**Note:** Ledgers synced *before* this update only have JSON in UDF 25001 — re-sync Daily Project once so TDL columns populate.

### 3. Open reports in Tally

**Gateway of Tally → PesoWise Reports (O)** then:

| Key | Report |
|-----|--------|
| **V** | Claim Verification List |
| **A** | Claim Approval List |
| **E** | Detailed Expense Report |
| **D** | Daily Project Report |

Do not use Display More Reports — that menu name is not valid for TDL on TallyPrime Gold.

The grid uses the **same 23 column headers** as PesoWise `DAILY_PROJECT_REPORT_HEADERS`. Row values come from flat ledger UDFs when present, otherwise from **`PESOWISE_METADATA_JSON`** (so existing syncs still fill Track Date, employee, project, costs, Remarks, **Presence (P)**, and **percent** when stored in JSON).

**Total Resource, Food, Over Time, Other Remarks, Site Id/RO Code** stay blank in Tally unless your org maps them in PesoWise (they are often blank in the web report too).

**Empty report / one bad row?** Press **Ctrl+Alt+R** after updating TDL under `C:\pesowise\`. Confirm company **PesoWise Integration Test** is open (not TallyPrime Server alone on port 9000).

Optional: `BACKFILL_LIMIT=5000 node scripts/tally-integration/backfill-dpr-flat-udfs.mjs` with the company open (Alter may fail on TP7; the JSON fallback still renders the report).

### Duplicate rows

Re-sync creates **new physical ledgers** per content change (append-only). The report lists all daily metadata ledgers. Hide old versions in Tally or re-sync on a clean company for a single generation.

## Other three reports

Claim Verification, Claim Approval, and Detailed Expense still need TDL menus (same metadata JSON, different `report_type`). Contract: [TALLY-TDL-READ-MODEL-CONTRACT.md](./TALLY-TDL-READ-MODEL-CONTRACT.md).

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Only thousands of `PW-META-*` in Chart of Accounts | Expected until TDL loaded — use **Display More Reports** menu above |
| Report empty after load | Re-sync Daily Project after edge deploy; confirm ledgers under **PesoWise Metadata** |
| `EXCEPTIONS` during delivery | Tally rejected XML — check connector log; ensure bootstrap UDF indices match TDL |
| Menu missing | **Ctrl+Alt+R** after copy; Gateway line must use **`Key Item`** (not `Menu Item`). Hotkey **O** = PesoWise Reports. F12 must show **2 loaded, 0 errors** for *both* files — if Reports has errors, only Bootstrap loads and **no menu** appears. |
| Submenu gray / not clickable | Submenu lines must be **`Key Item : … : V/A/E/D : Display : PW … Report`** (plain **`Item`** without Display stays disabled). Reload **`C:\pesowise\PesoWise-Reports.tdl`**, **Ctrl+Alt+R**. Reports open **empty** until sync — that is OK. |
| `tally.ini` only lists Bootstrap | OK — still add **PesoWise-Reports.tdl** in **F12 → Manage Local TDLs** with Load = Yes (do not rely on tally.ini alone). |
| T0008 Display More Reports | Remove that menu hook from TDL — use Gateway of Tally only |
