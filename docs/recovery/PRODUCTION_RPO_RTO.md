# Production PITR RPO / RTO (measured)

**Environment:** 192.168.23.46, first production chain 2026-09-25.

## RPO (Recovery Point Objective)

| Measure | Value | Method |
|---------|--------|--------|
| WAL streaming lag | **Seconds** (segment flush + partial file) | `pg_receivewal` active; slot `pesowise_pitr` active when service healthy |
| Practical RPO | **≤ 1–2 minutes** under normal load | Re-measure with `check-pitr-health.sh` (latest WAL age) |

Archive is **continuous physical WAL** (not SQL dumps).

## RTO (Recovery Time Objective) — first drill

| Phase | Approximate time | Notes |
|-------|------------------|-------|
| Base restore (rsync copy ~921 MiB) | ~1 min | Local disk on same host |
| WAL replay to target | **< 5 s** | Target at backup-consistent LSN `0/BC02C480` / promote to `0/BD000000` |
| PostgreSQL startup (isolated container) | ~15 s | `supabase/postgres:15.8.1.085` |
| Validation queries | ~1 min | Row counts, org/expense tables |
| **Total (isolated drill)** | **~2–3 minutes** | Excludes human decision + download if off-host |

Full Supabase stack bring-up (Kong, Auth, etc.) on a **new** recovery host would add time not measured here.

## Isolated restore test

- **Target:** recovery to backup end (`recovery_target_lsn` / time at backup completion).
- **Port:** `55433` (container `pesowise-pitr-restore-test`).
- **Validated counts:** `expenses` 24213, `expense_form_field_values` 85939, `organizations` 5.

No production data was deleted or mutated.
