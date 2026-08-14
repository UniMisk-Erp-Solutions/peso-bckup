# DOC-077 — Missing Receipt Files (OPEN INCIDENT)

**Last updated:** 2026-08-01
**Status:** in progress — **OPEN. Data loss confirmed. No backup coverage for the PesoWise DB or receipt storage (§5a). Prevention fix not yet implemented.**
**Reported by:** Admin (`admin@patidartravels.com`), 2026-08-01
**SQL executed:** **No.** Every query in this document is SELECT-only.
**Related:** [DOC-076 — Receipt Preview: Stale `temp/` Path Recovery](./receipt-preview-stale-temp-path-fix.md)

> This document records an **unresolved data-loss issue**. It is not a fix.
> DOC-076 fixes a *different*, recoverable class of failure found during the same audit.

---

## 1. The issue

Receipt previews show:

> **This file is no longer available in storage.**
> The attachment record exists but the file was not recovered during migration.

The `attachments` row exists; the object does not. Every access route — public URL,
authenticated download, and signed URL — returns HTTP 400 from the self-hosted storage API
(`pesowise-supabase.unimisk.com`), which is how that build reports "object not found".

Confirmed **not** the cause (each would break *every* receipt, and most preview fine):
bucket visibility, storage RLS, CORS, or a wrong storage host. `receipts` is `public = true`.

---

## 2. Scale (audit of 2026-08-01)

Summed from `scripts/diagnose-missing-receipts.sql` Q4:

| Period | Missing objects | Character |
|--------|-----------------|-----------|
| On/before **2026-05-27** | **~1,865** | Mass loss — roughly 60–70 % of rows on affected days (e.g. 375/568 on 05-22, 171/257 on 05-17, 119/172 on 05-25) |
| **2026-06-01 → 2026-08-01** | **10** | Isolated; 6 of them recoverable via DOC-076 |

**Total ≈ 1,875 attachment rows with no object.**

The boundary is sharp: nothing between 2026-06-01 and 2026-06-28 is missing, and nothing
from 2026-06-30 onward except three isolated days.

### The 10 post-restore failures

| Date | Expense | Rows | Bytes located? |
|------|---------|------|----------------|
| 2026-06-29 | `361fbbcc-6ada-4442-8848-ba0d59b74169` | 6 | **Yes** — at `{expenseId}/` (stale `file_url`; fixed by DOC-076) |
| 2026-07-13 | `61ad7216-6dd0-4c23-8d03-3a51774db9ca` | 3 | No |
| 2026-07-30 | `bcb9dbc8-00c2-4690-9bb0-e0cc1d7cabcf` | 1 | No — the originally reported receipt |

---

## 3. Cause A — partial storage restore (historic, ~1,865 files)

The pre-2026-05-27 losses align with a storage restore performed around **2026-05-30**
(cf. `supabase_backup_2026-05-30/`). Database rows were restored in full; the storage
objects were not. The app's on-screen message already describes this accurately.

**These files are unrecoverable** unless a storage backup newer than the affected uploads
exists. The known local backups are `supabase_backup_2026-05-30`,
`kqlqirdneocivumdjtvx_20260601` and `full_20260609_144055` — none contains post-restore uploads.

---

## 4. Cause B — single-copy uploads on existing expenses (ACTIVE RISK)

This is the live defect and the reason the reported Jul 30 receipt is gone.

### The intended safety net

`supabase/functions/finalize-expense-receipts/index.ts` **copies** `temp/{userId}/{file}` →
`{expenseId}/{file}` and **never deletes the source** — there is no `.remove(` anywhere in
that function. Q7 confirms this empirically: `temp/` objects from 2026-07-31 and 2026-08-01
are still present with their bytes. So draft uploads exist **twice**.

### The gap

