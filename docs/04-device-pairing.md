# Device pairing

**Status:** Implemented — Admin UI at **`/admin/tally`**.

Flow:

1. Admin → **Generate pairing code** (RPC `create_tally_connector_pairing_code_v1`).
2. On Tally PC: `PesoWiseConnector.exe pair …` (command copied from UI).
3. Device row in `tally_connector_devices`; token in `%USERPROFILE%\PesoWise\TallyConnector\config.json`.

See `docs/tally-integration/AGENT-PAIRING-AND-SECURITY.md` and `src/lib/tallyConnectorCloud.ts`.
