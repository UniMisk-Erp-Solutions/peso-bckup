# Background sync

**Status:** Implemented.

- Jobs and batches live in Postgres (`tally_sync_jobs`, `tally_sync_delivery_batches`).
- **PesoWiseConnector.exe run** claims and delivers without the browser.
- Reports UI polls job status; when cloud connector is online, user may close the tab.

Dev: optional local bridge `:9876` nudge via `npm run dev`.

See `docs/E2E-PRODUCTION-RUNBOOK.md`.
