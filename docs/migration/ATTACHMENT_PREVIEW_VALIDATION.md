# Historical attachment preview validation (Gate J)

**Latest run:** `20260930T070435Z`  
**Report:** `/tmp/pesowise-migration-backup/attachment-gate-j-20260930T070435Z.md`  
**Gate J:** **PARTIAL** (staging API signed URL + HTTP download proven; full React preview not run)

## Summary

| Metric | Value |
|--------|------:|
| Samples tested (MinIO-backed) | 4 |
| Passed | 4 |
| Failed | 0 |
| Skipped (metadata path, no physical object) | 1 |

## What was validated

For each sample (oldest/recent/JPEG/PDF/PNG candidates in resolved org):

1. Attachment metadata `storage_path` + `storage.objects.version`
2. Physical object under `stub/storage-single-tenant/{bucket}/{name}/{version}`
3. `GET /api/storage/sign-download` as admin → **200**
4. Presigned GET to migration MinIO → **200**
5. Employee IDOR on unrelated attachment key → **403**

## Backend fix (staging)

Supabase-mirrored objects use **`{logicalName}/{versionId}`** in MinIO. Staging API resolves `storage.objects.version` when signing downloads (`backend/src/routes/storage.ts`).

## Missing object investigation (`e1a68041`)

**Classification:** **SOURCE_ALREADY_MISSING**

- DB metadata and `storage.objects.version` exist on migration v2.
- Physical object `receipts/{path}/{version}` absent on **both** production Supabase MinIO and migration MinIO (`missing-attachment-e1a68041-20260930T072116Z.txt`).
- Not a target-only migration omission; stale/orphan metadata on source and target.

