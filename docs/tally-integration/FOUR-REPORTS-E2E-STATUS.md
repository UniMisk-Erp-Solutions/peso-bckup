# Four PesoWise → Tally reports — E2E status

**Last updated:** 2026-10-07 (implementation pass)

## Status: PARTIAL

| Layer | Claim Ver. | Claim Appr. | Detailed | Daily Project |
|-------|------------|-------------|----------|---------------|
| Admin Sync UI | Yes | Yes | Yes | Yes |
| Server prepare (full scope) | Yes | Yes | Yes | Yes |
| Mapper metadata + flat row UDF | Yes | Yes | Yes | Yes |
| Connector delivery | Yes | Yes | Yes | Yes |
| TDL menu + list/detail UI v2 | Yes | Yes | Yes | Yes |
| Max-revision dedupe in TDL | Yes (FilterCount) | Yes | Yes | Yes |
| Org custom columns in TDL | JSON only | JSON only | JSON only | N/A |
| Claim opening/closing in sync row | If in RPC row | If in RPC row | Yes | N/A |

## Tally navigation (after F12 load + Ctrl+Alt+R)

`Gateway of Tally → PesoWise Reports (R)`

- **V** Claim Verification List  
- **A** Claim Approval List  
- **E** Detailed Expense Report  
- **D** Daily Project Report  

## Human steps after deploy

1. Copy `tally-extension/PesoWise-Bootstrap.tdl` and `PesoWise-Reports.tdl` to `C:\pesowise\`.
2. F12 → both TDLs **Load = Yes** → **Ctrl+Alt+R**.
3. `node scripts/tally-integration/deploy-e2e-controlled-stack.mjs` (when mapper changes).
4. Tally company **PesoWise Integration Test** open; TallyConnector running.
5. PesoWise → each report tab → **Sync to Tally** (admin).

## Remaining engineering

- TDL **one row per metadata_delivery_key** (max `metadata_revision`) — currently sort-only; re-sync may show duplicate logical keys until aggregation collection is validated on TP7.
- Enrich claim sync rows with **opening/closing balance** at prepare time if not in `report_expense_rows_v1` payload.
- Future: `tally_sync_allowed_roles` policy (default admin-only today).

## References

- [SYNC-THEN-TALLY-DAILY-REPORT.md](./SYNC-THEN-TALLY-DAILY-REPORT.md)
- [TALLY-TDL-READ-MODEL-CONTRACT.md](./TALLY-TDL-READ-MODEL-CONTRACT.md)
- [PHASE-06-INSTALL-PESOWISE-REPORTS.md](./PHASE-06-INSTALL-PESOWISE-REPORTS.md)
