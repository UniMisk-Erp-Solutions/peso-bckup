# Phase 5 — Edge deploy fix (root cause + mechanism)

## Symptom

`run-tally-sync-delivery` HTTP **500** — `Module not found …/tallyMapping/accountingRegistry`.

Deploy script logged **Staged:** but **Remote dependency check: MISSING** for all `_shared/*` files.

## Root cause (verified)

1. **Wrong verification path:** Post-copy checks used `test -f /data/coolify/services/.../volumes/functions/...` as SSH user **`hasto`**. That host path is **root-only** (Coolify). Non-root `test` always fails → false **MISSING** even when `sudo cp` may have written files.

2. **Wrong mental model:** Deno loads from **`/home/deno/functions`** inside container **`supabase-edge-functions-kar0ro1k6jiyfxzzw7acnsza`**, not from a path the deploy user can read without `sudo`.

3. **Broken deploy may still have aborted** before restart on MISSING, leaving a **partial** `_shared/tallyMapping` tree (no `accountingRegistry.ts`) → runtime 500.

## Correct mechanism (repo)

`deploy-phase5-metadata-revision-only.mjs` now:

1. SFTP to **`/home/hasto/peso-tally-edge-staging`** (user-writable).
2. **`docker cp`** staging → **`supabase-edge-functions-kar0ro1k6jiyfxzzw7acnsza:/home/deno/functions/...`**
3. **`docker exec … test -f`** on **container paths** — before and **after** restart.
4. **`SKIP_MIGRATION=1`** skips SQL when revision migration already applied.
5. Logs **`docker inspect` mounts** for audit (bind source usually `/data/coolify/services/kar0ro1k6jiyfxzzw7acnsza/volumes/functions`).

Read-only inspect: `scripts/tally-integration/inspect-edge-functions-mount.mjs`

## Deploy command

```powershell
cd "c:\Users\admin\Desktop\priyanshu intern\test project\peso-bckup-priyanshu"
$env:DEPLOY_SSH_PASSWORD = "<.46 password>"
$env:SKIP_MIGRATION = "1"
node scripts/tally-integration/deploy-phase5-metadata-revision-only.mjs
node scripts/tally-integration/probe-backup-edge-functions.mjs
```

## Import graph (edge)

`_shared/tallyMapping` uses **relative** imports with explicit **`.ts`** extensions (Supabase Deno edge does not resolve extensionless `./accountingRegistry` → `accountingRegistry.ts`). No `@/lib/`.

Regenerate after src sync: `node scripts/tally-integration/fix-edge-tally-mapping-imports.mjs`

Diagnose on server: `node scripts/tally-integration/diagnose-edge-deno-resolution.mjs`

## Node `crypto` (bare import)

**Symptom:** `Relative import path "crypto" not prefixed with / or ./ or ../`

**File:** `_shared/tallyMapping/identities.ts` imported bare `"crypto"`.

**Fix:** SHA-256 via `sha256Utf8HexSync()` in `_shared/tallySync/contentHash.ts` using **`node:crypto`** (Deno-compatible prefix). Identity hashes unchanged — see `tallyEdgeSha256Compat.test.ts`.

## Pre-deploy validation

```powershell
node scripts/tally-integration/validate-edge-import-graph.mjs
```

Deploy script runs this automatically before `docker cp`.

### Deno edge rules (delivery worker)

- Relative imports: **`./file.ts`** (explicit extension)
- Node built-ins: **`node:crypto`** only (no bare `crypto`)
- No `@/lib` aliases in `_shared`
- Remote: `https://esm.sh/...` only in function entrypoints

## Old broken behavior

- `sudo cp` to host `FUNCS_VOL` + non-sudo `test -f` on same path → always **MISSING** for deploy user.
