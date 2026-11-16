# PITR E2E test report (500 + 500)

**Environment:** Isolated Docker lab on `192.168.23.46` (`/tmp/pesowise-pitr-lab`)  
**Production Pesowise Postgres:** **NOT touched**  
**Date:** 2026-09-25  

## Timeline (lab)

| Step | Time (UTC) | Action |
|------|------------|--------|
| T1 | 2026-09-25 07:57:13 | Batch A — 500 expenses + EFV |
| Wait | 15s | Configurable (`WAIT_SEC`) |
| T2 | ~07:57:28 | Batch B — 500 expenses + EFV |
| T_PRE_DELETE | **2026-09-25T07:57:29+00** | Recorded target |
| Delete | after T_PRE | DELETE 1000 fixture rows |
| Restore | target = T_PRE_DELETE | PITR into `pitr-lab-restore` :55432 |

`recovery_test_id`: `ac474fbd-e6a0-4cd8-ac82-506c3ba47b34`

## Results

| Check | Result |
|-------|--------|
| Expenses before delete | 1000 |
| Expenses after delete (source) | 0 |
| Expenses after PITR (recovery) | **1000 / 1000** |
| `expense_form_field_values` | **1000 / 1000** |
| **FINAL** | **PASS** |

## Dependency matrix (lab fixture schema)

| TABLE | EXPECTED | RECOVERED | MATCH |
|-------|----------|-----------|-------|
| recovery_fixture.expenses | 1000 | 1000 | YES |
| recovery_fixture.expense_form_field_values | 1000 | 1000 | YES |

## Not in this lab run

- Full PesoWise `public.*` schema  
- Supabase Auth / Kong / frontend  
- Production WAL chain  
- Post-target row exclusion audit (future enhancement)  

## Command

```bash
WAIT_SEC=15 LAB_ROOT=/tmp/pesowise-pitr-lab bash scripts/recovery/run-e2e-pitr-test.sh
```

Server log: `/tmp/pitr-e2e.log` on `.46`.
