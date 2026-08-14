# DOC-078 — Receipt Recovery & Deletion Safety

**Last updated:** 2026-08-01
**Status:** in progress — phase 1 implemented; durability tiers designed, not built
**Branch:** `fix/receipt-recovery-and-deletion-safety` (from `fix/tenant-pwa-auth-origin`)
**SQL executed:** **No.** Migration created, not applied.
**Production storage changed:** **No.** No bucket created, no versioning enabled, nothing deleted.
**Related:** [DOC-077 (open incident)](./missing-receipt-files-incident.md) · [DOC-076](./receipt-preview-stale-temp-path-fix.md)

---

## 1. Why this exists

DOC-077 §5d proved the mechanism: a receipt was uploaded at 17:56:27 UTC, served once at
17:57:04, and physically destroyed at 18:00:14 by a browser-issued
`storage.object.delete_many` from the uploader's own authenticated session. Lifetime:
**3 minutes 47 seconds**. The bucket is unversioned, the file had no staging twin, and the
storage backup tier had failed for two days.

An authenticated request identifies the *session*, not the *intent*. The product defect is
that a single tap could irreversibly destroy the only copy, and then leave an orphaned
metadata row behind.

---

## 2. What is implemented in this change

### 2.1 No browser code can physically delete a linked receipt

| File | Before | After |
|------|--------|-------|
| `FileUpload.tsx` `deleteAttachment` | `storage.from('receipts').remove([filePath])` then hard-delete the row | `removeAttachmentSafely()` — metadata only, object retained |
| `ExpenseForm.tsx` `deleteSessionTempUploads` | `remove(paths)` on `temp/{userId}/…` | staging **retained**; local refs cleared only |
| `ExpenseBatchForm.tsx` `deleteBatchTempUploads` | `remove(Array.from(paths))` | staging **retained**; local refs cleared only |

Verified by test: no `from('receipts').remove` remains anywhere under `src/`.

Retaining staging matters as much as the delete removal — `temp/{userId}/{file}` is the
only second copy a receipt has until the archive tier exists.

### 2.2 Soft deletion (`src/lib/attachmentRemoval.ts`)

`removeAttachmentSafely()` prefers the `soft_delete_attachment` RPC. When that RPC is
absent (migration not yet applied) it falls back to unlinking the metadata row — **still
never touching storage**. So the destructive path is gone immediately, and soft delete
activates the moment the migration lands.

| Mode | Meaning | Object | Undoable |
|------|---------|--------|----------|
| `soft_deleted` | RPC applied | retained | yes |
| `row_removed_object_retained` | migration pending | retained | no |
| `local_only` | never persisted | n/a | n/a |

Genuine authorization errors propagate; only `PGRST202` triggers the fallback.

### 2.3 Same-device recovery scanner (`src/lib/receiptRecoveryScan.ts`)

Reads **only** the app's own store:

```
IndexedDB   pesowise-submitted-backup-receipts  (v1)
store       receipts   keyPath "id", indexes by_backupKey / by_expiresAt
localStorage pesowise:expense-submitted-backups:{orgId}:{userId}
```

It never enumerates browser databases, never opens a `readwrite` transaction, and never
deletes or expires a record — recovery must not destroy the evidence it searches.

Confidence scoring (no single signal mandatory, since historical records lack fields):
expense match +45, exact filename +35, incident window +25, JPEG type +10; zero-byte blobs
are rejected outright.

**Why a browser copy can exist:** `ExpenseForm.persistSubmittedSafetyCopy()` runs on the
**edit** path too, so saving the 23:26 edit downloaded the then-live bytes into IndexedDB.
TTL is 7 days → **the copy for this incident expires ~2026-08-06.**

### 2.4 Migration (created, not applied)

`supabase/migrations/20260801120000_attachment_soft_delete_and_storage_copies.sql`

* `attachments`: `deleted_at`, `deleted_by`, `delete_reason`, `deletion_source`,
  `restored_at`, `restored_by`, `durability_status` (+ CHECK, + partial indexes).
* `attachment_storage_copies`: one row per physical copy — `copy_role`
  (`staging|primary|archive`), `status` (`pending|verified|missing|failed|quarantined`),
  `size_bytes`, `sha256`, `verified_at`, uniqueness on (provider, bucket, path) and
  (attachment, role, provider). RLS: **SELECT only** for org members; rows are written
  exclusively by server-side `SECURITY DEFINER` operations.
* `soft_delete_attachment` / `restore_soft_deleted_attachment` — org-scoped, master-admin
  aware, idempotent.

Additive only: no `DROP`, no `TRUNCATE`, no `DELETE FROM`.

---

