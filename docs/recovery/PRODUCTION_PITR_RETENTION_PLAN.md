# Production PITR WAL retention plan

Measurements taken **2026-09-25** on `.46` after PITR enablement (sample window ~20 minutes post-streaming).

## WAL archive state

| Metric | Value |
|--------|--------|
| WAL path | `…/supabase-db-config/_data/pitr-wal` |
| Segments observed | `…BA`, `…BB`, `…BC`, `…BD` (+ partial while open) |
| Size after ~20 min | ~65 MiB |
| Estimated rate | **~195 MiB/hour** (~4.7 GiB/day) — **re-measure weekly** |
| Free space on `/` | ~63 GiB (57% used on 150 GiB volume) |
| Estimated retention (WAL only, current rate) | **~13 days** at full disk free (upper bound; do not plan to fill `/`) |

## Recommendations

| Item | Recommendation |
|------|----------------|
| Minimum WAL retention | Keep all WAL back to **oldest verified base backup** + **24 h** safety margin |
| Base backup frequency | **Weekly** initially; move to **daily** if WAL rate or RTO requires (DB ~921 MiB base) |
| Alert threshold | WARN if latest WAL segment **> 15 min** old; FAIL if **> 60 min** or slot inactive |
| Disk alert | WARN if `/` **> 75%** used; FAIL **> 85%** |
| Deletion | Use `scripts/recovery/backup-retention.sh` (**dry-run default**); no auto-delete enabled |

## Base backup storage (rough)

- ~0.9 GiB per backup × 4 weekly ≈ **3.6 GiB/month** (excluding WAL).
- WAL ~4.7 GiB/day × 30 ≈ **140 GiB/month** if never pruned — **retention policy mandatory** before long production run.

## Actions not taken

- No WAL or base backup deletion.
- Timer `pesowise-pitr-base-backup.timer.example` **not enabled**.
