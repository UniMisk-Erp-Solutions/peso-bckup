# Pending Tally jobs / batches — investigation notes

## Why quarantine dry-run showed zero

`list-and-quarantine-smoke-batches.mjs` filters **narrowly**:

1. **Single org:** `TALLY_SMOKE_ORG_ID` (default `80ab039f-f9e2-4c76-8b5b-e65b15d66af9`).
2. **Job status:** only `waiting_for_connector` (not `prepared`, `delivering`, etc.).
3. **Batches:** only `pending` batches whose `job_id` is in that filtered job list.

If pending work is in **other orgs**, other statuses, or jobs without matching filter, dry-run returns `[]` while DB-wide counts can still show **7 pending batches** and **11 jobs** in broader statuses.

## Deploy script preflight counts (broader)

From `deploy-phase5-metadata-revision-only.mjs` PRE_CHECK:

- `pending_batches` = all rows with `tally_sync_delivery_batches.status = 'pending'` (**any org**).
- `pending_tally_jobs` = `tally_sync_jobs.status IN ('waiting_for_connector','delivering','prepared')` (**any org**).

These are **not** the same filters as the quarantine dry-run.

## Read-only detail

**Primary (REST, admin JWT — GET only):**

```powershell
$env:TALLY_VALIDATE_ADMIN_EMAIL = "…"
$env:TALLY_VALIDATE_ADMIN_PASSWORD = "…"
node scripts/tally-integration/investigate-pending-tally-work.mjs
```

Optional SSH count cross-check: `$env:DEPLOY_SSH_PASSWORD = "…"` (same command).

**Silent exit fix:** old script had no `conn.on("error")` and required SSH only — connection failures exited with no stdout. New script always prints JSON (results or error).

**Class A rule:** only explicit Phase 5/smoke/quarantine text in safe error fields — not item count alone.

**Schema note (2026-10-06):** `tally_sync_jobs` has no `updated_at` (use `created_at`, `prepared_at`, `started_at`, `completed_at`). Batches have `updated_at` per Phase 5 migration.

**SSH quarantine script (2026-10-06):** `ssh-quarantine-smoke-batches-transaction.mjs` sends SQL via **base64 → stdin** to `docker exec -i psql` (not `psql -c` + `JSON.stringify`, which produced literal `\nSELECT` / `invalid command` on the remote shell).

**Pairing issuer fix (2026-10-06):** `ssh-issue-test-pairing-code.mjs` now loads **`QUEUE_SNAPSHOT_SQL`** from `_queueSafeShared.mjs` (same as `ssh-verify-queue-safe.mjs`). It had incorrectly passed `microlink_prepared_jobs: []` into `evaluateQueueSafe`, causing false “missing Microlink prepared job” errors.

**ESM export fix (2026-10-06):** Removed duplicate `export { SMOKE_ORG, TALLY_COMPANY }` at file end (`TALLY_COMPANY` already `export const`; `SMOKE_ORG` re-exported once via `export { SMOKE_ORG }`). Tests now run `node --check` + dynamic import on executable scripts.

**psql output fix (2026-10-06):** DML + SELECT in one stdin script emitted `INSERT 0 1` before JSON. Pairing issuer now uses **`sshPsqlMutate`** (DML) then **`sshPsqlJson`** (SELECT readback). Plaintext code generated in Node (same 8-char digest semantics). Orphan unused codes: inspect via `ssh-inspect-test-pairing-state.mjs`; revoke with `REVOKE_ORPHAN_PAIRING_CONFIRM=1` before re-issue.

## Safety until investigated

- **Do not** start Agent (would claim pending batches).
- **Do not** pair for E2E until `run-tally-sync-delivery` boot probe passes **and** pending work is classified.

## Classification (after investigate)

| Question | Action |
|----------|--------|
| Old smoke / wrong XML architecture | Quarantine via admin RPC (dry-run first) — **not run yet** |
| Legitimate customer sync | Preserve; do not quarantine |
| Unknown | Hold; no Agent delivery |
