# Priyanshu HA lab (local only)

Full **end-to-end** local system — no production hosts, **no git push**.

## Run everything

```powershell
powershell -ExecutionPolicy Bypass -File scripts/ha/lab/run-priyanshu-ha-e2e.ps1
```

```bash
bash scripts/ha/lab/run-priyanshu-ha-e2e.sh
```

| Layer | What |
|-------|------|
| State machine | Failover → failback + split-brain guard |
| Docker (optional) | HAProxy + PG46/PG68 replication + promote |

Reports: `reports/`  
Docs: `docs/ha/PRIYANSHU_HA_E2E_SYSTEM.md`
