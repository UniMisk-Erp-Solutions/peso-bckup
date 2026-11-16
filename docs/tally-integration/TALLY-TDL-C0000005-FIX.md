# TallyPrime c0000005 — PesoWise TDL root cause (2026-10-07)

## Cause (static audit, no live Tally HTTP)

1. **`[#Part : Led Other Details]` in `PesoWise-Bootstrap.tdl`**  
   Bound `PESOWISE_METADATA_JSON` to a visible ledger alter field. Metadata ledgers store **large JSON** per sync row. Opening Chart of Accounts / ledger master forced Tally to load that UDF → **memory access violation**.

2. **Report collections + filters on JSON**  
   - Formula `PW Meta JSON Plain` used `$$String:$PESOWISE_METADATA_JSON`.  
   - Filters used `$$StringContains:@@PWMetaJSONPlain:...` on every ledger under `PesoWise Metadata`.  
   - Collections **Fetched** `PESOWISE_METADATA_JSON` and `PESOWISE_META_JSON_PLAIN`.  
   Opening any report walked **all** metadata ledgers and materialized huge strings → **c0000005**.

## Fix

- **Bootstrap:** UDF declarations + session variables only. **No** ledger form/part hooks.  
- **Filters:** `$PESOWISE_REPORT_TYPE` string equality only (set at sync import).  
- **Collections:** Fetch display UDFs + flat row only; **never** JSON UDFs at report time.  
- **Recovery:** `PesoWise-Reports-SafeMenu.tdl` — menu + static shells, **no collections**.

## Reload (human)

1. Quit TallyPrime completely.  
2. Copy repo `tally-extension\` → `C:\pesowise\`.  
3. F12 → load **`PesoWise-Bootstrap.tdl`** + **exactly one** of:
   - **`PesoWise-Reports.tdl`** (normal — list + drill-down), **or**
   - **`PesoWise-Reports-SafeMenu.tdl`** (recovery shells only — **never both**).
4. Quit & restart Tally → open company → Gateway → PesoWise Reports.

If T0009 duplicate style: you loaded **Reports + SafeMenu** together — F4 → remove SafeMenu (or remove Reports if testing SafeMenu only).

JSON remains on disk in ledger UDF for audit/sync; **TDL UI does not parse it**.
