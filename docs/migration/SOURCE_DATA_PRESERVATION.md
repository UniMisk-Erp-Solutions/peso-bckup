# Source Supabase data preservation (mandatory)

This migration is **copy-first**, not move-and-delete.

## After cutover (and always until explicit approval)

**Do not delete** any data from the existing PesoWise Supabase stack (`kar0ro1k6jiyfxzzw7acnsza`), including:

- PostgreSQL databases, schemas, tables, auth users
- Storage metadata and MinIO objects (receipts, PDFs, images, reports)
- Docker volumes backing Supabase

The new stack may become active production, but the **old Supabase copy must remain intact** for rollback and history.

## Allowed later (requires explicit user approval)

- Place old stack in **read-only / archive** mode
- Stop routing **new** traffic to old stack

## Never authorized automatically

- `DROP`, `TRUNCATE`, volume deletion, bucket wipe, or Supabase service removal

## Post-cutover preservation check (report required)

| Check | Expected |
|-------|----------|
| OLD SUPABASE DATABASE PRESENT | **YES** |
| OLD SUPABASE AUTH DATA PRESENT | **YES** |
| OLD SUPABASE STORAGE PRESENT | **YES** |
| OLD SUPABASE MINIO OBJECTS PRESENT | **YES** |
| OLD SUPABASE VOLUMES PRESENT | **YES** |
| OLD SUPABASE DATA DELETED | **NO** |
| OLD SUPABASE OBJECTS DELETED | **NO** |
| ROLLBACK COPY PRESERVED | **YES** |

**Deletion of the old Supabase stack or its data requires a separate explicit user instruction.** No agent may treat cutover success as permission to delete the source.

Migration method: **COPY → VALIDATE → SWITCH** — never **MOVE → DELETE**.

Migration complete only when **new system is active** and **old Supabase remains preserved**.