[`src/components/FileUpload.tsx:255`](../src/components/FileUpload.tsx#L255):

```ts
const uploadPath = expenseId === "new" || !expenseId
  ? `temp/${user?.id}/${fileName}`   // draft   → temp copy, finalize copies it → TWO copies
  : `${expenseId}/${fileName}`;      // existing → straight to final    → ONE copy
```

**A receipt attached to an expense that already exists never passes through `temp/`, so no
second copy is ever created.** The safety net covers draft uploads only.

### How the reported file was lost

| Fact | Value |
|------|-------|
| Attachment id | `fdda25c9-5bcd-4b9f-8904-8635ef7f2d98` |
| Expense id | `bcb9dbc8-00c2-4690-9bb0-e0cc1d7cabcf` |
| Object key | `bcb9dbc8-…/1785434184415-grfx7vumcj6.jpeg` |
| Uploaded by | `eead54de-f12c-427c-a205-ef190e8b314b` |
| Row created | `2026-07-30 17:56:27 UTC` = **23:26 IST** |

The expense timeline shows *submitted* 23:23, then `expense_updated` at **23:26** and 23:30.
The attachment was therefore created during the **23:26 edit** of an already-submitted
expense — the single-copy path. No `temp/` twin was ever written, so Q1 (which searches every
folder in the bucket by filename) returns nothing.

Deletion candidates for the surviving copy:
* [`FileUpload.tsx:403`](../src/components/FileUpload.tsx#L403) — `storage.remove([filePath])` when an attachment is removed in the UI
* [`ExpenseForm.tsx:722`](../src/pages/ExpenseForm.tsx#L722) — `deleteSessionTempUploads()`
* [`ExpenseBatchForm.tsx:364`](../src/pages/ExpenseBatchForm.tsx#L364) — batch cleanup

The 23:30 edit is the most likely actor. **Not yet proven** — storage API logs from the host
would be needed to confirm which call issued the delete.

---

## 5. Recovery status

| Item | Recoverable? |
|------|--------------|
| Reported Jul 30 receipt | **Unrecoverable from currently available server infrastructure.** Absent from the live MinIO volume, `.minio.sys` trash/multipart, `storage.objects`, all four buckets, every backup archive, all Docker volumes and any host snapshot. **NOT yet declared globally unrecoverable** — the uploader's iPhone Photos/iCloud/Files and the same-device browser IndexedDB backup have not been checked. See §6a and DOC-078. |
| 2026-07-13 (3 rows) | **No — confirmed.** Already absent from the 2026-07-26 snapshot (§5b). |
| 2026-06-29 (6 rows) | **Yes** — bytes present; DOC-076 makes them display once deployed |
| Pre-2026-05-27 (~1,865) | No |

---

## 5a. Backup coverage — NO BACKUP EXISTS (added 2026-08-01)

A Coolify dump (`pg-dump-coolify-1785456009.dmp`, archived 2026-07-31 00:00:11 UTC) was
supplied to search for the lost object. Findings:

* The dump is `dbname: coolify` — **Coolify's own management database**, not PesoWise's.
  Single `public` schema; no `storage` schema, no `storage.objects`, no `attachments`.
  A Postgres dump cannot contain storage bytes in any case: Supabase keeps objects on disk
  and only the metadata row in Postgres.
* `scheduled_database_backups` contains **exactly one row**.
* All **53** rows of `scheduled_database_backup_executions` target the same destination:
  `/data/coolify/backups/coolify/coolify-db-hostdockerinternal/` — every artefact is
  `pg-dump-coolify-*.dmp`, ~1.36 MB, daily at `0 0 * * *`, retention 360.

**Conclusions:**

| Asset | Backed up? |
|-------|-----------|
| Coolify's own database | Yes — daily |
| **PesoWise Supabase database** | **No** |
| **Receipt storage objects (`receipts` bucket)** | **No** |

`local_persistent_volumes` registers `supabase-db-data` and `supabase-db-config` but **no
Supabase storage volume**, so the receipts volume is not a Coolify-tracked volume and is
not covered by any Coolify backup or retention policy.

This is why the ~1,865 files lost in the ~2026-05-30 restore were unrecoverable, and it
means anything uploaded today has no backup either. It is now the highest-priority action.

## 5b. CORRECTION — a separate backup system DOES exist (2026-08-01)

**§5a's conclusion that nothing is backed up was wrong, and is retracted here.**
It was drawn only from Coolify's own `scheduled_database_backups`. A separate backup
system exists outside Coolify's scheduler and was supplied afterwards:

```
latest/  Pesowise-main_db.sql.gz (291 MB) + Pesowise-main_storage.tar.gz (3.65 GB)
daily/   2026-07-26, 2026-07-27 (x2), 2026-07-28, 2026-07-29
```

Each snapshot carries a summary, e.g. the newest:

```
Snapshot        : 2026-07-30 1300  (hourly)
Auth users      : 754    (change since last: +0)
Storage uploads : 13209  (change since last: +17)
Tables          : 107
Integrity       : VERIFIED (14 roles, data=1)
```

So the PesoWise database **and** the `receipts` bucket are both backed up, hourly for
`latest` plus daily retention. Storage is MinIO-backed — objects appear as
`receipts/{folder}/{file}/{uuid}/{uuid}/part.1` alongside `xl.meta`.

Corrected status: actions **3a/3b are not "add backups from scratch"**; they are
**verify retention depth and confirm the schedule still runs**. The set supplied held only
~4 days of dailies plus one hourly `latest`.

### Search result — all five archives

Method validated first: a control object known to exist in production
(`361fbbcc-…/1782737966702-yrc2mnmcdyi.png`) was located in the listing, so absences below
are real and not a search artefact.

| Archive | Snapshot | Jul-30 receipt | 3x Jul-13 files |
|---------|----------|----------------|------------------|
| `latest` | 2026-07-30 1300 | **absent** | **absent** |
| `daily/2026-07-28` | 2026-07-28 1430 | absent | **absent** |
| `daily/2026-07-27` (1430) | 2026-07-27 1430 | absent | **absent** |
| `daily/2026-07-27` (0644) | 2026-07-27 0644 | absent | **absent** |
| `daily/2026-07-26` | 2026-07-26 1430 | absent | **absent** |

The Jul-13 files were already gone by the 2026-07-26 snapshot, so they cannot be recovered
from this set either.

### Why no backup could have caught the Jul-30 receipt

| Event | Time (UTC) |
|-------|-----------|
| Attachment row created | 2026-07-30 **17:56:27** |
| Expense edited again (`expense_updated`, 23:30 IST) | 2026-07-30 **~18:00** |
| Most recent snapshot in the supplied set | 2026-07-30 **13:00** |

**The object existed for roughly 3–4 minutes.** Even an hourly backup would almost
certainly have missed it. This is not a backup-coverage failure — it is the single-copy
defect in §4 destroying the only copy minutes after it was written.

### Refined deletion hypothesis (not proven)

[`FileUpload.tsx:403`](../src/components/FileUpload.tsx#L403) removes the storage object
first, then deletes the DB row **only** when
`attachmentId && !attachmentId.startsWith('temp-')`. If the UI still tracked the attachment
under a `temp-` id while the edit had already persisted a real row, the object would be
deleted while the `attachments` row survived — exactly the state observed. Confirming this
requires storage API logs from the host.

## 5c. Server-side backup audit — CONCLUSIVE (2026-08-01, read-only over SSH)

Inspected `webadmin@192.168.0.18:/home/webadmin/supabase-backups/` directly. **The server
runs in UTC**, so all snapshot labels are UTC and unambiguous.

The backup system is far better than §5a assumed: `hourly/`, `daily/`, `weekly/`,
`monthly/` and `latest/` tiers across 16 projects, plus `_whole-box`, `restore.sh` and
`verify_all.sh`. Latest snapshot at time of audit: `2026-08-01 0500`, 13,554 storage
uploads, `Integrity: VERIFIED (14 roles, data=1)`.

### The gap that lost the file

| Snapshot | Storage archive? |
|----------|------------------|
| `daily/2026-07-28_1430` | **yes** (3.35 GB) — last one before the incident |
| `daily/2026-07-29_1430` | **NO — `db.sql.gz` + summary only** |
| `daily/2026-07-30_1430` | **NO — `db.sql.gz` + summary only** |
| `hourly/2026-07-31_0000` | **yes** (3.73 GB) — first one after |

**The storage tarball silently failed to produce on 2026-07-29 and 2026-07-30 while the
database backup succeeded on both days.** Hourly storage snapshots only begin at
`2026-07-31 0000`. That leaves a **~57.5-hour hole in storage coverage,
2026-07-28 14:30 → 2026-07-31 00:00 UTC** — which contains the entire lifetime of the lost
object (2026-07-30 17:56:27 → ~18:00 UTC).

The `latest/` archive downloaded during triage was labelled `2026-07-30 1300` — still ~5
hours before the upload.

### Verification

Searched the two nearest archives with a control object
(`361fbbcc-…/1782737966702-yrc2mnmcdyi.png`) to prove the method:

| Archive | control | target `1785434184415-grfx7vumcj6.jpeg` |
|---------|---------|------------------------------------------|
| `hourly/2026-07-31_0000` | **found** | **absent** |
| `daily/2026-07-28_1430` | **found** | **absent** |

**Conclusion: the 2026-07-30 receipt is permanently unrecoverable.** No archive exists that
covers the window in which it lived. Storage is MinIO-backed
(`receipts/{folder}/{file}/{uuid}/{uuid}/part.1`).

### New action

The silent storage-backup failure on two consecutive days is its own defect: the DB tier
succeeded, so nothing signalled that storage was unprotected. See action 3d.

### Remaining recovery avenue for the 2026-07-30 receipt

Only the live storage volume or a hypervisor/VPS-level disk snapshot could still hold
`bcb9dbc8-…/1785434184415-grfx7vumcj6.jpeg`. On the host:

```bash
# 1. Find the Supabase storage container and its mount
docker ps --format '{{.Names}}' | grep -i storage
docker inspect <storage-container> --format '{{json .Mounts}}'

# 2. Search the volume for the object (read-only)
find /var/lib/docker/volumes -name '1785434184415-grfx7vumcj6.jpeg' 2>/dev/null

# 3. If the deployment uses the S3 driver instead of the file driver, check that bucket
```

If none of these produce the file, it is permanently lost.

---

## 5d. Storage API deletion audit — CONCLUSIVE (2026-08-01)

Storage API logs (`supabase-storage-evo3o0fdjaroxq7uohrm21cp`, retained from 2026-07-29)
contain 23 entries for this object. The decisive three:

| Time (UTC) | Method | Status | Path |
|-----------|--------|--------|------|
| 2026-07-30 17:56:27.291 | POST | 200 | `/object/receipts/bcb9dbc8-…/1785434184415-grfx7vumcj6.jpeg` |
| 2026-07-30 17:57:04.422 | GET | 200 | `/object/public/receipts/bcb9dbc8-…/1785434184415-grfx7vumcj6.jpeg` |
| 2026-07-30 18:00:14.384 | DELETE | 200 | `/object/receipts` |

The DELETE record:

```
operation : storage.object.delete_many
owner     : eead54de-f12c-427c-a205-ef190e8b314b   (the uploader)
role      : authenticated
resources : ["/receipts/bcb9dbc8-…/1785434184415-grfx7vumcj6.jpeg"]
client    : iPhone; CPU iPhone OS 18_7 … Safari
status    : 200
```

**Established facts:** the upload succeeded, the object was served successfully once, and
it was then physically deleted through the authenticated uploader's own session from an
iPhone. Object lifetime: **3 minutes 47 seconds**. The bucket is unversioned, no staging
twin existed (the receipt was added to an already-existing expense, which bypassed
`temp/` — §4), and the storage backup tier had failed for the two preceding days (§5c).

**Language note — important.** An authenticated request identifies the session and device
that issued it. It does **not** establish that the person operating that device understood
the action would irreversibly destroy the file. The UI offered a removal control with no
warning, no undo and no second copy behind it. This must not be described as intentional
data destruction, nor as corruption, spontaneous loss, or a failed upload.

### Corrected root cause

> The object was physically deleted through the authenticated uploader session. The
> unresolved product defect is that the application performed an irreversible storage
> deletion while leaving the attachment metadata row orphaned — so the receipt could not
> be recovered, and the expense still displayed a broken attachment record.

The defect has four parts, all product-side:

1. the client was allowed to physically delete the only object;
2. the deletion was immediate and irreversible;
3. no version, staging twin or archive copy existed;
4. the `attachments` row survived, leaving an orphaned record in the UI.

This supersedes the earlier speculation in §4 about which code path issued the delete.
The mechanism is now proven: a browser-issued `storage.object.delete_many` from
`FileUpload.deleteAttachment`.

## 6. Open actions

| # | Action | Owner | Status |
|---|--------|-------|--------|
| 1 | Deploy DOC-076 so the 6 recoverable receipts display | Dev | **Pending deploy** |
| 2 | **Close the single-copy gap** — route *every* upload through `temp/` so edit-time receipts get the same twin as draft uploads | Dev | **Not started — awaiting go-ahead** |
| 3 | ~~Check Coolify for a storage-volume snapshot covering 2026-07-30/31~~ | Infra | **Done 2026-08-01 — no such backup exists (§5a). Only Coolify's own DB is backed up.** |
| 3a | **Add a scheduled backup of the PesoWise Supabase database** — currently unprotected | Infra | **Not started — HIGHEST PRIORITY** |
| 3b | **Add a backup of the `receipts` storage volume/bucket** — currently unprotected | Infra | **Not started — HIGHEST PRIORITY** |
| 3c | ~~Search the server for a snapshot covering the object~~ | Infra | **Done 2026-08-01 — §5c. No archive covers 2026-07-28 14:30 → 2026-07-31 00:00 UTC. File permanently unrecoverable.** |
| 3d | **Alert on storage-tier backup failure** — `storage.tar.gz` silently failed on 2026-07-29 and 2026-07-30 while `db.sql.gz` succeeded; nothing flagged it | Infra | **Not started — HIGH** |
| 4 | ~~Confirm which delete call removed the Jul 30 object~~ | Infra | **Done 2026-08-01 — §5d. Browser-issued `storage.object.delete_many` from the authenticated uploader session.** |
| 4a | **Same-device IndexedDB recovery** — run `/receipt-recovery` on the uploader's iPhone | Product | **OPEN — URGENT, browser copy expires ~2026-08-06** |
| 4b | Soft deletion deployed | Dev | Not deployed (code + migration ready, DOC-078) |
| 4c | MinIO versioning enabled on `receipts` | Infra | **Not enabled** |
| 4d | Protected `receipts-archive` bucket created | Infra | **Not created** |
| 4e | Integrity monitor | Dev | Not implemented |
| 5 | Decide whether attachment removal should soft-delete instead of hard-deleting the object | Product/Dev | Not started |
| 6 | Consider a scheduled integrity check (`attachments` ↔ `storage.objects`) to catch new losses within a day | Dev | Not started |
| 7 | Investigate the duplicate `attachments` rows seen for expense `361fbbcc` (same object referenced 3×) | Dev | Not started |

Action **2 is the one that stops this recurring.** Until it ships, any receipt added to an
already-existing expense has exactly one copy and no safety net.

---

## 7. Diagnostics

`scripts/diagnose-missing-receipts.sql` — SELECT-only, Q1–Q7:

| Q | Purpose |
|---|---------|
| Q1 | Does a given file exist anywhere in `receipts` (filename match across all folders)? |
| Q2 | What does the `attachments` row point at? |
| Q3 | Bucket configuration (`public`, size limit, MIME types) |
| Q4 | Missing counts by upload date — reveals the restore cut-off |
| Q5 | The actual broken rows |
| Q6 | **Decisive** — are "missing" files present under a different path? |
| Q7 | `temp/` objects still in storage (proves the copy-and-keep behaviour) |

Q3 result on 2026-08-01: `receipts` is `public = true`, 10 MB limit, MIME types
`image/jpeg, image/jpg, image/png, image/heic, image/heif, application/pdf`.

---

## 8. Explicitly out of scope here

Per the DOC-075 task constraints, this incident does **not** change receipt handling,
temp-file movement, backup behaviour or upload semantics. DOC-076 is a read-path fix only.
Action 2 above **would** change upload routing and is therefore held until explicitly approved.

---

## Revision log

| Date | Rev | Author | Notes |
|------|-----|--------|-------|
| 2026-08-01 | 1.4 | Agent | Added §5d — conclusive Storage API deletion audit. POST 200 at 17:56:27Z, GET 200 at 17:57:04Z, `storage.object.delete_many` 200 at 18:00:14Z, owner = the uploader, role authenticated, iPhone/iOS 18.7/Safari, single resource = the canonical path. Object lifetime 3m47s. Root cause corrected from speculative cleanup to a browser-issued physical deletion leaving an orphaned metadata row; language explicitly separates session attribution from user intent. Recovery status changed to **unrecoverable from currently available server infrastructure** (not globally). Open actions updated: delete investigation closed; same-device IndexedDB recovery opened as urgent (browser copy expires ~2026-08-06); soft delete, versioning, archive bucket and integrity monitor recorded as not yet done. |
| 2026-08-01 | 1.3 | Agent | Added §5c from a read-only SSH audit of the backup server (UTC). Backup tiers are hourly/daily/weekly/monthly across 16 projects with integrity verification. **Found a ~57.5-hour storage-coverage hole (2026-07-28 14:30 → 2026-07-31 00:00 UTC): the `storage.tar.gz` tier silently failed on 2026-07-29 and 2026-07-30 while the DB tier succeeded.** That hole contains the object's entire ~4-minute lifetime. Verified against the two nearest archives with a control object: control found in both, target absent from both. **The 2026-07-30 receipt is permanently unrecoverable.** Opened action 3d (alert on storage-tier backup failure). |
| 2026-08-01 | 1.2 | Agent | **Retracted §5a's "no backups exist" conclusion.** A separate backup system outside Coolify's scheduler does back up both the PesoWise DB and the `receipts` bucket (hourly `latest` + dailies, MinIO layout, integrity-verified). Searched all five supplied archives with a validated method: the Jul-30 receipt and the three Jul-13 files are absent from every one. Established that the Jul-30 object lived only ~3–4 minutes (created 17:56:27 UTC, expense edited again ~18:00 UTC), so no realistic backup cadence could have captured it — confirming §4's single-copy defect as the cause rather than backup coverage. Actions 3a/3b re-scoped to verifying retention depth and schedule. |
| 2026-08-01 | 1.1 | Agent | Added §5a after analysing `pg-dump-coolify-1785456009.dmp`: it is Coolify's own management DB, not PesoWise's, and cannot contain storage bytes. All 53 backup executions target `coolify-db-hostdockerinternal` only — **the PesoWise Supabase database and the `receipts` storage volume have no backup at all**. Action 3 closed (no snapshot exists); 3a/3b opened as highest priority; 3c records the last recovery avenue. |
| 2026-08-01 | 1.0 | Agent | Initial — opened after an admin reported a missing receipt preview. SELECT-only audit found ~1,875 attachment rows with no object: ~1,865 from a partial storage restore (~2026-05-30) and 10 post-restore. Identified the active defect: `FileUpload.tsx:255` uploads directly to `{expenseId}/` for existing expenses, bypassing the `temp/` copy that `finalize-expense-receipts` deliberately retains, so edit-time receipts have no second copy. Reported Jul 30 receipt confirmed **unrecoverable**. 6 of the 10 recoverable via DOC-076. **No SQL executed; incident remains OPEN.** |