## 3. Designed, NOT implemented

These were specified but are not in this commit. Each is a substantial piece of work and
shipping a shallow version would be worse than shipping none.

| Area | Status | Note |
|------|--------|------|
| `/receipt-recovery` route + UI | **not built** | scanner library is complete and tested; the page and server restore endpoint are not |
| Staging for existing-expense uploads (Phase 9) | **not built** | `FileUpload.tsx:255` still branches on `expenseId`; changing upload routing needs its own tested change |
| `receipts-archive` bucket + two-copy finalization (Phase 10) | **not built** | table exists in the migration; the write/verify pipeline does not |
| MinIO versioning / object lock (Phase 11) | **not done** | operator steps below; must not be automated |
| Archive restore RPCs (Phase 12) | **not built** | |
| Backup reliability contract (Phase 13) | **not built** | backup scripts are not in this repository — operator patch required |
| Integrity monitor (Phase 14) | **not built** | |
| Archive backfill (Phase 15) | **not built** | |
| Physical purge | **deliberately out of scope** | soft delete only for the first release |

---

## 4. Operator steps — MinIO (do not automate)

Read-only checks first. Do not hardcode aliases, endpoints or credentials.

```bash
mc version info <alias>/<bucket>          # expect: versioning disabled today
mc ls --versions <alias>/<bucket>/<path>  # confirm no prior versions exist
```

**Plan A — versioning on the existing primary bucket.** After Preview validation and a
verified backup, enable versioning so an ordinary delete leaves a delete marker with the
prior version recoverable:

```bash
mc version enable <alias>/<bucket>
```

**Plan B — protected archive.** Object locking **cannot** be enabled retroactively, so the
archive must be created as a new bucket with lock at creation:

```bash
mc mb --with-lock <alias>/receipts-archive
```

Proposed initial retention: **Governance mode, 90-day minimum**. Governance (not
Compliance) is proposed because Compliance cannot be bypassed even by an administrator for
the retention duration — that is unsafe to adopt without legal sign-off and a tested
deletion-request process. Retention mode and duration require explicit approval.

Considerations to weigh before approving: storage growth (~3.9 GB and rising per snapshot
today, and versioning retains every overwrite); privacy/GDPR erasure obligations vs. locked
retention; privileged bypass semantics under Governance; and that rollback after enabling
locking means recreating the bucket. **Archive replication must never propagate delete
operations** — a primary delete must not remove the archive version.

---

## 5. Deployment order

1. Run `/receipt-recovery` on the uploader's iPhone **first** — the browser copy expires ~2026-08-06.
2. Deploy this branch to **Preview**; verify DOC-076 previews and existing upload flows.
3. Apply the migration manually; confirm `soft_delete_attachment` resolves.
4. Verify soft delete + undo on Preview.
5. Enable MinIO versioning (§4 Plan A) after a verified backup.
6. Create `receipts-archive` with lock (§4 Plan B).
7. Build the two-copy pipeline, then backfill.

**Rollback:** revert the commit. The migration is additive; leaving the columns in place is
harmless. Reverting restores the previous behaviour, including the destructive delete —
so prefer fixing forward.

---

## 6. Test plan

`src/lib/__tests__/receiptDeletionSafety.test.ts` — 24 tests: scanner scope (own DB/store
only, no enumeration, no readwrite), candidate matching (expense, filename, time window,
zero-byte rejection, sparse records, ranking, TTL), deletion safety (soft delete, RPC-missing
fallback, local-only, idempotency, auth errors propagate), source-level guarantees (no
`receipts.remove` anywhere, staging retained), and migration shape (columns, constraints,
RPCs, additive-only, SELECT-only RLS).

| Check | Result |
|-------|--------|
| `npx tsc --noEmit` | pass |
| `npm run typecheck:api` | pass |
| `npm test -- --run` | **1740 passed / 100 files** |
| `npm run build` | pass |

---

## Revision log

| Date | Rev | Author | Notes |
|------|-----|--------|-------|
| 2026-08-01 | 1.0 | Agent | Initial — removed every physical receipt deletion from browser code (`FileUpload`, `ExpenseForm`, `ExpenseBatchForm`); staging copies now retained; `attachmentRemoval.ts` soft-delete helper with RPC-missing fallback that still never deletes objects; `receiptRecoveryScan.ts` same-device IndexedDB scanner (read-only, own store only, confidence-scored); additive migration for soft-delete columns, `attachment_storage_copies` and the two RPCs. 24 new tests (1740 total). Recovery route, staging re-routing, archive tier, versioning, integrity monitor and backfill designed but **not implemented** — §3. **No SQL executed, no Production storage changed.** |
