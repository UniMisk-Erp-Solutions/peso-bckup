# Agent preflight / doctor (read-only)

## Command

```text
node connector/tally/dist/main.js doctor
```

Packaged: `PesoWise-Tally-Connector.exe doctor` (same binary as future Background Agent).

## Checks

- Agent version
- Config present + paths
- Backend HTTPS + device token (heartbeat only)
- Organization / connector ids from config
- `127.0.0.1:9000` reachable
- Configured Tally company name appears in company list export
- Log directory writable

## Does NOT

- claim / ack batches
- POST import XML to Tally
- create ledgers or vouchers
- mutate queue or delivery state

## Script alternative

`scripts/tally-integration/connector-preflight.mjs` — JSON summary for CI/automation (heartbeat-based).

## Exit code

`0` when config + backend auth + Tally localhost OK; `1` otherwise.
