# Sync → Daily Project report in Tally (checklist)

Use this every time you change TDL or sync mapper code.

## One-time on this PC

1. Copy latest TDL to `C:\pesowise\` (Bootstrap + Reports).
2. **F12 → Manage Local TDLs** — both files **Load = Yes**, **0 errors**.
3. Tally company **PesoWise Integration Test** open; **TallyConnector** running (bridge `127.0.0.1:9876`).

## After mapper / edge changes (required for “Sync” to fill report columns)

```powershell
cd peso-bckup-priyanshu
node scripts/tally-integration/deploy-e2e-controlled-stack.mjs
```

Wait for `DEPLOY_E2E_CONTROLLED_OK`.

## Each sync (user clicks **Sync to Tally** in PesoWise)

1. Job finishes **Prepared** then connector shows **Delivered to Tally**.
2. Each new daily row ledger gets: flat columns, **pipe row (25028)**, **plain JSON (25029)**, and list JSON (25001).
3. In Tally: **Ctrl+Alt+R**, then **Gateway → PesoWise Daily Project (P)**.

## Why rows were blank before

- **~7377** ledgers matched the report, but column formulas used **`$$`** instead of Tally’s **`@@`** user formulae, so cells stayed empty.
- Old sync XML only stored **list JSON**; the report now reads **plain JSON** + **pipe row** on every **new** create after deploy.

## Existing ledgers (synced before this fix)

They still have JSON only. The updated TDL reads that JSON via **`@@PWMetaJSONPlain`**. If a row is still empty, run **Sync to Tally** again (new content creates new ledgers with flat fields) or use a clean test company.

## Verify one ledger (optional)

With company open in Tally, open any **PW-META-…** ledger under **PesoWise Metadata** → alter screen should show **PesoWise metadata** and DPR storage fields after Ctrl+Alt+R.
