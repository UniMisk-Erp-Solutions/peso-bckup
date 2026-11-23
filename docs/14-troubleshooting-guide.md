# Troubleshooting Guide (Placeholder)

Common issues (from audit):

| Symptom | Check |
|---------|--------|
| Empty Daily Project report | TDL: `PesoWise-Load.tdl` not SafeMenu; UDF backfill; Tally company on HTTP 9000 |
| Sync stuck waiting_for_connector | Connector running? Paired? `doctor` command |
| “Nothing sent” / 1 skipped batch | Job created before `tally_force_refresh`; rebuild delivery |
| Tally HTTP idle | Open company + F1 server for this company |

Scripts: `scripts/tally-integration/_tally-diagnose-dpr-empty.mjs`, `fix-daily-tally-report-empty.mjs`.

**Phase 10** expands with recovery procedures.
