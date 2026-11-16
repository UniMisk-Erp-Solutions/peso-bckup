# PesoWiseConnector.exe (Production Agent)

**Status:** Phase 4 complete — standalone Windows executable for customer PCs.

## What it does

- Outbound HTTPS to PesoWise (`tally-connector` Edge): heartbeat, claim delivery batches, ACK results.
- Inbound only to **TallyPrime on localhost:9000** (XML import).
- **No browser**, **no npm**, **no dev bridge** (`:9876`) in production builds.
- Default command: **`run`** (infinite service loop with backoff reconnect).

## Build (developers)

```powershell
cd connector/tally
npm install
npm.cmd run package:win
```

| Output | Notes |
|--------|--------|
| `dist/PesoWiseConnector.exe` | **Primary** product name |
| `dist/PesoWise-Tally-Connector.exe` | Alias (same binary) |
| `dist/PesoWise-Tally-Agent.exe` | Alias (legacy) |
| `dist/BUILD_INFO.txt` | Version + build timestamp |

Script: `connector/tally/scripts/build-win-exe.mjs` (pkg, `node18-win-x64`, GZip).

## Customer setup

1. **Pair once** (Setup wizard Phase 5, or CLI):

   ```powershell
   PesoWiseConnector.exe pair --url https://YOUR-SUPABASE --anon-key ANON --code PAIRING --name "Office PC"
   ```

2. **Config:** `%USERPROFILE%\PesoWise\TallyConnector\config.json`

3. **Run:**

   ```powershell
   PesoWiseConnector.exe run
   ```

4. **Logon auto-start** (optional):

   ```powershell
   powershell -ExecutionPolicy Bypass -File connector\tally\scripts\install-connector-production.ps1 -ExePath "C:\Program Files\PesoWise\PesoWiseConnector.exe"
   ```

   Scheduled task name: **`PesoWiseConnector`**.

## Observability

| Path | Purpose |
|------|---------|
| `%USERPROFILE%\PesoWise\TallyConnector\connector.log` | Rotating log (~2 MB → `.1`), token redaction |
| `%USERPROFILE%\PesoWise\TallyConnector\health.json` | Last heartbeat, Tally reachability, last batch ACK |

## CLI

| Command | Production |
|---------|------------|
| `run` | Yes (default) |
| `pair` | Yes (one-time) |
| `doctor` | Yes (JSON diagnostics) |
| `version` | Yes |
| `serve` / `bridge` | **No** — blocked when packaged unless `PESOWISE_ALLOW_DEV_BRIDGE=1` |

## Dev vs production

| | Development | Production |
|--|-------------|------------|
| Entry | `npm run dev` → Vite + `main.js serve` + bridge `:9876` | `PesoWiseConnector.exe run` |
| UI delivery nudge | Browser calls `/v1/deliver-job` on bridge | Not required — connector claims from cloud |
| Delivery code | `deliverClaimedBatch` (Phase 3+) | Same |

## Version

Current agent string: **`0.4.0-production`** (`connector/tally/src/doctor.ts` → heartbeat + doctor).

## Related docs

- `connector/tally/README-PRODUCTION.md`
- `docs/Phase-4-Report.md`
- `docs/07-setup-installer.md` (Phase 9 — bundles this EXE)
- `docs/08-health-dashboard.md` (Phase 8 — reads `health.json` / cloud heartbeats)
