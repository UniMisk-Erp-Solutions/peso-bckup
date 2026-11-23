# Replication lag baseline (.46 → .68)

**Observation window:** 2026-09-25, 12 samples × 60s (~11 minutes)  
**Method:** `pg_current_wal_lsn()` on primary + `pg_stat_replication` for `client_addr = 192.168.23.68` (no artificial load).

## Primary-side samples (write_lsn ≈ primary LSN)

| UTC time | Primary LSN | Replica write_lsn | flush_lag | replay_lag |
|----------|-------------|-------------------|-----------|------------|
| 09:30:51 | 0/BF0ADF80 | 0/BF0ADF80 | ~11m55s | ~11m55s |
| 09:31:52 | 0/BF0DBBF8 | 0/BF0DBBF8 | ~12m55s | ~12m55s |
| 09:35:53 | 0/BF1872F8 | 0/BF1872F8 | ~16m56s | ~16m56s |
| 09:41:55 | 0/BFEEAB38 | 0/BFEEAB38 | ~22m58s | ~22m58s |

- **write_lsn** tracked primary (WAL shipped to replica connection).
- **replay_lag** on primary stayed **~12–23 minutes** (empty `replay_lsn` in samples).
- Standby-side **`pg_last_xact_replay_timestamp`** was **~1 day+** behind (separate read on `.68`).

## Summary

| Metric | Value |
|--------|--------|
| Min replay lag (primary view) | ~12 min |
| Max replay lag (primary view) | ~23 min |
| Median | ~16–18 min |
| Standby transaction replay age | **~32 hours** (critical) |
| Byte lag (write_lsn) | ~0 when streaming |
| **Effective RPO if promoted now** | **Unbounded / stale** — **not near-zero** |

## Conclusion

Do **not** treat current replication as failover-ready.  
**Safe next action:** repair `.68` physical replication (WAL receiver + replay) while keeping `.46` primary; re-run this baseline after fix.
