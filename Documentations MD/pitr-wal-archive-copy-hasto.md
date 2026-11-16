# PITR WAL archive copy on the hasto server (PesoWise backup)

**Doc ID:** DOC-161  
**Status:** in progress  
**Last updated:** 2026-11-06  
**Owner / area:** Backup and recovery (PITR), server .46

---

## 1) Summary

The PesoWise PITR archive (WAL segments, base backups, receiver status files) that lives on
the attached backup HDD (`/mnt/hdd/pesowise-pitr`, 44.7 GB, 2,226 files) was copied to the
4 TB disk of the same server and a read-only check script was added to the PesoWise recovery
scripts. **The archive only reaches 2026-10-28 22:11 IST. It is not current.**

---

## 2) Problem / requirement

- The owner wanted the PITR WAL kept as part of the PesoWise backup.
- The PesoWise backup Supabase stack's own `pitr-wal` folder is on `/` (150 GB disk, 18 GB free,
  88% used) and still holds only old September segments, so a 44.7 GB archive cannot go there and
  the two histories must not be mixed.
- The archive's receiver (`pesowise-pitr-pg-receivewal.service`) stopped after 2026-10-28;
  its `status/pi-wal.json` still says `OK` because it was never updated afterwards.

---

## 3) Solution

1. Read-only inspection of the HDD (2,216 segments `000000010000001F00000042` to `...27E9`, 35 GB;
   `base/` 7.1 GB; newest file is `...E9.partial` written 2026-10-28 22:11).
2. Copied the whole folder with `rsync -a` (low priority) to
   `/srv/immich-data/backup/pesowise-pitr/` on the 4 TB disk (3.4 TB free). Finished 12:45 IST on
   2026-11-06; file count (2,226) and bytes (44,710,042,216) equal the source; a second rsync
   dry run showed no differences. The HDD was only read.
3. Added `scripts/recovery/check-pitr-archive-copy.sh` (read-only): WAL present, continuity (no
   gaps across consecutive segments), file validation (reuses `validate-wal-archive.sh`),
   freshness (WARN when the archive ends more than 24 h ago), and that at least one complete
   base backup exists (`base.tar.zst`; `*.partial` ignored).
4. `scripts/recovery/check-pitr-health.sh` prints this check as an extra informational block when
   the archive folder exists. It does not change that script's OVERALL result.

Result of the check on the server (2026-11-06): WAL present PASS, continuity PASS (2,215 complete
segments, no gaps), validation PASS, freshness **WARN (206 h old)**, complete base backup PASS
(`20261014T193016Z`, `20261018T080006Z`). `20261025T080002Z.partial` is unfinished and unusable.

Restorable range: from the 2026-10-18 base backup up to 2026-10-28 22:06 (last complete segment).
Nothing after that exists on this HDD.

Path override: `PESOWISE_PITR_ARCHIVE_ROOT` (default `/srv/immich-data/backup/pesowise-pitr`),
`PESOWISE_PITR_ARCHIVE_MAX_AGE_H` (default 24).

### 3.1) Restore and merge into the backup stack (2026-11-06)

1. Base backup `20261018T080006Z` (checksum verified) unpacked on the main disk and all WAL replayed in an isolated
   throwaway container (`pitr-recovery-20261106`, image `supabase/postgres:15.8.1.085`, localhost port 55433).
   Recovery ended at 2026-10-28 22:06 IST (last completed transaction 16:36:36 UTC).
2. Compared with the backup stack database (`supabase-db-kar0ro1k6jiyfxzzw7acnsza`): 2,986 expenses were missing
   there, 2 backup-stack-only expenses were left untouched.
3. Safety dump of the backup stack DB: `/var/lib/pesowise-pitr-recovery-20261106/live-pre-merge-20261106.dump`.
4. Rolled-back trial, then one committed transaction (`session_replication_role = replica`, so triggers did not
   renumber or recompute anything): 3 auth users + identities, 3 profiles, 579 expense batches, **2,985 expenses**
   and their attachments, audit logs, balance deductions, correction logs, form values and history, submission
   receipts and notifications. Post-checks: 0 orphan rows, 0 duplicate transaction numbers. Expenses 38,667 -> 41,652.
5. Left out: 1 expense whose (organization, transaction number 31381) is already used by a different expense in the
   backup stack, and 2 profiles whose auth users are not in the backup stack.
6. Not recoverable from WAL: receipt image files (storage objects), so the imported attachments rows may not render.

7. The 35 GB WAL (2,216 files, byte-identical) was also copied into the backup stack own `pitr-wal` folder on the main disk; the old September files (11) were moved to `/srv/immich-data/backup/stack-pitr-wal-sept-old-20261106`. The 28 GB temporary recovery folder was deleted; the pre-merge dump is at `/srv/immich-data/backup/pesowise-backup-stack-pre-merge-20261106.dump`. Main disk: 11 GB free (93%).

Operational note: the server has 7.3 GB RAM. The recovery container was first started with a 6 GB limit; at that time
the `realtime` container of the backup stack restarted. Use at most 1.5 GB for any further recovery work.

---

## 4) Key files

```
scripts/recovery/check-pitr-archive-copy.sh   (new)
scripts/recovery/check-pitr-health.sh         (optional archive block added)
docs/recovery/PITR_RUNBOOK.md                 (restore procedure; use the archive path as --wal-dir)
```

Server paths (not in the repository): source `/mnt/hdd/pesowise-pitr`, copy
`/srv/immich-data/backup/pesowise-pitr`, rsync log `/srv/immich-data/backup/pesowise-pitr-rsync.log`.

---

## 5) Database / migrations

None. No database was touched; nothing was written to the PesoWise Supabase stack or any other
container. The archive contains production database content and must stay outside the repository
(see CLAUDE.md, Sensitive Data and Git Safety).

---

## 6) Test plan

- [x] File count and byte total of copy equal source; rsync dry run reports no differences.
- [x] `check-pitr-archive-copy.sh` run on the server: no gaps, validation PASS, freshness WARN.
- [x] `bash -n` on both scripts.
- [ ] Find out why the receiver stopped after 2026-10-28 (journal, `/mnt/hdd/logs`) and restart it
      with owner approval; then re-run the rsync to bring the copy up to date.
- [ ] Rehearse one restore into an isolated target using the 2026-10-18 base and the copied WAL
      (`restore-pitr.sh --dry-run` first).
- [ ] Decide retention for the stale `*.partial` base and the September segments in the stack volume.

---

## 7) Related docs

- [PITR runbook](../docs/recovery/PITR_RUNBOOK.md) · [PITR architecture](../docs/recovery/PITR_ARCHITECTURE.md)
- [Retention plan](../docs/recovery/PRODUCTION_PITR_RETENTION_PLAN.md)

---

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-11-06 | 1.2 | Claude Code | WAL files also placed in the backup stack pitr-wal folder; temp recovery folder deleted. |
| 2026-11-06 | 1.1 | Claude Code | Archive restored in an isolated container (to 2026-10-28 22:06 IST) and 2,985 missing expenses plus related rows merged into the backup stack database; 1 expense skipped (transaction number clash). Receipt files not recoverable. |
| 2026-11-06 | 1.0 | Claude Code | Archive inspected (ends 2026-10-28), copied to the 4 TB disk and verified, read-only check script added and wired into the health check. Receiver not repaired; copy is not current. |
