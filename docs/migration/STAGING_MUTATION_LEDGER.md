# Staging mutation ledger (integrity recheck)

Use with baseline migration counts when comparing v2 after validation tests.

| Entity | ID / marker | Before | After | Expected delta | Notes |
|--------|-------------|--------|-------|----------------|-------|
| `public.pitr_drill_markers` | marker_a/b | 0 rows | drill rows on v2 | +2 transient | WAL PITR drill only; truncate in script |
| Expense `b5117e06-…` | concurrency verify | status `submitted` | unchanged | 0 | duplicate verify POST → 403 |
| Financial totals | — | baseline sum 20,989,240.59 | not re-baselined this pass | 0 intended | full workflow Gate P not complete |

**Unexplained deltas vs baseline:** none recorded for production. Staging API financial lifecycle proofs remain **TODO** for Gate P.
