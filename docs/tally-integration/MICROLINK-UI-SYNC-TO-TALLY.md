# MicroLink — click Sync → data in Tally (local E2E)

## One-time setup

1. **Pair Agent to MicroLink** (not smoke org):
   ```powershell
   $env:TALLY_ORG_ID = "6709c1fe-e8c8-404d-bc68-d1edda923344"
   # create code + pair — see pair-org-agent.ps1
   ```

2. **Deploy edge** (once after pull — adds `job_batches` action):
   ```powershell
   node scripts/tally-integration/deploy-e2e-controlled-stack.mjs
   ```

3. **TallyPrime** open, ODBC/HTTP **9000**, company name matches UI field.

## Every dev session (fix `localhost refused to connect`)

**`localhost:3000` only works while Vite is running.** If the browser shows *connection refused*, start the stack and **leave that terminal open**:

```powershell
cd "c:\Users\admin\Desktop\priyanshu intern\test project\peso-bckup-priyanshu"
npm run start:reports
```

Same as `dev:microlink-tally` — starts **bridge** (`127.0.0.1:9876`) + **http://localhost:3000**.

## Real test checklist (before Sync)

| Check | Value |
|--------|--------|
| Login | `admin@microlink.com` / `qwertyui` |
| TallyPrime open | Company **`PesoWise Integration Test`** (only company on this test PC) |
| Reports → Tally company field | **`PesoWise Integration Test`** → **Save company** |
| Bridge line under the field | “Local delivery bridge is running…” |

## Click flow — **exactly when you can look in Tally**

1. Open **http://localhost:3000/admin/reports** → tab for the report you want (e.g. Claim Verification, Daily Project).
2. Click **Sync to Tally** once (do not close Vite or Tally).
3. Watch the grey status line under the buttons:

| UI message | Meaning | Look in Tally? |
|------------|---------|----------------|
| Preparing data on server… | Backup is building rows | **No** — wait |
| Delivering to Tally on this PC… | Bridge is posting XML | **No** — wait |
| **Delivered to Tally (N/N batches)** | All batches acked OK | **Yes — now** |
| Delivery issue: … failed … | Tally rejected some batches | Fix company/bridge; sync again |

**Timing:** small jobs **~30–90 s**; full MicroLink Claim Verification **~3–6 minutes** (thousands of rows, ~200 batches).

4. In **TallyPrime** (company **`PesoWise Integration Test`**):

| What you synced | Where to look (not Day Book for current build) |
|-----------------|------------------------------------------------|
| Any report via Sync | **Gateway of Tally → Chart of Accounts → Ledgers** — search altered/created ledger names |
| **Same grid as PesoWise Daily Project** | Load **`tally-extension/PesoWise-Reports.tdl`** → **Display More Reports → PesoWise Daily Project** (see [PHASE-06-INSTALL-PESOWISE-REPORTS.md](./PHASE-06-INSTALL-PESOWISE-REPORTS.md)). Re-sync Daily Project after edge deploy so column UDFs are written. |
| “Report” as a Tally menu (other 3 tabs) | TDL for Claim / Detailed not shipped yet — sync still lands metadata on ledgers |

**Rule:** You only treat sync as successful when the UI shows **Delivered to Tally (all batches)**. That is the moment records should exist under **Ledgers** for that company.

No separate `run` loop required when bridge is running.

## One click — all 4 report tabs

Each tab has its own **Sync to Tally** (Claim Verification, Claim Approval, Detailed Expense, Daily Project). **One click = one report type only.**

| Do | Don't |
|----|--------|
| Click **Sync once**, leave page open until **Delivered (N/N)** | Click Sync again while batches are delivering (409 in console is OK) |
| Use **`npm run start:reports`** before testing | Close the PowerShell window running Vite |
| Company **`PesoWise Integration Test`** in UI + TallyPrime | Use company name **MicroLink** on this PC |

Large syncs (10k+ rows) use **chunked batch build** on the server (5–20 min). Bridge delivery is **~½–1 s per batch** (e.g. 303 batches ≈ 3–6 min).

Verify stack: `npm run verify:tally-sync` (optional; needs SSH password file + bridge up).

## Production note

Local bridge is for **dev on the Tally PC only**. Production uses always-on `PesoWise-Tally-Agent.exe run` paired to each org.
