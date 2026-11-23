# PITR expense demo — WAL on `.68`

Recovery uses an **isolated** Postgres on **`.68` port `55432`** (`pitr-expense-recovery`). WAL is archived on **`.68`** via `pg_receivewal` from **`.46`**. Production primary **`.46`** is never overwritten.

---

## Latest run — 500 expenses (random amounts) — **PASS** (2026-09-28)

| Field | Value |
|-------|--------|
| `batch_id` / `purpose` | `PITR_WAL_BATCH_1790575046` |
| `expected_count` | **500** |
| `recovery_target_time` | `2026-09-28T05:57:29.759621+00` |
| Base backup (`.46`, before insert) | `pitr-base-20260928T055637Z` → `/var/lib/pesowise-pitr-backup/base/pitr-base-pack-20260928T055637Z/data` |

### Results

| Check | `.46` live | `.68` PITR restore (`:55432`) |
|-------|-----------|----------------------------------|
| Rows for batch | **0** (deleted) | **500** |
| Amounts | — | Random per row (`total_amount` ≈ 10–5000) |
| **Outcome** | DELETE confirmed | **RECOVERED from WAL + base** |

### End-to-end flow (orchestration)

**On `.46` (order matters):**

```bash
bash /tmp/ha/pitr-e2e-500-demo-46.sh
# → /tmp/pitr-base-20260928T055637Z.tar.gz + /tmp/pitr-expense-demo/manifest.json
```

**Copy** tarball + manifest to `.68`, then:

```bash
export SUDO_PASSWORD=…
bash /tmp/ha/pitr-e2e-recover-68.sh /tmp/pitr-base-20260928T055637Z.tar.gz /tmp/pitr-expense-demo/manifest.json
bash /tmp/ha/pitr-verify-e2e-both.sh /tmp/pitr-expense-demo/manifest.json
```

**If `pitr-wal` on `.68` lags primary** (archive stopped at old segments), backfill from `.46` then re-run recovery:

```bash
# .46
bash /tmp/ha/pitr-wal-backfill-pack-46.sh
# copy /tmp/pitr-wal-backfill.tar.gz to .68
bash /tmp/ha/pitr-wal-backfill-apply-68.sh /tmp/pitr-wal-backfill.tar.gz
```

Restart archive receiver after demo:

```bash
sudo systemctl restart pesowise-pitr-pg-receivewal.service
```

---

## Earlier run — single row, amount 500.00 (2026-09-25)

| Field | Value |
|-------|--------|
| `expense_id` | `03750b52-db26-44e9-9b58-7ee270a2dc7e` |
| `title` | `PITR_WAL_DEMO_1790338464` |
| `total_amount` | **500.00** (one row, not 500 rows) |
| `recovery_target_time` | `2026-09-25T12:14:25.490455+00` |

| Check | `.46` live | `.68` PITR restore |
|-------|-----------|---------------------|
| Row present | **0** | **1** |

---

## Scripts (repo `scripts/recovery/`)

| Script | Purpose |
|--------|---------|
| `pitr-e2e-500-demo-46.sh` | Base backup then 500 insert/delete on `.46` |
| `pitr-e2e-recover-68.sh` | Extract base + run recovery on `.68` |
| `pitr-expense-demo-insert-delete-46.sh` | Insert N expenses (default 500), delete, write manifest |
| `pitr-recover-expense-from-68-wal.sh` | Configure PGDATA + start lab container |
| `restore-pitr.sh` | Base copy + `recovery_target_time` / inclusive |
| `pitr-wal-backfill-pack-46.sh` / `pitr-wal-backfill-apply-68.sh` | WAL gap fill when archive lags |
| `pitr-verify-e2e-both.sh` | Count recovered rows on `:55432` |

## Safety

- Lab PGDATA: `/var/lib/pesowise-pitr-recovery-demo/pgdata`
- Do **not** point the app at `:55432` without incident approval.
- Stop lab when done: `sudo docker rm -f pitr-expense-recovery`

## Production re-insert (2026-09-28)

After PITR proof, **500 rows were copied back to live `.46`** so the app/frontend could show them:

```bash
# .68 — CSV from recovery container
bash /tmp/ha/pitr-export-68-oneline.sh PITR_WAL_BATCH_1790575046
# copy CSV to .46, then:
bash /tmp/pitr-import-recovered-expenses-46.sh PITR_WAL_BATCH_1790575046 /tmp/pitr-restore-500.csv
# Result: RESTORE_TO_46=PASS (500 rows on primary)
```

Scripts: `pitr-export-68-oneline.sh`, `pitr-import-recovered-expenses-46.sh`
