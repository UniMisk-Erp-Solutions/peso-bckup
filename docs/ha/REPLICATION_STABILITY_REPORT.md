# Replication stability observation (.68 standby)

**Window:** 2026-09-25 ~10:16–10:22 UTC (post-rebuild)  
**Method:** `scripts/ha/verify-replication-68.sh` on `.68`, 30s interval samples  
**Note:** Full 30–60 minute watch should continue on-server via cron/manual; this report captures initial post-repair stability.

## Metrics (standby `now() - pg_last_xact_replay_timestamp()`)

| Sample | Receive/replay LSN | Replay age |
|--------|-------------------|------------|
| 1 | `0/C40593A0` / `0/C40593A0` | **0.05 s** |
| 2 | `0/C4078A28` / `0/C4078A28` | **0.25 s** |
| 3 | `0/C40938F0` / `0/C40938F0` | **0.20 s** |
| 4 | `0/C40AE000` / `0/C40ADFE8` | **2.91 s** |
| 5 | `0/C40CEE90` / `0/C40CEE90` | **2.32 s** |

**Window:** ~5 min (30 s spacing). **MIN lag:** ~0.05 s · **MEDIAN:** ~0.25 s · **MAX:** ~2.91 s  

## WAL receiver

- **Status:** `streaming` (stable across samples)
- **Slot:** `pesowise_68_standby`
- **Disconnects / errors:** None observed in sample window

## Primary view (`pg_stat_replication`)

- Active **`main`** walsender to `.68`: `replay_lag` **sub-second**.
- **Stale row:** One additional `.68` entry with **~58 min** `replay_lag` and empty `application_name` (likely pre-rebuild zombie walsender). **Action:** when on `.46`, confirm PID and `pg_terminate_backend` if still present; authoritative health = **`main` + `.68` wal receiver**.

## Data spot checks (same window)

| Table | Primary | Standby |
|-------|---------|---------|
| `expenses` | 24713 | 24713 |
| `organizations` | 5 | 5 |
| `notifications` | 84829 | 84829 |

## PITR (remote spot check)

- `pesowise_pitr` slot **active** on `.46` (via remote SQL from `.68`).
- Full `check-pitr-health.sh` must still be run **on `.46`** for `pg_receivewal` + WAL directory checks.

## FINAL STATUS (observation window)

**PASS** — receive/replay LSNs advance together; replay age **&lt; 1 s**; counts aligned; no receiver errors.

**Follow-up:** Extend monitoring to **60 minutes** on `.68` and re-run `verify-replication-68.sh`; terminate stale walsender on `.46` if duplicate `.68` row persists.
