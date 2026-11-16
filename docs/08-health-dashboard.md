# Health dashboard

**Status:** Implemented in **`/admin/tally`**.

| Signal | Source |
|--------|--------|
| Connector online | `tally_connector_devices.last_seen_at` (heartbeat via Edge) |
| Device list / revoke | Same table + `revoke_tally_connector_v1` |
| Recent sync jobs | `tally_sync_jobs` |
| Local detail (support) | `%USERPROFILE%\PesoWise\TallyConnector\health.json` |

Reports panel also shows cloud connector status and link to setup.
